const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const xpm = require("../lib/pipeline");

// A two-file project and a map with three steps on it: two share a file, one has no anchor.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-since-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src/door.js"), "function open() {}\n");
  fs.writeFileSync(path.join(root, "src/brain.js"), "function think() {}\nfunction answer() {}\n");
  const pipeline = { id: "inbound", nodes: [
    { id: "open", kind: "door", anchor: { repo: "bot", path: "src/door.js", symbol: "open" } },
    { id: "think", kind: "model", anchor: { repo: "bot", path: "src/brain.js", symbol: "think" } },
    { id: "answer", kind: "sender", anchor: { repo: "bot", path: "src/brain.js", symbol: "answer" } },
    { id: "idea", kind: "tool" },
  ], edges: [] };
  return { root, repos: { bot: root }, pipeline };
}

test("since: nothing changed right after the check", () => {
  const { repos, pipeline } = project();
  const stamp = xpm.takeStamp(pipeline, repos, { by: "someone", codeVersion: "1.2.0", now: new Date("2026-01-02T03:04:05Z") });
  assert.equal(stamp.takenAt, "2026-01-02T03:04:05.000Z");
  assert.equal(stamp.how, "by hand");
  assert.equal(stamp.codeVersion, "1.2.0");
  assert.deepEqual(Object.keys(stamp.files).sort(), ["bot:src/brain.js", "bot:src/door.js"]);
  assert.match(stamp.files["bot:src/door.js"], /^[0-9a-f]{64}$/);
  assert.deepEqual(xpm.compareStamp(pipeline, repos, stamp), { changed: [], uncovered: [], files: [] });
});

test("since: a changed file flags every step in it, and only those", () => {
  const { root, repos, pipeline } = project();
  const stamp = xpm.takeStamp(pipeline, repos, {});
  fs.appendFileSync(path.join(root, "src/brain.js"), "// a new line\n");
  const diff = xpm.compareStamp(pipeline, repos, stamp);
  assert.deepEqual(diff.changed, ["think", "answer"]);
  assert.deepEqual(diff.uncovered, []);
  assert.equal(diff.files.length, 1);
  assert.equal(diff.files[0].file, "bot:src/brain.js");
  assert.equal(diff.files[0].state, "changed");
  assert.deepEqual(diff.files[0].nodes, ["think", "answer"]);
  assert.ok(!Number.isNaN(Date.parse(diff.files[0].changedAt)));
});

test("since: a touched file with the same content is not a change", () => {
  const { root, repos, pipeline } = project();
  const stamp = xpm.takeStamp(pipeline, repos, {});
  const later = new Date(Date.now() + 60000);
  fs.utimesSync(path.join(root, "src/brain.js"), later, later);
  assert.deepEqual(xpm.compareStamp(pipeline, repos, stamp).changed, []);
});

test("since: a deleted file is reported as gone", () => {
  const { root, repos, pipeline } = project();
  const stamp = xpm.takeStamp(pipeline, repos, {});
  fs.rmSync(path.join(root, "src/door.js"));
  const diff = xpm.compareStamp(pipeline, repos, stamp);
  assert.deepEqual(diff.changed, ["open"]);
  assert.equal(diff.files[0].state, "gone");
});

test("since: a step added or pointed elsewhere after the check is uncovered, not changed", () => {
  const { root, repos, pipeline } = project();
  const stamp = xpm.takeStamp(pipeline, repos, {});
  fs.writeFileSync(path.join(root, "src/new.js"), "function fresh() {}\n");
  pipeline.nodes.push({ id: "fresh", kind: "tool", anchor: { repo: "bot", path: "src/new.js", symbol: "fresh" } });
  pipeline.nodes[0].anchor.path = "src/brain.js";
  const diff = xpm.compareStamp(pipeline, repos, stamp);
  assert.deepEqual(diff.changed, []);
  assert.deepEqual(diff.uncovered.sort(), ["fresh", "open"]);
});

