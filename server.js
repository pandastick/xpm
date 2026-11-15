const express = require("express");
const fs = require("fs");
const path = require("path");
const os = require("os");
const net = require("net");
const { execFile } = require("child_process");

// Load .env file if it exists (no dependency needed)
const envPath = path.join(__dirname, ".env");
if (fs.existsSync(envPath)) {
  fs.readFileSync(envPath, "utf-8").split("\n").forEach((line) => {
    const match = line.match(/^\s*([\w]+)\s*=\s*(.+?)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  });
}

const app = express();
const PORT = process.env.PORT || 3333;
// Loopback by default: put a proxy (tailscale serve) in front to reach it from elsewhere.
const HOST = process.env.HOST || "127.0.0.1";
const list = (v) => (v || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
// Behind tailscale serve: only these Tailscale logins get in (comma separated). Tagged devices send no login, so they are refused.
const ALLOWED_LOGINS = list(process.env.XPM_ALLOWED_LOGINS);
// One login can own many devices. These lists let in, or keep out, single devices by their Tailscale name.
const nodeLabel = (name) => String(name || "").toLowerCase().split(".")[0];
const ALLOWED_NODES = list(process.env.XPM_ALLOWED_NODES).map(nodeLabel);
const DENIED_NODES = list(process.env.XPM_DENIED_NODES).map(nodeLabel);
// Host names a browser may use for this server besides localhost: the name the proxy serves it under.
const ALLOWED_HOSTS = list(process.env.XPM_ALLOWED_HOSTS);
const TAILSCALE_BIN = process.env.XPM_TAILSCALE_BIN || "tailscale";
const LOOPBACK = ["127.0.0.1", "::1", "localhost"].includes(HOST);
// One folder or several, separated like PATH (":" on macOS and Linux). The first folder that has a project wins.
const MANIFESTS_DIRS = (process.env.MANIFESTS_DIR || path.join(__dirname, "manifests")).split(path.delimiter).filter(Boolean);
const manifestPath = (id) => MANIFESTS_DIRS.map((d) => path.join(d, `${id}.json`)).find((f) => fs.existsSync(f)) || path.join(MANIFESTS_DIRS[0], `${id}.json`);
function manifestFiles() {
  const seen = new Map();
  for (const d of MANIFESTS_DIRS) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d).filter((x) => x.endsWith(".json"))) if (!seen.has(f)) seen.set(f, path.join(d, f));
  }
  return [...seen.values()];
}
// Private execution events and drafts live outside git (see .gitignore). Examples ship under examples/.
const EVENTS_DIR = process.env.XPM_EVENTS_DIR || path.join(__dirname, "events");
const DRAFTS_DIR = process.env.XPM_DRAFTS_DIR || path.join(__dirname, "drafts");
// What XPM writes itself: stamps and notes. Beside the drafts folder unless XPM_STATE_DIR says otherwise.
const STATE_DIR = process.env.XPM_STATE_DIR || path.join(path.dirname(DRAFTS_DIR), "state");
const REPOS_FILE = process.env.XPM_REPOS || path.join(__dirname, ".xpm-repos.json");
// Per project: where the code really lives (truth), what to compare it with (mirror), and how XPM is set up for it.
const PROFILES_FILE = process.env.XPM_PROJECTS || path.join(__dirname, ".xpm-projects.json");
const EXAMPLES = path.join(__dirname, "examples");
const ID_RE = /^[a-z0-9][a-z0-9_-]{0,80}$/i;
const xpm = require("./lib/pipeline");

// The proxy's headers are only trustworthy when nothing but the local proxy can reach this server.
const GATED = ALLOWED_LOGINS.length + ALLOWED_NODES.length + DENIED_NODES.length > 0;
if (GATED && !LOOPBACK) {
  console.error("  Refusing to start: XPM_ALLOWED_LOGINS, XPM_ALLOWED_NODES and XPM_DENIED_NODES need HOST on loopback, or the proxy's headers can be forged.");
  process.exit(1);
}
const refuse = (res, why) => res.status(403).type("text/plain").send(`XPM: ${why}`);

