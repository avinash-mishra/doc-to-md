# PDF → Markdown Bench

Upload one PDF, run every PDF-to-markdown engine against it, and compare
**speed**, **conversion quality** and the **actual markdown** side by side.

Built for picking an extraction strategy for a RAG pipeline, where the choice
is usually a trade between "fast and flat" and "slow and structured".

![engines](docs/engines.png)

## Quick start

It's a static site — no install, no server, no build step:

```bash
cd frontend && python -m http.server 8000   # or any static file server
```

Open `http://localhost:8000`, or open `frontend/index.html` directly in a
browser. This is also what's deployed to GitHub Pages — the whole app,
including PDF parsing, runs client-side.

## Engines

Every engine here runs entirely in the browser, on top of Mozilla's
[pdf.js](https://mozilla.github.io/pdf.js/) (vendored locally in
`frontend/vendor/pdfjs/` — the one exception to the no-dependencies rule
below, since hand-rolling a PDF parser isn't practical).

| Engine | Output | Notes |
| --- | --- | --- |
| **PDF.js — Raw text** | plain text | Text layer straight from pdf.js, joined in reading order. No structure detection — the speed baseline. |
| **PDF.js — Structured** | markdown | Headings ranked from font-size, bullet/numbered lists, and paragraph reflow, reconstructed from text-item geometry. |
| **PDF.js — Structured + tables** | markdown | Same heuristics, plus column-alignment table detection rendered as GFM tables. |

All three are heuristic, not ML-based — there's no layout model involved, just
font-size ranking and x/y-position clustering on the text layer pdf.js
exposes. See [frontend/engines.js](frontend/engines.js) to extend or tune them.

Every engine is optional to run (all are pre-selected by default); one that
throws is reported on its own card and the other engines still finish.

## How the score works

An arbitrary PDF has no ground-truth markdown, so the composite is a weighted
blend of four observable signals — all measured on the *same* document, which
is what makes them comparable:

| Sub-score | Weight | What it measures |
| --- | --- | --- |
| **Coverage** | 30% | Characters recovered vs. the best engine on this file. |
| **Structure** | 25% | Headings, tables, list items, links and emphasis that survived. |
| **Cleanliness** | 25% | Absence of `(cid:N)` artifacts, control/replacement characters, whitespace and column-gap noise. |
| **Integrity** | 20% | Tokens that read as real words; no char-spacing damage, broken hyphenation or glued-together words. |

Coverage is relative and computed once every engine has reported; the other
three are absolute and computed in [frontend/metrics.js](frontend/metrics.js),
which also exposes the raw counts behind each one in the **Metrics** tab.

Two honest caveats:

- **Structure is document-dependent.** A PDF with no tables gives no engine
  table points. That's fine for ranking engines against each other on one
  file, and meaningless as an absolute number.
- **Raw text scores low on structure by construction.** It isn't trying to
  emit markdown. Read its card as the speed and coverage floor, not a failure.

Use the score to order the field, then open the viewer and read the output —
the side-by-side compare is where the real differences show up.

## Using it

1. Drop a PDF on the upload zone. It never leaves your machine — there's no
   upload, the file is read directly by the browser.
2. Tick the engines to race (all three are pre-selected).
3. Pick a page limit (default: first 5 pages — raise it for a real benchmark).
4. **Run comparison.** Engines run sequentially by default so the timings are
   clean; tick *Run in parallel* when you only care about the output.
5. Sort by score / speed / volume, then **View markdown** for the rendered
   output, raw source, full metrics, or a side-by-side diff against any other
   engine. Copy or download any result as `.md`.

## Layout

```
frontend/
  index.html      single page, no build step
  app.js           state, rendering, and a dependency-free markdown renderer
  engines.js       the three pdf.js-based conversion engines
  metrics.js       quality heuristics (structure / cleanliness / integrity)
  pdf-loader.js    wires up the vendored pdf.js module + worker
  vendor/pdfjs/    vendored pdf.js build (Apache-2.0, Mozilla)
  styles.css       design tokens, dark + light
backend/           an earlier FastAPI + Python-engine version of this app.
                   No longer wired to frontend/ — see CLAUDE.md.
```

### Adding an engine

Write a function `(pdfDoc, maxPages) -> Promise<string>` (a pdf.js
`PDFDocumentProxy` in, markdown or plain text out) and add it to `DEFS` in
[frontend/engines.js](frontend/engines.js). `frontend/engines.js` exports
`extractLines(page)` for text-geometry extraction (position, font size, per
line) if your engine wants to reuse it instead of parsing raw text items
itself.

## Notes

- The markdown preview renderer escapes every character before generating
  markup, so converter output can't inject markup into the page.
- Encrypted PDFs (ones that need a password to open) are rejected at upload
  with a clear message rather than failing once per engine.
- The heuristics here are geometry-based, not ML-based: multi-column layouts,
  rotated text, and unusual table shapes will fool them more easily than
  they'd fool a layout model like Docling. Read the output, don't just trust
  the score.
