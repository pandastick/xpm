const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const xpm = require("../lib/pipeline");

const ROOT = path.join(__dirname, "..");
const copy = (x) => JSON.parse(JSON.stringify(x));

// A small project: code, a map file with two pipelines, a state folder, and a proposal that adds a step.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-prop-"));
  fs.mkdirSync(path.join(root, "code/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "code/src/door.js"), "function open() {}\nfunction audit() {}\n");
  fs.writeFileSync(path.join(root, "code/src/brain.js"), "function think() {}\nfunction answer() {}\n");
  const pipeline = {
    id: "inbound", name: "A message comes in", lanes: ["door", "brain"], entry: "open",
    nodes: [
      { id: "open", name: "Open", kind: "door", lane: "door", anchor: { repo: "bot", path: "src/door.js", symbol: "open" } },
      { id: "think", name: "Think", kind: "model", lane: "brain", anchor: { repo: "bot", path: "src/brain.js", symbol: "think" } },
      { id: "answer", name: "Answer", kind: "sender", lane: "brain", anchor: { repo: "bot", path: "src/brain.js", symbol: "answer" } },
    ],
    edges: [{ from: "open", to: "think" }, { from: "think", to: "answer" }],
  };
  const manifest = { id: "prop-bot", name: "Prop bot", screens: [], pipelines: [pipeline, { id: "other", nodes: [{ id: "x", kind: "door" }], edges: [] }] };
  const manifestFile = path.join(root, "prop-bot.json");
  fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 4) + "\n");
  const repos = { bot: path.join(root, "code") };
  const dir = path.join(root, "state");
  const proposed = copy(pipeline);
  proposed.nodes.splice(1, 0, { id: "audit", name: "Audit", kind: "hook", lane: "door", anchor: { repo: "bot", path: "src/door.js", symbol: "audit" } });
  proposed.nodes.find((n) => n.id === "think").name = "Think it over";
  proposed.edges = [{ from: "open", to: "audit" }, { from: "audit", to: "think" }, { from: "think", to: "answer" }];
  const put = (jobId, pl = proposed, extra = {}, into = dir) => {
    const p = { ...xpm.makeProposal(pipeline, pl, repos, { jobId, now: new Date("2026-03-01T10:00:00Z") }), ...extra };
    const file = xpm.proposalFile(into, "prop-bot", "inbound", jobId);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(p));
    return p;
  };
  const onDisk = () => JSON.parse(fs.readFileSync(manifestFile, "utf-8"));
  const args = (jobId) => ({ dir, project: "prop-bot", pid: "inbound", jobId, manifestFile, repos, by: "owner@example.com", codeVersion: "1.2.0" });
  return { root, pipeline, proposed, manifest, manifestFile, repos, dir, put, onDisk, args };
}

test("proposals: the same map gives the same fingerprint whatever the key order, and any change gives another", () => {
  const { pipeline } = project();
  const shuffled = { edges: pipeline.edges, nodes: pipeline.nodes.map((n) => Object.fromEntries(Object.entries(n).reverse())), entry: pipeline.entry, lanes: pipeline.lanes, name: pipeline.name, id: pipeline.id };
  assert.equal(xpm.mapSha(shuffled), xpm.mapSha(pipeline));
  const other = copy(pipeline);
  other.nodes[0].anchor.symbol = "opened";
  assert.notEqual(xpm.mapSha(other), xpm.mapSha(pipeline));
});

test("proposals: XPM works out what would change itself", () => {
  const { pipeline, proposed } = project();
  const d = xpm.diffPipelines(pipeline, proposed);
  assert.deepEqual(d.nodes, { added: ["audit"], removed: [], changed: [{ id: "think", fields: ["name"] }] });
  assert.deepEqual(d.edges, { added: ["open->audit", "audit->think"], removed: ["open->think"], changed: [] });
  assert.deepEqual(d.other, []);
  assert.equal(d.total, 5);
  assert.equal(xpm.diffPipelines(pipeline, copy(pipeline)).total, 0);
  // Nothing slips through: a link's kind, a top-level key, an anchor, the order.
  const sly = copy(pipeline);
  sly.edges[0].kind = "error";
  sly.note = "x";
  sly.nodes[2].anchor.path = "src/door.js";
  sly.nodes.reverse();
  const s = xpm.diffPipelines(pipeline, sly);
  assert.deepEqual(s.edges.changed, [{ id: "open->think", fields: ["kind"] }]);
  assert.deepEqual(s.nodes.changed, [{ id: "answer", fields: ["anchor"] }]);
  assert.deepEqual(s.other, ["note", "the order of the steps"]);
  const gone = copy(pipeline);
  gone.nodes.pop();
  gone.edges.pop();
  assert.deepEqual(xpm.diffPipelines(pipeline, gone).nodes.removed, ["answer"]);
});

