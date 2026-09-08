import { canonical } from "./receipt.js";

const escapeHtml = (value) =>
  String(value ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[c]);

const VERDICT_META = {
  supported: { label: "SUPPORTED", color: "var(--green, #74f6ac)", desc: "Claim holds on the observed source text." },
  contradicted: { label: "CONTRADICTED", color: "var(--red, #ff607c)", desc: "Source text does not support the claim." },
  incomplete: { label: "INCOMPLETE", color: "var(--amber, #ffc766)", desc: "Source lacked a requested field needed for verification." },
  mixed: { label: "MIXED", color: "var(--amber, #ffc766)", desc: "Active observations disagree on verdict." },
  unasserted: { label: "OBSERVED", color: "var(--muted, #789184)", desc: "No assertion stated; fact observation only." },
  unknown: { label: "UNKNOWN", color: "var(--red, #ff607c)", desc: "Unrecognized verdict state; claim status unknown." },
};

function getVerdictInfo(verdict) {
  if (verdict === "supported") return VERDICT_META.supported;
  if (verdict === "contradicted") return VERDICT_META.contradicted;
  if (verdict === "incomplete") return VERDICT_META.incomplete;
  if (verdict === "mixed") return VERDICT_META.mixed;
  if (verdict === null || verdict === undefined) return VERDICT_META.unasserted;
  return {
    ...VERDICT_META.unknown,
    desc: `Unrecognized verdict (${escapeHtml(String(verdict))}); claim status unknown.`,
  };
}

/**
 * 1. Signed JSON rendering
 * Returns deterministic JSON string of the signed receipt.
 */
export function renderReceiptJson(receipt, { pretty = true } = {}) {
  if (!receipt || typeof receipt !== "object") throw new Error("invalid_receipt");
  return pretty ? JSON.stringify(receipt, null, 2) : canonical(receipt);
}

/**
 * 2. Human-readable HTML page rendering
 * Self-contained HTML page reflecting the receipt and cryptographic proof.
 */