// On loopback, a web page that points its own name at 127.0.0.1 must not be able to read the API (DNS rebinding).
if (LOOPBACK) {
  const names = new Set(["localhost", "127.0.0.1", "[::1]", ...ALLOWED_HOSTS]);
  app.use((req, res, next) => {
    const name = String(req.headers.host || "").toLowerCase().replace(/:\d+$/, "");
    if (names.has(name)) return next();
    refuse(res, "this host name is not allowed. Add it to XPM_ALLOWED_HOSTS.");
  });
}
if (ALLOWED_LOGINS.length) {
  app.use((req, res, next) => {
    const login = String(req.get("Tailscale-User-Login") || "").toLowerCase();
    if (ALLOWED_LOGINS.includes(login)) return next();
    refuse(res, "this Tailscale login is not allowed.");
  });
}

// Which device is calling: the proxy puts the caller's tailnet address last in X-Forwarded-For, and tailscale names it.
const whoCache = new Map();
function nodeNames(ip) {
  const hit = whoCache.get(ip);
  if (hit && Date.now() - hit.at < hit.ttl) return hit.names;
  const entry = { at: Date.now(), ttl: 60000 };
  entry.names = new Promise((resolve) => {
    execFile(TAILSCALE_BIN, ["whois", "--json", ip], { timeout: 3000, maxBuffer: 1 << 20 }, (err, stdout) => {
      let names = null;
      try {
        const node = err ? null : JSON.parse(stdout).Node;
        if (node) names = [node.Name, node.ComputedName, node.Hostinfo && node.Hostinfo.Hostname].map(nodeLabel).filter(Boolean);
      } catch {
        names = null;
      }
      if (!names || !names.length) { names = null; entry.ttl = 5000; } // ask again soon after a failure
      resolve(names);
    });
  });
  if (whoCache.size >= 500) whoCache.delete(whoCache.keys().next().value);
  whoCache.set(ip, entry);
  return entry.names;
}
if (ALLOWED_NODES.length || DENIED_NODES.length) {
  app.use(async (req, res, next) => {
    const ip = String(req.get("X-Forwarded-For") || "").split(",").pop().trim();
    // No answer means no entry: a device nobody can name is refused.
    if (!net.isIP(ip)) return refuse(res, "the proxy did not say which device is calling.");
    const names = await nodeNames(ip);
    if (!names) return refuse(res, "tailscale could not name this device.");
    if (names.some((n) => DENIED_NODES.includes(n))) return refuse(res, "this device is not allowed.");
    if (ALLOWED_NODES.length && !names.some((n) => ALLOWED_NODES.includes(n))) return refuse(res, "this device is not allowed.");
    next();
  });
}

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json({ limit: "200kb" }));

// Ids become file names: only plain ids, never paths.
app.param("id", (req, res, next, id) => (ID_RE.test(id) ? next() : res.status(400).json({ error: "Bad project id" })));
app.param("pid", (req, res, next, id) => (ID_RE.test(id) ? next() : res.status(400).json({ error: "Bad pipeline id" })));

function readManifest(id) {
  const filePath = manifestPath(id);
  if (!fs.existsSync(filePath)) return null;
  return JSON.parse(fs.readFileSync(filePath, "utf-8"));
}

function findPipeline(req, res) {
  let manifest;
  try {
    manifest = readManifest(req.params.id);
  } catch (err) {
    res.status(500).json({ error: `Invalid JSON: ${err.message}` });
    return null;
  }
  const pipeline = manifest && (manifest.pipelines || []).find((p) => p.id === req.params.pid);
  if (!pipeline) {
    res.status(404).json({ error: "Pipeline not found" });
    return null;
  }
  return { manifest, pipeline };
}

// Real events win; the example project falls back to its synthetic events.
function eventsDirFor(project) {
  const real = path.join(EVENTS_DIR, project);
  if (fs.existsSync(real)) return real;
  const example = path.join(EXAMPLES, "events", project);
  return project.startsWith("example-") && fs.existsSync(example) ? example : null;
}

// The example project always finds its synthetic repo; a local repos file adds the real ones.
function reposFor(project) {
  const example = project.startsWith("example-") ? xpm.loadRepos(path.join(__dirname, ".xpm-repos.example.json")) : {};
  return { ...example, ...xpm.loadRepos(REPOS_FILE) };
}

