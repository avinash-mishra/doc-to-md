"""Converter registry.

Every engine is registered with a `@register` decorator and is discovered
lazily: an engine whose library is not installed is reported as unavailable
instead of breaking the app. To add an engine, write a function that takes
(data: bytes, max_pages: int | None) and returns markdown, and register it.
"""

from __future__ import annotations

import importlib.metadata as md_meta
import importlib.util
import io
import time
from dataclasses import dataclass, field
from typing import Callable, Optional

ConverterFn = Callable[[bytes, Optional[int]], str]


@dataclass
class Engine:
    id: str
    name: str
    module: str                 # import name used for the availability probe
    dist: str                   # distribution name used for the version lookup
    description: str
    output: str                 # "markdown" | "plain text"
    fn: ConverterFn = field(repr=False, default=None)  # type: ignore[assignment]
    heavy: bool = False         # slow / downloads models -> off by default
    supports_page_limit: bool = True
    homepage: str = ""
    install_hint: str = "Install the package with pip to enable this engine."

    @property
    def available(self) -> bool:
        return importlib.util.find_spec(self.module) is not None

    @property
    def version(self) -> str | None:
        try:
            return md_meta.version(self.dist)
        except md_meta.PackageNotFoundError:
            return None

    def as_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.name,
            "description": self.description,
            "output": self.output,
            "heavy": self.heavy,
            "supports_page_limit": self.supports_page_limit,
            "homepage": self.homepage,
            "available": self.available,
            "version": self.version,
            "install_hint": self.install_hint,
        }


REGISTRY: dict[str, Engine] = {}


def register(engine: Engine) -> Callable[[ConverterFn], ConverterFn]:
    def wrap(fn: ConverterFn) -> ConverterFn:
        engine.fn = fn
        REGISTRY[engine.id] = engine
        return fn
    return wrap


def _page_indices(total: int, max_pages: int | None) -> list[int]:
    limit = total if not max_pages else min(total, max_pages)
    return list(range(limit))


# --- PyMuPDF (raw text layer) -------------------------------------------------

@register(Engine(
    id="pymupdf-raw",
    name="PyMuPDF",
    module="pymupdf",
    dist="pymupdf",
    description="Raw text layer straight from the PDF. The speed baseline — no "
                "structure detection, so it shows what the document costs to read.",
    output="plain text",
    homepage="https://pymupdf.readthedocs.io/",
))
def _pymupdf_raw(data: bytes, max_pages: int | None) -> str:
    import pymupdf

    with pymupdf.open(stream=data, filetype="pdf") as doc:
        chunks = [doc[i].get_text("text") for i in _page_indices(doc.page_count, max_pages)]
    return "\n\n".join(chunks)


# --- PyMuPDF4LLM --------------------------------------------------------------

@register(Engine(
    id="pymupdf4llm",
    name="PyMuPDF4LLM",
    module="pymupdf4llm",
    dist="pymupdf4llm",
    description="PyMuPDF's RAG-oriented layer: reconstructs headings from font "
                "sizes and emits GitHub-flavoured markdown tables.",
    output="markdown",
    homepage="https://pymupdf.readthedocs.io/en/latest/pymupdf4llm/",
))
def _pymupdf4llm(data: bytes, max_pages: int | None) -> str:
    import pymupdf
    import pymupdf4llm

    with pymupdf.open(stream=data, filetype="pdf") as doc:
        return pymupdf4llm.to_markdown(doc, pages=_page_indices(doc.page_count, max_pages))


# --- MarkItDown ---------------------------------------------------------------

