const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("node:child_process");
const xpm = require("../lib/pipeline");

const ROOT = path.join(__dirname, "..");

// A small project whose code reports two of the map's three steps, and one step the map does not have.
function project() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-calls-"));
  fs.mkdirSync(path.join(root, "src/tests"), { recursive: true });
  fs.mkdirSync(path.join(root, "src/old-backup"));
  fs.writeFileSync(path.join(root, "src/door.js"), [
    "function open(u, trace) {",
    "  trace.node(u.runId, \"open\");",
    "  trace.decide(u.runId, 'sort', { kind: \"a\" });",
    "  trace.node(u.runId, \"extra\");",
    "  trace.node(u.runId, stepName);",
    "}",
  ].join("\n"));
  fs.writeFileSync(path.join(root, "src/steps.py"), "def run(u, trace):\n    trace.fail(u.run_id, \"py-step\")\n");
  fs.writeFileSync(path.join(root, "src/tests/door.test.js"), "trace.node(id, \"only-in-a-test\");\n");
  fs.writeFileSync(path.join(root, "src/old-backup/door.js"), "trace.node(id, \"only-in-a-backup\");\n");
  fs.writeFileSync(path.join(root, "src/wrap.ts"), "bot.use(markAt('open'))\nbot.use(markAt('wrapped'))\nconst STEPS=[{id:'answer',key:'ok'}]\n");
  fs.writeFileSync(path.join(root, "notes.md"), "trace.node(id, \"in-a-text-file\");\n");
  const pipeline = { id: "inbound", nodes: [{ id: "open", kind: "door" }, { id: "sort", kind: "router" }, { id: "answer", kind: "sender" }], edges: [] };
  return { root, pipeline };
}

test("trace calls: no profile entry means no answer, not an empty one", () => {
  const { root, pipeline } = project();
  assert.equal(xpm.traceCalls(pipeline, root, undefined), null);
  assert.equal(xpm.traceCalls(pipeline, root, [{ path: "src", pipeline: "another" }]), null);
});

test("trace calls: the writers' own calls are found, in code files only, outside tests and backups", () => {
  const { root, pipeline } = project();
  const t = xpm.traceCalls(pipeline, root, [{ path: "src" }]);
  assert.deepEqual(t.traced, [{ id: "open", file: "src/door.js", line: 2 }, { id: "sort", file: "src/door.js", line: 3 }]);
  assert.deepEqual(t.unknown, [{ id: "extra", file: "src/door.js", line: 4 }, { id: "py-step", file: "src/steps.py", line: 2 }]);
  assert.equal(t.unknownCount, 2);
  assert.deepEqual(t.untraced, ["answer"]);
  assert.equal(t.files, 3);
});

test("trace calls: a project's own wrapper is read with its own pattern, one file or a folder", () => {
  const { root, pipeline } = project();
  const t = xpm.traceCalls(pipeline, root, [
    { path: "src/wrap.ts", pattern: "markAt\\('([\\w-]+)'\\)" },
    { path: "src/wrap.ts", pattern: "\\{id:'([\\w-]+)'" },
  ]);
  assert.deepEqual(t.traced.map((c) => c.id), ["open", "answer"]);
  assert.deepEqual(t.unknown, [{ id: "wrapped", file: "src/wrap.ts", line: 2 }]);
  assert.deepEqual(t.untraced, ["sort"]);
  assert.equal(t.files, 1);
});

test("trace calls: a place that is not there, or outside the repo, is an error and never a clean answer", () => {
  const { root, pipeline } = project();
  assert.match(xpm.traceCalls(pipeline, root, [{ path: "lib" }]).error, /"lib", which is not in the truth repo/);
  assert.match(xpm.traceCalls(pipeline, root, [{ path: "../elsewhere" }]).error, /problems/);
  assert.match(xpm.traceCalls(pipeline, path.join(root, "gone"), [{ path: "src" }]).error, /not on this machine/);
  assert.match(xpm.traceCalls(pipeline, undefined, [{ path: "src" }]).error, /not on this machine/);
});

test("trace calls: the profile is checked before it is used", () => {
  assert.deepEqual(xpm.validateCalls(undefined), []);
  assert.deepEqual(xpm.validateCalls([{ path: "src" }, { path: "a/b.ts", pattern: "at\\((\\w+)\\)", pipeline: "inbound" }]), []);
  assert.equal(xpm.validateCalls([]).length, 1);
  assert.equal(xpm.validateCalls("src").length, 1);
  const bad = xpm.validateCalls([{ path: "/etc" }, { path: "../x" }, { path: "-x" }, { path: "a", pattern: "no group" }, { path: "a", pattern: "(" }, { path: "a", pattern: "x".repeat(301) }, { path: "a", pipeline: 3 }, null]);
  assert.equal(bad.length, 8);
  assert.match(bad[3], /one group in brackets/);
  assert.match(bad[4], /not a regular expression/);
  const errors = xpm.validateProfile({ truth: { repo: "bot" }, traces: { calls: [{ path: "/abs" }] } });
  assert.match(errors.join("\n"), /traces\.calls\[0\]\.path/);
});

test("xpm check: a step the code reports and the map lacks fails the check, steps without a call are only noted", () => {
  const { root, pipeline } = project();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-calls-cli-"));
  const file = (name, data) => { const f = path.join(dir, name); fs.writeFileSync(f, JSON.stringify(data)); return f; };
  const manifest = file("calls-bot.json", { id: "calls-bot", pipelines: [pipeline] });
  const repos = file("repos.json", { bot: root });
  const run = (profiles) => {
    try {
      return { code: 0, out: execFileSync(process.execPath, ["bin/xpm.js", "check", manifest, "--repos", repos, "--projects", file("projects.json", profiles)], { cwd: ROOT, encoding: "utf8" }) };
    } catch (err) {
      return { code: err.status, out: String(err.stdout) };
    }
  };
  const bad = run({ "calls-bot": { truth: { repo: "bot" }, traces: { calls: [{ path: "src" }] } } });
  assert.equal(bad.code, 1);
  assert.match(bad.out, /FAIL inbound/);
  assert.match(bad.out, /traced-not-on-map: extra \(src\/door\.js:4\)/);
  assert.match(bad.out, /note: 1 of 3 steps have no trace call: answer/);
  const fine = run({ "calls-bot": { truth: { repo: "bot" }, traces: { calls: [{ path: "src/wrap.ts", pattern: "\\{id:'([\\w-]+)'" }] } } });
  assert.equal(fine.code, 0);
  assert.match(fine.out, /OK {3}inbound/);
  assert.match(fine.out, /note: 2 of 3 steps have no trace call: open, sort/);
  // No profile: the check is as it always was.
  assert.equal(run({}).code, 0);
});