test("proposals: a sound one passes, and each way of being wrong is named", () => {
  const f = project();
  const good = f.put("job-1");
  const c = xpm.checkProposal(f.pipeline, xpm.readProposal(f.dir, "prop-bot", "inbound", "job-1"), f.repos);
  assert.equal(c.ok, true);
  assert.equal(xpm.whyNot(c), "");
  assert.equal(c.anchors.length, 4);
  // The map changed since.
  const moved = copy(f.pipeline);
  moved.nodes[0].name = "Open the door";
  assert.match(xpm.whyNot(xpm.checkProposal(moved, good, f.repos)), /map was changed after/);
  // A step that is not in the code.
  const lost = copy(f.proposed);
  lost.nodes[1].anchor.symbol = "auditTrail";
  const l = xpm.checkProposal(f.pipeline, f.put("job-2", lost), f.repos);
  assert.equal(l.ok, false);
  assert.match(xpm.whyNot(l), /1 of its steps do not match the code/);
  // A map that does not hold together, another pipeline, nothing changed, too many steps.
  const broken = copy(f.proposed);
  broken.edges.push({ from: "audit", to: "nowhere" });
  assert.match(xpm.whyNot(xpm.checkProposal(f.pipeline, f.put("job-3", broken), f.repos)), /does not hold together: pipeline inbound: edge to unknown node nowhere/);
  assert.match(xpm.whyNot(xpm.checkProposal(f.pipeline, f.put("job-4", { ...copy(f.proposed), id: "other" }), f.repos)), /is for pipeline other, not inbound/);
  assert.match(xpm.whyNot(xpm.checkProposal(f.pipeline, f.put("job-5", copy(f.pipeline)), f.repos)), /changes nothing/);
  const huge = copy(f.proposed);
  for (let i = 0; i < 200; i++) huge.nodes.push({ id: `n${i}`, kind: "tool" });
  assert.match(xpm.whyNot(xpm.checkProposal(f.pipeline, f.put("job-6", huge), f.repos)), /200 steps at most/);
  // The code changed since the proposal was made.
  fs.appendFileSync(path.join(f.root, "code/src/door.js"), "// later\n");
  const late = xpm.checkProposal(f.pipeline, good, f.repos);
  assert.deepEqual(late.codeMoved, ["bot:src/door.js"]);
  assert.match(xpm.whyNot(late), /code changed after/);
});

test("proposals: a file that is not a proposal is not read as one, and its words are cleaned", () => {
  const f = project();
  const base = path.dirname(xpm.proposalFile(f.dir, "prop-bot", "inbound", "x"));
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, "junk.json"), "{ not json");
  fs.writeFileSync(path.join(base, "old.json"), JSON.stringify({ v: 2, basedOnMapSha: "x", basedOnCode: {}, pipeline: {} }));
  fs.writeFileSync(path.join(base, "nocode.json"), JSON.stringify({ v: 1, basedOnMapSha: "x", pipeline: f.proposed }));
  fs.writeFileSync(path.join(base, "big.json"), JSON.stringify({ v: 1, basedOnMapSha: "x", basedOnCode: {}, pipeline: f.proposed, pad: "x".repeat(1 << 20) }));
  for (const id of ["junk", "old", "nocode", "big", "missing", "../../escape"]) assert.equal(xpm.readProposal(f.dir, "prop-bot", "inbound", id), null);
  f.put("job-1", f.proposed, { model: "a\u0000model\nname", changes: [{ node: "audit", reason: "line one\nline two" + "x".repeat(600), evidence: [{ file: "src/door.js", lines: "2-2" }, { lines: "9" }] }, { node: "", reason: "no step" }, "junk"], unsure: ["maybe", 7, ""] });
  const p = xpm.readProposal(f.dir, "prop-bot", "inbound", "job-1");
  assert.equal(p.model, "a model name");
  assert.equal(p.changes.length, 1);
  assert.equal(p.changes[0].reason.length, 500);
  assert.ok(!/\n/.test(p.changes[0].reason));
  assert.deepEqual(p.changes[0].evidence, [{ file: "src/door.js", lines: "2-2" }]);
  assert.deepEqual(p.unsure, ["maybe", "7"]);
  const list = xpm.listProposals(f.dir, "prop-bot", "inbound", f.pipeline, f.repos);
  assert.equal(list.unreadable, 4);
  assert.deepEqual(list.waiting.map((w) => [w.jobId, w.ok, w.nodes, w.edges]), [["job-1", true, { added: 1, removed: 0, changed: 1 }, { added: 2, removed: 1, changed: 0 }]]);
  assert.throws(() => xpm.listProposals(f.dir, "../x", "inbound", f.pipeline, f.repos), /cannot be used as a file name/);
});

