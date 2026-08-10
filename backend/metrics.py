"""Quality heuristics for converted markdown.

There is no ground truth for an arbitrary uploaded PDF, so "quality" here is a
set of *observable* signals about the output text, grouped into three absolute
sub-scores (0-100) that can be computed from a single conversion:

  structure   - how much markdown structure survived (headings, tables, lists...)
  cleanliness - how much extraction garbage is present (cid artifacts, control
                chars, replacement chars, whitespace noise)
  integrity   - does the text read like real words (vs. char-spaced or shredded
                tokens, broken hyphenation, glued-together words)

A fourth sub-score, `coverage`, is inherently *relative* (how much text an
engine got compared to the best engine on the same file) and is therefore
computed in the frontend once every engine has reported.
"""

from __future__ import annotations

import re
from typing import Any

# --- regexes ------------------------------------------------------------------

RE_CID = re.compile(r"\(cid:\d+\)")
RE_CONTROL = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]")
RE_HEADING = re.compile(r"^\s{0,3}#{1,6}\s+\S", re.M)
RE_SETEXT = re.compile(r"^\s{0,3}\S.*\n\s{0,3}(?:=+|-{2,})\s*$", re.M)
RE_TABLE_SEP = re.compile(r"^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$", re.M)
RE_TABLE_ROW = re.compile(r"^\s*\|.*\|\s*$", re.M)
RE_LIST = re.compile(r"^\s*(?:[-*+]|\d{1,3}[.)])\s+\S", re.M)
RE_FENCE = re.compile(r"^\s*(?:```|~~~)", re.M)
RE_IMAGE = re.compile(r"!\[[^\]]*\]\([^)]+\)")
RE_LINK = re.compile(r"(?<!!)\[[^\]]+\]\([^)]+\)")
RE_EMPHASIS = re.compile(r"(\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*))")
RE_BLOCKQUOTE = re.compile(r"^\s{0,3}>\s?\S", re.M)
RE_HRULE = re.compile(r"^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$", re.M)

RE_TOKEN = re.compile(r"\S+")
RE_WORDISH = re.compile(r"^[A-Za-z][A-Za-z'’-]*$")
RE_HAS_LETTER = re.compile(r"[A-Za-z]")
RE_BROKEN_HYPHEN = re.compile(r"[A-Za-z]-\s*\n\s*[a-z]")
RE_BLANK_RUN = re.compile(r"\n[ \t]*\n(?:[ \t]*\n)+")
RE_INNER_SPACES = re.compile(r"\S[ \t]{3,}\S")
RE_GLUED = re.compile(r"[a-z]{2}[A-Z][a-z]{2}")

# Words that legitimately appear as single characters in English prose.
_OK_SINGLES = {"a", "i", "o", "&", "-", "*", "|", "#", ">", "+", "1", "2", "3", "4",
               "5", "6", "7", "8", "9", "0", "(", ")", "[", "]", ".", ",", ":", ";"}


def _clamp(value: float, low: float = 0.0, high: float = 1.0) -> float:
    return max(low, min(high, value))


def _saturate(value: float, full_at: float) -> float:
    """Map `value` onto 0..1, reaching 1.0 at `full_at`."""
    if full_at <= 0:
        return 0.0
    return _clamp(value / full_at)


def _pct(value: float) -> float:
    return round(_clamp(value) * 100, 1)


def collect_counts(md: str, pages: int) -> dict[str, Any]:
    """Raw, non-judgemental counts about the markdown."""
    pages = max(1, pages)
    chars = len(md)
    stripped = md.strip()
    tokens = RE_TOKEN.findall(md)
    letter_tokens = [t for t in tokens if RE_HAS_LETTER.search(t)]
    lines = md.splitlines()

    table_rows = len(RE_TABLE_ROW.findall(md))
    tables = len(RE_TABLE_SEP.findall(md))

    return {
        "chars": chars,
        "chars_nonspace": len(re.sub(r"\s", "", md)),
        "words": len(tokens),
        "lines": len(lines),
        "non_empty_lines": sum(1 for line in lines if line.strip()),
        "pages": pages,
        "is_empty": not stripped,
        # structure
        "headings": len(RE_HEADING.findall(md)) + len(RE_SETEXT.findall(md)),
        "tables": tables,
        "table_rows": table_rows,
        "list_items": len(RE_LIST.findall(md)),
        "code_blocks": len(RE_FENCE.findall(md)) // 2,
        "images": len(RE_IMAGE.findall(md)),
        "links": len(RE_LINK.findall(md)),
        "emphasis": len(RE_EMPHASIS.findall(md)),
        "blockquotes": len(RE_BLOCKQUOTE.findall(md)),
        "hrules": len(RE_HRULE.findall(md)),
        # noise
        "cid_artifacts": len(RE_CID.findall(md)),
        "control_chars": len(RE_CONTROL.findall(md)),
        "replacement_chars": md.count("�"),
        "blank_line_runs": len(RE_BLANK_RUN.findall(md)),
        "inner_space_runs": len(RE_INNER_SPACES.findall(md)),
        # integrity
        "letter_tokens": len(letter_tokens),
        "wordish_tokens": sum(1 for t in letter_tokens if RE_WORDISH.match(t)),
        "single_char_tokens": sum(1 for t in tokens if len(t) == 1 and t.lower() not in _OK_SINGLES),
        "broken_hyphens": len(RE_BROKEN_HYPHEN.findall(md)),
        "glued_words": len(RE_GLUED.findall(md)),
        "avg_word_len": round(sum(len(t) for t in letter_tokens) / len(letter_tokens), 2)
        if letter_tokens else 0.0,
    }