// Writes are taken only from XPM's own page: another site, or another service on the same host name, is refused.
function ownPage(req, res, next) {
  const no = () => res.status(403).json({ error: "Writes are only taken from XPM's own page." });
  // The browser sets Sec-Fetch-Site itself and a page cannot fake it. Older browsers send only Origin.
  const site = req.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return no();
  const origin = req.get("Origin");
  if (origin && site !== "same-origin") {
    let host = null;
    try { host = new URL(origin).host; } catch { host = null; }
    if (host !== String(req.headers.host || "").toLowerCase()) return no();
  }
  if (req.method === "POST" && !req.is("application/json")) return res.status(415).json({ error: "Send JSON." });
  next();
}
// The login is only known, and only trusted, when the login gate is on.
const who = (req) => (ALLOWED_LOGINS.length ? String(req.get("Tailscale-User-Login") || "").toLowerCase().slice(0, 80) : "");
// A write that fails says so in plain words, without the folder's full path.
const writeFailed = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : `XPM could not write to its state folder (${err.code || "error"}). Check XPM_STATE_DIR on the machine XPM runs on.` });

// The version the code gives itself, read from the truth repo. With no profile: from the one repo every step points at.
function versionFor(pipeline, repos, profile) {
  const used = [...new Set((pipeline.nodes || []).map((n) => n.anchor?.repo).filter(Boolean))];
  const repo = profile?.truth?.repo || (used.length === 1 ? used[0] : null);
  return xpm.codeVersion(repos[repo], profile?.truth?.versionFile);
}

// Which steps the code reports to the tracer, read from the truth repo. Null when the profile names no trace calls.
function traceCallsFor(project, pipeline) {
  const profile = profileFor(project);
  if (!profile?.traces?.calls || xpm.validateProfile(profile).length) return null;
  return xpm.traceCalls(pipeline, reposFor(project)[profile.truth.repo], profile.traces.calls);
}

// Proposals: whole new maps waiting for a yes. Accepting writes the map file, so it is off unless this machine's
// profile for the project says the map may be written here.
const ACCEPT_OFF = "Accepting is off for this project on this machine: its profile does not say that XPM may write the map file here.";
function mapWritable(project) {
  const profile = profileFor(project);
  return !!profile && profile.map?.writable === true && !xpm.validateProfile(profile).length;
}
function proposalsFor(project, pipeline) {
  try {
    return { ...xpm.listProposals(STATE_DIR, project, pipeline.id, pipeline, reposFor(project)), canAccept: mapWritable(project), undo: mapWritable(project) ? xpm.undoInfo(STATE_DIR, project, pipeline.id, pipeline) : null };
  } catch {
    return { waiting: [], unreadable: 0, canAccept: false, undo: null };
  }
}
// A change to the map file answers in plain words; anything unexpected says only that it failed.
const changeFailed = (res, err) => res.status(err.status || 500).json({ error: err.status ? err.message : `XPM could not finish this (${err.code || "error"}).` });

// What moved in the code since the map was last marked as checked
function sinceFor(project, pipeline) {
  const repos = reposFor(project);
  const profile = profileFor(project);
  const stamp = xpm.readStamp(STATE_DIR, project, pipeline.id);
  const diff = stamp ? xpm.compareStamp(pipeline, repos, stamp) : { changed: [], uncovered: [], files: [] };
  return {
    stamp: stamp ? { takenAt: stamp.takenAt, by: stamp.by || "", how: stamp.how || "", codeVersion: stamp.codeVersion || null } : null,
    codeVersion: versionFor(pipeline, repos, profile),
    ...diff,
  };
}

// List all available project manifests
app.get("/api/projects", (req, res) => {
  const files = manifestFiles();
  const projects = [];

  files.forEach((f) => {
    try {
      const data = JSON.parse(fs.readFileSync(f, "utf-8"));
      projects.push({
        id: data.id,
        name: data.name,
        description: data.description,
        tech: data.tech,
        screenCount: data.screens?.length || 0,
        entityCount: data.entities?.length || 0,
        pipelineCount: data.pipelines?.length || 0,
      });
    } catch (err) {
      console.error(`  Error reading ${f}: ${err.message}`);
    }
  });

  res.json(projects);
});

// Get a specific project manifest
app.get("/api/project/:id", (req, res) => {
  const filePath = manifestPath(req.params.id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Project not found" });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: `Invalid JSON: ${err.message}` });
  }
});