test("proposals: accept writes the map file, keeps the old map, marks the new one as checked", () => {
  const f = project();
  f.put("job-1");
  xpm.writeStamp(f.dir, "prop-bot", "inbound", xpm.takeStamp(f.pipeline, f.repos, { by: "owner@example.com", codeVersion: "1.1.0", now: new Date("2026-02-01T09:00:00Z") }));
  const now = new Date("2026-03-02T08:30:00Z");
  xpm.acceptProposal({ ...f.args("job-1"), now });
  const after = f.onDisk();
  assert.deepEqual(after.pipelines[0], f.proposed);
  // Everything else in the file is as it was, with its indent and its last line break.
  assert.deepEqual({ ...after, pipelines: [f.pipeline, after.pipelines[1]] }, f.manifest);
  const text = fs.readFileSync(f.manifestFile, "utf-8");
  assert.ok(text.startsWith('{\n    "id"') && text.endsWith("}\n"));
  assert.deepEqual(fs.readdirSync(f.root).filter((x) => x.includes("tmp")), []);
  const stamp = xpm.readStamp(f.dir, "prop-bot", "inbound");
  assert.equal(stamp.how, "from a proposal");
  assert.equal(stamp.by, "owner@example.com");
  assert.equal(stamp.codeVersion, "1.2.0");
  assert.deepEqual(Object.keys(stamp.nodes), ["open", "audit", "think", "answer"]);
  assert.deepEqual(xpm.compareStamp(f.proposed, f.repos, stamp), { changed: [], uncovered: [], files: [] });
  // It no longer waits, cannot be taken twice, and can be undone.
  assert.deepEqual(xpm.listProposals(f.dir, "prop-bot", "inbound", f.proposed, f.repos).waiting, []);
  assert.throws(() => xpm.acceptProposal(f.args("job-1")), /already accepted/);
  assert.throws(() => xpm.discardProposal(f.args("job-1")), /already accepted/);
  assert.deepEqual(xpm.undoInfo(f.dir, "prop-bot", "inbound", f.proposed), { at: now.toISOString(), by: "owner@example.com", jobId: "job-1" });
  // The proposal file itself is never changed.
  assert.equal(JSON.parse(fs.readFileSync(xpm.proposalFile(f.dir, "prop-bot", "inbound", "job-1"), "utf-8")).decided, undefined);
});

test("proposals: a proposal that does not pass is not written, whatever it says about itself", () => {
  const f = project();
  const before = fs.readFileSync(f.manifestFile, "utf-8");
  const lost = copy(f.proposed);
  lost.nodes[1].anchor.path = "src/gone.js";
  f.put("job-bad", lost, { changes: [{ node: "audit", reason: "trust me" }] });
  assert.throws(() => xpm.acceptProposal(f.args("job-bad")), (e) => e.status === 409 && /do not match the code/.test(e.message));
  assert.throws(() => xpm.acceptProposal(f.args("job-none")), (e) => e.status === 404);
  f.put("job-1");
  // The map file changed by hand after the proposal was made.
  const m = f.onDisk();
  m.pipelines[0].nodes[0].name = "Open the door";
  fs.writeFileSync(f.manifestFile, JSON.stringify(m, null, 4) + "\n");
  assert.throws(() => xpm.acceptProposal(f.args("job-1")), (e) => e.status === 409 && /map was changed after/.test(e.message));
  assert.equal(fs.readFileSync(f.manifestFile, "utf-8"), JSON.stringify(m, null, 4) + "\n");
  fs.writeFileSync(f.manifestFile, before);
  assert.throws(() => xpm.acceptProposal({ ...f.args("job-1"), pid: "nope" }), (e) => e.status === 404);
  assert.equal(xpm.undoInfo(f.dir, "prop-bot", "inbound", f.pipeline), null);
  assert.equal(fs.existsSync(path.join(f.dir, "history")), false);
});