@register(Engine(
    id="markitdown",
    name="MarkItDown",
    module="markitdown",
    dist="markitdown",
    description="Microsoft's any-file-to-markdown tool. Uses pdfminer under "
                "the hood for PDFs.",
    output="markdown",
    homepage="https://github.com/microsoft/markitdown",
))
def _markitdown(data: bytes, max_pages: int | None) -> str:
    from markitdown import MarkItDown, StreamInfo

    # MarkItDown's convert API has no page-range parameter, so a limit is
    # applied by trimming the PDF itself before handing it over.
    if max_pages:
        import pymupdf

        with pymupdf.open(stream=data, filetype="pdf") as doc:
            indices = _page_indices(doc.page_count, max_pages)
            if len(indices) < doc.page_count:
                doc.select(indices)
                data = doc.write()

    converter = MarkItDown(enable_plugins=False)
    result = converter.convert_stream(
        io.BytesIO(data),
        stream_info=StreamInfo(extension=".pdf", mimetype="application/pdf"),
    )
    return result.text_content or ""


# --- anydoc ---------------------------------------------------------------------

@register(Engine(
    id="anydoc",
    name="AnyDoc",
    module="anydoc",
    dist="firecrawl-anydoc",
    description="Firecrawl's Rust-backed document parser (PDF, DOCX, PPTX, "
                "XLSX, EPUB, ...) converting straight to GitHub-flavoured "
                "markdown.",
    output="markdown",
    homepage="https://github.com/firecrawl/anydoc",
))
def _anydoc(data: bytes, max_pages: int | None) -> str:
    import anydoc

    # anydoc's PDF conversion has no page-range parameter, so a limit is
    # applied by trimming the PDF itself before handing it over.
    if max_pages:
        import pymupdf

        with pymupdf.open(stream=data, filetype="pdf") as doc:
            indices = _page_indices(doc.page_count, max_pages)
            if len(indices) < doc.page_count:
                doc.select(indices)
                data = doc.write()

    return anydoc.to_markdown_bytes(data)


# --- pdf-inspector ------------------------------------------------------------

@register(Engine(
    id="pdf-inspector",
    name="pdf-inspector",
    module="pdf_inspector",
    dist="pdf-inspector",
    description="Rust-backed per-page markdown extraction that also flags pages "
                "needing OCR and detects multi-column layouts.",
    output="markdown",
    homepage="https://pypi.org/project/pdf-inspector/",
))
def _pdf_inspector(data: bytes, max_pages: int | None) -> str:
    import pdf_inspector

    pages = list(range(max_pages)) if max_pages else None
    result = pdf_inspector.extract_pages_markdown_bytes(data, pages=pages)
    return "\n\n".join(page.markdown for page in result.pages if page.markdown)


# --- pdfplumber ---------------------------------------------------------------

@register(Engine(
    id="pdfplumber",
    name="pdfplumber",
    module="pdfplumber",
    dist="pdfplumber",
    description="Precise word/table geometry. Tables are lifted with its own "
                "detector and rendered as markdown here.",
    output="markdown",
    homepage="https://github.com/jsvine/pdfplumber",
))
def _pdfplumber(data: bytes, max_pages: int | None) -> str:
    import pdfplumber

    def _table_to_md(table: list[list]) -> str:
        rows = [[(cell or "").replace("\n", " ").replace("|", "\\|").strip() for cell in row]
                for row in table if row]
        if not rows:
            return ""
        width = max(len(r) for r in rows)
        rows = [r + [""] * (width - len(r)) for r in rows]
        header, *body = rows
        out = ["| " + " | ".join(header) + " |",
               "| " + " | ".join(["---"] * width) + " |"]
        out += ["| " + " | ".join(r) + " |" for r in body]
        return "\n".join(out)

    parts: list[str] = []
    with pdfplumber.open(io.BytesIO(data)) as pdf:
        for index in _page_indices(len(pdf.pages), max_pages):
            page = pdf.pages[index]
            text = page.extract_text() or ""
            if text:
                parts.append(text)
            for table in page.extract_tables():
                rendered = _table_to_md(table)
                if rendered:
                    parts.append(rendered)
            page.flush_cache()
    return "\n\n".join(parts)


# --- pdfminer.six -------------------------------------------------------------

@register(Engine(
    id="pdfminer",
    name="pdfminer.six",
    module="pdfminer",
    dist="pdfminer.six",
    description="The classic pure-Python text extractor. No markdown, but it is "
                "the reference many other tools are built on.",
    output="plain text",
    homepage="https://pdfminersix.readthedocs.io/",
))
def _pdfminer(data: bytes, max_pages: int | None) -> str:
    from pdfminer.high_level import extract_text

    return extract_text(io.BytesIO(data), maxpages=max_pages or 0)


