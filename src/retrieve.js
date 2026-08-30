const READER_DEFAULT = "https://reader.outbid.sh/scrape";

/**
 * Fail-closed reader adapter: refusal, timeout, non-200, or empty body all
 * throw — the caller (handleQuote/handleWitness) turns that into 422. It
 * never returns null/empty, so nothing downstream can sign an observation
 * the reader did not actually return.
 */
export function makeRetrieve({ fetch: doFetch = globalThis.fetch, readerUrl = process.env.READER_URL || READER_DEFAULT, timeoutMs = 20000 } = {}) {
  return async function retrieve(url) {
    if (typeof url !== "string" || !url.startsWith("https://")) throw new Error("retrieve_refused");
    const res = await doFetch(`${readerUrl}?url=${encodeURIComponent(url)}`, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "text/plain" } });
    if (!res.ok) throw new Error(`reader_${res.status}`);
    const text = await res.text();
    if (!text || !text.trim()) throw new Error("reader_empty");
    return text;
  };
}