function profileFor(project) {
  const example = project.startsWith("example-") ? xpm.loadProfiles(path.join(__dirname, ".xpm-projects.example.json")) : {};
  return { ...example, ...xpm.loadProfiles(PROFILES_FILE) }[project] || null;
}

// Comparing two trees reads every file: keep the answer 10 minutes, or until ?refresh=1.
const mirrorCache = new Map();
function mirrorFor(project, profile, repos) {
  if (!profile?.mirror) return null;
  const hit = mirrorCache.get(project);
  if (hit && Date.now() - hit.at < 600000) return hit.data;
  const m = profile.mirror;
  const checkout = repos[m.checkout] || (path.isAbsolute(m.checkout) ? m.checkout : null);
  const truthRoot = repos[profile.truth?.repo];
  let data;
  if (!checkout || !truthRoot) data = { error: `${!checkout ? `mirror checkout ${m.checkout}` : `truth repo ${profile.truth?.repo}`} is not in the repos file on this machine` };
  else {
    try { data = xpm.compareMirror({ truthRoot, checkout, ref: m.ref, paths: m.paths, prefix: m.prefix, fetch: !!m.fetch, ignore: m.ignore }); }
    catch (err) { data = { error: `compare failed: ${String(err.message).split("\n")[0].slice(0, 160)}` }; }
  }
  mirrorCache.set(project, { at: Date.now(), data });
  return data;
}

// Setup: the six settings of a project, with what is true on this machine
app.get("/api/project/:id/source", (req, res) => {
  const profile = profileFor(req.params.id);
  const errors = profile ? xpm.validateProfile(profile) : [];
  const repos = reposFor(req.params.id);
  if (req.query.refresh) mirrorCache.delete(req.params.id);
  const mirror = errors.length ? null : mirrorFor(req.params.id, profile, repos);
  const facts = xpm.setupFacts(errors.length ? null : profile, {
    repos, mirror, hostname: os.hostname(), eventsDir: eventsDirFor(req.params.id),
    allowedLogins: ALLOWED_LOGINS.length, allowedNodes: ALLOWED_NODES.length, deniedNodes: DENIED_NODES.length, allowedHosts: ALLOWED_HOSTS.length,
    loopback: LOOPBACK, proxied: ["x-forwarded-for", "x-forwarded-host", "forwarded", "tailscale-user-login"].some((h) => req.headers[h] !== undefined),
  });
  const cap = (list) => (list || []).slice(0, 100);
  res.json({
    configured: facts.configured, errors, rows: facts.rows,
    mirror: mirror && !mirror.error ? { ...mirror, differ: cap(mirror.differ), onlyTruth: cap(mirror.onlyTruth), onlyMirror: cap(mirror.onlyMirror) } : mirror,
    generatedAt: new Date().toISOString(),
  });
});

// Pipeline: the map, its code check, and the last runs laid over it
app.get("/api/project/:id/pipeline/:pid", (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  const { pipeline } = found;
  const errors = xpm.validatePipeline(pipeline);
  // A map that does not hold together is answered with the reasons, never laid out or lit up.
  if (errors.length) {
    return res.json({ pipeline, check: { errors, anchors: [] }, overlay: null, runs: [], rejectedEvents: 0, scrubbedDecisions: 0, generatedAt: new Date().toISOString() });
  }
  const anchors = xpm.checkAnchors(pipeline, reposFor(req.params.id));
  const dir = eventsDirFor(req.params.id);
  const { events, rejected, scrubbed } = xpm.loadEvents(dir, pipeline.id, { pipeline });
  const last50 = xpm.foldRuns(events).slice(0, 50);
  // What the person typed is attached here, for the runs list only, and only when the project's profile says previews are on.
  // It never enters simulate or a spec.
  const previews = profileFor(req.params.id)?.traces?.previews === true ? xpm.loadPreviews(dir) : new Map();
  res.json({
    pipeline,
    check: { errors, anchors, traces: traceCallsFor(req.params.id, pipeline) },
    overlay: xpm.overlay(pipeline, last50),
    runs: last50.map((r) => ({ ...r, preview: previews.get(r.runId) ?? null })),
    rejectedEvents: rejected.length,
    scrubbedDecisions: scrubbed,
    since: sinceFor(req.params.id, pipeline),
    notes: xpm.readNotes(STATE_DIR, req.params.id, pipeline.id),
    mapSha: xpm.mapSha(pipeline),
    proposals: proposalsFor(req.params.id, pipeline),
    generatedAt: new Date().toISOString(),
  });
});

