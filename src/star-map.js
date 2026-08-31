const escape = (value) => String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const LABELS = { steady: "current", double: "replicated", flare: "contradicted", unresolved: "persistent disagreement", dim: "expired" };

export function renderStarMap(cards, now) {
  const articles = (cards ?? []).map((card, i) => `
    <article class="card ${card.state}" style="--delay:${i * 0.3}s">
      <div class="star" aria-hidden="true"><i></i><i></i><i></i></div>
      <div><span class="state">${escape(LABELS[card.state])}</span>
      <h2>${escape(card.question)}</h2>
      <code>${escape(card.spec_hash)}</code>
      <p>${card.active} current · ${card.total} recorded</p></div>
    </article>`).join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>The Observatory · witness</title><style>
:root{color-scheme:dark;--ink:#e9f7ef;--muted:#789184;--void:#030806;--green:#74f6ac;--amber:#ffc766;--red:#ff607c}
*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 50% -20%,#173629 0,#07110d 38%,var(--void) 75%);color:var(--ink);font:15px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
main{width:min(1080px,92vw);margin:auto;padding:72px 0}header{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;border-bottom:1px solid #284036;padding-bottom:28px}
.eyebrow,.state{color:var(--green);font-size:11px;letter-spacing:.18em;text-transform:uppercase}h1{font:clamp(42px,8vw,88px)/.9 Georgia,serif;letter-spacing:-.05em;margin:8px 0 14px}header p{max-width:650px;color:#a4b8ad;margin:0}.clock{text-align:right;color:var(--muted);font-size:12px}
.sky{position:relative;display:grid;grid-template-columns:repeat(2,1fr);gap:1px;margin-top:44px;background:#1b2c24;border:1px solid #1b2c24}.card{min-height:230px;padding:30px;background:linear-gradient(135deg,#09130f,#050b08);display:grid;grid-template-columns:104px 1fr;gap:22px;align-items:center}.card:last-child{grid-column:1/-1}
.star{position:relative;width:94px;height:94px;display:grid;place-items:center}.star i{position:absolute;width:15px;height:15px;border-radius:50%;background:var(--green);box-shadow:0 0 10px var(--green),0 0 32px #53cf8b88}.star i:nth-child(n+2){display:none}
h2{font:24px/1.15 Georgia,serif;margin:8px 0 18px}code{color:#71877b;font-size:11px}.card p{color:var(--muted);margin:8px 0 0;font-size:12px}
.double .star i:first-child{transform:translateX(-12px)}.double .star i:nth-child(2){display:block;transform:translateX(12px)}
.flare .star i:first-child{background:var(--red);box-shadow:0 0 12px var(--red),0 0 48px #ff405f;animation:flare 1.8s ease-in-out infinite}.flare .state,.unresolved .state{color:var(--red)}
.unresolved .star i{display:block;background:var(--amber);box-shadow:0 0 12px var(--amber)}.unresolved .star i:nth-child(1){transform:translate(-16px,-8px)}.unresolved .star i:nth-child(2){transform:translate(16px,-8px)}.unresolved .star i:nth-child(3){transform:translateY(18px);background:var(--red)}
.dim{opacity:.42}.dim .star i{background:#63736a;box-shadow:0 0 8px #63736a}.dim .state{color:#8a9991}
footer{display:flex;justify-content:space-between;gap:20px;color:var(--muted);font-size:11px;padding-top:28px}@keyframes flare{50%{transform:scale(1.8);filter:brightness(1.5)}}
@media(max-width:700px){main{padding:40px 0}header{grid-template-columns:1fr}.clock{text-align:left}.sky{grid-template-columns:1fr}.card,.card:last-child{grid-column:auto;grid-template-columns:70px 1fr;padding:22px}.star{width:64px;height:64px}footer{display:block}}
</style></head><body><main><header><div><div class="eyebrow">witness / observatory</div><h1>The Observatory</h1><p>Independent observations are attributable, perishable, and open to contradiction.</p></div><div class="clock">comparison instant<br>${escape(new Date(now).toISOString())}</div></header>
<section class="sky" aria-label="Observation states">${articles}</section><footer><span>● current &nbsp; ◉ replicated &nbsp; ✦ contradicted</span><span>same method · different vantages</span></footer>
</main></body></html>`;
}
