// Click checks for the pipeline page: a real (headless) browser taps through Map, Runs and Draft.
// Run with `npm run test:click`. Needs Chromium on the machine (or CHROMIUM=/path/to/it); nothing to install.
// It starts its own XPM on a free port with the example bot plus three small fixtures made on the spot:
// edge-bot (a run that only just started, an unreadable line, a decision that is not a label),
// broken-bot (a map the engine refuses), noname-bot (a project without a name), bare-bot (runs with no steps)
// moved-bot (a copy of the example code the checks may edit, to see the map notice that the code moved),
// calls-bot (code whose trace calls and map disagree), prop-bot (two proposed maps wait, and XPM may write its map)
// and locked-bot (a proposed map waits, and XPM may not write its map).
// SHOTS=/some/folder also saves screenshots there.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { appendFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findBrowser, freePort, open, sleep } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const bin = findBrowser();
if (!bin) { console.error("No Chromium found. Install one or set CHROMIUM=/path/to/chromium."); process.exit(2); }

// ---------- fixtures ----------
const tmp = mkdtempSync(path.join(os.tmpdir(), "xpm-click-data-"));
const example = JSON.parse(readFileSync(path.join(root, "manifests/example-bot.json"), "utf-8"));
const variant = (id, change) => { const m = JSON.parse(JSON.stringify(example)); m.id = id; m.name = id; change(m); mkdirSync(path.join(tmp, "manifests"), { recursive: true }); writeFileSync(path.join(tmp, "manifests", `${id}.json`), JSON.stringify(m)); };
variant("edge-bot", () => {});
variant("broken-bot", (m) => { m.pipelines[0].nodes[1].kind = "wizard"; m.pipelines[0].edges.push({ from: "receive", to: "nowhere" }); });
variant("noname-bot", (m) => { delete m.name; });
variant("bare-bot", () => {});
// Its steps point at a copy of the example code under another repo name, so editing a file here touches nothing in the repo.
variant("moved-bot", (m) => { for (const n of m.pipelines[0].nodes) if (n.anchor) n.anchor.repo = "moved"; });
cpSync(path.join(root, "examples/example-bot"), path.join(tmp, "code"), { recursive: true });
// Its code reports a step the map lacks and stops reporting one the map has, and its profile says where the trace calls are.
variant("calls-bot", (m) => { for (const n of m.pipelines[0].nodes) if (n.anchor) n.anchor.repo = "calls"; });
cpSync(path.join(root, "examples/example-bot"), path.join(tmp, "calls-code"), { recursive: true });
appendFileSync(path.join(tmp, "calls-code/src/door.js"), 'function audit(u, trace) { trace.node(u.runId, "audit-log"); }\n');
writeFileSync(path.join(tmp, "calls-code/src/send.js"), "async function sendReply(chat, text) { return { chat, text }; }\nmodule.exports = { sendReply };\n");
// Proposed maps wait for two projects. One profile lets XPM write the map file, the other says nothing about it.
const xpm = createRequire(import.meta.url)(path.join(root, "lib/pipeline"));
const propRepos = { prop: path.join(tmp, "prop-code") };
cpSync(path.join(root, "examples/example-bot"), propRepos.prop, { recursive: true });
appendFileSync(path.join(propRepos.prop, "src/door.js"), "function auditLog(u) { return u; }\n");
const propose = (id, jobId, agoMs, change, extra) => {
  variant(id, (m) => { for (const n of m.pipelines[0].nodes) if (n.anchor) n.anchor.repo = "prop"; });
  const current = JSON.parse(readFileSync(path.join(tmp, "manifests", `${id}.json`), "utf-8")).pipelines[0];
  const next = JSON.parse(JSON.stringify(current));
  change(next);
  const dir = path.join(tmp, "state/proposals", id, "inbound");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, `${jobId}.json`), JSON.stringify(xpm.makeProposal(current, next, propRepos, { jobId, now: new Date(Date.now() - agoMs), ...extra })));
};
const withAudit = (pl) => {
  pl.nodes.push({ id: "audit", name: "Write the audit line", description: "Notes that a reply went out.", kind: "hook", lane: "after", owner: "example", anchor: { repo: "prop", path: "src/door.js", symbol: "auditLog" } });
  pl.edges.push({ from: "reply", to: "audit" });
  pl.nodes.find((n) => n.id === "agent").description = "The main agent reads the message, looks things up and writes the reply.";
};
const words = { model: "hand-made", changes: [{ node: "audit", reason: "The door file now has a function that notes each reply.", evidence: [{ file: "src/door.js", lines: "10" }] }, { node: "agent", reason: "The agent also looks things up now." }], unsure: ["Whether the audit line is written before or after the reply is sent."] };
propose("prop-bot", "job-new", 60000, withAudit, words);
propose("prop-bot", "job-old", 3600000, (pl) => { pl.nodes.find((n) => n.id === "reply").name = "Send the answer"; });
propose("locked-bot", "job-locked", 60000, withAudit, words);
writeFileSync(path.join(tmp, "state/proposals/prop-bot/inbound/job-torn.json"), "{ not a proposal");
writeFileSync(path.join(tmp, "profiles.json"), JSON.stringify({ "calls-bot": { truth: { repo: "calls" }, traces: { calls: [{ path: "src" }] } }, "prop-bot": { truth: { repo: "prop" }, map: { writable: true } }, "locked-bot": { truth: { repo: "prop" } } }));
writeFileSync(path.join(tmp, "repos.json"), JSON.stringify({ moved: path.join(tmp, "code"), calls: path.join(tmp, "calls-code"), ...propRepos }));
const at = (agoMs) => new Date(Date.now() - agoMs).toISOString();
const line = (runId, agoMs, seq, type, node, metadata = {}) => JSON.stringify({ runId, ts: at(agoMs), seq, pipeline: "inbound", type, ...(node ? { node } : {}), metadata });
mkdirSync(path.join(tmp, "events/edge-bot"), { recursive: true });
writeFileSync(path.join(tmp, "events/edge-bot", `${at(20000).slice(0, 10)}.jsonl`), [
  line("done000000000001", 20000, 1, "run.started"),
  line("done000000000001", 19990, 2, "node.completed", "receive", { durationMs: 5 }),
  line("done000000000001", 19980, 3, "decision", "dedupe", { decision: { duplicate: "a-word-the-map-does-not-name" }, durationMs: 2 }),
  line("done000000000001", 19970, 4, "run.completed"),
  "this line is not JSON",
  line("fresh00000000002", 5000, 1, "run.started"),
].join("\n") + "\n");

