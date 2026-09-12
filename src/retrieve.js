export const READER_ORIGIN = "https://reader.outbid.sh";
export const READER_SCRAPE_PATH = "/scrape";
export const READER_BROWSE_PATH = "/browse";
const READER_DEFAULT = `${READER_ORIGIN}${READER_SCRAPE_PATH}`;

/** `null` means the caller sent a value that is not a retrieval. Omitted is scrape. */
export function normalizeRetrieval(value) {
  if (value == null || value === "") return "scrape";
  if (value === "scrape" || value === "browse") return value;
  return null;
}

export function readerResourceUrl(readerUrl, retrieval = "scrape") {
  const base = new URL(readerUrl);
  base.pathname = retrieval === "browse" ? READER_BROWSE_PATH : READER_SCRAPE_PATH;
  base.search = "";
  base.hash = "";
  return `${base.origin}${base.pathname}`;
}

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
  if (parsed.ok === false) {
    if (parsed.reason === "needs_browser") throw new Error("needs_browser");
    throw new Error("reader_not_ok");
  }
  if (typeof parsed.content === "string" && parsed.content.trim()) return parsed.content;
  // ok:true with blank/missing content is a failed retrieve, not a document whose
  // fields are the transport keys (title, ok, content).
  if (parsed.ok === true) throw new Error("reader_empty");
  return text;
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
  const attempt = (f, url, retrieval) => f(`${readerResourceUrl(readerUrl, retrieval)}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs), redirect: "manual", headers: { accept: "text/plain" } });
  return async function retrieve(url, opts = {}) {
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("retrieve_refused");
    const retrieval = normalizeRetrieval(opts.retrieval) ?? "scrape";
    let res = await attempt(doFetch, url, retrieval);
    if (res.status === 402 && paymentsEnabled && payFetch) res = await attempt(payFetch, url, retrieval);
    const text = await res.text();
    if (!res.ok) {
      if (res.status === 422) {
        try {
          const parsed = JSON.parse(text);
          if (parsed && parsed.reason === "needs_browser") throw new Error("needs_browser");
        } catch (e) {
          if (e && e.message === "needs_browser") throw e;
        }
      }
      throw new Error(`reader_${res.status}`);
    }
    if (!text || !text.trim()) throw new Error("reader_empty");
    const doc = unwrapReader(text);
    if (!doc || !doc.trim()) throw new Error("reader_empty");
    return doc;
  };
}
