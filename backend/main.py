"""FastAPI app: upload a PDF once, then race every converter against it."""

from __future__ import annotations

import shutil
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, Optional

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.concurrency import run_in_threadpool

from . import __version__, converters, metrics

MAX_UPLOAD_BYTES = 100 * 1024 * 1024   # 100 MB
UPLOAD_TTL_SECONDS = 6 * 60 * 60       # forget uploads after 6h

FRONTEND_DIR = Path(__file__).resolve().parent.parent / "frontend"
UPLOAD_DIR = Path(tempfile.gettempdir()) / "pdf-md-bench"
UPLOAD_DIR.mkdir(parents=True, exist_ok=True)

@asynccontextmanager
async def lifespan(_: FastAPI):
    yield
    shutil.rmtree(UPLOAD_DIR, ignore_errors=True)


app = FastAPI(title="PDF → Markdown Bench", version=__version__, lifespan=lifespan)

# file_id -> metadata. In-process only; this is a local single-user tool.
UPLOADS: dict[str, dict[str, Any]] = {}


# --- helpers ------------------------------------------------------------------

def _sweep_expired() -> None:
    cutoff = time.time() - UPLOAD_TTL_SECONDS
    for file_id, meta in list(UPLOADS.items()):
        if meta["uploaded_at"] < cutoff:
            Path(meta["path"]).unlink(missing_ok=True)
            UPLOADS.pop(file_id, None)


def _get_upload(file_id: str) -> dict[str, Any]:
    meta = UPLOADS.get(file_id)
    if meta is None or not Path(meta["path"]).exists():
        raise HTTPException(404, "Upload not found or expired. Please upload the file again.")
    return meta


def _probe(data: bytes) -> dict[str, Any]:
    """Cheap facts about the PDF, used to frame the comparison in the UI."""
    info: dict[str, Any] = {"pages": 0, "encrypted": False, "title": None,
                            "producer": None, "classification": None}
    try:
        import pymupdf

        with pymupdf.open(stream=data, filetype="pdf") as doc:
            info["pages"] = doc.page_count
            info["encrypted"] = bool(doc.is_encrypted)
            meta = doc.metadata or {}
            info["title"] = (meta.get("title") or "").strip() or None
            info["producer"] = (meta.get("producer") or "").strip() or None
    except Exception:
        pass

    try:
        import pdf_inspector

        result = pdf_inspector.classify_pdf_bytes(data)
        info["classification"] = {
            "pages_needing_ocr": sorted(getattr(result, "pages_needing_ocr", []) or []),
            "has_text_layer": not getattr(result, "pages_needing_ocr", []),
        }
    except Exception:
        pass

    return info


# --- API ----------------------------------------------------------------------

@app.get("/api/engines")
async def get_engines() -> dict[str, Any]:
    return {"engines": converters.list_engines()}


@app.post("/api/upload")
async def upload(file: UploadFile = File(...)) -> dict[str, Any]:
    _sweep_expired()

    data = await file.read()
    if not data:
        raise HTTPException(400, "The uploaded file is empty.")
    if len(data) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, f"File is larger than {MAX_UPLOAD_BYTES // (1024 * 1024)} MB.")
    if not data.lstrip()[:5].startswith(b"%PDF-"):
        raise HTTPException(415, "That does not look like a PDF (missing %PDF- header).")

    file_id = uuid.uuid4().hex
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)  # temp dir may be swept by the OS while running
    path = UPLOAD_DIR / f"{file_id}.pdf"
    path.write_bytes(data)

    info = _probe(data)
    if info["encrypted"]:
        path.unlink(missing_ok=True)
        raise HTTPException(422, "This PDF is encrypted; converters cannot read it.")

    UPLOADS[file_id] = {
        "path": str(path),
        "filename": file.filename or "document.pdf",
        "size_bytes": len(data),
        "uploaded_at": time.time(),
        **info,
    }
    return {"file_id": file_id, **{k: v for k, v in UPLOADS[file_id].items() if k != "path"}}


@app.post("/api/convert")
async def convert(
    file_id: str = Body(..., embed=True),
    engine: str = Body(..., embed=True),
    max_pages: Optional[int] = Body(None, embed=True),
) -> JSONResponse:
    meta = _get_upload(file_id)
    if engine not in converters.REGISTRY:
        raise HTTPException(404, f"Unknown engine '{engine}'.")

    data = Path(meta["path"]).read_bytes()
    limit = max_pages if (max_pages and max_pages > 0) else None
    result = await run_in_threadpool(converters.run, engine, data, limit)

    engine_def = converters.REGISTRY[engine]
    pages_converted = min(meta["pages"], limit) if (limit and engine_def.supports_page_limit) \
        else meta["pages"]

    payload: dict[str, Any] = {
        "engine": engine,
        "ok": result["ok"],
        "error": result["error"],
        "elapsed_ms": result["elapsed_ms"],
        "pages_converted": pages_converted,
        "ms_per_page": round(result["elapsed_ms"] / max(1, pages_converted), 1),
        "markdown": result["markdown"],
    }
    payload["metrics"] = metrics.analyse(result["markdown"], pages_converted) if result["ok"] \
        else None
    return JSONResponse(payload)


@app.get("/api/file/{file_id}")
async def raw_file(file_id: str) -> FileResponse:
    meta = _get_upload(file_id)
    return FileResponse(meta["path"], media_type="application/pdf",
                        filename=meta["filename"])


@app.delete("/api/file/{file_id}")
async def delete_file(file_id: str) -> dict[str, bool]:
    meta = UPLOADS.pop(file_id, None)
    if meta:
        Path(meta["path"]).unlink(missing_ok=True)
    return {"deleted": bool(meta)}


# --- static SPA (mounted last so /api/* wins) ---------------------------------

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="spa")