// A product that reports only that a message came and went: two runs, no step in either.
mkdirSync(path.join(tmp, "events/bare-bot"), { recursive: true });
writeFileSync(path.join(tmp, "events/bare-bot", `${at(20000).slice(0, 10)}.jsonl`), [
  line("bare000000000001", 20000, 1, "run.started"), line("bare000000000001", 19600, 2, "run.completed"),
  line("bare000000000002", 9000, 1, "run.started"), line("bare000000000002", 8500, 2, "run.completed"),
].join("\n") + "\n");

// ---------- the app and the browser ----------
const port = await freePort();
const server = spawn(process.execPath, ["server.js"], { cwd: root, stdio: "ignore", env: { ...process.env, PORT: String(port), HOST: "127.0.0.1", MANIFESTS_DIR: [path.join(root, "manifests"), path.join(tmp, "manifests")].join(path.delimiter), XPM_EVENTS_DIR: path.join(tmp, "events"), XPM_DRAFTS_DIR: path.join(tmp, "drafts"), XPM_STATE_DIR: path.join(tmp, "state"), XPM_REPOS: path.join(tmp, "repos.json"), XPM_PROJECTS: path.join(tmp, "profiles.json"), XPM_ALLOWED_LOGINS: "", XPM_ALLOWED_NODES: "", XPM_DENIED_NODES: "", XPM_ALLOWED_HOSTS: "" } });
const base = `http://127.0.0.1:${port}`;
for (let i = 0; i < 40; i++) { try { if ((await fetch(`${base}/api/projects`)).ok) break; } catch { await sleep(150); } }
const b = await open(bin);

const out = [];
const check = (name, ok) => out.push(`${ok ? "PASS" : "FAIL"} ${name}`);
const page = (project, view, extra = "") => `${base}/pipeline.html?project=${project}&pipeline=inbound&view=${view}${extra}`;
const q = (sel) => `document.querySelector(${JSON.stringify(sel)})`;
const count = (sel) => b.ev(`document.querySelectorAll(${JSON.stringify(sel)}).length`);
const shot = async (name) => { if (process.env.SHOTS) { mkdirSync(process.env.SHOTS, { recursive: true }); await b.shot(path.join(process.env.SHOTS, `${name}.png`)); } };
const stepText = () => b.text(".scrub .row span");

