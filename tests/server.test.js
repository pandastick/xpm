const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("node:http");

const ROOT = path.join(__dirname, "..");
let nextPort = 4100 + Math.floor(Math.random() * 400);

// A failed check must not leave its server running: the test run would wait for it forever.
const started = [];
test.after(() => { for (const child of started) child.kill(); });

function start(env) {
  const port = nextPort++;
  const child = spawn(process.execPath, ["server.js"], { cwd: ROOT, env: { ...process.env, PORT: String(port), ...env }, stdio: ["ignore", "pipe", "pipe"] });
  started.push(child);
  let out = "";
  child.stdout.on("data", (d) => (out += d));
  child.stderr.on("data", (d) => (out += d));
  const ready = new Promise((resolve) => {
    const t = setInterval(() => { if (out.includes("running at") || child.exitCode !== null) { clearInterval(t); resolve(); } }, 25);
  });
  return { port, child, ready, log: () => out };
}

// fetch cannot set Host, and the host check is about exactly that header.
function get(port, urlPath, headers = {}, body, method) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: urlPath, method: method || (body ? "POST" : "GET"), headers: { ...(body ? { "Content-Type": "application/json" } : {}), ...headers } }, (res) => {
      let text = "";
      res.on("data", (d) => (text += d));
      res.on("end", () => resolve({ status: res.statusCode, text, json: () => JSON.parse(text) }));
    });
    req.on("error", reject);
    req.end(body ? JSON.stringify(body) : undefined);
  });
}

// Stands in for `tailscale whois --json <ip>`: two known devices, everything else unknown.
function fakeTailscale() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-ts-"));
  const bin = path.join(dir, "tailscale");
  fs.writeFileSync(bin, `#!${process.execPath}
const [cmd, flag, ip] = process.argv.slice(2);
const nodes = { "100.64.0.1": { Name: "My-Laptop.example-tailnet.ts.net.", ComputedName: "my-laptop", Hostinfo: { Hostname: "My-Laptop" } }, "100.64.0.2": { Name: "build-box.example-tailnet.ts.net.", ComputedName: "build-box" } };
if (cmd !== "whois" || flag !== "--json" || !nodes[ip]) { console.error("peer not found"); process.exit(1); }
console.log(JSON.stringify({ Node: nodes[ip], UserProfile: { LoginName: "owner@example.com" } }));
`);
  fs.chmodSync(bin, 0o755);
  return bin;
}

test("server binds loopback by default", async () => {
  const s = start({ HOST: "" });
  await s.ready;
  assert.match(s.log(), /running at http:\/\/127\.0\.0\.1:/);
  s.child.kill();
});

test("allowed logins: the right Tailscale login gets in, others and no header get 403", async () => {
  const s = start({ XPM_ALLOWED_LOGINS: "owner@example.com" });
  await s.ready;
  const url = `http://127.0.0.1:${s.port}/api/projects`;
  assert.equal((await fetch(url, { headers: { "Tailscale-User-Login": "Owner@Example.com" } })).status, 200);
  assert.equal((await fetch(url, { headers: { "Tailscale-User-Login": "someone@example.com" } })).status, 403);
  assert.equal((await fetch(url)).status, 403);
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/pipeline.html`)).status, 403);
  s.child.kill();
});

test("allowed logins refuse to start on a non-loopback HOST", async () => {
  const s = start({ HOST: "0.0.0.0", XPM_ALLOWED_LOGINS: "owner@example.com" });
  const code = await new Promise((r) => s.child.on("exit", r));
  assert.equal(code, 1);
  assert.match(s.log(), /need HOST on loopback/);
});

test("project ids cannot walk out of the manifests folder", async () => {
  const s = start({});
  await s.ready;
  assert.equal((await fetch(`http://127.0.0.1:${s.port}/api/project/..%2F..%2Fpackage`)).status, 400);
  s.child.kill();
});