export function renderReceiptHtml(receipt) {
  if (!receipt || typeof receipt !== "object") throw new Error("invalid_receipt");

  const url = receipt.requested_url || receipt.method?.url || "";
  const verdict = receipt.verdict;
  const verdictInfo = getVerdictInfo(verdict);
  const assertion = receipt.assertion ?? receipt.method?.assertion ?? null;
  const observedAt = receipt.observed_at || receipt.retrieved_at || "";
  const validUntil = receipt.valid_until || "";
  const sourceHash = receipt.source_hash || "";
  const specHash = receipt.spec_hash || "";
  const sig = receipt.receipt || "";
  const agreement = receipt.agreement || "1-of-1";
  const vantage = receipt.vantage || "box";
  const reasonText = receipt.verdict_reason
    ? `(${escapeHtml(receipt.verdict_reason)})`
    : verdictInfo.label === "UNKNOWN"
      ? `(unrecognized: ${escapeHtml(String(verdict))})`
      : "";
  const reason = reasonText ? `<span class="reason">${reasonText}</span>` : "";

  let valuesHtml = "";
  if (receipt.value && typeof receipt.value === "object") {
    const rows = Object.entries(receipt.value).map(([k, v]) => `
      <tr>
        <td class="key"><code>${escapeHtml(k)}</code></td>
        <td class="val"><code>${escapeHtml(JSON.stringify(v))}</code></td>
      </tr>`).join("");
    valuesHtml = `
      <section class="section">
        <h3>Extracted Values</h3>
        <table class="values-table">
          <thead><tr><th>Field</th><th>Value</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </section>`;
  }

  let evidenceHtml = "";
  if (Array.isArray(receipt.evidence)) {
    const items = receipt.evidence.map((e) => `
      <div class="evidence-item">
        <span class="evidence-field"><code>${escapeHtml(e.field)}</code></span>
        ${e.quote ? `<blockquote class="evidence-quote">&ldquo;${escapeHtml(e.quote)}&rdquo;</blockquote>` : ""}
        ${e.location ? `<span class="evidence-loc">offsets [${escapeHtml(e.location.start)}:${escapeHtml(e.location.end)}]</span>` : ""}
      </div>`).join("");
    evidenceHtml = `
      <section class="section">
        <h3>Cited Evidence</h3>
        <div class="evidence-list">${items}</div>
      </section>`;
  } else if (typeof receipt.evidence === "string" && receipt.evidence.length) {
    evidenceHtml = `
      <section class="section">
        <h3>Cited Evidence</h3>
        <blockquote class="evidence-quote">&ldquo;${escapeHtml(receipt.evidence)}&rdquo;</blockquote>
      </section>`;
  }

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Witness Receipt · ${escapeHtml(verdictInfo.label)}</title>
  <style>
    :root {
      color-scheme: dark;
      --ink: #e9f7ef;
      --muted: #789184;
      --void: #030806;
      --surface: #09130f;
      --border: #1b2c24;
      --green: #74f6ac;
      --amber: #ffc766;
      --red: #ff607c;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      background: radial-gradient(circle at 50% -20%, #173629 0, #07110d 38%, var(--void) 75%);
      color: var(--ink);
      font: 14px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace;
    }
    main {
      width: min(840px, 92vw);
      margin: auto;
      padding: 48px 0 72px;
    }
    header {
      border-bottom: 1px solid var(--border);
      padding-bottom: 24px;
      margin-bottom: 32px;
    }
    .eyebrow {
      color: var(--muted);
      font-size: 11px;
      letter-spacing: .18em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    h1 {
      font: clamp(28px, 5vw, 40px)/1.1 Georgia, serif;
      letter-spacing: -.03em;
      margin: 0 0 12px;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 12px;
      border-radius: 4px;
      font-size: 12px;
      font-weight: 600;
      letter-spacing: .08em;
      border: 1px solid ${verdictInfo.color};
      color: ${verdictInfo.color};
      background: rgba(0, 0, 0, 0.4);
    }
    .verdict-desc {
      color: var(--muted);
      font-size: 13px;
      margin: 12px 0 0;
    }
    .section {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 20px 24px;
      margin-bottom: 24px;
    }
    h3 {
      font-size: 12px;
      letter-spacing: .12em;
      text-transform: uppercase;
      color: var(--muted);
      margin: 0 0 16px;
    }
    .meta-grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
      gap: 16px;
    }
    .meta-item { display: flex; flex-direction: column; gap: 4px; }
    .meta-label { font-size: 11px; color: var(--muted); text-transform: uppercase; }
    .meta-value { font-size: 13px; word-break: break-all; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 8px 12px; border-bottom: 1px solid var(--border); }
    th { color: var(--muted); font-size: 11px; text-transform: uppercase; }
    blockquote {
      margin: 0;
      padding: 12px 16px;
      background: rgba(255, 255, 255, 0.03);
      border-left: 3px solid var(--border);
      color: #c4d7cd;
      font-style: italic;
    }
    code { font-family: inherit; color: var(--green); }
    .proof-box { word-break: break-all; font-size: 12px; color: #a4b8ad; }
    .sig { color: var(--muted); font-size: 11px; margin-top: 8px; }
    footer {
      border-top: 1px solid var(--border);
      padding-top: 20px;
      display: flex;
      justify-content: space-between;
      color: var(--muted);
      font-size: 11px;
    }
    a { color: var(--green); text-decoration: none; }
    a:hover { text-decoration: underline; }
  </style>
</head>
<body>
  <main>
    <header>
      <div class="eyebrow">witness / observation receipt</div>
      <h1>${escapeHtml(url)}</h1>
      <div class="badge">
        <span>${escapeHtml(verdictInfo.label)}</span>
        ${reason}
      </div>
      <p class="verdict-desc">${escapeHtml(verdictInfo.desc)}</p>
    </header>

    <section class="section">
      <h3>Observation Details</h3>
      <div class="meta-grid">
        <div class="meta-item">
          <span class="meta-label">Assertion</span>
          <span class="meta-value"><code>${escapeHtml(assertion || "none (unasserted observation)")}</code></span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Observed At</span>
          <span class="meta-value">${escapeHtml(observedAt)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Valid Until</span>
          <span class="meta-value">${escapeHtml(validUntil)}</span>
        </div>
        <div class="meta-item">
          <span class="meta-label">Agreement</span>
          <span class="meta-value">${escapeHtml(agreement)} (${escapeHtml(vantage)})</span>
        </div>
      </div>
    </section>

    ${valuesHtml}
    ${evidenceHtml}

    <section class="section">
      <h3>Cryptographic Attestation</h3>
      <div class="proof-box">
        <div><strong>Source Hash (SHA-256):</strong> <code>${escapeHtml(sourceHash)}</code></div>
        ${specHash ? `<div><strong>Spec Hash:</strong> <code>${escapeHtml(specHash)}</code></div>` : ""}
        <div class="sig"><strong>Ed25519 Signature:</strong> <code>${escapeHtml(sig)}</code></div>
      </div>
    </section>

    <footer>
      <span>Verify offline via <a href="/pubkey">GET /pubkey</a></span>
      <span>Perishable evidence</span>
    </footer>
  </main>
</body>
</html>`;
}

/**
 * 3. MCP tool response rendering
 * Formats the receipt into a model-context-protocol tool result.
 */
export function renderReceiptMcp(receipt) {
  if (!receipt || typeof receipt !== "object") throw new Error("invalid_receipt");

  const url = receipt.requested_url || receipt.method?.url || "unknown";
  const verdict = receipt.verdict;
  const verdictInfo = getVerdictInfo(verdict);
  const assertion = receipt.assertion ?? receipt.method?.assertion ?? null;
  const observedAt = receipt.observed_at || receipt.retrieved_at || "";
  const validUntil = receipt.valid_until || "";
  const sourceHash = receipt.source_hash || "";
  const sig = receipt.receipt || "";

  const verdictDetail = receipt.verdict_reason
    ? ` (${receipt.verdict_reason})`
    : verdictInfo.label === "UNKNOWN"
      ? ` (unrecognized: ${String(verdict)})`
      : "";

  const lines = [
    `# Witness Observation Receipt`,
    `- **Target URL**: ${url}`,
    `- **Verdict**: ${verdictInfo.label}${verdictDetail}`,
    `- **Description**: ${verdictInfo.desc}`,
    `- **Assertion**: ${assertion ? `\`${assertion}\`` : "None (unasserted observation)"}`,
    `- **Observed At**: ${observedAt}`,
    `- **Valid Until**: ${validUntil}`,
    `- **Source Hash**: \`${sourceHash}\``,
  ];

  if (receipt.value && typeof receipt.value === "object" && Object.keys(receipt.value).length) {
    lines.push(``, `## Extracted Values`);
    for (const [k, v] of Object.entries(receipt.value)) {
      lines.push(`- **${k}**: \`${JSON.stringify(v)}\``);
    }
  }

  if (receipt.missing && Array.isArray(receipt.missing) && receipt.missing.length) {
    lines.push(``, `## Missing Fields`);
    for (const m of receipt.missing) {
      lines.push(`- \`${m}\``);
    }
  }

  if (Array.isArray(receipt.evidence) && receipt.evidence.length) {
    lines.push(``, `## Evidence`);
    for (const e of receipt.evidence) {
      lines.push(`- Field \`${e.field}\`: "${e.quote ?? ""}"`);
    }
  } else if (typeof receipt.evidence === "string" && receipt.evidence.length) {
    lines.push(``, `## Evidence`, `> ${receipt.evidence}`);
  }

  lines.push(
    ``,
    `## Signature`,
    `\`${sig}\``,
    `*Verified ed25519 signature over canonical JSON. Perishable after \`${validUntil}\`.*`
  );

  return {
    content: [
      {
        type: "text",
        text: lines.join("\n"),
      },
    ],
    isError: verdictInfo.label === "UNKNOWN",
  };
}

/**
 * Universal dispatcher
 */
export function renderReceipt(receipt, format = "json", options = {}) {
  switch (format) {
    case "json":
      return renderReceiptJson(receipt, options);
    case "html":
      return renderReceiptHtml(receipt);
    case "mcp":
      return renderReceiptMcp(receipt);
    default:
      throw new Error(`unsupported_render_format: ${format}`);
  }
}