// "The map matches the code as it is now": keeps a fingerprint of every file the steps point at.
// Refused while any step does not match the code, because then the map plainly does not match.
app.post("/api/project/:id/pipeline/:pid/stamp", ownPage, (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  const { pipeline } = found;
  if (xpm.validatePipeline(pipeline).length) return res.status(409).json({ error: "This map has errors. Fix them first." });
  const anchors = xpm.checkAnchors(pipeline, reposFor(req.params.id));
  const bad = anchors.filter((a) => xpm.BAD.has(a.status)).length;
  if (bad) return res.status(409).json({ error: `${bad} of ${anchors.length} steps do not match the code. Fix the map first.` });
  if (!anchors.some((a) => a.status === "ok")) return res.status(409).json({ error: "No step on this map points at code, so there is nothing to check it against." });
  const profile = profileFor(req.params.id);
  const repos = reposFor(req.params.id);
  try {
    xpm.writeStamp(STATE_DIR, req.params.id, pipeline.id, xpm.takeStamp(pipeline, repos, { by: who(req), how: "by hand", codeVersion: versionFor(pipeline, repos, profile) }));
  } catch (err) {
    return writeFailed(res, err);
  }
  res.json({ since: sinceFor(req.params.id, pipeline) });
});

// Notes on steps: what someone wants to remember, ask or change. Kept in XPM's state folder, never in the project.
app.post("/api/project/:id/pipeline/:pid/notes", ownPage, (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  const { pipeline } = found;
  const errors = [...xpm.validatePipeline(pipeline).slice(0, 1).map(() => "This map has errors. Fix them first."), ...xpm.validateNote(pipeline, req.body)];
  if (errors.length) return res.status(400).json({ error: errors.join("; ") });
  try {
    xpm.addNote(STATE_DIR, req.params.id, pipeline.id, { nodes: req.body.nodes, text: req.body.text, by: who(req) });
  } catch (err) {
    return writeFailed(res, err);
  }
  res.json({ notes: xpm.readNotes(STATE_DIR, req.params.id, pipeline.id) });
});

app.delete("/api/project/:id/pipeline/:pid/notes/:nid", ownPage, (req, res) => {
  if (!/^[0-9a-f]{12}$/.test(req.params.nid)) return res.status(400).json({ error: "Bad note id" });
  const found = findPipeline(req, res);
  if (!found) return;
  try {
    xpm.removeNote(STATE_DIR, req.params.id, found.pipeline.id, req.params.nid);
  } catch (err) {
    return writeFailed(res, err);
  }
  res.json({ notes: xpm.readNotes(STATE_DIR, req.params.id, found.pipeline.id) });
});

// One proposal: the proposed map, what XPM found when it compared and checked it, and what the proposal says about itself.
app.param("jid", (req, res, next, id) => (/^[A-Za-z0-9][\w.-]{0,79}$/.test(id) ? next() : res.status(400).json({ error: "Bad proposal id" })));
app.get("/api/project/:id/pipeline/:pid/proposals/:jid", (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  let proposal;
  try { proposal = xpm.readProposal(STATE_DIR, req.params.id, found.pipeline.id, req.params.jid); } catch (err) { return changeFailed(res, err); }
  if (!proposal) return res.status(404).json({ error: "This proposal is not there any more." });
  const check = xpm.checkProposal(found.pipeline, proposal, reposFor(req.params.id));
  const { pipeline, basedOnCode, ...about } = proposal;
  res.json({ proposal: about, pipeline, check: { ...check, why: xpm.whyNot(check) }, canAccept: mapWritable(req.params.id) });
});

// Accept: the proposal takes the place of the map. Checked again at this moment, written to the map file,
// the old map kept. Never done by XPM on its own: only this route does it, from XPM's own page.
app.post("/api/project/:id/pipeline/:pid/proposals/:jid/accept", ownPage, (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  if (!mapWritable(req.params.id)) return res.status(403).json({ error: ACCEPT_OFF });
  const repos = reposFor(req.params.id);
  try {
    xpm.acceptProposal({ dir: STATE_DIR, project: req.params.id, pid: found.pipeline.id, jobId: req.params.jid, manifestFile: manifestPath(req.params.id), repos, by: who(req), codeVersion: versionFor(found.pipeline, repos, profileFor(req.params.id)) });
  } catch (err) {
    return changeFailed(res, err);
  }
  res.json({ ok: true });
});

