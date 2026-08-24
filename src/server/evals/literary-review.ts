import { createHash } from "node:crypto";

type Candidate = { output: string | null };

export type LiteraryComparisonReport = {
  createdAt: string;
  promptVersions: string[];
  results: Array<{
    id: string;
    genre: string;
    original: string;
    draft: string;
    reviewNotes?: string;
    candidates: Record<string, Candidate>;
  }>;
};

export type LiteraryReviewChoice = "A" | "B" | "tie" | "both_bad";
export type LiteraryReviewExport = {
  schemaVersion: 1;
  sourceFingerprint: string;
  reviews: Array<{
    id: string;
    choice: LiteraryReviewChoice;
    candidateFlags: { A: string[]; B: string[] };
    notes: string;
  }>;
};

function hash(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

export function comparisonFingerprint(report: LiteraryComparisonReport) {
  return hash(
    JSON.stringify({
      createdAt: report.createdAt,
      promptVersions: report.promptVersions,
      cases: report.results.map((result) => ({
        id: result.id,
        original: result.original,
        draft: result.draft,
        candidates: report.promptVersions.map(
          (version) => result.candidates[version]?.output ?? null,
        ),
      })),
    }),
  );
}

export function candidateOrder(report: LiteraryComparisonReport, caseId: string) {
  if (report.promptVersions.length !== 2) {
    throw new Error("Blind review requires exactly two prompt versions");
  }
  const versions = [...report.promptVersions];
  return Number.parseInt(hash(`${report.createdAt}:${caseId}`).slice(0, 2), 16) % 2
    ? versions.reverse()
    : versions;
}

export function buildBlindReviewData(report: LiteraryComparisonReport) {
  const fingerprint = comparisonFingerprint(report);
  return {
    schemaVersion: 1,
    sourceFingerprint: fingerprint,
    cases: report.results.map((result) => {
      const [versionA, versionB] = candidateOrder(report, result.id);
      return {
        id: result.id,
        genre: result.genre,
        original: result.original,
        draft: result.draft,
        reviewNotes: result.reviewNotes ?? "",
        candidates: {
          A: result.candidates[versionA]?.output ?? "",
          B: result.candidates[versionB]?.output ?? "",
        },
      };
    }),
  };
}

function inlineJson(value: unknown) {
  return JSON.stringify(value).replace(/[<>&]/g, (character) => {
    const escapes: Record<string, string> = { "<": "\\u003c", ">": "\\u003e", "&": "\\u0026" };
    return escapes[character];
  });
}

export function buildLiteraryReviewHtml(report: LiteraryComparisonReport) {
  const data = buildBlindReviewData(report);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" href="data:,">
  <title>Literary A/B Review</title>
  <style>
    :root{color-scheme:dark;--canvas:#0b0e14;--surface:#111722;--raised:#171f2d;--border:#263041;--strong:#46536a;--text:#e7edf5;--muted:#8b98aa;--accent:#59c2ff;--accent-soft:#10283a;--success:#66d9a3;--danger:#ff6b7a;--mono:"SFMono-Regular",Consolas,"Liberation Mono",monospace;font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
    *{box-sizing:border-box}body{margin:0;min-width:320px;min-height:100vh;background:var(--canvas);color:var(--text)}button,textarea{font:inherit}:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
    header{position:sticky;top:0;z-index:2;display:grid;grid-template-columns:1fr auto;gap:16px;align-items:center;padding:14px clamp(16px,4vw,48px);border-bottom:1px solid var(--border);background:rgb(11 14 20/.96)}
    h1{margin:0;font-size:clamp(18px,3vw,24px);letter-spacing:-.02em}.meta{margin-top:4px;color:var(--muted);font:12px/1.4 var(--mono)}.toolbar{display:flex;align-items:center;gap:12px}.progress{min-width:110px;color:var(--muted);font:12px/1.4 var(--mono);text-align:right}
    button{min-height:40px;border:1px solid var(--strong);border-radius:4px;padding:9px 13px;background:var(--raised);color:var(--text);cursor:pointer}button:hover{border-color:var(--accent)}button.primary{border-color:var(--accent);background:var(--accent);color:var(--canvas);font-weight:700}button:disabled{cursor:not-allowed;opacity:.45}
    main{width:min(1440px,100%);margin:0 auto;padding:28px clamp(16px,4vw,48px) 48px}.case-head{display:flex;justify-content:space-between;gap:20px;align-items:end;margin-bottom:20px}.case-id{font:600 12px/1.4 var(--mono);color:var(--accent)}.genre{font:12px/1.4 var(--mono);color:var(--muted)}
    .source-grid{display:grid;grid-template-columns:1fr 1fr;border:1px solid var(--border);border-radius:6px;overflow:hidden;background:var(--surface)}.source-block{padding:18px}.source-block+.source-block{border-left:1px solid var(--border)}.label{margin:0 0 10px;color:var(--muted);font:600 11px/1.4 var(--mono);letter-spacing:.06em;text-transform:uppercase}.prose{max-width:72ch;margin:0;white-space:pre-wrap;font-size:15px;line-height:1.65}
    .candidates{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:16px}.candidate{min-height:180px;padding:20px;border:1px solid var(--border);border-radius:6px;background:var(--surface)}.candidate h2{margin:0 0 14px;font:650 14px/1.3 var(--mono);color:var(--accent)}.candidate-flags{margin:20px 0 0;padding:16px 0 0;border:0;border-top:1px solid var(--border)}.candidate-flags legend{padding:0 8px 0 0}.flags{display:flex;flex-wrap:wrap;gap:8px 16px}.flags label{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12px}.flags input{accent-color:var(--accent)}
    .decision{margin-top:24px;padding:20px 0 0;border:0;border-top:1px solid var(--border)}.decision legend{padding:0 8px 0 0}.choices{display:flex;flex-wrap:wrap;gap:8px}.choice{position:relative}.choice input{position:absolute;opacity:0;pointer-events:none}.choice span{display:inline-flex;align-items:center;min-height:40px;padding:9px 13px;border:1px solid var(--strong);border-radius:4px;background:var(--raised);cursor:pointer}.choice input:checked+span{border-color:var(--accent);background:var(--accent-soft);color:var(--accent)}.choice input:focus-visible+span{outline:2px solid var(--accent);outline-offset:2px}.notes-label{display:block;margin-top:18px}textarea{width:100%;min-height:82px;margin-top:8px;padding:11px 12px;resize:vertical;border:1px solid var(--border);border-radius:4px;background:var(--surface);color:var(--text);line-height:1.5}textarea::placeholder{color:var(--muted)}
    .footer-nav{display:flex;justify-content:space-between;gap:12px;margin-top:20px}.hint{align-self:center;color:var(--muted);font:11px/1.4 var(--mono)}.saved{color:var(--success)}
    @media(max-width:760px){header{position:static;grid-template-columns:1fr}.toolbar{justify-content:space-between}.progress{text-align:left}.source-grid,.candidates{grid-template-columns:1fr}.source-block+.source-block{border-left:0;border-top:1px solid var(--border)}.case-head{display:block}.genre{margin-top:5px}.hint{display:none}}
    @media(prefers-reduced-motion:no-preference){main{animation:enter 180ms ease-out}@keyframes enter{from{opacity:.6}to{opacity:1}}}
  </style>
</head>
<body>
<!-- THESIS: Blind comparison is an editorial instrument, not a model leaderboard.
OWN-WORLD: The Command Workbench palette, crisp rules, compact operational labels, and generous prose measure.
STORY: Read the source and fixed draft, compare anonymous candidates, record a concrete judgment, export.
FIRST VIEWPORT: Persistent progress and export controls above source evidence, paired candidates, and one decision rail.
FORM: A focused split-desk reviewer that keeps model identity out of the visible task. -->
<header><div><h1>Literary A/B Review</h1><div class="meta">Anonymous candidates · progress is saved locally</div></div><div class="toolbar"><div class="progress" id="progress" aria-live="polite"></div><button class="primary" id="export">Export reviews</button></div></header>
<main><div class="case-head"><div><div class="case-id" id="case-id"></div><div class="genre" id="genre"></div></div><div class="hint">1 A · 2 B · 3 tie · 4 both bad · ← → navigate</div></div>
<section class="source-grid" aria-label="Source evidence"><article class="source-block"><h2 class="label">Original</h2><p class="prose" id="original"></p></article><article class="source-block"><h2 class="label">Fixed draft</h2><p class="prose" id="draft"></p></article></section>
<section class="candidates" aria-label="Anonymous candidates"><article class="candidate"><h2>Candidate A</h2><p class="prose" id="candidate-a"></p><fieldset class="candidate-flags" data-flags="A"><legend class="label">Issues in A</legend><div class="flags"><label><input type="checkbox" value="semantic_error">Semantic error</label><label><input type="checkbox" value="calque">Calque</label><label><input type="checkbox" value="unnatural">Unnatural</label><label><input type="checkbox" value="voice_regression">Voice regression</label><label><input type="checkbox" value="over_editing">Over-editing</label></div></fieldset></article><article class="candidate"><h2>Candidate B</h2><p class="prose" id="candidate-b"></p><fieldset class="candidate-flags" data-flags="B"><legend class="label">Issues in B</legend><div class="flags"><label><input type="checkbox" value="semantic_error">Semantic error</label><label><input type="checkbox" value="calque">Calque</label><label><input type="checkbox" value="unnatural">Unnatural</label><label><input type="checkbox" value="voice_regression">Voice regression</label><label><input type="checkbox" value="over_editing">Over-editing</label></div></fieldset></article></section>
<fieldset class="decision"><legend class="label">Decision</legend><div class="choices"><label class="choice"><input type="radio" name="decision" value="A"><span>A is better</span></label><label class="choice"><input type="radio" name="decision" value="B"><span>B is better</span></label><label class="choice"><input type="radio" name="decision" value="tie"><span>Tie</span></label><label class="choice"><input type="radio" name="decision" value="both_bad"><span>Both are bad</span></label></div><label class="label notes-label" for="notes">Evidence for this judgment</label><textarea id="notes" placeholder="Optional details"></textarea></fieldset>
<nav class="footer-nav" aria-label="Cases"><button id="previous">Previous</button><button id="next-unreviewed">Next unreviewed</button><span class="hint" id="save-state" aria-live="polite"></span><button id="next">Next</button></nav></main>
<script>const DATA=${inlineJson(data)};const KEY="literary-review:"+DATA.sourceFingerprint;const empty=()=>({choice:null,candidateFlags:{A:[],B:[]},notes:""});let state={currentCaseId:null,reviews:{}};try{const saved=JSON.parse(localStorage.getItem(KEY)||"null");if(saved?.reviews)state=saved} catch{}let index=Math.max(0,DATA.cases.findIndex(c=>c.id===state.currentCaseId));if(!state.currentCaseId){const unreviewed=DATA.cases.findIndex(c=>!state.reviews[c.id]?.choice);if(unreviewed>=0)index=unreviewed}const byId=id=>document.getElementById(id);const els={progress:byId("progress"),caseId:byId("case-id"),genre:byId("genre"),original:byId("original"),draft:byId("draft"),a:byId("candidate-a"),b:byId("candidate-b"),notes:byId("notes"),previous:byId("previous"),next:byId("next"),nextUnreviewed:byId("next-unreviewed"),save:byId("save-state")};function current(){return DATA.cases[index]}function saveNow(){state.currentCaseId=current().id;localStorage.setItem(KEY,JSON.stringify(state));els.save.textContent="Saved locally";els.save.className="hint saved";renderProgress()}let saveTimer;function scheduleSave(){clearTimeout(saveTimer);saveTimer=setTimeout(saveNow,250)}function review(){return state.reviews[current().id]||(state.reviews[current().id]=empty())}function update(patch){state.reviews[current().id]={...review(),...patch};saveNow();renderControls()}function flushNotes(){review().notes=els.notes.value.trim();saveNow()}function renderProgress(){const done=Object.values(state.reviews).filter(x=>x.choice).length;els.progress.textContent=(index+1)+" / "+DATA.cases.length+" · "+done+" reviewed"}function renderControls(){const r=review();document.querySelectorAll('input[name="decision"]').forEach(input=>input.checked=input.value===r.choice);document.querySelectorAll("[data-flags]").forEach(group=>{const candidate=group.dataset.flags;group.querySelectorAll('input[type="checkbox"]').forEach(input=>input.checked=r.candidateFlags[candidate].includes(input.value))});els.notes.value=r.notes;els.previous.disabled=index===0;els.next.disabled=index===DATA.cases.length-1;els.nextUnreviewed.disabled=!DATA.cases.some((c,i)=>i!==index&&!state.reviews[c.id]?.choice)}function render(){const c=current();state.currentCaseId=c.id;els.caseId.textContent=c.id;els.genre.textContent=c.genre;els.original.textContent=c.original;els.draft.textContent=c.draft;els.a.textContent=c.candidates.A;els.b.textContent=c.candidates.B;renderControls();saveNow();scrollTo({top:0,behavior:"auto"})}document.querySelectorAll('input[name="decision"]').forEach(input=>input.addEventListener("change",()=>update({choice:input.value})));document.querySelectorAll("[data-flags]").forEach(group=>group.addEventListener("change",()=>{const candidate=group.dataset.flags;const flags=[...group.querySelectorAll('input[type="checkbox"]:checked')].map(input=>input.value);update({candidateFlags:{...review().candidateFlags,[candidate]:flags}})}));els.notes.addEventListener("input",()=>{review().notes=els.notes.value;scheduleSave()});function move(nextIndex){flushNotes();index=nextIndex;render()}els.previous.addEventListener("click",()=>{if(index>0)move(index-1)});els.next.addEventListener("click",()=>{if(index<DATA.cases.length-1)move(index+1)});els.nextUnreviewed.addEventListener("click",()=>{const offset=DATA.cases.findIndex((c,i)=>i>index&&!state.reviews[c.id]?.choice);const wrapped=DATA.cases.findIndex((c,i)=>i!==index&&!state.reviews[c.id]?.choice);const target=offset>=0?offset:wrapped;if(target>=0)move(target)});document.addEventListener("keydown",event=>{if(event.metaKey||event.ctrlKey||event.altKey||event.shiftKey||event.target.closest("button,input,textarea,label"))return;const choices={"1":"A","2":"B","3":"tie","4":"both_bad"};if(choices[event.key])update({choice:choices[event.key]});else if(event.key==="ArrowLeft")els.previous.click();else if(event.key==="ArrowRight")els.next.click()});addEventListener("pagehide",flushNotes);byId("export").addEventListener("click",()=>{flushNotes();const payload={schemaVersion:1,sourceFingerprint:DATA.sourceFingerprint,reviews:DATA.cases.flatMap(c=>state.reviews[c.id]?.choice?[{id:c.id,...state.reviews[c.id]}]:[])};const blob=new Blob([JSON.stringify(payload,null,2)+"\\n"],{type:"application/json"});const link=document.createElement("a");link.href=URL.createObjectURL(blob);link.download="literary-review-"+DATA.sourceFingerprint.slice(0,10)+".json";link.click();URL.revokeObjectURL(link.href)});render();</script>
</body></html>`;
}

export function summarizeLiteraryReview(
  report: LiteraryComparisonReport,
  review: LiteraryReviewExport,
) {
  const fingerprint = comparisonFingerprint(report);
  if (review.sourceFingerprint !== fingerprint) {
    throw new Error("Review export does not match the comparison report");
  }
  const wins = Object.fromEntries(report.promptVersions.map((version) => [version, 0]));
  const knownCases = new Set(report.results.map((result) => result.id));
  const reviewedCases = new Set<string>();
  let ties = 0;
  let bothBad = 0;
  for (const item of review.reviews) {
    if (!knownCases.has(item.id)) throw new Error(`Unknown review case: ${item.id}`);
    if (reviewedCases.has(item.id)) throw new Error(`Duplicate review case: ${item.id}`);
    reviewedCases.add(item.id);
    if (item.choice === "tie") ties++;
    else if (item.choice === "both_bad") bothBad++;
    else if (item.choice !== "A" && item.choice !== "B") {
      throw new Error(`Invalid review choice for ${item.id}`);
    } else {
      const order = candidateOrder(report, item.id);
      wins[order[item.choice === "A" ? 0 : 1]]++;
    }
  }
  return { reviewed: review.reviews.length, wins, ties, bothBad };
}