test("proposals: a map file that cannot be written leaves the map, the check and the history as they were", { skip: process.getuid?.() === 0 }, () => {
  const f = project();
  // The state folder sits somewhere XPM can write; the folder of the map file is read-only.
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-prop-state-"));
  f.put("job-1", f.proposed, {}, state);
  const before = fs.readFileSync(f.manifestFile, "utf-8");
  fs.chmodSync(f.root, 0o500);
  try {
    assert.throws(() => xpm.acceptProposal({ ...f.args("job-1"), dir: state }), (e) => e.status === 500 && /could not write the map file \(EACCES\)\. The map is as it was\./.test(e.message));
  } finally {
    fs.chmodSync(f.root, 0o700);
  }
  assert.equal(fs.readFileSync(f.manifestFile, "utf-8"), before);
  assert.equal(xpm.readStamp(state, "prop-bot", "inbound"), null);
  assert.deepEqual(fs.readdirSync(path.join(state, "history/prop-bot/inbound")), []);
  assert.equal(xpm.listProposals(state, "prop-bot", "inbound", f.pipeline, f.repos).waiting.length, 1);
});

test("proposals: undo puts the old map and the old check back, once, and only over the map it wrote", () => {
  const f = project();
  f.put("job-1");
  const old = xpm.takeStamp(f.pipeline, f.repos, { by: "owner@example.com", codeVersion: "1.1.0", now: new Date("2026-02-01T09:00:00Z") });
  xpm.writeStamp(f.dir, "prop-bot", "inbound", old);
  const before = fs.readFileSync(f.manifestFile, "utf-8");
  assert.throws(() => xpm.undoAccept(f.args()), /nothing to undo/);
  xpm.acceptProposal({ ...f.args("job-1"), now: new Date("2026-03-02T08:30:00Z") });
  xpm.undoAccept({ ...f.args(), now: new Date("2026-03-02T08:31:00Z") });
  assert.equal(fs.readFileSync(f.manifestFile, "utf-8"), before);
  assert.deepEqual(xpm.readStamp(f.dir, "prop-bot", "inbound"), old);
  assert.equal(xpm.undoInfo(f.dir, "prop-bot", "inbound", f.pipeline), null);
  assert.throws(() => xpm.undoAccept(f.args()), /nothing to undo/);
  // The proposal waits again, and can be discarded.
  assert.equal(xpm.listProposals(f.dir, "prop-bot", "inbound", f.pipeline, f.repos).waiting.length, 1);
  xpm.discardProposal(f.args("job-1"));
  assert.deepEqual(xpm.listProposals(f.dir, "prop-bot", "inbound", f.pipeline, f.repos).waiting, []);
  assert.throws(() => xpm.acceptProposal(f.args("job-1")), /already discarded/);
});

test("proposals: undo is refused once the map was changed again, and a map with no check gets none back", () => {
  const f = project();
  f.put("job-1");
  xpm.acceptProposal({ ...f.args("job-1"), now: new Date("2026-03-02T08:30:00Z") });
  assert.ok(xpm.readStamp(f.dir, "prop-bot", "inbound"));
  const m = f.onDisk();
  m.pipelines[0].nodes[0].name = "Edited by hand";
  fs.writeFileSync(f.manifestFile, JSON.stringify(m));
  assert.equal(xpm.undoInfo(f.dir, "prop-bot", "inbound", m.pipelines[0]), null);
  assert.throws(() => xpm.undoAccept(f.args()), (e) => e.status === 409 && /will not put the old one back over it/.test(e.message));
  assert.equal(f.onDisk().pipelines[0].nodes[0].name, "Edited by hand");
  // Back to the accepted map: now it can be undone, and since there was no check before, there is none after.
  m.pipelines[0] = f.proposed;
  fs.writeFileSync(f.manifestFile, JSON.stringify(m));
  xpm.undoAccept(f.args());
  assert.deepEqual(f.onDisk().pipelines[0], f.pipeline);
  assert.equal(xpm.readStamp(f.dir, "prop-bot", "inbound"), null);
});
