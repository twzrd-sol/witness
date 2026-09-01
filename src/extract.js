const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findValue(text, key, type) {
  const k = esc(key);
  if (type === "number") {
    const m = text.match(new RegExp(`${k}[^0-9\\n-]{0,60}(-?[$€£]?[\\d,]+(?:\\.\\d+)?)`, "i"));
    if (!m) return null;
    const n = Number(m[1].replace(/[$€£,]/g, ""));
    return Number.isFinite(n) ? n : null;
  }
  const m = text.match(new RegExp(`"?${k}"?\\s*[:=]\\s*(?:"([^"\\n]{1,128})"|([^"\\s<]{1,64}))`, "i"));
  if (!m) return null;
  return (m[1] ?? m[2]).trim();
}

export function fillExtract(text, extract) {
  const values = {};
  const missing = [];
  for (const [key, type] of Object.entries(extract)) {
    const v = findValue(text, key, type);
    if (v === null) missing.push(key);
    else values[key] = v;
  }
  return { values, missing };
}
