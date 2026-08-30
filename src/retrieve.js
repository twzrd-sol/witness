const READER_DEFAULT = "https://reader.outbid.sh/scrape";

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
    return text;
  };
}
