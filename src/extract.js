const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function findValue(text, key, type) {
  const k = esc(key);
  // Keep dotted, hyphenated, and Unicode key names from matching a suffix.
  const exactKey = `(?<![\\p{L}\\p{N}.$_-])"?${k}"?(?![\\p{L}\\p{N}.$_-])`;
  // A quoted key followed by a colon is a real field in the document. A bare
  // `key=` is not: it is equally a URL query parameter or prose. Both matchers
  // scan left to right and take the first hit, so on any page whose text
  // mentions the key before the field appears, the loose form wins and the
  // receipt signs the wrong span. That is not hypothetical -- `version` on
  // pypi.org matched `?version=latest` inside a README badge URL and a signed
  // receipt asserted 60 characters of markdown as the package version. Try the
  // strict field form first; fall back to the loose form only for documents
  // (HTML, markdown, plain text) that have no quoted-key syntax to offer.
  const field = `"${k}"\\s*:\\s*`;
  const span = (m, raw) => ({ value: raw, start: m.index + m[0].indexOf(raw), end: m.index + m[0].indexOf(raw) + raw.length });

  if (type === "number") {
    // Anchor on a digit. `[\\d,]+` matches a lone comma, and Number(",".replace(
    // /,/g,"")) is Number("") is 0 -- which Number.isFinite accepts -- so a field
    // holding null next to a comma signed a confident 0. Wrong values are worse
    // than refusals here: the whole product is the receipt being trustworthy.
    // Ending on a digit too: `3893,` in JSON parsed to the right number but the
    // quote bound as evidence carried the delimiter, claiming source bytes for
    // the value that are not part of it.
    const num = `(-?[$€£]?\\d(?:[\\d,]*\\d)?(?:\\.\\d+)?)`;
    // The loose gap must not step over a structural boundary. `[^0-9\\n-]{0,60}`
    // does, so `{"pricing":null,"tax":20}` asked for `pricing` walks the comma
    // into the next field and signs 20. Barring , { } [ ] keeps the fallback
    // inside the one field it named; a document that separates key from number
    // by a boundary is a refusal, which for a paid receipt is the honest answer.
    const m = text.match(new RegExp(`${field}${num}`, "iu"))
           ?? text.match(new RegExp(`${exactKey}[^0-9\\n,{}\\[\\]-]{0,60}${num}`, "iu"));
    if (!m) return null;
    const n = Number(m[1].replace(/[$€£,]/g, ""));
    if (!Number.isFinite(n)) return null;
    const s = span(m, m[1]);
    return { value: n, start: s.start, end: s.end };
  }
  const val = `(?:"([^"\\n]{1,128})"|([^"\\s<]{1,64}))`;
  const m = text.match(new RegExp(`${field}${val}`, "iu"))
         ?? text.match(new RegExp(`${exactKey}\\s*[:=]\\s*${val}`, "iu"));
  if (!m) return null;
  const rawValue = m[1] ?? m[2];
  const s = span(m, rawValue);
  return { value: rawValue.trim(), start: s.start, end: s.end };
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