# --- Docling ------------------------------------------------------------------

@register(Engine(
    id="docling",
    name="Docling",
    module="docling",
    dist="docling",
    description="IBM's layout-model pipeline. The most structure-aware option "
                "and by far the slowest; downloads models on first run.",
    output="markdown",
    heavy=True,
    homepage="https://github.com/docling-project/docling",
))
def _docling(data: bytes, max_pages: int | None) -> str:
    from docling.document_converter import DocumentConverter
    from docling_core.types.io import DocumentStream

    source = DocumentStream(name="upload.pdf", stream=io.BytesIO(data))
    kwargs = {"page_range": (1, max_pages)} if max_pages else {}
    result = DocumentConverter().convert(source, **kwargs)
    return result.document.export_to_markdown()


# --- Unlimited-OCR (Baidu) -----------------------------------------------------
#
# A DeepSeek-OCR-based vision-language parser. Unlike every other engine here,
# it has no pip-installable client: it needs a local GPU inference server
# (SGLang/vLLM/transformers) hosting several GB of model weights, and SGLang
# itself has no official Windows support. `module` names a package that will
# never be importable so this always reports as unavailable rather than
# attempting (and failing) a heavyweight server launch from a document-compare
# demo. See https://github.com/baidu/Unlimited-OCR.

@register(Engine(
    id="unlimited-ocr",
    name="Unlimited-OCR",
    module="unlimited_ocr",
    dist="unlimited-ocr",
    description="Baidu's DeepSeek-OCR-based vision-language parser. Strong on "
                "scanned and complex layouts, but needs a local GPU inference "
                "server (SGLang/vLLM) hosting multi-GB model weights rather "
                "than a pip-installable client.",
    output="markdown",
    heavy=True,
    supports_page_limit=False,
    install_hint="Needs a local SGLang/vLLM/transformers server hosting the "
                 "model weights (NVIDIA GPU, several GB VRAM, Linux/CUDA) — "
                 "this can't be pip-installed. See github.com/baidu/Unlimited-OCR.",
    homepage="https://github.com/baidu/Unlimited-OCR",
))
def _unlimited_ocr(data: bytes, max_pages: int | None) -> str:
    raise RuntimeError(
        "Unlimited-OCR requires a running SGLang/vLLM/transformers inference "
        "server hosting the model weights; it cannot be pip-installed. See "
        "https://github.com/baidu/Unlimited-OCR for setup."
    )


# --- runner -------------------------------------------------------------------

def list_engines() -> list[dict]:
    return [engine.as_dict() for engine in REGISTRY.values()]


def run(engine_id: str, data: bytes, max_pages: int | None) -> dict:
    """Execute one engine and time only the conversion itself."""
    engine = REGISTRY.get(engine_id)
    if engine is None:
        raise KeyError(engine_id)
    if not engine.available:
        return {"ok": False, "elapsed_ms": 0.0, "markdown": "",
                "error": f"{engine.name} is not available. {engine.install_hint}"}

    limit = max_pages if engine.supports_page_limit else None
    started = time.perf_counter()
    try:
        markdown = engine.fn(data, limit) or ""
    except (KeyboardInterrupt, SystemExit, GeneratorExit):
        raise
    except BaseException as exc:  # a failing engine must not fail the comparison
        # BaseException, not Exception: several engines here are Rust
        # extensions, and a panic in one surfaces as pyo3's PanicException,
        # which does not derive from Exception. Letting that escape would
        # abort the whole run instead of just this engine's card.
        return {"ok": False,
                "elapsed_ms": round((time.perf_counter() - started) * 1000, 1),
                "markdown": "",
                "error": f"{type(exc).__name__}: {exc}"}
    elapsed_ms = round((time.perf_counter() - started) * 1000, 1)
    return {"ok": True, "elapsed_ms": elapsed_ms, "markdown": markdown, "error": None}