test("host check: on loopback only local names and allowed hosts are answered", async () => {
  const s = start({ XPM_ALLOWED_HOSTS: "Example-Host.example-tailnet.ts.net" });
  await s.ready;
  const status = async (host) => (await get(s.port, "/api/projects", { Host: host })).status;
  assert.equal(await status(`localhost:${s.port}`), 200);
  assert.equal(await status("127.0.0.1"), 200);
  assert.equal(await status(`[::1]:${s.port}`), 200);
  assert.equal(await status("example-host.example-tailnet.ts.net:8450"), 200);
  assert.equal(await status("rebound.attacker.example"), 403);
  assert.equal(await status(`127.0.0.1.attacker.example:${s.port}`), 403);
  assert.equal((await get(s.port, "/pipeline.html", { Host: "rebound.attacker.example" })).status, 403);
  s.child.kill();
});

test("device lists: a denied device is refused, and no answer means no entry", async () => {
  const s = start({ XPM_ALLOWED_LOGINS: "owner@example.com", XPM_DENIED_NODES: "Build-Box", XPM_TAILSCALE_BIN: fakeTailscale() });
  await s.ready;
  const login = { "Tailscale-User-Login": "owner@example.com" };
  const status = async (headers) => (await get(s.port, "/api/projects", { ...login, ...headers })).status;
  assert.equal(await status({ "X-Forwarded-For": "100.64.0.1" }), 200);
  assert.equal(await status({ "X-Forwarded-For": "100.64.0.2" }), 403);
  // A caller can add entries in front; the proxy's own entry is the last one.
  assert.equal(await status({ "X-Forwarded-For": "100.64.0.1, 100.64.0.2" }), 403);
  assert.equal(await status({ "X-Forwarded-For": "100.64.0.2, 100.64.0.1" }), 200);
  assert.equal(await status({ "X-Forwarded-For": "100.64.0.9" }), 403); // tailscale does not know it
  assert.equal(await status({ "X-Forwarded-For": "--help" }), 403);
  assert.equal(await status({}), 403);
  assert.equal((await get(s.port, "/api/projects", { "X-Forwarded-For": "100.64.0.1" })).status, 403); // the login gate still applies
  s.child.kill();
});

test("device lists: with an allowed list only listed devices get in, and a missing tailscale fails closed", async () => {
  const s = start({ XPM_ALLOWED_NODES: "my-laptop.example-tailnet.ts.net", XPM_TAILSCALE_BIN: fakeTailscale() });
  await s.ready;
  const status = async (ip) => (await get(s.port, "/api/projects", { "X-Forwarded-For": ip })).status;
  assert.equal(await status("100.64.0.1"), 200);
  assert.equal(await status("100.64.0.2"), 403);
  s.child.kill();
  const broken = start({ XPM_DENIED_NODES: "build-box", XPM_TAILSCALE_BIN: path.join(os.tmpdir(), "no-such-tailscale") });
  await broken.ready;
  assert.equal((await get(broken.port, "/api/projects", { "X-Forwarded-For": "100.64.0.1" })).status, 403);
  broken.child.kill();
  const open = start({ HOST: "0.0.0.0", XPM_DENIED_NODES: "build-box" });
  assert.equal(await new Promise((r) => open.child.on("exit", r)), 1);
  assert.match(open.log(), /need HOST on loopback/);
});

test("previews are served only when the project's profile says so", async () => {
  const api = "/api/project/example-bot/pipeline/inbound";
  const on = start({});
  await on.ready;
  const shown = (await get(on.port, api)).json();
  assert.ok(shown.runs.some((r) => typeof r.preview === "string" && r.preview.length > 0));
  assert.equal(shown.scrubbedDecisions, 0);
  on.child.kill();
  // Same files on disk, but this machine's profile says previews are off.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-prof-"));
  const profiles = path.join(dir, "projects.json");
  fs.writeFileSync(profiles, JSON.stringify({ "example-bot": { truth: { repo: "example" }, traces: { previews: false } } }));
  const off = start({ XPM_PROJECTS: profiles });
  await off.ready;
  const hidden = (await get(off.port, api)).json();
  assert.equal(hidden.runs.length, 50);
  assert.ok(hidden.runs.every((r) => r.preview === null));
  off.child.kill();
});