app.post("/api/project/:id/pipeline/:pid/proposals/:jid/discard", ownPage, (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  try {
    xpm.discardProposal({ dir: STATE_DIR, project: req.params.id, pid: found.pipeline.id, jobId: req.params.jid, by: who(req) });
  } catch (err) {
    return err.status ? changeFailed(res, err) : writeFailed(res, err);
  }
  res.json({ ok: true });
});

// Undo the last accept: the map and its check go back to what they were, unless the map was changed since.
app.post("/api/project/:id/pipeline/:pid/undo", ownPage, (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  if (!mapWritable(req.params.id)) return res.status(403).json({ error: ACCEPT_OFF });
  try {
    xpm.undoAccept({ dir: STATE_DIR, project: req.params.id, pid: found.pipeline.id, manifestFile: manifestPath(req.params.id), by: who(req) });
  } catch (err) {
    return changeFailed(res, err);
  }
  res.json({ ok: true });
});

// Drafts saved for a pipeline (private folder, examples for the example project)
app.get("/api/project/:id/pipeline/:pid/drafts", (req, res) => {
  const dirs = [path.join(DRAFTS_DIR, req.params.id)];
  if (req.params.id.startsWith("example-")) dirs.push(path.join(EXAMPLES, "drafts"));
  const drafts = [];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith(".json"))) {
      try {
        const d = JSON.parse(fs.readFileSync(path.join(dir, f), "utf-8"));
        const savedAt = fs.statSync(path.join(dir, f)).mtime.toISOString();
        if (!d.pipeline || d.pipeline === req.params.pid) drafts.push({ ...d, file: f, savedAt });
      } catch (err) {
        console.error(`  Error reading draft ${f}: ${err.message}`);
      }
    }
  }
  res.json(drafts);
});

// What-if: replay the recorded runs through a draft. Nothing is written.
app.post("/api/project/:id/pipeline/:pid/simulate", (req, res) => {
  const found = findPipeline(req, res);
  if (!found) return;
  const draft = req.body && typeof req.body === "object" ? req.body : {};
  // Check the map and the draft before any run is read: a bad one is refused with the reasons.
  const bad = [...xpm.validatePipeline(found.pipeline), ...xpm.validateDraft(draft)];
  if (bad.length) return res.status(400).json({ ok: false, errors: bad });
  const runs = xpm.foldRuns(xpm.loadEvents(eventsDirFor(req.params.id), found.pipeline.id, { pipeline: found.pipeline }).events);
  const result = xpm.simulate(found.pipeline, draft, runs);
  if (!result.ok) return res.status(400).json(result);
  // Only the runs that change route travel back; that is all the result table needs.
  res.json({ ...result, perRun: result.perRun.filter((r) => r.changed), spec: xpm.draftToSpec(found.pipeline, draft, result) });
});

// Validate a manifest (re-reads and reports stats)
app.post("/api/regenerate/:id", (req, res) => {
  const filePath = manifestPath(req.params.id);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ success: false, error: "Manifest not found" });
  }
  try {
    const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
    const stats = {
      sections: data.sections?.length || 0,
      screens: data.screens?.length || 0,
      entities: data.entities?.length || 0,
      relationships: data.relationships?.length || 0,
      flows: data.flows?.length || 0,
    };
    res.json({ success: true, stats });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.listen(PORT, HOST, () => {
  const count = manifestFiles().length;
  const gates = [ALLOWED_LOGINS.length ? `Tailscale logins: ${ALLOWED_LOGINS.length}` : "", ALLOWED_NODES.length ? `devices allowed: ${ALLOWED_NODES.length}` : "", DENIED_NODES.length ? `devices refused: ${DENIED_NODES.length}` : ""].filter(Boolean).join(", ");
  console.log(`\n  XPM (Xcali Project Mapper) running at http://${HOST}:${PORT}${gates ? ` (${gates})` : ""}`);
  console.log(`  Manifests: ${MANIFESTS_DIRS.join(", ")} (${count} projects)\n`);
});