test("code version: package.json first, then VERSION, a named file when given, null when the code does not say", () => {
  const { root } = project();
  assert.equal(xpm.codeVersion(root), null);
  fs.writeFileSync(path.join(root, "VERSION"), "release v2.5.1 (stable)\n");
  assert.equal(xpm.codeVersion(root), "2.5.1");
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "3.0.0-beta.1" }));
  assert.equal(xpm.codeVersion(root), "3.0.0-beta.1");
  fs.writeFileSync(path.join(root, "src/release.txt"), "1.71\n");
  assert.equal(xpm.codeVersion(root, "src/release.txt"), "1.71");
  assert.equal(xpm.codeVersion(root, "../outside.txt"), null);
  assert.equal(xpm.codeVersion(root, "src/missing.txt"), null);
  assert.equal(xpm.codeVersion(undefined), null);
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ version: "<script>alert(1)</script>" }));
  assert.equal(xpm.codeVersion(root, "package.json"), null);
});

test("stamps and notes: written under the state folder, private to the user, read back", () => {
  const { repos, pipeline } = project();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-state-"));
  assert.equal(xpm.readStamp(dir, "bot", "inbound"), null);
  assert.deepEqual(xpm.readNotes(dir, "bot", "inbound"), []);
  xpm.writeStamp(dir, "bot", "inbound", xpm.takeStamp(pipeline, repos, {}));
  assert.equal(xpm.readStamp(dir, "bot", "inbound").pipeline, "inbound");
  const file = path.join(dir, "stamps/bot/inbound.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(file)).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["inbound.json"]);

  const first = xpm.addNote(dir, "bot", "inbound", { nodes: ["think", "think", "answer"], text: "  why twice?\r\nline two\u0007  ", by: "someone", now: new Date("2026-01-02T00:00:00Z") });
  xpm.addNote(dir, "bot", "inbound", { nodes: ["open"], text: "newer", now: new Date("2026-01-03T00:00:00Z") });
  xpm.addNote(dir, "bot", "other", { nodes: ["x"], text: "another pipeline" });
  assert.match(first.id, /^[0-9a-f]{12}$/);
  assert.deepEqual(first.nodes, ["think", "answer"]);
  assert.equal(first.text, "why twice?\nline two");
  assert.deepEqual(xpm.readNotes(dir, "bot", "inbound").map((n) => n.text), ["newer", "why twice?\nline two"]);
  assert.equal(xpm.removeNote(dir, "bot", "other", first.id), false);
  assert.equal(xpm.removeNote(dir, "bot", "inbound", first.id), true);
  assert.deepEqual(xpm.readNotes(dir, "bot", "inbound").map((n) => n.text), ["newer"]);
  assert.equal(xpm.readNotes(dir, "bot", "other").length, 1);
});

test("stamps and notes: an id that is not a plain name gets no file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-state-"));
  assert.equal(xpm.readStamp(dir, "bot", "../../escape"), null);
  assert.deepEqual(xpm.readNotes(dir, "../escape", "inbound"), []);
  assert.throws(() => xpm.writeStamp(dir, "bot", "../../escape", { v: 1 }), { status: 400 });
  assert.throws(() => xpm.addNote(dir, "..", "inbound", { nodes: ["a"], text: "x" }), { status: 400 });
  assert.deepEqual(fs.readdirSync(dir), []);
});

test("notes: what cannot be saved is said in a sentence", () => {
  const { pipeline } = project();
  assert.deepEqual(xpm.validateNote(pipeline, { nodes: ["think"], text: "fine" }), []);
  assert.deepEqual(xpm.validateNote(pipeline, null), ["a note needs the steps it is about and a text"]);
  assert.deepEqual(xpm.validateNote(pipeline, { nodes: [], text: " \n " }), ["a note is about at least one step", "the note is empty"]);
  assert.deepEqual(xpm.validateNote(pipeline, { nodes: ["nope"], text: "x" }), ["a note can only be about steps on this map"]);
  assert.deepEqual(xpm.validateNote(pipeline, { nodes: ["think"], text: "x".repeat(xpm.NOTE_MAX + 1) }), [`a note holds ${xpm.NOTE_MAX} characters at most`]);
  assert.deepEqual(xpm.validateNote(pipeline, { nodes: Array(51).fill("think"), text: "x" }), ["a note can be about 50 steps at most"]);
});