test("simulate: the answer and the spec hold no typed text, and a bad draft or map gets the reasons", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-man-"));
  fs.writeFileSync(path.join(dir, "broken.json"), JSON.stringify({ id: "broken", name: "Broken", pipelines: [{ id: "p", name: "No steps" }, { id: "q", nodes: [{ id: "a", kind: "door" }], edges: 5 }] }));
  const s = start({ MANIFESTS_DIR: [path.join(ROOT, "manifests"), dir].join(path.delimiter) });
  await s.ready;
  const api = "/api/project/example-bot/pipeline/inbound";
  const previews = (await get(s.port, api)).json().runs.map((r) => r.preview).filter(Boolean);
  assert.ok(previews.length > 10);
  const draft = JSON.parse(fs.readFileSync(path.join(ROOT, "examples/drafts/example-bot-classifier-first.json"), "utf-8"));
  const res = await get(s.port, `${api}/simulate`, {}, draft);
  assert.equal(res.status, 200);
  assert.ok(res.json().spec.length > 100);
  for (const text of previews) assert.equal(res.text.includes(JSON.stringify(text).slice(1, -1)), false, text);

  for (const bad of [{ addNodes: 5 }, { removeEdges: [null] }, { addNodes: [{ id: "c", assume: { split: {} } }] }]) {
    const r = await get(s.port, `${api}/simulate`, {}, bad);
    assert.equal(r.status, 400, JSON.stringify(bad));
    assert.ok(r.json().errors.length > 0);
  }
  for (const pid of ["p", "q"]) {
    const map = await get(s.port, `/api/project/broken/pipeline/${pid}`);
    assert.equal(map.status, 200);
    assert.ok(map.json().check.errors.length > 0);
    assert.equal(map.json().overlay, null);
    assert.equal((await get(s.port, `/api/project/broken/pipeline/${pid}/simulate`, {}, {})).status, 400);
  }
  s.child.kill();
});

// A copy of the example bot that the test may edit, mapped under its own repo name.
function movedBot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xpm-moved-"));
  fs.cpSync(path.join(ROOT, "examples/example-bot"), path.join(dir, "code"), { recursive: true });
  const m = JSON.parse(fs.readFileSync(path.join(ROOT, "manifests/example-bot.json"), "utf-8"));
  m.id = "moved-bot";
  for (const p of m.pipelines) for (const n of p.nodes) if (n.anchor) n.anchor.repo = "moved";
  fs.mkdirSync(path.join(dir, "manifests"));
  fs.writeFileSync(path.join(dir, "manifests/moved-bot.json"), JSON.stringify(m));
  fs.writeFileSync(path.join(dir, "repos.json"), JSON.stringify({ moved: path.join(dir, "code") }));
  const env = { MANIFESTS_DIR: path.join(dir, "manifests"), XPM_REPOS: path.join(dir, "repos.json"), XPM_STATE_DIR: path.join(dir, "state"), XPM_DRAFTS_DIR: path.join(dir, "drafts"), XPM_EVENTS_DIR: path.join(dir, "events") };
  return { dir, env, api: "/api/project/moved-bot/pipeline/inbound", manifest: m };
}

test("trace calls: the answer says which steps the code reports, only when the profile says where to look", async () => {
  const f = movedBot();
  const profiles = path.join(f.dir, "projects.json");
  // No profile: nothing is claimed either way.
  const plain = start({ ...f.env, XPM_PROJECTS: profiles });
  await plain.ready;
  assert.equal((await get(plain.port, f.api)).json().check.traces, null);
  plain.child.kill();
  // The code reports a step the map lacks, and stops reporting one the map has.
  fs.appendFileSync(path.join(f.dir, "code/src/door.js"), "function audit(u, trace) { trace.node(u.runId, \"audit-log\"); }\n");
  fs.writeFileSync(path.join(f.dir, "code/src/send.js"), "async function sendReply(chat, text) { return { chat, text }; }\nmodule.exports = { sendReply };\n");
  fs.writeFileSync(profiles, JSON.stringify({ "moved-bot": { truth: { repo: "moved" }, traces: { calls: [{ path: "src" }] } } }));
  const s = start({ ...f.env, XPM_PROJECTS: profiles });
  await s.ready;
  const t = (await get(s.port, f.api)).json().check.traces;
  assert.equal(t.traced.length, 8);
  assert.deepEqual(t.traced.find((c) => c.id === "receive"), { id: "receive", file: "src/door.js", line: 3 });
  assert.equal(t.unknownCount, 1);
  assert.equal(t.unknown[0].id, "audit-log");
  assert.equal(t.unknown[0].file, "src/door.js");
  assert.deepEqual(t.untraced, ["reply"]);
  // It does not stop the map being marked as checked: that is about anchors, this is about runs.
  assert.equal((await get(s.port, `${f.api}/stamp`, { "Sec-Fetch-Site": "same-origin" }, {})).status, 200);
  s.child.kill();
  // A profile that points outside the repo is not half used.
  fs.writeFileSync(profiles, JSON.stringify({ "moved-bot": { truth: { repo: "moved" }, traces: { calls: [{ path: "../elsewhere" }] } } }));
  const bad = start({ ...f.env, XPM_PROJECTS: profiles });
  await bad.ready;
  assert.equal((await get(bad.port, f.api)).json().check.traces, null);
  bad.child.kill();
});

