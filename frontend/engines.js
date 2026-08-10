/* ============================================================================
   Client-side PDF -> Markdown engines, built on pdf.js. This is the
   extension point for the static (GitHub Pages) build: every engine here
   is a function (pdfDoc, maxPages | null) -> Promise<string>, mirroring
   backend/converters.py's ConverterFn shape, just running entirely in the
   browser instead of calling out to a Python library.
   ========================================================================== */
window.Engines = (() => {
  "use strict";

  function pageIndices(numPages, maxPages) {
    const limit = maxPages ? Math.min(numPages, maxPages) : numPages;
    return Array.from({ length: limit }, (_, i) => i);
  }

  /* ── shared text-layer geometry ─────────────────────────────────────── */

  async function extractLines(page) {
    const tc = await page.getTextContent();
    const raw = [];
    for (const item of tc.items) {
      if (typeof item.str !== "string" || !item.str.trim()) continue;
      const fontSize = Math.hypot(item.transform[2], item.transform[3]) || item.height || 10;
      raw.push({ str: item.str, x0: item.transform[4], y: item.transform[5],
                 width: item.width || 0, fontSize });
    }
    if (!raw.length) return [];
    raw.sort((a, b) => (b.y - a.y) || (a.x0 - b.x0));

    const lines = [];
    let cur = null;
    for (const it of raw) {
      if (cur && Math.abs(it.y - cur.y) <= Math.max(2, cur.fontSize * 0.4)) {
        cur.items.push(it);
        cur.fontSize = Math.max(cur.fontSize, it.fontSize);
      } else {
        cur = { y: it.y, fontSize: it.fontSize, items: [it] };
        lines.push(cur);
      }
    }
    return lines.map(finalizeLine);
  }

  function finalizeLine(line) {
    const items = line.items.slice().sort((a, b) => a.x0 - b.x0);
    let text = "";
    let prevX1 = null;
    for (const it of items) {
      if (prevX1 !== null) {
        const gap = it.x0 - prevX1;
        if (gap > line.fontSize * 0.18 && !text.endsWith(" ")) text += " ";
      }
      text += it.str;
      prevX1 = it.x0 + it.width;
    }
    return { text: text.trim(), y: line.y, fontSize: line.fontSize, items };
  }

  function bulletInfo(text) {
    let m = text.match(/^[•◦‣▪·∙]\s+(.*)$/);
    if (m) return { ordered: false, rest: m[1] };
    m = text.match(/^[-*+]\s+(.*)$/);
    if (m) return { ordered: false, rest: m[1] };
    m = text.match(/^\d{1,3}[.)]\s+(.*)$/);
    if (m) return { ordered: true, rest: text.replace(/^\d{1,3}[.)]\s+/, "") };
    return null;
  }

  async function computeHeadingLevels(pdfDoc, idxs) {
    const sizeWeight = new Map();
    const perPageLines = [];
    for (const idx of idxs) {
      const page = await pdfDoc.getPage(idx + 1);
      const lines = await extractLines(page);
      perPageLines.push(lines);
      for (const line of lines) {
        const r = Math.round(line.fontSize * 2) / 2;
        sizeWeight.set(r, (sizeWeight.get(r) || 0) + line.text.length);
      }
    }
    let bodySize = 10, bodyWeight = -1;
    for (const [size, w] of sizeWeight) if (w > bodyWeight) { bodyWeight = w; bodySize = size; }
    const headingSizes = [...sizeWeight.keys()].filter((s) => s > bodySize * 1.08).sort((a, b) => b - a);
    const levels = new Map();
    headingSizes.forEach((s, i) => levels.set(s, Math.min(6, i + 1)));
    return { levels, perPageLines };
  }

  /* ── prose reconstruction: headings, lists, reflowed paragraphs ──────── */

  function linesToMarkdown(lines, headingLevels) {
    const out = [];
    let para = [];
    let listBuf = null;
    let prevY = null, prevFontSize = null;

    const flushPara = () => { if (para.length) { out.push(para.join(" ")); para = []; } };
    const flushList = () => {
      if (listBuf && listBuf.items.length) {
        out.push(listBuf.items.map((it, i) => (listBuf.ordered ? `${i + 1}. ${it}` : `- ${it}`)).join("\n"));
      }
      listBuf = null;
    };

    for (const line of lines) {
      if (!line.text) continue;
      const roundedSize = Math.round(line.fontSize * 2) / 2;
      const level = headingLevels.get(roundedSize);
      const bullet = bulletInfo(line.text);
      const bigGap = prevY !== null && Math.abs(prevY - line.y) > prevFontSize * 1.7;

      if (level) {
        flushPara(); flushList();
        out.push(`${"#".repeat(level)} ${line.text}`);
      } else if (bullet) {
        flushPara();
        if (!listBuf || listBuf.ordered !== bullet.ordered) { flushList(); listBuf = { ordered: bullet.ordered, items: [] }; }
        listBuf.items.push(bullet.rest);
      } else {
        flushList();
        if (bigGap) flushPara();
        para.push(line.text);
      }
      prevY = line.y; prevFontSize = line.fontSize;
    }
    flushPara(); flushList();
    return out.join("\n\n");
  }

  /* ── column-alignment table detection ─────────────────────────────────── */

  function segmentsForLine(line) {
    const items = line.items;
    if (!items.length) return [];
    const segs = [{ text: items[0].str, x0: items[0].x0, x1: items[0].x0 + items[0].width }];
    for (let i = 1; i < items.length; i++) {
      const it = items[i];
      const cur = segs[segs.length - 1];
      const gap = it.x0 - cur.x1;
      if (gap > Math.max(10, line.fontSize * 1.5)) {
        segs.push({ text: it.str, x0: it.x0, x1: it.x0 + it.width });
      } else {
        cur.text += (gap > line.fontSize * 0.18 ? " " : "") + it.str;
        cur.x1 = it.x0 + it.width;
      }
    }
    return segs;
  }

  function detectTableBlocks(lines) {
    const blocks = [];
    let i = 0;
    while (i < lines.length) {
      const segs = segmentsForLine(lines[i]);
      if (segs.length >= 2) {
        const run = [{ segs }];
        let j = i + 1;
        while (j < lines.length) {
          const s = segmentsForLine(lines[j]);
          if (s.length < 2 || Math.abs(s.length - segs.length) > 1) break;
          run.push({ segs: s });
          j++;
        }
        if (run.length >= 3) { blocks.push({ start: i, end: j, run }); i = j; continue; }
      }
      i++;
    }
    return blocks;
  }

  function renderTable(run) {
    const header = run.reduce((a, b) => (b.segs.length > a.segs.length ? b : a)).segs;
    const starts = header.map((s) => s.x0).sort((a, b) => a - b);
    const splits = starts.slice(0, -1).map((s, i) => (s + starts[i + 1]) / 2);
    const colOf = (x0) => splits.filter((s) => x0 >= s).length;
    const nCols = starts.length;

    const rows = run.map(({ segs }) => {
      const cells = Array(nCols).fill("");
      for (const seg of segs) {
        const c = Math.min(nCols - 1, colOf(seg.x0));
        cells[c] = cells[c] ? `${cells[c]} ${seg.text}` : seg.text;
      }
      return cells.map((c) => c.replace(/\|/g, "\\|").trim());
    });

    const [head, ...body] = rows;
    const out = [`| ${head.join(" | ")} |`, `| ${head.map(() => "---").join(" | ")} |`];
    for (const r of body) out.push(`| ${r.join(" | ")} |`);
    return out.join("\n");
  }

  function pageToMarkdownWithTables(lines, headingLevels) {
    const blocks = detectTableBlocks(lines);
    if (!blocks.length) return linesToMarkdown(lines, headingLevels);
    const out = [];
    let cursor = 0;
    for (const b of blocks) {
      if (b.start > cursor) out.push(linesToMarkdown(lines.slice(cursor, b.start), headingLevels));
      out.push(renderTable(b.run));
      cursor = b.end;
    }
    if (cursor < lines.length) out.push(linesToMarkdown(lines.slice(cursor), headingLevels));
    return out.filter(Boolean).join("\n\n");
  }

  /* ── engines ───────────────────────────────────────────────────────── */

  async function runRaw(pdfDoc, maxPages) {
    const parts = [];
    for (const idx of pageIndices(pdfDoc.numPages, maxPages)) {
      const page = await pdfDoc.getPage(idx + 1);
      const tc = await page.getTextContent();
      let text = "";
      for (const item of tc.items) {
        if (typeof item.str !== "string") continue;
        text += item.str + (item.hasEOL ? "\n" : "");
      }
      parts.push(text.trim());
    }
    return parts.join("\n\n");
  }

  async function runStructured(pdfDoc, maxPages) {
    const { levels, perPageLines } = await computeHeadingLevels(pdfDoc, pageIndices(pdfDoc.numPages, maxPages));
    return perPageLines.map((lines) => linesToMarkdown(lines, levels)).filter(Boolean).join("\n\n");
  }

  async function runTables(pdfDoc, maxPages) {
    const { levels, perPageLines } = await computeHeadingLevels(pdfDoc, pageIndices(pdfDoc.numPages, maxPages));
    return perPageLines.map((lines) => pageToMarkdownWithTables(lines, levels)).filter(Boolean).join("\n\n");
  }

  const DEFS = [
    {
      id: "pdfjs-raw",
      name: "PDF.js — Raw text",
      description: "Raw text layer straight from the PDF via Mozilla's pdf.js, "
                   + "joined in reading order. No structure detection — the speed baseline.",
      output: "plain text",
      heavy: false,
      homepage: "https://mozilla.github.io/pdf.js/",
      run: runRaw,
    },
    {
      id: "pdfjs-structured",
      name: "PDF.js — Structured",
      description: "Heuristic markdown reconstruction: headings ranked from font size, "
                   + "bullet/numbered lists, and reflowed paragraphs — all in the browser.",
      output: "markdown",
      heavy: false,
      homepage: "https://mozilla.github.io/pdf.js/",
      run: runStructured,
    },
    {
      id: "pdfjs-tables",
      name: "PDF.js — Structured + tables",
      description: "Same heuristics as Structured, plus column-alignment table "
                   + "detection rendered as GitHub-flavoured markdown tables.",
      output: "markdown",
      heavy: false,
      homepage: "https://mozilla.github.io/pdf.js/",
      run: runTables,
    },
  ];

  function list() {
    return DEFS.map(({ run, ...meta }) => ({
      ...meta,
      available: true,
      supports_page_limit: true,
      version: (window.pdfjsLib && window.pdfjsLib.version) || null,
      install_hint: "",
    }));
  }

  async function run(engineId, pdfDoc, maxPages) {
    const def = DEFS.find((d) => d.id === engineId);
    if (!def) throw new Error(`Unknown engine '${engineId}'`);
    const started = performance.now();
    try {
      const markdown = (await def.run(pdfDoc, maxPages)) || "";
      return { ok: true, elapsed_ms: Math.round((performance.now() - started) * 10) / 10, markdown, error: null };
    } catch (err) {
      return { ok: false, elapsed_ms: Math.round((performance.now() - started) * 10) / 10, markdown: "",
               error: `${err.name || "Error"}: ${err.message || err}` };
    }
  }

  return { list, run, extractLines };
})();
