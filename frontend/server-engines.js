/* ============================================================================
   Optional Python-engine backend.

   The bench runs standalone as a static site on the pdf.js engines in
   engines.js. When it is served by `python run.py` instead, a much wider set
   of real-world converters becomes reachable — PyMuPDF, PyMuPDF4LLM,
   MarkItDown, pdf-inspector, pdfplumber, pdfminer.six, Docling — because
   those are Python libraries that cannot run in a browser.

   This module is the client for backend/main.py's API. It answers one
   question at startup: "is there a bench server behind this page?" If yes,
   app.js runs conversions through here; if no (GitHub Pages, file://, any
   plain static host) it silently stays on the in-browser engines.
   ========================================================================== */
window.ServerEngines = (() => {
  "use strict";

  const API = "/api";
  const PROBE_TIMEOUT_MS = 2000;

  async function call(path, init) {
    const res = await fetch(`${API}/${path}`, init);
    if (!res.ok) {
      let detail = `HTTP ${res.status}`;
      try {
        const body = await res.json();
        if (body && body.detail) detail = body.detail;
      } catch { /* non-JSON error body — the status line will do */ }
      throw new Error(detail);
    }
    return res.json();
  }

  /** Engine list from the bench server, or null when there is no server.
   *  Never throws: "no server" is the normal case for the static build. */
  async function probe() {
    if (!/^https?:$/.test(location.protocol)) return null;   // file:// — no API to reach
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), PROBE_TIMEOUT_MS);
    try {
      const body = await call("engines", { signal: abort.signal });
      return Array.isArray(body.engines) && body.engines.length ? body.engines : null;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Hand the PDF to the server once; every engine then converts from that
   *  copy, so the file crosses the wire a single time. */
  async function upload(file) {
    const form = new FormData();
    form.append("file", file, file.name || "document.pdf");
    return call("upload", { method: "POST", body: form });
  }

  /** Run one engine. Returns the same payload shape app.js builds locally:
   *  { engine, ok, error, elapsed_ms, pages_converted, ms_per_page, markdown, metrics } */
  async function convert(fileId, engineId, maxPages) {
    return call("convert", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ file_id: fileId, engine: engineId, max_pages: maxPages || 0 }),
    });
  }

  /** Best-effort cleanup of the server-side copy; the server also expires it. */
  function release(fileId) {
    if (!fileId) return;
    fetch(`${API}/file/${fileId}`, { method: "DELETE", keepalive: true }).catch(() => {});
  }

  return { probe, upload, convert, release };
})();
