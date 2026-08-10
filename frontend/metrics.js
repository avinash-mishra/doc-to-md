/* ============================================================================
   Quality heuristics for converted markdown — JS port of backend/metrics.py.

   There is no ground truth for an arbitrary uploaded PDF, so "quality" here is
   a set of *observable* signals about the output text, grouped into three
   absolute sub-scores (0-100) computable from a single conversion:

     structure   - how much markdown structure survived (headings, tables, lists...)
     cleanliness - how much extraction garbage is present (cid artifacts, control
                   chars, replacement chars, whitespace noise)
     integrity   - does the text read like real words (vs. char-spaced or shredded
                   tokens, broken hyphenation, glued-together words)

   A fourth sub-score, `coverage`, is relative (how much text an engine got
   compared to the best engine on the same file) and is computed in app.js
   once every engine has reported — see rescoreAll().
   ========================================================================== */
window.Metrics = (() => {
  "use strict";

  const RE_CID = /\(cid:\d+\)/g;
  const RE_CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g;
  const RE_HEADING = /^\s{0,3}#{1,6}\s+\S/gm;
  const RE_SETEXT = /^\s{0,3}\S.*\n\s{0,3}(?:=+|-{2,})\s*$/gm;
  const RE_TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/gm;
  const RE_TABLE_ROW = /^\s*\|.*\|\s*$/gm;
  const RE_LIST = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\S/gm;
  const RE_FENCE = /^\s*(?:```|~~~)/gm;
  const RE_IMAGE = /!\[[^\]]*\]\([^)]+\)/g;
  const RE_LINK = /(?<!!)\[[^\]]+\]\([^)]+\)/g;
  const RE_EMPHASIS = /(\*\*[^*\n]+\*\*|__[^_\n]+__|(?<!\*)\*[^*\n]+\*(?!\*))/g;
  const RE_BLOCKQUOTE = /^\s{0,3}>\s?\S/gm;
  const RE_HRULE = /^\s{0,3}(?:\*\s*){3,}$|^\s{0,3}(?:-\s*){3,}$|^\s{0,3}(?:_\s*){3,}$/gm;

  const RE_TOKEN = /\S+/g;
  const RE_WORDISH = /^[A-Za-z][A-Za-z'’-]*$/;
  const RE_HAS_LETTER = /[A-Za-z]/;
  const RE_BROKEN_HYPHEN = /[A-Za-z]-\s*\n\s*[a-z]/g;
  const RE_BLANK_RUN = /\n[ \t]*\n(?:[ \t]*\n)+/g;
  const RE_INNER_SPACES = /\S[ \t]{3,}\S/g;
  const RE_GLUED = /[a-z]{2}[A-Z][a-z]{2}/g;

  const OK_SINGLES = new Set(["a", "i", "o", "&", "-", "*", "|", "#", ">", "+", "1", "2", "3",
    "4", "5", "6", "7", "8", "9", "0", "(", ")", "[", "]", ".", ",", ":", ";"]);

  const count = (re, s) => (s.match(re) || []).length;
  const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));
  const saturate = (v, fullAt) => (fullAt <= 0 ? 0 : clamp(v / fullAt));
  const pct = (v) => Math.round(clamp(v) * 1000) / 10;

  function collectCounts(md, pages) {
    pages = Math.max(1, pages);
    const chars = md.length;
    const stripped = md.trim();
    const tokens = md.match(RE_TOKEN) || [];
    const letterTokens = tokens.filter((t) => RE_HAS_LETTER.test(t));
    const lines = md.split("\n");
    const nonEmptyLines = lines.filter((l) => l.trim()).length;

    return {
      chars,
      chars_nonspace: md.replace(/\s/g, "").length,
      words: tokens.length,
      lines: lines.length,
      non_empty_lines: nonEmptyLines,
      pages,
      is_empty: !stripped,
      headings: count(RE_HEADING, md) + count(RE_SETEXT, md),
      tables: count(RE_TABLE_SEP, md),
      table_rows: count(RE_TABLE_ROW, md),
      list_items: count(RE_LIST, md),
      code_blocks: Math.floor(count(RE_FENCE, md) / 2),
      images: count(RE_IMAGE, md),
      links: count(RE_LINK, md),
      emphasis: count(RE_EMPHASIS, md),
      blockquotes: count(RE_BLOCKQUOTE, md),
      hrules: count(RE_HRULE, md),
      cid_artifacts: count(RE_CID, md),
      control_chars: count(RE_CONTROL, md),
      replacement_chars: count(/�/g, md),
      blank_line_runs: count(RE_BLANK_RUN, md),
      inner_space_runs: count(RE_INNER_SPACES, md),
      letter_tokens: letterTokens.length,
      wordish_tokens: letterTokens.filter((t) => RE_WORDISH.test(t)).length,
      single_char_tokens: tokens.filter((t) => t.length === 1 && !OK_SINGLES.has(t.toLowerCase())).length,
      broken_hyphens: count(RE_BROKEN_HYPHEN, md),
      glued_words: count(RE_GLUED, md),
      avg_word_len: letterTokens.length
        ? Math.round((letterTokens.reduce((a, t) => a + t.length, 0) / letterTokens.length) * 100) / 100
        : 0.0,
    };
  }

  function structureScore(c) {
    const pages = c.pages;
    const parts = {
      headings: saturate(c.headings / pages, 1.0),
      tables: saturate(c.tables, 1.0) * 0.6 + saturate(c.table_rows / pages, 2.0) * 0.4,
      lists: saturate(c.list_items / pages, 3.0),
      inline: saturate((c.emphasis + c.links + c.images) / pages, 4.0),
      blocks: saturate(c.code_blocks + c.blockquotes + c.hrules, 2.0),
    };
    const weights = { headings: 0.34, tables: 0.22, lists: 0.18, inline: 0.18, blocks: 0.08 };
    let score = 0;
    for (const k in weights) score += parts[k] * weights[k];
    return [score, parts];
  }

  function cleanlinessScore(c) {
    const chars = Math.max(1, c.chars);
    const noise = c.cid_artifacts * 6 + c.control_chars + c.replacement_chars * 4;
    const noiseDensity = noise / chars;
    const lines = Math.max(1, c.non_empty_lines);

    const parts = {
      artifacts: 1.0 - clamp(noiseDensity * 500),
      whitespace: 1.0 - clamp((c.blank_line_runs / lines) * 4),
      alignment: 1.0 - clamp((c.inner_space_runs / lines) * 2),
    };
    const weights = { artifacts: 0.6, whitespace: 0.2, alignment: 0.2 };
    let score = 0;
    for (const k in weights) score += parts[k] * weights[k];
    return [score, parts];
  }

  function integrityScore(c) {
    const letters = Math.max(1, c.letter_tokens);
    const words = Math.max(1, c.words);
    const avg = c.avg_word_len;

    let lengthOk;
    if (avg <= 0) lengthOk = 0.0;
    else if (avg >= 3.5 && avg <= 7.5) lengthOk = 1.0;
    else if (avg < 3.5) lengthOk = clamp(avg / 3.5);
    else lengthOk = clamp(1.0 - (avg - 7.5) / 6.0);

    const parts = {
      wordish: c.wordish_tokens / letters,
      fragments: 1.0 - clamp((c.single_char_tokens / words) * 6),
      hyphenation: 1.0 - clamp((c.broken_hyphens / letters) * 60),
      glued: 1.0 - clamp((c.glued_words / letters) * 30),
      word_length: lengthOk,
    };
    const weights = { wordish: 0.34, fragments: 0.22, hyphenation: 0.14, glued: 0.12, word_length: 0.18 };
    let score = 0;
    for (const k in weights) score += parts[k] * weights[k];
    return [score, parts];
  }

  function round3(parts) {
    const out = {};
    for (const k in parts) out[k] = Math.round(parts[k] * 1000) / 1000;
    return out;
  }

  function analyse(md, pages) {
    const counts = collectCounts(String(md || ""), pages);
    if (counts.is_empty) {
      return { counts, scores: { structure: 0.0, cleanliness: 0.0, integrity: 0.0 }, breakdown: {} };
    }

    const [structure, sParts] = structureScore(counts);
    const [cleanliness, cParts] = cleanlinessScore(counts);
    const [integrity, iParts] = integrityScore(counts);

    return {
      counts,
      scores: { structure: pct(structure), cleanliness: pct(cleanliness), integrity: pct(integrity) },
      breakdown: { structure: round3(sParts), cleanliness: round3(cParts), integrity: round3(iParts) },
    };
  }

  return { analyse, collectCounts };
})();
