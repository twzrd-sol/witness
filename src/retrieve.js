const READER_DEFAULT = "https://reader.outbid.sh/scrape";

/**
 * The reader answers with a transport envelope -- {"ok":true,"title":...,
 * "content":"<the document, JSON-escaped>"} -- not the document. Extracting from
 * the envelope reads the escaped form, where every field is `\"key\": \"value\"`,
 * and the backslash sits exactly where the string matcher needs `\s*[:=]`. Strings
 * could therefore never match a JSON document; numbers matched only because their
 * gap is `[^0-9\n-]{0,60}`, wide enough to step over `\": ` by accident. Unwrap so
 * both matchers see the document. source_hash consequently covers the document
 * text rather than the envelope -- strictly closer to the origin bytes it names.
 * A body that is not an envelope (HTML, plain text) is returned unchanged.
 */
export function unwrapReader(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch { return text; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return text;
  // The reader reporting its own failure is a retrieval failure, not a document.
  if (parsed.ok === false) throw new Error("reader_not_ok");
  return typeof parsed.content === "string" && parsed.content.trim() ? parsed.content : text;
}

/**
 * Fail-closed reader adapter: refusal, timeout, non-200, or empty body all
 * throw — the caller (handleQuote/handleWitness) turns that into 422. It
 * never returns null/empty, so nothing downstream can sign an observation
 * the reader did not actually return.
 *
 * On a reader 402, and only when payments are enabled
 * (X402_READER_PAYMENTS_ENABLED=1) AND a paying fetch is injected, the
 * request is retried once with the paying fetch ($0.005 x402, Base, to
 * reader.outbid.sh only). A paying retry that fails is still fail-closed.
 */
export function makeRetrieve({ fetch: doFetch = globalThis.fetch, payFetch, paymentsEnabled = process.env.X402_READER_PAYMENTS_ENABLED === "1", readerUrl = process.env.READER_URL || READER_DEFAULT, timeoutMs = 20000 } = {}) {
  const attempt = (f, url) => f(`${readerUrl}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/plain" } });
  return async function retrieve(url) {
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("retrieve_refused");
    let res = await attempt(doFetch, url);
    if (res.status === 402 && paymentsEnabled && payFetch) res = await attempt(payFetch, url);
    if (!res.ok) throw new Error(`reader_${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error("reader_empty");
    const doc = unwrapReader(text);
    if (!doc || !doc.trim()) throw new Error("reader_empty");
    return doc;
  };
}
