/* ============================================================================
   PDF → Markdown Bench — SPA
   ========================================================================== */
(() => {
  "use strict";

  /** Composite score weights. Coverage is relative to the best engine on the
   *  same file, so it can only be computed once every engine has reported. */
  const WEIGHTS = { coverage: 0.30, structure: 0.25, cleanliness: 0.25, integrity: 0.20 };

  const state = {
    engines: [],
    selected: new Set(),
    file: null,          // { pdfDoc, blobUrl, filename, size_bytes, pages, producer, title, classification }
    results: new Map(),  // engineId -> { status, data, scores, composite }
    sort: "score",
    view: "rendered",
    drawerEngine: null,
    compareEngine: "",
    running: false,
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, cls, text) => {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  };

  /* ── formatting ─────────────────────────────────────────────────────── */

  const fmtBytes = (n) => {
    if (!n) return "0 B";
    const units = ["B", "KB", "MB", "GB"];
    const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)));
    return `${(n / 1024 ** i).toFixed(i ? 1 : 0)} ${units[i]}`;
  };
  const fmtMs = (ms) => (ms >= 10000 ? `${(ms / 1000).toFixed(1)}s`
    : ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`);
  const fmtNum = (n) => (n >= 1000 ? n.toLocaleString("en-US") : String(n ?? 0));
  const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
  const scoreColor = (v) => (v >= 75 ? "var(--good)" : v >= 50 ? "var(--ok)" : "var(--bad)");

  function toast(message, isError = false) {
    const node = $("#toast");
    node.textContent = message;
    node.className = `toast${isError ? " error" : ""}`;
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => node.classList.add("hidden"), 3600);
  }

  /* ── markdown renderer ──────────────────────────────────────────────
     Small, dependency-free and escape-first: every character is HTML-escaped
     before any markup is generated, so converter output can never inject
     markup into the page.                                                 */

  const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const safeUrl = (raw) => {
    const url = raw.trim().replace(/^<|>$/g, "");
    return /^(https?:|mailto:|data:image\/|#|\/|\.{0,2}\/)/i.test(url) ? url : "";
  };

  function renderInline(text) {
    const stash = [];
    const NUL = "\u0000";
    const keep = (html) => `${NUL}${stash.push(html) - 1}${NUL}`;

    let out = text
      // inline code first: its contents must survive every other rule
      .replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, code) =>
        keep(`<code>${escapeHtml(code.trim())}</code>`))
      .replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, alt, src) => {
        const url = safeUrl(src);
        return url ? keep(`<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy">`)
          : escapeHtml(m);
      })
      .replace(/\[([^\]]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g, (m, label, href) => {
        const url = safeUrl(href);
        return url ? keep(`<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`)
          : escapeHtml(m);
      })
      .replace(/<((?:https?:\/\/|mailto:)[^>\s]+)>/g, (_, href) =>
        keep(`<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>`));

    out = escapeHtml(out)
      .replace(/~~([^~\n]+)~~/g, "<del>$1</del>")
      .replace(/\*\*\*([^*\n]+)\*\*\*/g, "<strong><em>$1</em></strong>")
      .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
      .replace(/__([^_\n]+)__/g, "<strong>$1</strong>")
      .replace(/(^|[\s(])\*([^*\n]+)\*/g, "$1<em>$2</em>")
      .replace(/(^|[\s(])_([^_\n]+)_(?![A-Za-z0-9])/g, "$1<em>$2</em>")
      .replace(/ {2,}$/gm, "<br>");

    return out.replace(/\u0000(\d+)\u0000/g, (_, i) => stash[Number(i)]);
  }

  const splitRow = (row) => row.replace(/^\s*\|/, "").replace(/\|\s*$/, "")
    .split(/(?<!\\)\|/).map((cell) => cell.replace(/\\\|/g, "|").trim());

  const isTableSep = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);

  function renderMarkdown(src) {
    const lines = String(src || "").replace(/\r\n?/g, "\n").split("\n");
    const html = [];
    let i = 0;

    const listItemMatch = (line) => line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);

    function parseList(indent) {
      const first = listItemMatch(lines[i]);
      const ordered = /\d/.test(first[2]);
      const items = [];
      while (i < lines.length) {
        const m = listItemMatch(lines[i]);
        if (!m || m[1].length < indent) break;
        if (m[1].length > indent) {                       // nested list
          const nested = parseList(m[1].length);
          if (items.length) items[items.length - 1] += nested;
          else items.push(nested);
          continue;
        }
        if (/\d/.test(m[2]) !== ordered) break;
        i++;
        let content = m[3];
        while (i < lines.length && lines[i].trim() && !listItemMatch(lines[i]) &&
               /^\s{2,}/.test(lines[i])) {
          content += " " + lines[i].trim();
          i++;
        }
        items.push(renderInline(content));
      }
      const tag = ordered ? "ol" : "ul";
      return `<${tag}>${items.map((it) => `<li>${it}</li>`).join("")}</${tag}>`;
    }

    while (i < lines.length) {
      const line = lines[i];

      if (!line.trim()) { i++; continue; }

      const fence = line.match(/^\s*(```|~~~)(.*)$/);
      if (fence) {
        i++;
        const body = [];
        while (i < lines.length && !new RegExp(`^\\s*${fence[1]}`).test(lines[i])) body.push(lines[i++]);
        i++;
        html.push(`<pre><code>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      const heading = line.match(/^\s{0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
      if (heading) {
        const level = heading[1].length;
        html.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
        i++; continue;
      }

      if (/^\s{0,3}([-*_])\s*(\1\s*){2,}$/.test(line)) { html.push("<hr>"); i++; continue; }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(splitRow(lines[i])); i++;
        }
        const head = header.map((c) => `<th>${renderInline(c)}</th>`).join("");
        const body = rows.map((r) => {
          const cells = [...r, ...Array(Math.max(0, header.length - r.length)).fill("")];
          return `<tr>${cells.slice(0, Math.max(header.length, r.length))
            .map((c) => `<td>${renderInline(c)}</td>`).join("")}</tr>`;
        }).join("");
        html.push(`<div class="md-table-scroll"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`);
        continue;
      }

      if (/^\s{0,3}>/.test(line)) {
        const quoted = [];
        while (i < lines.length && /^\s{0,3}>/.test(lines[i])) {
          quoted.push(lines[i].replace(/^\s{0,3}>\s?/, "")); i++;
        }
        html.push(`<blockquote>${renderMarkdown(quoted.join("\n"))}</blockquote>`);
        continue;
      }

      if (listItemMatch(line)) { html.push(parseList(listItemMatch(line)[1].length)); continue; }

      const para = [];
      while (i < lines.length && lines[i].trim() && !/^\s{0,3}(#{1,6}\s|>|```|~~~)/.test(lines[i])
             && !listItemMatch(lines[i]) && !isTableSep(lines[i])) {
        para.push(lines[i]); i++;
      }
      if (para.length) html.push(`<p>${renderInline(para.join("\n"))}</p>`);
      else i++;
    }
    return html.join("\n");
  }

  /* ── scoring ────────────────────────────────────────────────────────── */

  function rescoreAll() {
    const ok = [...state.results.values()].filter((r) => r.status === "done" && r.data.ok);
    const maxChars = Math.max(1, ...ok.map((r) => r.data.metrics.counts.chars));

    for (const entry of state.results.values()) {
      if (entry.status !== "done" || !entry.data.ok) { entry.composite = 0; entry.scores = null; continue; }
      const s = entry.data.metrics.scores;
      const coverage = Math.round(
        Math.min(1, entry.data.metrics.counts.chars / maxChars) * 1000) / 10;
      entry.scores = { coverage, ...s };
      entry.composite = Math.round(
        coverage * WEIGHTS.coverage + s.structure * WEIGHTS.structure +
        s.cleanliness * WEIGHTS.cleanliness + s.integrity * WEIGHTS.integrity);
    }
  }

  const sortedResults = () => {
    const list = [...state.results.entries()].map(([id, entry]) => ({ id, ...entry }));
    const rank = { score: (r) => -(r.composite ?? -1), time: (r) => r.data?.elapsed_ms ?? Infinity,
                   chars: (r) => -(r.data?.metrics?.counts.chars ?? -1) };
    return list.sort((a, b) => {
      const aOk = a.status === "done" && a.data.ok, bOk = b.status === "done" && b.data.ok;
      if (aOk !== bOk) return aOk ? -1 : 1;
      return rank[state.sort](a) - rank[state.sort](b);
    });
  };

  /* ── upload ─────────────────────────────────────────────────────────── */

  async function classifyPages(pdfDoc) {
    const needsOcr = [];
    for (let i = 1; i <= pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i);
      const tc = await page.getTextContent();
      const chars = tc.items.reduce((n, it) =>
        n + (typeof it.str === "string" ? it.str.replace(/\s/g, "").length : 0), 0);
      if (chars < 10) needsOcr.push(i);
    }
    return { pages_needing_ocr: needsOcr, has_text_layer: needsOcr.length === 0 };
  }

  async function uploadFile(file) {
    if (!file) return;
    if (!/\.pdf$/i.test(file.name) && file.type !== "application/pdf") {
      return toast("Only PDF files are supported.", true);
    }
    const dropzone = $("#dropzone");
    dropzone.classList.add("busy");
    try {
      const buf = await file.arrayBuffer();
      let pdfDoc;
      try {
        pdfDoc = await window.pdfjsLib.getDocument({ data: buf }).promise;
      } catch (err) {
        throw new Error(err && err.name === "PasswordException"
          ? "This PDF is encrypted; converters cannot read it."
          : `Could not read this PDF (${err.message || err}).`);
      }

      const meta = await pdfDoc.getMetadata().catch(() => null);
      const info = (meta && meta.info) || {};
      const classification = await classifyPages(pdfDoc);

      if (state.file) {
        URL.revokeObjectURL(state.file.blobUrl);
        state.file.pdfDoc.destroy();
      }
      state.file = {
        pdfDoc,
        blobUrl: URL.createObjectURL(file),
        filename: file.name || "document.pdf",
        size_bytes: file.size,
        pages: pdfDoc.numPages,
        producer: (info.Producer || "").trim() || null,
        title: (info.Title || "").trim() || null,
        classification,
      };
      state.results.clear();
      renderFileCard();
      $("#controls-panel").classList.remove("hidden");
      $("#results-panel").classList.add("hidden");
      $("#upload-panel").querySelector(".dropzone").classList.add("hidden");
      updateRunButton();
      toast(`Loaded ${state.file.filename} · ${plural(state.file.pages, "page")}`);
    } catch (err) {
      toast(err.message, true);
    } finally {
      dropzone.classList.remove("busy");
    }
  }

  function renderFileCard() {
    const f = state.file;
    $("#filecard").classList.remove("hidden");
    $("#file-name").textContent = f.filename;
    $("#preview-link").href = f.blobUrl;

    const chips = $("#file-chips");
    chips.innerHTML = "";
    const add = (label, cls = "") => chips.appendChild(el("span", `chip ${cls}`.trim(), label));
    add(plural(f.pages, "page"));
    add(fmtBytes(f.size_bytes));
    if (f.producer) add(f.producer.slice(0, 40));
    const cls = f.classification;
    if (cls) {
      const needOcr = cls.pages_needing_ocr || [];
      if (needOcr.length) add(`${plural(needOcr.length, "page")} need OCR`, "warn");
      else add("Text layer present", "good");
    }
  }

  function resetFile() {
    if (state.file) {
      URL.revokeObjectURL(state.file.blobUrl);
      state.file.pdfDoc.destroy();
    }
    state.file = null;
    state.results.clear();
    $("#filecard").classList.add("hidden");
    $("#controls-panel").classList.add("hidden");
    $("#results-panel").classList.add("hidden");
    $("#upload-panel").querySelector(".dropzone").classList.remove("hidden");
    $("#file-input").value = "";
    updateRunButton();
  }

  /* ── engine picker ──────────────────────────────────────────────────── */

  function renderEngines() {
    const grid = $("#engine-grid");
    grid.innerHTML = "";
    for (const engine of state.engines) {
      const label = el("label", "engine-opt");
      if (!engine.available) label.classList.add("disabled");
      if (state.selected.has(engine.id)) label.classList.add("checked");

      const box = el("input");
      box.type = "checkbox";
      box.checked = state.selected.has(engine.id);
      box.disabled = !engine.available;
      box.addEventListener("change", () => {
        box.checked ? state.selected.add(engine.id) : state.selected.delete(engine.id);
        label.classList.toggle("checked", box.checked);
        updateRunButton();
      });

      const body = el("div");
      const name = el("div", "eo-name");
      name.appendChild(el("span", null, engine.name));
      if (engine.output === "markdown") name.appendChild(el("span", "tag md", "md"));
      if (engine.heavy) name.appendChild(el("span", "tag heavy", "slow"));
      if (!engine.available) name.appendChild(el("span", "tag missing", "unavailable"));
      else if (engine.version) name.appendChild(el("span", "tag", `v${engine.version}`));
      body.append(name, el("div", "eo-desc", engine.available
        ? engine.description
        : `${engine.description}  —  ${engine.install_hint}`));

      label.append(box, body);
      grid.appendChild(label);
    }
    updateRunButton();
  }

  function updateRunButton() {
    const btn = $("#run-btn");
    btn.disabled = state.running || state.selected.size === 0 || !state.file;
    btn.lastChild.textContent = state.running
      ? " Running…"
      : ` Run comparison${state.selected.size ? ` (${state.selected.size})` : ""}`;
  }

  /* ── run ────────────────────────────────────────────────────────────── */

  async function runComparison() {
    if (!state.file || !state.selected.size) return;
    state.running = true;
    updateRunButton();

    const maxPages = Number($("#page-limit").value) || null;
    const ids = state.engines.filter((e) => state.selected.has(e.id)).map((e) => e.id);

    state.results.clear();
    ids.forEach((id) => state.results.set(id, { status: "pending", data: null, composite: null }));
    $("#results-panel").classList.remove("hidden");
    $("#run-summary").textContent = "";
    render();

    const started = performance.now();
    const runOne = async (id) => {
      try {
        const result = await window.Engines.run(id, state.file.pdfDoc, maxPages);
        const pagesConverted = maxPages ? Math.min(state.file.pages, maxPages) : state.file.pages;
        const data = {
          engine: id,
          ok: result.ok,
          error: result.error,
          elapsed_ms: result.elapsed_ms,
          pages_converted: pagesConverted,
          ms_per_page: Math.round((result.elapsed_ms / Math.max(1, pagesConverted)) * 10) / 10,
          markdown: result.markdown,
          metrics: result.ok ? window.Metrics.analyse(result.markdown, pagesConverted) : null,
        };
        state.results.set(id, { status: "done", data, composite: null });
      } catch (err) {
        state.results.set(id, {
          status: "done",
          data: { engine: id, ok: false, error: err.message, elapsed_ms: 0, markdown: "", metrics: null },
          composite: null,
        });
      }
      rescoreAll();
      render();
    };

    if ($("#parallel").checked) await Promise.all(ids.map(runOne));
    else for (const id of ids) await runOne(id);

    const wall = performance.now() - started;
    const okCount = [...state.results.values()].filter((r) => r.data?.ok).length;
    const pages = [...state.results.values()].find((r) => r.data?.ok)?.data.pages_converted ?? 0;
    $("#run-summary").textContent =
      `· ${okCount}/${ids.length} succeeded · ${plural(pages, "page")} · ${fmtMs(wall)} wall clock`;

    state.running = false;
    updateRunButton();
    render();
  }

  /* ── result cards ───────────────────────────────────────────────────── */

  function ring(value) {
    const wrap = el("div", "ring");
    const R = 26, C = 2 * Math.PI * R;
    wrap.innerHTML = `
      <svg viewBox="0 0 62 62">
        <circle class="track" cx="31" cy="31" r="${R}" fill="none" stroke-width="5"></circle>
        <circle class="bar" cx="31" cy="31" r="${R}" fill="none" stroke-width="5"
                stroke="${scoreColor(value)}" stroke-dasharray="${C}"
                stroke-dashoffset="${C * (1 - value / 100)}"></circle>
      </svg>
      <div class="ring-label">${Math.round(value)}<small>SCORE</small></div>`;
    return wrap;
  }

  function bar(label, value) {
    const row = el("div", "bar-row");
    row.appendChild(el("span", null, label));
    const track = el("div", "bar-track");
    const fill = el("div", "bar-fill");
    fill.style.width = `${value}%`;
    fill.style.background = scoreColor(value);
    track.appendChild(fill);
    row.append(track, el("b", null, Math.round(value)));
    return row;
  }

  function buildCard(entry, isWinner) {
    const engine = state.engines.find((e) => e.id === entry.id);
    const card = el("div", "card");
    const head = el("div", "card-head");
    const titleWrap = el("div");
    const title = el("div", "card-title");
    title.appendChild(el("span", null, engine?.name || entry.id));
    if (isWinner) title.appendChild(el("span", "crown", "★ best"));
    titleWrap.append(title, el("div", "card-sub",
      `${engine?.output || ""}${engine?.version ? ` · v${engine.version}` : ""}`));
    head.appendChild(titleWrap);

    if (entry.status === "pending") {
      card.classList.add("pending");
      head.appendChild(el("div", "spinner"));
      card.append(head, el("div", "skeleton-line"), el("div", "skeleton-line"));
      return card;
    }

    const { data } = entry;
    if (!data.ok) {
      card.classList.add("failed");
      card.append(head, el("div", "card-error", data.error || "Conversion failed."));
      return card;
    }

    if (isWinner) card.classList.add("winner");
    head.appendChild(ring(entry.composite));

    const counts = data.metrics.counts;
    const stats = el("div", "stat-row");
    const stat = (value, label) => {
      const box = el("div", "stat");
      box.append(el("b", null, value), el("span", null, label));
      return box;
    };
    stats.append(stat(fmtMs(data.elapsed_ms), "time"),
                 stat(`${fmtNum(Math.round(data.ms_per_page))}ms`, "per page"),
                 stat(fmtNum(counts.chars), "chars"));

    const bars = el("div", "bars");
    bars.append(bar("Coverage", entry.scores.coverage), bar("Structure", entry.scores.structure),
                bar("Clean", entry.scores.cleanliness), bar("Integrity", entry.scores.integrity));

    const foot = el("div", "card-foot");
    const view = el("button", "ghost-btn", "View markdown");
    view.type = "button";
    view.addEventListener("click", () => openDrawer(entry.id));
    const dl = el("button", "ghost-btn", "Download");
    dl.type = "button";
    dl.addEventListener("click", () => download(entry.id));
    foot.append(view, dl);

    card.append(head, stats, bars, foot);
    return card;
  }

  function renderTable() {
    const tbody = $("#metric-tbody");
    tbody.innerHTML = "";
    const rows = sortedResults().filter((r) => r.status === "done" && r.data.ok);
    if (!rows.length) { $("#table-wrap").classList.add("hidden"); return; }
    $("#table-wrap").classList.remove("hidden");

    const best = {
      composite: Math.max(...rows.map((r) => r.composite)),
      elapsed: Math.min(...rows.map((r) => r.data.elapsed_ms)),
      chars: Math.max(...rows.map((r) => r.data.metrics.counts.chars)),
    };

    for (const row of rows) {
      const c = row.data.metrics.counts, s = row.scores;
      const engine = state.engines.find((e) => e.id === row.id);
      const tr = el("tr");
      const cells = [
        [engine?.name || row.id, false],
        [row.composite, row.composite === best.composite],
        [fmtMs(row.data.elapsed_ms), row.data.elapsed_ms === best.elapsed],
        [Math.round(row.data.ms_per_page), false],
        [fmtNum(c.chars), c.chars === best.chars],
        [fmtNum(c.words), false],
        [s.coverage, false], [s.structure, false], [s.cleanliness, false], [s.integrity, false],
        [c.headings, false], [c.tables, false], [c.list_items, false],
      ];
      cells.forEach(([value, isBest]) => {
        const td = el("td", isBest ? "best" : null, String(value));
        tr.appendChild(td);
      });
      tr.addEventListener("click", () => openDrawer(row.id));
      tr.style.cursor = "pointer";
      tbody.appendChild(tr);
    }
  }

  function render() {
    const container = $("#cards");
    container.innerHTML = "";
    const rows = sortedResults();
    const bestScore = Math.max(-1, ...rows.filter((r) => r.status === "done" && r.data.ok)
      .map((r) => r.composite));
    for (const row of rows) {
      const isWinner = row.status === "done" && row.data?.ok && row.composite === bestScore
        && rows.filter((r) => r.composite === bestScore).length < rows.length;
      container.appendChild(buildCard(row, isWinner));
    }
    renderTable();
  }

  /* ── drawer ─────────────────────────────────────────────────────────── */

  function openDrawer(engineId) {
    const entry = state.results.get(engineId);
    if (!entry || entry.status !== "done" || !entry.data.ok) return;
    state.drawerEngine = engineId;
    state.compareEngine = "";

    const engine = state.engines.find((e) => e.id === engineId);
    $("#drawer-title").textContent = engine?.name || engineId;
    $("#drawer-sub").textContent =
      `${fmtMs(entry.data.elapsed_ms)} · ${plural(entry.data.pages_converted, "page")} · ` +
      `${fmtNum(entry.data.metrics.counts.chars)} chars · score ${entry.composite}`;

    const select = $("#compare-select");
    select.innerHTML = '<option value="">Compare with…</option>';
    for (const [id, other] of state.results) {
      if (id === engineId || other.status !== "done" || !other.data.ok) continue;
      const opt = el("option", null, state.engines.find((e) => e.id === id)?.name || id);
      opt.value = id;
      select.appendChild(opt);
    }
    select.value = "";

    $("#drawer").classList.remove("hidden");
    $("#drawer").setAttribute("aria-hidden", "false");
    $("#drawer-backdrop").classList.remove("hidden");
    document.body.style.overflow = "hidden";
    renderDrawerBody();
  }

  function closeDrawer() {
    $("#drawer").classList.add("hidden");
    $("#drawer").setAttribute("aria-hidden", "true");
    $("#drawer-backdrop").classList.add("hidden");
    document.body.style.overflow = "";
    state.drawerEngine = null;
  }

  function paneFor(engineId) {
    const entry = state.results.get(engineId);
    const pane = el("div");
    if (state.view === "source") {
      const pre = el("pre", "source", entry.data.markdown || "(empty output)");
      pane.appendChild(pre);
    } else if (state.view === "rendered") {
      const box = el("div", "md-render");
      box.innerHTML = renderMarkdown(entry.data.markdown) ||
        '<div class="empty-state">This engine returned no text.</div>';
      pane.appendChild(box);
    } else {
      pane.appendChild(metricsView(entry));
    }
    return pane;
  }

  function metricsView(entry) {
    const wrap = el("div", "metric-groups");
    const c = entry.data.metrics.counts;
    const group = (title, pairs) => {
      const box = el("div", "metric-group");
      box.appendChild(el("h4", null, title));
      for (const [key, value] of pairs) {
        const row = el("div", "kv");
        row.append(el("span", null, key), el("b", null, String(value)));
        box.appendChild(row);
      }
      return box;
    };
    wrap.append(
      group("Score", [
        ["Composite", entry.composite],
        ["Coverage (rel.)", entry.scores.coverage],
        ["Structure", entry.scores.structure],
        ["Cleanliness", entry.scores.cleanliness],
        ["Integrity", entry.scores.integrity],
      ]),
      group("Speed", [
        ["Elapsed", fmtMs(entry.data.elapsed_ms)],
        ["Pages converted", entry.data.pages_converted],
        ["ms / page", Math.round(entry.data.ms_per_page)],
        ["Chars / second", fmtNum(Math.round(c.chars / Math.max(0.001, entry.data.elapsed_ms / 1000)))],
      ]),
      group("Volume", [
        ["Characters", fmtNum(c.chars)],
        ["Non-space chars", fmtNum(c.chars_nonspace)],
        ["Words", fmtNum(c.words)],
        ["Non-empty lines", fmtNum(c.non_empty_lines)],
        ["Avg word length", c.avg_word_len],
      ]),
      group("Structure found", [
        ["Headings", c.headings], ["Tables", c.tables], ["Table rows", c.table_rows],
        ["List items", c.list_items], ["Code blocks", c.code_blocks],
        ["Links", c.links], ["Images", c.images], ["Emphasis spans", c.emphasis],
      ]),
      group("Noise detected", [
        ["(cid:N) artifacts", c.cid_artifacts],
        ["Control chars", c.control_chars],
        ["Replacement chars", c.replacement_chars],
        ["Blank-line runs", c.blank_line_runs],
        ["Column-gap runs", c.inner_space_runs],
      ]),
      group("Text integrity", [
        ["Word-like tokens", fmtNum(c.wordish_tokens)],
        ["Stray single chars", fmtNum(c.single_char_tokens)],
        ["Broken hyphenations", c.broken_hyphens],
        ["Glued words", c.glued_words],
      ]),
    );
    return wrap;
  }

  function renderDrawerBody() {
    const body = $("#drawer-body");
    body.innerHTML = "";
    body.scrollTop = 0;
    if (!state.drawerEngine) return;

    if (state.compareEngine && state.results.get(state.compareEngine)?.data?.ok) {
      const split = el("div", "split");
      for (const id of [state.drawerEngine, state.compareEngine]) {
        const col = el("div");
        col.appendChild(el("div", "split-label",
          state.engines.find((e) => e.id === id)?.name || id));
        col.appendChild(paneFor(id));
        split.appendChild(col);
      }
      body.appendChild(split);
    } else {
      body.appendChild(paneFor(state.drawerEngine));
    }
  }

  function download(engineId) {
    const entry = state.results.get(engineId);
    if (!entry?.data?.ok) return;
    const base = (state.file?.filename || "document").replace(/\.pdf$/i, "");
    const blob = new Blob([entry.data.markdown], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = el("a");
    a.href = url;
    a.download = `${base}.${engineId}.md`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  /* ── wiring ─────────────────────────────────────────────────────────── */

  function bindEvents() {
    const dropzone = $("#dropzone");
    const input = $("#file-input");

    dropzone.addEventListener("click", () => input.click());
    dropzone.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); }
    });
    input.addEventListener("change", () => uploadFile(input.files[0]));

    ["dragenter", "dragover"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.add("dragging"); }));
    ["dragleave", "drop"].forEach((evt) =>
      dropzone.addEventListener(evt, (e) => { e.preventDefault(); dropzone.classList.remove("dragging"); }));
    dropzone.addEventListener("drop", (e) => uploadFile(e.dataTransfer.files[0]));
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());

    $("#reset-btn").addEventListener("click", resetFile);
    $("#run-btn").addEventListener("click", runComparison);

    $("#select-all").addEventListener("click", () => {
      state.engines.filter((e) => e.available).forEach((e) => state.selected.add(e.id));
      renderEngines();
    });
    $("#select-none").addEventListener("click", () => { state.selected.clear(); renderEngines(); });

    $("#sort-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.sort = btn.dataset.sort;
      [...e.currentTarget.children].forEach((b) => b.classList.toggle("active", b === btn));
      render();
    });

    $("#view-seg").addEventListener("click", (e) => {
      const btn = e.target.closest("button");
      if (!btn) return;
      state.view = btn.dataset.view;
      [...e.currentTarget.children].forEach((b) => b.classList.toggle("active", b === btn));
      renderDrawerBody();
    });

    $("#compare-select").addEventListener("change", (e) => {
      state.compareEngine = e.target.value;
      renderDrawerBody();
    });

    $("#drawer-close").addEventListener("click", closeDrawer);
    $("#drawer-backdrop").addEventListener("click", closeDrawer);
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && state.drawerEngine) closeDrawer();
    });

    $("#copy-btn").addEventListener("click", async () => {
      const entry = state.results.get(state.drawerEngine);
      if (!entry?.data?.ok) return;
      try {
        await navigator.clipboard.writeText(entry.data.markdown);
        toast("Markdown copied to clipboard");
      } catch {
        toast("Clipboard blocked by the browser", true);
      }
    });
    $("#download-btn").addEventListener("click", () => download(state.drawerEngine));

    $("#theme-toggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
      document.documentElement.dataset.theme = next;
      localStorage.setItem("bench-theme", next);
    });
  }

  function init() {
    document.documentElement.dataset.theme = localStorage.getItem("bench-theme")
      || (matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
    bindEvents();
    state.engines = window.Engines.list();
    state.engines.filter((e) => e.available && !e.heavy).forEach((e) => state.selected.add(e.id));
    renderEngines();
  }

  init();
})();