try {
  // ---------- Map ----------
  await b.go(page("example-bot", "map"));
  check("map shows 9 steps", (await count(".node")) === 9);
  check("anchor check ok", (await b.text(".status")).includes("9 of 9 anchors ok"));
  check("a short map keeps its lanes side by side", (await b.ev(`new Set([...document.querySelectorAll(".band")].map((x) => x.style.top)).size`)) === 1);
  await b.click(q('.node[data-arg="agent"]'));
  check("a step opens its detail panel", (await b.text(".side")).includes("src/agent.js"));
  check("the panel shows the function", (await b.text(".side")).includes("runAgent"));
  await b.click(q('[data-act="close-panel"]'));
  check("the panel closes", (await count(".side")) === 0);
  await b.click(q('[data-act="menu"][data-arg="project"]'));
  check("the project menu opens", (await count('.menu [data-act="set-project"]')) > 0);
  check("a project with no name is listed and sorted without an error", (await b.text(".menu")).includes("noname-bot"));
  await b.click("document.body");
  check("the menu closes on an outside tap", (await count(".menu")) === 0);
  await shot("map-1440");

  // ---------- colour says what a step is for ----------
  const fam = (id) => b.ev(`[...document.querySelector('.node[data-arg="${id}"]').classList].find((c) => c.startsWith("f-"))`);
  check("every step card carries its family colour", (await count('.node[class*=" f-"]')) === 9);
  check("a door is in / out, a gate a decision, a model AI, a tool an action, a queue storage", JSON.stringify([await fam("receive"), await fam("dedupe"), await fam("agent"), await fam("command-reply"), await fam("planner-hold")]) === '["f-io","f-decide","f-ai","f-act","f-keep"]');
  check("the stripe and the kind word take the colour, and five families give five colours", (await b.ev(`new Set(["receive", "dedupe", "agent", "command-reply", "planner-hold"].map((id) => { const n = document.querySelector('.node[data-arg="' + id + '"]'); const c = getComputedStyle(n, "::before").backgroundColor; return c === getComputedStyle(n.querySelector(".k")).color ? c : "differs"; })).size`)) === 5);
  check("the key names the five families on this map", (await count('.key [data-act="kind"]')) === 5 && (await b.text(".key")).replace(/\s+/g, " ").includes("In / out Decision AI Action Storage"));
  await b.click(q('[data-act="kind"][data-arg="ai"]'));
  check("tapping AI in the key fades the other seven steps", (await count(".node.faded")) === 7 && (await count('.node.f-ai:not(.faded)')) === 2 && (await b.ev(`${q('[data-act="kind"][data-arg="ai"]')}.getAttribute("aria-pressed")`)) === "true");
  await shot("map-one-family");
  await b.click(q('[data-act="kind"][data-arg="ai"]'));
  check("tapping it again brings every step back", (await count(".node.faded")) === 0);
  check("every line ends in an arrowhead that is defined", await b.ev(`(() => { const svg = document.querySelector(".stage svg"); const lines = [...svg.querySelectorAll(":scope > path")]; return lines.length >= 9 && lines.every((l) => { const m = /#([^)"]+)/.exec(l.getAttribute("marker-end") || ""); return m && svg.querySelector("marker#" + m[1]); }); })()`));
  check("a line out of a decision reads only the answer, the full rule is in its title", await b.ev(`[...document.querySelectorAll(".chip")].some((c) => c.innerText.trim() === "no" && c.title === "duplicate = no")`));
  check("the first step says start and a step nothing follows says end", (await b.text('.node[data-arg="receive"] .flag')).trim() === "start" && (await b.text('.node[data-arg="reply"] .flag')).trim() === "end");
  check("the lanes are numbered in reading order", (await b.ev(`[...document.querySelectorAll(".band-h .no")].map((x) => x.innerText).join("")`)) === "123");
  // ---------- a tapped step shows its own lines ----------
  const lit = () => b.ev(`[...document.querySelectorAll(".stage svg > path")].filter((l) => l.getAttribute("stroke") === "#e7e7e9").length`);
  check("with no step picked no line is lit and no card steps back", (await lit()) === 0 && (await count(".node.far")) === 0);
  await b.click(q('.node[data-arg="fast-path"]'));
  check("tapping a step lights its three lines and their labels", (await lit()) === 3 && (await count(".chip.on")) === 3 && (await count(".chip.faded")) === 3);
  check("the steps it does not touch step back", (await count(".node.far")) === 5 && (await b.ev(`["fast-path", "mode-gate", "command-reply", "agent"].every((id) => !document.querySelector('.node[data-arg="' + id + '"]').classList.contains("far"))`)));
  check("the lit lines are drawn on top of the others", await b.ev(`(() => { const l = [...document.querySelectorAll(".stage svg > path[marker-end]")].map((x) => x.getAttribute("stroke") === "#e7e7e9"); return l.includes(true) && l.lastIndexOf(false) < l.indexOf(true); })()`));
  check("the panel says what the step does", (await b.text(".side .about")).length > 10);
  check("the panel lists where it comes from and where it goes", (await b.text(".side")).replace(/\s+/g, " ").toLowerCase().includes("comes from") && (await count(".side .hops")) === 2 && (await count('.side .hop[data-act="goto"]')) === 3);
  check("a way out of a decision carries its answer", await b.ev(`[...document.querySelectorAll(".side .hop")].some((h) => h.dataset.arg === "command-reply" && h.querySelector(".chip-in")?.innerText.trim() === "yes") && [...document.querySelectorAll(".side .hop")].some((h) => h.dataset.arg === "agent" && h.querySelector(".chip-in")?.innerText.trim() === "else")`));
  check("every link in the panel is at least 42 px tall", await b.ev(`[...document.querySelectorAll(".side .hop")].every((h) => h.getBoundingClientRect().height >= 42)`));
  await shot("map-step-picked");
  await b.click(q('.side .hop[data-arg="agent"]'));
  check("tapping a link moves the panel and the light to that step", (await b.text(".side")).includes("src/agent.js") && (await lit()) === 2 && !(await b.ev(`${q('.node[data-arg="agent"]')}.classList.contains("far")`)));
  await b.click(q('.side .hop[data-arg="reply"]'));
  check("the last step says the path ends there", (await b.text(".side")).includes("The path ends here.") && (await count(".side .hops")) === 1);
  await b.click(q('[data-act="close-panel"]'));
  check("closing the panel brings every line and card back", (await lit()) === 0 && (await count(".node.far")) === 0 && (await count(".chip.faded")) === 0);
  check("each lane says in one line what happens there", (await b.ev(`[...document.querySelectorAll(".band-h")].map((x) => x.innerText).join(" | ")`)).replace(/\s+/g, " ").includes("Takes the update, drops repeats."));
  await b.go(page("noname-bot", "map"));
  check('a project with no run on record does not say "0 hits"', (await count(".node")) === 9 && !(await b.text(".stage")).includes("hits"));
  await b.go(page("example-bot", "map"));

  // ---------- Runs ----------
  await b.click(q('[data-act="view"][data-arg="runs"][data-filter="ghost"]'), 300);
  check("the ghost strip goes to Runs with the Ghost filter", (await b.text('[data-act="filter"][aria-pressed="true"]')).startsWith("Ghost"));
  check("the url carries the view", (await b.ev("location.search")).includes("view=runs"));
  await b.click(q('[data-act="filter"][data-arg="failed"]'));
  check("the failed filter shows a failed run", (await count(".run")) >= 1 && (await b.text(".strip")).includes("failed at step"));
  await b.click(q('[data-act="filter"][data-arg="all"]'));
  await b.click('document.querySelectorAll(".run")[2]');
  check("picking a run puts it in the url", (await b.ev("location.search")).includes("run="));
  const before = await stepText();
  await b.click(q('[aria-label="Previous step"]'));
  check("previous step moves the scrubber", before !== (await stepText()));
  await b.click(q('.step[data-arg="0"]'));
  check("a step button jumps to step 1", (await stepText()).startsWith("Step 1 of"));
  await b.click(q('.node.path[data-act="step"]'));
  check("tapping a step on the path selects it", (await stepText()).startsWith("Step 1 of"));
  await shot("runs-1440");

  // ---------- Draft ----------
  await b.go(page("example-bot", "runs", "&run=6dcf6b12"));
  check("a link to a run picks that run", (await b.text(".strip")).includes("6dcf6b12"));
  check("the ghost step is drawn", (await count(".node.ghost")) === 1);
  await b.click(q('[data-act="ghost-draft"]'), 1200);
  check("a ghost step becomes a draft", (await b.text(".strip")).includes("add-history-log"));
  check("the ghost draft is replayed", (await b.text(".result")).includes("runs change route"));
  check("an unsaved draft says Discard", (await b.text(".strip")).includes("Discard draft"));
  await b.click(q('[data-act="discard"]'), 300);
  check("discard leaves the draft list", (await b.text("main")).includes("Open a draft"));
  await b.click(q('[data-act="open-draft"]'), 1200);
  check("a saved draft opens and replays", (await b.text(".result .verdict")).includes("runs change route"));
  await shot("draft-1440");
  const see = await b.text('[data-act="see-changed"]');
  await b.click(q('[data-act="see-changed"]'), 300);
  const seg = await b.text('[data-act="filter"][aria-pressed="true"]');
  check(`"${see}" opens Runs on "${seg}"`, seg.startsWith("Changed") && see.includes(seg.replace("Changed ", "")));
  await b.click(q('[data-act="rail"][data-arg="0"]'));
  check("the rail closes and a Show runs button appears", (await count("aside")) === 0 && (await count('[data-act="rail"][data-arg="1"]')) === 1);
  const pct = parseInt(await b.text(".pct"), 10);
  await b.click(q('[data-act="zoom"][data-arg="1"]'));
  check("zoom in raises the percent", parseInt(await b.text(".pct"), 10) > pct);
  const small = await b.ev(`[...document.querySelectorAll("button")].filter((x) => x.offsetParent && !x.classList.contains("node") && x.getBoundingClientRect().height < 42).map((x) => (x.getAttribute("aria-label") || x.innerText).slice(0, 30))`);
  check(`every control is at least 42 px tall ${JSON.stringify(small)}`, small.length === 0);
  check("no touchmove handler in the page code (it would cancel Pencil taps)", !(await b.ev(`Promise.all(["/pipeline.js", "/pipeline-layout.js"].map((f) => fetch(f).then((r) => r.text()))).then((t) => t.some((x) => /addEventListener\\(\\s*["']touchmove/.test(x) || /ontouchmove/.test(x)))`)));

  // ---------- one draft link, one replay ----------
  await b.go(page("example-bot", "map"));
  await b.ev(`(() => { window.__posts = 0; const f = window.fetch; window.fetch = (u, o) => { if (o && o.method === "POST") window.__posts += 1; return f(u, o); }; })()`);
  await b.click(q('[data-act="view"][data-arg="draft"]'), 1200);
  check("opening the only draft replays it once", (await b.ev("window.__posts")) === 1);
  await b.click(q('[data-act="discard"]'), 300);
  await b.click(q('[data-act="menu"][data-arg="pipeline"]'));
  await b.click(q('[data-act="set-pipeline"]'), 1200);
  check("after a pipeline switch the only draft opens by itself again", (await b.text(".strip")).includes("Close draft"));

  // ---------- two fast picks: the later one wins ----------
  await b.go(page("example-bot", "map"));
  await b.ev(`(loadProject("edge-bot"), loadProject("broken-bot"), loadProject("example-bot"), 1)`);
  await sleep(1200);
  check("after three fast project picks the last one is on screen", (await b.text(".pick-btn")).includes("example-bot") && (await b.ev("S.data.pipeline.nodes.length")) === 9 && (await b.text(".status")).includes("9 of 9"));

  // ---------- a narrower window wraps the lanes into rows ----------
  await b.size(820, 900);
  await b.go(page("example-bot", "map"));
  await b.click(q('[data-act="lens"][data-arg="all"]'), 300);
  const tops = await b.ev(`new Set([...document.querySelectorAll(".band")].map((x) => x.style.top)).size`);
  check(`on a narrow window the lanes stack as rows (${tops} rows)`, tops > 1 && (await count(".node")) === 9);
  const inside = await b.ev(`(() => { const s = document.querySelector(".stage").getBoundingClientRect(); return [...document.querySelectorAll(".node")].every((n) => { const r = n.getBoundingClientRect(); return r.left >= s.left && r.right <= s.right + 1 && r.top >= s.top && r.bottom <= s.bottom + 1; }); })()`);
  check("every card sits inside the drawn stage", inside);
  await shot("map-wrapped-820");

  // ---------- phone ----------
  await b.size(390, 844);
  await b.go(page("example-bot", "map"));
  check("phone: one picker for project and pipeline", (await count(".pick-btn")) === 1 && (await b.text(".pick-btn")).includes("example-bot · inbound"));
  check("phone: the anchor count is in the footer, not the top bar", !(await b.text("header")).includes("anchors") && (await b.text("footer")).includes("9 of 9 anchors ok"));
  check("phone: a folded lane card shows the colours of the steps inside", (await count(".node .mix")) >= 2 && (await count('.node .mix i[class^="f-"]')) >= 3);
  check("phone: the whole colour key fits the screen", await b.ev(`(() => { const k = document.querySelector(".key"); return k.scrollWidth <= k.clientWidth && k.getBoundingClientRect().right <= innerWidth; })()`));
  check("a folded lane card shows a chevron and the word", (await count(".node .flag svg")) >= 1 && (await b.text(".node .flag")).includes("open"));
  check("a folded lane card says what happens there and how many steps it holds", (await b.text('.node.lane[data-arg="door"] .what')).includes("Takes the update") && (await b.text('.node.lane[data-arg="door"] .k')).replace(/\s+/g, " ").includes("3 steps"));
  check("a failing lane keeps its top row on one line and counts the failures below", (await b.text('.node.lane[data-arg="brain"] .st')).includes("1 failed") && !(await b.text('.node.lane[data-arg="brain"] .k')).includes("failed") && (await b.ev(`${q('.node.lane[data-arg="brain"] .k')}.getBoundingClientRect().height`)) < 22);
  await b.click(q('.node[data-arg="reply"]'), 300);
  await b.click(q('.side .hop[data-arg="agent"]'), 300);
  check("a link to a step in a folded lane opens that lane", (await count('.node[data-arg="agent"]')) === 1 && (await b.text(".side")).includes("src/agent.js"));
  await b.click(q('[data-act="close-panel"]'), 300);
  await b.go(page("example-bot", "map"));
  await b.click(q('[data-act="open-lane"]'), 300);
  check("an open lane has a fold control", (await count('.band-h.fold[aria-expanded="true"] .cue svg')) >= 1);
  await b.click(q('[data-act="menu"]'));
  check("phone: the one menu lists pipelines and projects", (await count('.menu [data-act="set-pipeline"]')) >= 1 && (await count('.menu [data-act="set-project"]')) >= 2);
  await shot("map-390");
  await b.click(q('.menu [data-act="set-project"][data-arg="edge-bot"]'), 1200);
  check("phone: picking a project from the one menu loads it", (await b.text(".pick-btn")).includes("edge-bot · inbound"));
  await b.size(1440, 900);

  // ---------- a run that only just started ----------
  await b.go(page("edge-bot", "runs"));
  check("a run with no step yet says so", (await b.text(".run")).includes("not at a step yet") && (await b.text(".strip")).includes("not at a step yet"));
  check("a run with no step yet has no scrubber", (await count(".scrub")) === 0);
  check('nothing on the page reads "undefined" or "NaN"', !/undefined|NaN/.test(await b.text("#app")));
  await shot("run-just-started");
  await b.click(q('[data-act="filter"][data-arg="failed"]'));
  check("an empty filter lights no run on the canvas", (await b.text(".strip")).includes("No runs match this filter") && (await count(".run")) === 0 && (await count(".node.path")) === 0 && (await count(".node")) === 9);
  await b.click(q('.strip [data-act="filter"][data-arg="all"]'));
  check("Show all brings the runs back", (await count(".run")) === 2);
  await b.click(q('[data-act="view"][data-arg="map"]'), 300);
  check("the map says when events were skipped or cleaned", /1 event line was unreadable/.test(await b.text("main")) && /1 decision value was not a known label/.test(await b.text("main")));
  check("the cleaned decision word is not on the page", !(await b.ev(`document.documentElement.innerHTML.includes("a-word-the-map-does-not-name")`)));

  // ---------- runs that carry no steps ----------
  await b.go(page("bare-bot", "map"));
  check("runs with no steps do not turn the map cold or print 0 hits", (await count(".node")) === 9 && (await count(".node.cold")) === 0 && !(await b.text(".stage")).includes("hits"));
  check("the map says once that the runs recorded no steps", (await b.text("main")).includes("All 2 runs on record recorded only a start and an end"));
  await b.click(q('[data-act="view"][data-arg="runs"]'), 300);
  check("a finished run with no steps says there is no path to light", (await b.text(".strip")).includes("no steps recorded") && (await b.text(".strip")).includes("no path to light") && (await count(".scrub")) === 0 && (await count(".node.path")) === 0);
  await b.go(page("edge-bot", "map"));
  check("a mix of runs counts only the ones with steps", (await b.text("main")).includes("1 of the last 2 runs recorded only a start and an end") && (await b.text('.node[data-arg="receive"]')).includes("1 hit ·"));

  // ---------- a map the engine refuses ----------
  await b.go(page("broken-bot", "map"));
  check("a broken map shows its problems instead of a canvas", (await b.text("main")).includes("cannot be drawn") && (await b.text(".errs")).includes("unknown kind wizard") && (await count(".node")) === 0);
  await b.click(q('[data-act="view"][data-arg="runs"]'), 300);
  check("a broken map stays an error list on Runs too", (await b.text("main")).includes("cannot be drawn"));
  await shot("broken-map");

  // ---------- the code moved on, and notes on steps ----------
  const type = (text) => b.ev(`(() => { const t = document.querySelector("#note-text"); if (!t) return "MISSING"; t.focus(); t.value = ${JSON.stringify(text)}; t.setSelectionRange(3, 3); t.dispatchEvent(new Event("input", { bubbles: true })); return "ok"; })()`);
  const typed = () => b.ev(`document.querySelector("#note-text")?.value`);
  const saveOff = () => b.ev(`document.querySelector('[data-act="save-note"]').disabled`);
  const stampFile = path.join(tmp, "state/stamps/moved-bot/inbound.json");
  await b.go(page("moved-bot", "map"));
  check("a map nobody checked says so, and flags nothing", (await b.text(".since-strip")).includes("Nobody has marked this map as checked") && (await count(".node.since")) === 0 && !(await b.text(".status")).includes("since"));
  await b.click(q('[data-act="ask-stamp"]'));
  check("Mark as checked asks first and writes nothing yet", (await b.text(".since-strip")).includes("Yes, it matches") && !existsSync(stampFile));
  await b.click(q('[data-act="cancel"]'));
  check("Cancel takes the question back", (await count('[data-act="stamp"]')) === 0 && (await count('[data-act="ask-stamp"]')) === 1);
  await b.click(q('[data-act="ask-stamp"]'));
  await b.click(q('[data-act="zoom"][data-arg="1"]'));
  check("any other tap takes the question back too", (await count('[data-act="stamp"]')) === 0 && !existsSync(stampFile));
  await b.click(q('[data-act="ask-stamp"]'));
  await b.click(q('[data-act="stamp"]'), 500);
  check("a checked map says since when the code is unchanged", (await count(".since-strip")) === 0 && (await b.text(".status")).includes("9 of 9 anchors ok · code unchanged since") && existsSync(stampFile));

  appendFileSync(path.join(tmp, "code/src/agent.js"), "// edited after the check\n");
  writeFileSync(path.join(tmp, "code/VERSION"), "1.5.0\n");
  await b.go(page("moved-bot", "map"));
  const strip = await b.text(".since-strip");
  check("the map says the code moved, since which version, and how much", strip.includes("Code moved:") && strip.includes("against version 1.4.0") && strip.includes("The code is now 1.5.0.") && strip.includes("2 steps sit in 1 file that changed since."));
  check("the status counts the steps behind the code", (await b.text(".status")).replace(/\s+/g, " ").includes("9 of 9 anchors ok · 2 steps behind the code"));
  check("exactly the steps in the changed file are tagged", (await b.ev(`[...document.querySelectorAll(".node.since")].map((n) => n.dataset.arg + ":" + n.querySelector(".tag-since").innerText).sort().join()`)) === "agent:code changed,private-model:code changed");
  check("the tag is in the step's spoken label", (await b.ev(`${q('.node[data-arg="agent"]')}.getAttribute("aria-label")`)).includes("its code changed since the map was checked"));
  await b.click(q('[data-act="lens"][data-arg="overview"]'), 300);
  check("a folded lane counts its changed steps", (await b.ev(`[...document.querySelectorAll(".node .tag-since")].map((t) => t.innerText).join()`)) === "2 changed" && (await b.ev(`document.querySelector(".node.since").getAttribute("aria-label")`)).includes("the code of 2 steps changed"));
  await b.click(q('[data-act="lens"][data-arg="all"]'), 300);
  await shot("code-moved");

  await b.click(q('[data-act="side"][data-arg="since"]'));
  check("See what changed lists the file and the steps in it", (await b.text(".side")).includes("moved:src/agent.js") && (await b.text(".side")).includes("Private model") && (await b.text(".side")).includes("Agent") && (await b.text(".side-foot")).includes("does not say which step"));
  check("the list holds no folder path of this machine", !(await b.text(".side")).includes(tmp));
  check("every step in the list is at least 42 px tall", await b.ev(`[...document.querySelectorAll(".side .hop")].length === 2 && [...document.querySelectorAll(".side .hop")].every((h) => h.getBoundingClientRect().height >= 42)`));
  await shot("code-moved-list");
  await b.click(q('.side .hop[data-arg="agent"]'));
  check("a step in the list opens that step, which says its file changed", (await b.text(".side-h")).includes("Agent") && (await b.text(".detail")).includes("its file changed since the check"));
  await b.click(q('.node[data-arg="receive"]'));
  check("an untouched step says it is the same since the check", (await b.text(".detail")).includes("same since the check"));

  // one note on one step
  check("an empty note cannot be saved", (await saveOff()) === true && (await b.text(".notes")).includes("No notes on this step yet"));
  await type("Why does this step run before the gate?\nSecond line.");
  check("typing wakes the Save button without a redraw", (await saveOff()) === false);
  await b.ev(`loadPipeline({ quiet: true })`);
  await sleep(400);
  check("a refresh while typing keeps the text, the focus and the caret", (await typed()).startsWith("Why does this step") && (await b.ev(`document.activeElement.id + ":" + document.activeElement.selectionStart`)) === "note-text:3");
  // a save that fails: the reason stays on screen, the text stays in the box
  await b.ev(`(window.realFetch = window.fetch, window.fetch = (u, o) => (o && o.method === "POST" ? Promise.resolve(new Response(JSON.stringify({ error: "the disk is full" }), { status: 500 })) : window.realFetch(u, o)))`);
  await b.click(q('[data-act="save-note"]'), 300);
  check("a note that could not be saved says why and keeps the text", (await b.text('.note-box [role="alert"]')).includes("Not saved: the disk is full") && (await typed()).startsWith("Why does this step") && (await count(".note")) === 0 && (await saveOff()) === false);
  // a slow save: the button waits, a second tap writes nothing twice
  await b.ev(`window.fetch = (u, o) => new Promise((r) => setTimeout(r, 500)).then(() => window.realFetch(u, o))`);
  await b.click(q('[data-act="save-note"]'), 100);
  check("a save in flight shows it and cannot be tapped again", (await b.text('[data-act="save-note"]')).includes("Saving") && (await saveOff()) === true && (await count('.note-box [role="alert"]')) === 0);
  await b.click(q('[data-act="save-note"]'), 900);
  await b.ev(`window.fetch = window.realFetch`);
  check("the note shows once the server has it, and the box empties", (await count(".side .note")) === 1 && (await b.text(".side .note")).includes("Second line.") && (await typed()) === "" && (await saveOff()) === true);
  check("a note keeps its line breaks", (await b.ev(`getComputedStyle(document.querySelector(".note p")).whiteSpace`)) === "pre-wrap");
  check("the step carries a note count", (await b.text('.node[data-arg="receive"] .nb')).trim() === "1" && (await b.ev(`${q('.node[data-arg="receive"]')}.getAttribute("aria-label")`)).includes("1 note"));
  check("the note box does not make a phone zoom", (await b.ev(`parseFloat(getComputedStyle(document.querySelector("#note-text")).fontSize)`)) >= 16);
  await shot("note-on-a-step");

  // one note on several steps
  await type("Text typed before picking more steps.");
  await b.click(q('[data-act="multi"]'));
  check("Select more steps starts from the open step and keeps what was typed", (await b.text(".side-h")).includes("1 step selected") && (await typed()) === "Text typed before picking more steps." && (await count(".node.sel")) === 1);
  await b.click(q('.node[data-arg="dedupe"]'));
  await b.click(q('.node[data-arg="reply"]'));
  check("tapping steps adds them to the selection", (await b.text(".side-h")).includes("3 steps selected") && (await count('.node.sel[aria-pressed="true"]')) === 3 && (await count(".node.far")) === 0);
  await b.click(q('.node[data-arg="dedupe"]'));
  check("tapping a picked step drops it", (await b.text(".side-h")).includes("2 steps selected") && (await count(".node.sel")) === 2);
  await b.click(q('.side [data-act="unsel"][data-arg="reply"]'));
  await b.click(q('.node[data-arg="reply"]'));
  check("the list in the panel drops a step as well", (await b.ev(`[...document.querySelectorAll(".node.sel")].map((n) => n.dataset.arg).sort().join()`)) === "receive,reply");
  await type("These two belong together.");
  await b.click(q('[data-act="save-note"]'), 500);
  check("one note can be about several steps", (await b.ev(`[...document.querySelectorAll(".side .note")].length`)) === 2 && (await b.text(".side .note")).includes("Receive update · Send reply") && (await b.text('.node[data-arg="reply"] .nb')).trim() === "1" && (await b.text('.node[data-arg="receive"] .nb')).trim() === "2");
  await shot("note-on-several-steps");
  let small2 = await b.ev(`[...document.querySelectorAll("button, textarea")].filter((x) => x.offsetParent && !x.classList.contains("node") && x.getBoundingClientRect().height < 42).map((x) => (x.getAttribute("aria-label") || x.innerText).slice(0, 30))`);
  check(`every control is at least 42 px tall while picking steps ${JSON.stringify(small2)}`, small2.length === 0);
  await b.ev(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }))`);
  check("Escape ends the selection", (await count(".side")) === 0 && (await count(".node.sel")) === 0);

  // all notes
  check("the footer counts the notes", (await b.text('[data-act="side"][data-arg="notes"]')).includes("Notes 2"));
  await b.click(q('[data-act="side"][data-arg="notes"]'));
  check("Notes lists every note, newest first, with its steps", (await b.ev(`[...document.querySelectorAll(".side .note p")].map((p) => p.innerText.split("\\n")[0]).join("|")`)) === "These two belong together.|Why does this step run before the gate?" && (await b.text(".side")).includes("Receive update · Send reply"));
  small2 = await b.ev(`[...document.querySelectorAll("button")].filter((x) => x.offsetParent && !x.classList.contains("node") && x.getBoundingClientRect().height < 42).map((x) => (x.getAttribute("aria-label") || x.innerText).slice(0, 30))`);
  check(`every control is at least 42 px tall in the notes list ${JSON.stringify(small2)}`, small2.length === 0);
  await shot("notes-list");
  await b.click(q('.side .note [data-act="show-note"]'));
  check("Show the steps picks the steps of that note on the map", (await b.ev(`[...document.querySelectorAll(".node.sel")].map((n) => n.dataset.arg).sort().join()`)) === "receive,reply" && (await b.text(".side-h")).includes("2 steps selected"));
  await b.click(q('[data-act="close-panel"]'));
  await b.click(q('[data-act="side"][data-arg="notes"]'));
  await b.click(`document.querySelectorAll('.side .note [data-act="show-note"]')[1]`);
  check("a note on one step opens that step", (await b.text(".side-h")).includes("Receive update") && (await count(".node.sel")) === 0 && (await count(".side .note")) === 2);
  await b.click(q('[data-act="close-panel"]'));
  await b.click(q('[data-act="side"][data-arg="notes"]'));
  await b.click(q('.side .note [data-act="del-note"]'));
  check("Delete asks for a second tap and deletes nothing yet", (await b.text('.side .note [data-act="del-note"]')).includes("Tap again to delete") && (await count(".side .note")) === 2);
  await b.click(q('[data-act="zoom"][data-arg="1"]'));
  check("another tap takes the delete back", (await b.text('.side .note [data-act="del-note"]')).trim() === "Delete" && (await count(".side .note")) === 2);
  await b.click(q('.side .note [data-act="del-note"]'));
  await b.click(q('.side .note [data-act="del-note"]'), 500);
  check("the second tap deletes that note and only that one", (await count(".side .note")) === 1 && (await b.text(".side .note")).includes("Why does this step") && (await b.text('[data-act="side"][data-arg="notes"]')).includes("Notes 1") && (await count('.node[data-arg="reply"] .nb')) === 0);
  await b.go(page("moved-bot", "map"));
  check("notes are still there after a reload", (await b.text('[data-act="side"][data-arg="notes"]')).includes("Notes 1") && (await b.text('.node[data-arg="receive"] .nb')).trim() === "1");
  await b.click(q('[data-act="view"][data-arg="runs"]'), 300);
  check("Runs carries no code tags, note counts or note buttons", (await count(".tag-since")) === 0 && (await count(".node .nb")) === 0 && (await count('[data-act="side"]')) === 0 && (await count(".since-strip")) === 0);
  await b.click(q('[data-act="view"][data-arg="map"]'), 300);

  // phone width
  await b.size(390, 800);
  await b.go(page("moved-bot", "map"));
  await b.click(q('[data-act="side"][data-arg="since"]'));
  check("phone: the list of changes fits the width", await b.ev(`document.documentElement.scrollWidth <= 390 && document.querySelector(".side").getBoundingClientRect().width <= 390`));
  await b.click(q('.side .hop[data-arg="agent"]'));
  check("phone: the note box can be scrolled to and is wide enough to type in", await b.ev(`(() => { const t = document.querySelector("#note-text"); t.scrollIntoView({ block: "center" }); const r = t.getBoundingClientRect(); return r.width >= 300 && r.bottom <= innerHeight && r.top >= 0 && document.documentElement.scrollWidth <= 390; })()`));
  await shot("note-390");
  await b.size(1440, 900);

  // checked again: the flags go
  await b.go(page("moved-bot", "map"));
  await b.click(q('[data-act="ask-stamp"]'));
  await b.click(q('[data-act="stamp"]'), 500);
  check("marking the map as checked again clears the flags", (await count(".since-strip")) === 0 && (await count(".node.since")) === 0 && (await b.text(".status")).includes("code unchanged since") && JSON.parse(readFileSync(stampFile, "utf-8")).codeVersion === "1.5.0");
  rmSync(path.join(tmp, "code/src/agent.js"));
  await b.go(page("moved-bot", "map"));
  check("a map with broken steps cannot be marked as checked", (await b.text(".status")).includes("2 of 9 anchors broken") && (await count('[data-act="ask-stamp"]')) === 0 && (await b.text(".since-strip")).includes("Fix the broken steps"));
  await b.go(page("edge-bot", "map"));
  check("a project whose code is not on this machine is not asked to be checked", (await count(".since-strip")) === 0);

  // ---------- does the code report the steps the map shows? ----------
  await b.go(page("calls-bot", "map"));
  const strips = (await b.ev(`[...document.querySelectorAll(".strip")].map((s) => s.innerText.replace(/\\s+/g, " ")).join(" | ")`));
  check("a step the code reports and the map lacks is named, with its file and line", strips.includes("The code reports 1 step this map does not have: audit-log (src/door.js line 10). A run through it shows as a ghost."));
  check("steps no trace call names are counted", strips.includes("1 of 9 steps is not named in any trace call in the code, so Runs cannot light it."));
  await b.click(q('[data-act="side"][data-arg="untraced"]'));
  check("See it lists the steps the code never reports", (await b.text(".side")).includes("Not reported by the code") && (await b.ev(`[...document.querySelectorAll(".side .hop")].map((h) => h.dataset.arg).join()`)) === "reply" && (await b.ev(`${q('[data-act="side"][data-arg="untraced"]')}.getAttribute("aria-pressed")`)) === "true");
  await b.click(q('.side .hop[data-arg="reply"]'));
  check("that step's panel says no trace call names it", (await b.text(".side")).replace(/\s+/g, " ").includes("no trace call names this step, so Runs cannot light it"));
  await b.click(q('.node[data-arg="receive"]'));
  check("a reported step's panel says where it is reported", (await b.text(".side")).replace(/\s+/g, " ").includes("in src/door.js, line 3"));
  await shot("trace-calls");
  await b.click(q('[data-act="view"][data-arg="runs"]'), 300);
  check("Runs carries no trace call strips", !(await b.text(".main")).includes("trace call"));
  await b.size(390, 800);
  await b.go(page("calls-bot", "map"));
  await b.click(q('[data-act="side"][data-arg="untraced"]'));
  check("phone: the trace call strips and the list fit the width", await b.ev(`document.documentElement.scrollWidth <= 390 && document.querySelector(".side").getBoundingClientRect().width <= 390 && [...document.querySelectorAll(".strip .btn")].every((x) => x.getBoundingClientRect().height >= 42)`));
  await shot("trace-calls-390");
  await b.size(1440, 900);
  await b.go(page("example-bot", "map"));
  check("a map whose every step is reported says nothing about trace calls", !(await b.text(".main")).includes("trace call"));
  await b.go(page("moved-bot", "map"));
  await b.click(q('.node[data-arg="receive"]'));
  check("a project that names no trace calls is told nothing about them", !(await b.text(".main")).includes("trace call") && !(await b.text(".side")).includes("reports to runs"));

  // ---------- a proposed new map: look, accept, undo, discard ----------
  const flat = async (sel) => (await b.text(sel)).replace(/\s+/g, " ");
  const propMap = () => JSON.parse(readFileSync(path.join(tmp, "manifests/prop-bot.json"), "utf-8")).pipelines[0];
  const tall = (sel) => b.ev(`[...document.querySelectorAll(${JSON.stringify(sel)})].every((x) => x.getBoundingClientRect().height >= 42)`);
  await b.go(page("prop-bot", "map"));
  check("a waiting proposal is announced on the map with what it would change", (await flat(".prop-strip")).includes("A new version of this map is waiting: 1 step added, 1 step changed, 1 link added.") && (await flat(".prop-strip")).includes("hand-made") && (await flat(".prop-strip")).includes("1 older proposal also waits"));
  check("a file that is not a proposal is counted, not shown", (await flat(".main")).includes("1 proposal file could not be read as a proposal and is left alone."));
  check("the map itself is still the old one", (await count('.node[data-arg="audit"]')) === 0);
  await b.click(q('[data-act="open-proposal"]'), 400);
  check("Look at it draws the proposed map, the new step marked new and the changed one marked changed", (await b.ev(`${q('.node[data-arg="audit"]')}.classList.contains("draft")`)) && (await flat('.node[data-arg="audit"]')).includes("new") && (await b.ev(`${q('.node[data-arg="agent"]')}.classList.contains("changed")`)) && (await count(".node.draft")) === 1 && (await count(".node.changed")) === 1);
  check("the proposal is in the address, so the link can be passed on", (await b.ev("location.search")).includes("proposal=job-new"));
  const sideText = (await flat(".side")).toLowerCase();
  check("the side lists what would change and what XPM checked", sideText.includes("what would change") && sideText.includes("steps added") && sideText.includes("write the audit line") && sideText.includes("steps changed") && sideText.includes("links added") && sideText.includes("send reply → write the audit line") && sideText.includes("unchanged since the proposal was made") && sideText.includes("10 of 10 found"));
  check("what the proposal is not sure about is shown", sideText.includes("the proposal is not sure about") && sideText.includes("before or after the reply is sent"));
  await b.click(q('.node[data-arg="agent"]'));
  check("tapping a changed step shows before and after, and the proposal's reason", (await flat(".prop-d .was")).includes("reads the message and writes the reply") && (await flat(".prop-d .now")).includes("looks things up") && (await flat(".prop-d")).includes("The agent also looks things up now.") && (await b.ev(`${q('.node[data-arg="agent"]')}.getAttribute("aria-expanded")`)) === "true");
  await b.click(q('.side .hop[data-arg="audit"]'));
  check("tapping a new step in the list shows where it is in the code and why", (await flat(".prop-d")).includes("src/door.js · auditLog") && (await flat(".prop-d")).includes("The door file now has a function that notes each reply.") && (await flat(".prop-d")).includes("src/door.js line 10"));
  await shot("proposal");
  check("the proposal's controls are tall enough to tap", (await tall(".prop-strip .btn")) && (await tall(".side .hop")));
  await b.click(q('[data-act="ask-accept"]'));
  check("Accept asks first and says the old map is kept", (await flat(".prop-strip")).includes("This writes the map file. The map as it is now is kept and can be put back.") && propMap().nodes.length === 9);
  await b.click(q('[data-act="cancel"]'));
  check("Cancel leaves the map file alone", (await count('[data-act="accept"]')) === 0 && propMap().nodes.length === 9);
  await b.click(q('[data-act="ask-accept"]'));
  await b.click(q('[data-act="accept"]'), 700);
  check("Yes, accept writes the map file and shows the new map", propMap().nodes.length === 10 && (await count('.node[data-arg="audit"]')) === 1 && (await count(".node.draft")) === 0 && !(await b.ev("location.search")).includes("proposal="));
  check("the accepted map counts as checked against the code", (await b.text(".status")).includes("code unchanged since"));
  check("the map says it was updated and offers Undo", (await flat(".main")).includes("from a proposal") && (await flat(".main")).includes("The map as it was is kept.") && (await count('[data-act="ask-undo"]')) === 1);
  await shot("proposal-accepted");
  check("the older proposal still waits but can no longer be accepted", (await flat(".main")).includes("It cannot be accepted as it is."));
  await b.click(q('[data-act="open-proposal"]'), 400);
  check("a proposal made from an older map says why and has no live Accept", (await flat(".prop-why")).includes("Cannot be accepted.") && (await flat(".prop-why")).includes("map") && (await b.ev(`${q('[data-act="ask-accept"]')}.disabled`)) === true);
  await shot("proposal-blocked");
  await b.click(q('[data-act="close-proposal"]'));
  await b.click(q('[data-act="ask-undo"]'));
  check("Undo asks first", (await flat(".main")).includes("This puts the map file back as it was before.") && propMap().nodes.length === 10);
  await b.click(q('[data-act="undo"]'), 700);
  check("Yes, undo puts the map file back and the proposal waits again", propMap().nodes.length === 9 && (await count('.node[data-arg="audit"]')) === 0 && (await count('[data-act="ask-undo"]')) === 0 && (await flat(".prop-strip")).includes("1 step added, 1 step changed, 1 link added"));
  await b.click(q('[data-act="open-proposal"]'), 400);
  await b.click(q('[data-act="ask-discard"]'));
  check("Discard asks first", (await flat(".prop-strip")).includes("The proposal goes away. The map stays as it is."));
  await b.click(q('[data-act="discard-proposal"]'), 700);
  check("Yes, discard takes the proposal away and leaves the map alone", propMap().nodes.length === 9 && !(await flat(".main")).includes("1 step added, 1 step changed") && (await flat(".prop-strip")).includes("A new version of this map is waiting: 1 step changed.") && existsSync(path.join(tmp, "state/proposals/prop-bot/inbound/job-new.json")));
  await b.go(page("locked-bot", "map"));
  await b.click(q('[data-act="open-proposal"]'), 400);
  check("where XPM may not write the map file, Accept is off and says so", (await b.ev(`${q('[data-act="ask-accept"]')}.disabled`)) === true && (await flat(".prop-why")).includes("Accept is off here. Accepting is off for this project on this machine") && (await count('.node[data-arg="audit"]')) === 1);
  await b.go(page("locked-bot", "map", "&proposal=job-locked"));
  await sleep(500);
  check("a link to a proposal opens it", (await count('.node[data-arg="audit"]')) === 1 && (await flat(".side")).includes("What would change"));
  await b.click(q('[data-act="view"][data-arg="runs"]'), 300);
  check("leaving for Runs leaves the proposal", (await count(".prop-strip")) === 0 && !(await b.ev("location.search")).includes("proposal="));
  await b.size(390, 800);
  await b.go(page("locked-bot", "map"));
  await b.click(q('[data-act="open-proposal"]'), 400);
  check("phone: the proposal fits the width and its buttons are tall enough", (await b.ev(`document.documentElement.scrollWidth <= 390 && document.querySelector(".side").getBoundingClientRect().width <= 390`)) && (await tall(".prop-strip .btn")) && (await tall(".side .hop")));
  await shot("proposal-390");
  await b.size(1440, 900);
  await b.go(page("example-bot", "map"));
  check("a map with no proposal says nothing about proposals", (await count(".prop-strip")) === 0 && !(await flat(".main")).includes("proposal"));

  check(`no page errors ${JSON.stringify(b.errors)}`, b.errors.length === 0);
} catch (err) {
  check(`the checks ran to the end (${err.message})`, false);
} finally {
  await b.close();
  server.kill();
  rmSync(tmp, { recursive: true, force: true });
}

console.log(out.join("\n"));
const failed = out.filter((l) => l.startsWith("FAIL")).length;
console.log(`\n${out.length - failed} of ${out.length} click checks pass`);
process.exit(failed ? 1 : 0);