def _structure_score(c: dict[str, Any]) -> tuple[float, dict[str, float]]:
    """Reward markdown structure that survived the conversion.

    Doc-dependent by nature: a PDF with no tables gives no engine table points.
    That is fine, because every engine is scored against the *same* document.
    """
    pages = c["pages"]
    parts = {
        "headings": _saturate(c["headings"] / pages, 1.0),
        "tables": _saturate(c["tables"], 1.0) * 0.6 + _saturate(c["table_rows"] / pages, 2.0) * 0.4,
        "lists": _saturate(c["list_items"] / pages, 3.0),
        "inline": _saturate((c["emphasis"] + c["links"] + c["images"]) / pages, 4.0),
        "blocks": _saturate(c["code_blocks"] + c["blockquotes"] + c["hrules"], 2.0),
    }
    weights = {"headings": 0.34, "tables": 0.22, "lists": 0.18, "inline": 0.18, "blocks": 0.08}
    score = sum(parts[k] * weights[k] for k in weights)
    return score, {k: round(v, 3) for k, v in parts.items()}


def _cleanliness_score(c: dict[str, Any]) -> tuple[float, dict[str, float]]:
    """Penalise extraction garbage. 1.0 means no detectable noise."""
    chars = max(1, c["chars"])
    noise = c["cid_artifacts"] * 6 + c["control_chars"] + c["replacement_chars"] * 4
    noise_density = noise / chars
    lines = max(1, c["non_empty_lines"])

    parts = {
        # 0.2% noise characters already reads as visibly broken output.
        "artifacts": 1.0 - _clamp(noise_density * 500),
        "whitespace": 1.0 - _clamp(c["blank_line_runs"] / lines * 4),
        "alignment": 1.0 - _clamp(c["inner_space_runs"] / lines * 2),
    }
    weights = {"artifacts": 0.6, "whitespace": 0.2, "alignment": 0.2}
    score = sum(parts[k] * weights[k] for k in weights)
    return score, {k: round(v, 3) for k, v in parts.items()}


def _integrity_score(c: dict[str, Any]) -> tuple[float, dict[str, float]]:
    """Does the output read like real prose rather than shredded glyphs?"""
    letters = max(1, c["letter_tokens"])
    words = max(1, c["words"])
    avg = c["avg_word_len"]

    # Real English averages ~4-6 chars/word. Far below => char-spacing damage,
    # far above => words glued together or whitespace lost entirely.
    if avg <= 0:
        length_ok = 0.0
    elif 3.5 <= avg <= 7.5:
        length_ok = 1.0
    elif avg < 3.5:
        length_ok = _clamp(avg / 3.5)
    else:
        length_ok = _clamp(1.0 - (avg - 7.5) / 6.0)

    parts = {
        "wordish": c["wordish_tokens"] / letters,
        "fragments": 1.0 - _clamp(c["single_char_tokens"] / words * 6),
        "hyphenation": 1.0 - _clamp(c["broken_hyphens"] / letters * 60),
        "glued": 1.0 - _clamp(c["glued_words"] / letters * 30),
        "word_length": length_ok,
    }
    weights = {"wordish": 0.34, "fragments": 0.22, "hyphenation": 0.14,
               "glued": 0.12, "word_length": 0.18}
    score = sum(parts[k] * weights[k] for k in weights)
    return score, {k: round(v, 3) for k, v in parts.items()}


def analyse(md: str, pages: int) -> dict[str, Any]:
    """Full metric bundle for one conversion result."""
    counts = collect_counts(md, pages)

    if counts["is_empty"]:
        zero = {"structure": 0.0, "cleanliness": 0.0, "integrity": 0.0}
        return {"counts": counts, "scores": zero, "breakdown": {}}

    structure, s_parts = _structure_score(counts)
    cleanliness, c_parts = _cleanliness_score(counts)
    integrity, i_parts = _integrity_score(counts)

    return {
        "counts": counts,
        "scores": {
            "structure": _pct(structure),
            "cleanliness": _pct(cleanliness),
            "integrity": _pct(integrity),
        },
        "breakdown": {"structure": s_parts, "cleanliness": c_parts, "integrity": i_parts},
    }
