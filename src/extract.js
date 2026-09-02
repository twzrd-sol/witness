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

/** Bounds on the wire extract. A key names one field, so 128 chars is generous
 *  and 32 keys is a wide page; past either the request is malformed (400), never
 *  a RegExp the engine refuses to compile or an unbounded scan of the source. */
export const MAX_EXTRACT_KEYS = 32;
export const MAX_EXTRACT_KEY_LENGTH = 128;
/** The typenames fillExtract implements — the whole advertised vocabulary. Anything
 *  else is a 400: unchecked, findValue routes it to the string matcher and the receipt
 *  signs a type the method never ran (rank 7 read as "7", then failing "rank < 100"). */
export const EXTRACT_TYPES = ["number", "string"];
/** JSON-Schema numeric spellings, honoured only inside the nested {type} dialect. The
 *  canonical flat map is never rewritten, so its spec_hash stays byte-identical. */
const SCHEMA_TYPE_ALIASES = new Map([["integer", "number"]]);
/** What both published contracts (openapi.json, the bazaar inputSchema) declare for
 *  `extract`, built from the same constants normalizeExtract enforces so the schema a
 *  client validates against and the check the server runs cannot drift apart. */
export const EXTRACT_SCHEMA = {
  type: "object", minProperties: 1, maxProperties: MAX_EXTRACT_KEYS,
  propertyNames: { minLength: 1, maxLength: MAX_EXTRACT_KEY_LENGTH },
  additionalProperties: { anyOf: [
    { type: "string", enum: EXTRACT_TYPES },
    { type: "object", required: ["type"], properties: { type: { type: "string", enum: [...EXTRACT_TYPES, ...SCHEMA_TYPE_ALIASES.keys()] } } },
  ] },
};

/** Collapse the dialects an agent actually writes to the canonical flat map
 *  {key: "typename"} that spec_hash is derived from. Canonical input comes back
 *  deep-equal (same keys, same strings), so its hash is unchanged. Per key:
 *  "number" | {"type": "number"} (JSON Schema; "integer" reads as number there).
 *  Arrays of key names are refused: the typename selects the matcher, so there is
 *  no honest default type. Returns null for any shape that does not name one method. */
export function normalizeExtract(extract) {
  if (!extract || typeof extract !== "object" || Array.isArray(extract)) return null;
  const entries = Object.entries(extract);
  if (!entries.length || entries.length > MAX_EXTRACT_KEYS) return null;
  const out = {};
  for (const [key, spec] of entries) {
    // JSON.parse makes "__proto__" a real own key; assigning it on a plain object
    // hits Object.prototype's setter and the key vanishes. Refuse it outright: the
    // method cannot bind a key that fillExtract's `values[key] =` would drop too.
    if (key === "__proto__" || !key.length || key.length > MAX_EXTRACT_KEY_LENGTH) return null;
    const nested = spec && typeof spec === "object" && !Array.isArray(spec);
    const type = nested ? (SCHEMA_TYPE_ALIASES.get(spec.type) ?? spec.type) : spec;
    if (!EXTRACT_TYPES.includes(type)) return null;
    out[key] = type;
  }
  // Fail closed on the OUTPUT, not the input: a key that did not survive the loop
  // would have silently narrowed the method the receipt then signs.
  if (Object.keys(out).length !== entries.length) return null;
  return out;
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