test("code moved: a check is kept, a changed file flags its steps, a new check clears them", async () => {
  const f = movedBot();
  const s = start(f.env);
  await s.ready;
  const before = (await get(s.port, f.api)).json();
  assert.deepEqual(before.since, { stamp: null, codeVersion: "1.4.0", changed: [], uncovered: [], files: [] });
  assert.deepEqual(before.notes, []);

  const marked = await get(s.port, `${f.api}/stamp`, {}, {});
  assert.equal(marked.status, 200);
  assert.equal(marked.json().since.stamp.how, "by hand");
  assert.equal(marked.json().since.stamp.codeVersion, "1.4.0");
  assert.equal(marked.json().since.stamp.by, "");
  assert.ok(fs.existsSync(path.join(f.dir, "state/stamps/moved-bot/inbound.json")));

  fs.appendFileSync(path.join(f.dir, "code/src/agent.js"), "// a later edit\n");
  fs.writeFileSync(path.join(f.dir, "code/VERSION"), "1.5.0\n");
  const after = (await get(s.port, f.api)).json().since;
  assert.deepEqual(after.changed.sort(), ["agent", "private-model"]);
  assert.equal(after.files.length, 1);
  assert.equal(after.files[0].file, "moved:src/agent.js");
  assert.equal(after.stamp.codeVersion, "1.4.0");
  assert.equal(after.codeVersion, "1.5.0");
  assert.ok(!JSON.stringify(after).includes(f.dir), "no folder path of this machine in the answer");

  const again = (await get(s.port, `${f.api}/stamp`, {}, {})).json().since;
  assert.deepEqual(again.changed, []);
  assert.equal(again.stamp.codeVersion, "1.5.0");
  s.child.kill();
});

test("code moved: a map that does not match the code cannot be marked as checked", async () => {
  const f = movedBot();
  fs.rmSync(path.join(f.dir, "code/src/agent.js"));
  const s = start(f.env);
  await s.ready;
  const res = await get(s.port, `${f.api}/stamp`, {}, {});
  assert.equal(res.status, 409);
  assert.match(res.json().error, /2 of 9 steps do not match the code/);
  assert.ok(!fs.existsSync(path.join(f.dir, "state")));
  assert.equal((await get(s.port, "/api/project/moved-bot/pipeline/nope/stamp", {}, {})).status, 404);
  s.child.kill();
});

