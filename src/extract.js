const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findValue(text, key, type) {
  const k = esc(key);
  // Keep dotted, hyphenated, and Unicode key names from matching a suffix.
  const exactKey = `(?<![\\p{L}\\p{N}.$_-])"?${k}"?(?![\\p{L}\\p{N}.$_-])`;
  if (type === "number") {
    const m = text.match(new RegExp(`${exactKey}[^0-9\\n-]{0,60}(-?[$€£]?[\\d,]+(?:\\.\\d+)?)`, "iu"));
    if (!m) return null;
    const n = Number(m[1].replace(/[$€£,]/g, ""));
    return Number.isFinite(n)
      ? { value: n, start: m.index + m[0].indexOf(m[1]), end: m.index + m[0].indexOf(m[1]) + m[1].length }
      : null;
  }
  const m = text.match(new RegExp(`${exactKey}\\s*[:=]\\s*(?:"([^"\\n]{1,128})"|([^"\\s<]{1,64}))`, "iu"));
  if (!m) return null;
  const value = (m[1] ?? m[2]).trim();
  const rawValue = m[1] ?? m[2];
  return { value, start: m.index + m[0].indexOf(rawValue), end: m.index + m[0].indexOf(rawValue) + rawValue.length };
}

export function fillExtract(text, extract) {
  const values = {};
  const missing = [];
  const spans = {};
  for (const [key, type] of Object.entries(extract)) {
    const found = findValue(text, key, type);
    if (found === null) missing.push(key);
    else { values[key] = found.value; spans[key] = { start: found.start, end: found.end }; }
  }
  const result = { values, missing };
  Object.defineProperty(result, "spans", { value: spans, enumerable: false });
  return result;
}

export function evidenceSnippet(text, spans, maxLength = 160) {
  const pieces = Object.values(spans ?? {}).map(({ start, end }) => {
    const from = Math.max(0, start - 48);
    const to = Math.min(text.length, end + 64);
    return text.slice(from, to).replace(/\s+/g, " ").trim();
  });
  return pieces.join(" … ").slice(0, maxLength);
}