test("notes: saved on steps of the map, listed newest first, deleted by id", async () => {
  const f = movedBot();
  const s = start(f.env);
  await s.ready;
  // With no login gate the header could be anyone's word, so no name is kept.
  const one = await get(s.port, `${f.api}/notes`, { "Tailscale-User-Login": "someone@example.com" }, { nodes: ["agent"], text: "why here?" });
  assert.equal(one.status, 200);
  assert.equal(one.json().notes[0].by, "");
  const two = (await get(s.port, `${f.api}/notes`, {}, { nodes: ["agent", "reply"], text: "merge these" })).json().notes;
  assert.deepEqual(two.map((n) => n.text), ["merge these", "why here?"]);
  assert.deepEqual(two[0].nodes, ["agent", "reply"]);
  assert.deepEqual((await get(s.port, f.api)).json().notes.map((n) => n.text), ["merge these", "why here?"]);

  const bad = await get(s.port, `${f.api}/notes`, {}, { nodes: ["not-a-step"], text: "x" });
  assert.equal(bad.status, 400);
  assert.match(bad.json().error, /steps on this map/);
  assert.equal((await get(s.port, `${f.api}/notes`, {}, { nodes: ["agent"], text: "   " })).status, 400);
  assert.equal((await get(s.port, `${f.api}/notes`, {}, { nodes: ["agent"], text: "x".repeat(2001) })).status, 400);

  assert.equal((await get(s.port, `${f.api}/notes/not-an-id`, {}, undefined, "DELETE")).status, 400);
  const left = await get(s.port, `${f.api}/notes/${two[0].id}`, {}, undefined, "DELETE");
  assert.equal(left.status, 200);
  assert.deepEqual(left.json().notes.map((n) => n.text), ["why here?"]);
  assert.equal(fs.statSync(path.join(f.dir, "state/notes/moved-bot.json")).mode & 0o777, 0o600);
  s.child.kill();
});

test("writes are taken only from the page itself, and only as JSON", async () => {
  const f = movedBot();
  const s = start(f.env);
  await s.ready;
  const note = { nodes: ["agent"], text: "x" };
  const host = `127.0.0.1:${s.port}`;
  const refused = [
    { Origin: "https://elsewhere.example" },
    { Origin: `http://127.0.0.1:${s.port + 1}` },
    { Origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
    { "Sec-Fetch-Site": "same-site", Origin: `http://${host}` },
  ];
  for (const headers of refused) {
    const res = await get(s.port, `${f.api}/notes`, headers, note);
    assert.equal(res.status, 403, JSON.stringify(headers));
    assert.match(res.json().error, /own page/);
    assert.equal((await get(s.port, `${f.api}/stamp`, headers, {})).status, 403);
    assert.equal((await get(s.port, `${f.api}/notes/0123456789ab`, headers, undefined, "DELETE")).status, 403);
  }
  assert.equal((await get(s.port, `${f.api}/notes`, { "Content-Type": "text/plain" }, note)).status, 415);
  assert.ok(!fs.existsSync(path.join(f.dir, "state")), "a refused write leaves nothing on disk");
  // The page itself: the browser says same-origin, or an older one sends an Origin that is this host.
  assert.equal((await get(s.port, `${f.api}/notes`, { Origin: `http://${host}` }, note)).status, 200);
  assert.equal((await get(s.port, `${f.api}/notes`, { "Sec-Fetch-Site": "same-origin", Origin: "https://the-name-a-proxy-shows.example" }, note)).status, 200);
  s.child.kill();
});

test("writes carry the login only when the login gate is on, and a state folder that cannot be written says so", async () => {
  const f = movedBot();
  const gated = start({ ...f.env, XPM_ALLOWED_LOGINS: "owner@example.com" });
  await gated.ready;
  const who = { "Tailscale-User-Login": "Owner@Example.com" };
  assert.equal((await get(gated.port, `${f.api}/notes`, who, { nodes: ["agent"], text: "mine" })).json().notes[0].by, "owner@example.com");
  assert.equal((await get(gated.port, `${f.api}/stamp`, who, {})).json().since.stamp.by, "owner@example.com");
  assert.equal((await get(gated.port, `${f.api}/notes`, {}, { nodes: ["agent"], text: "no login" })).status, 403);
  gated.child.kill();

  const blocked = path.join(f.dir, "a-file");
  fs.writeFileSync(blocked, "not a folder");
  const s = start({ ...f.env, XPM_STATE_DIR: blocked });
  await s.ready;
  const res = await get(s.port, `${f.api}/notes`, { "Tailscale-User-Login": "someone@example.com" }, { nodes: ["agent"], text: "x" });
  assert.equal(res.status, 500);
  assert.match(res.json().error, /could not write to its state folder/);
  assert.ok(!res.text.includes(f.dir));
  assert.equal((await get(s.port, f.api)).json().notes.length, 0);
  s.child.kill();
});
