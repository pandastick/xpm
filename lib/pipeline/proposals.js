// A proposal is a whole new map that someone, or an agent, wants in place of the current one.
// XPM never applies one by itself. It works out what would change by comparing the two maps (it does not take
// the proposal's word for it), checks the new map against the code, and waits for a person to accept it.
// Accepting writes the map file, keeps the map as it was, and can be undone.
//
// Files, all in XPM's state folder:
//   proposals/<project>/<pipeline>/<jobId>.json   written by whoever proposes, never changed by XPM
//   decisions/<project>/<pipeline>.json           which proposals were accepted or discarded, by whom
//   history/<project>/<pipeline>/<time>.json      the map and its check as they were before each accept

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { validatePipeline, edgeId } = require("./schema");
const { checkAnchors, BAD } = require("./check");
const { fingerprint, takeStamp } = require("./since");
const { readJson, writeJson, fileFor, plain, readStamp, writeStamp, removeStamp } = require("./state");

const MAX_BYTES = 1 << 20;   // one proposal file
const MAX_NODES = 200;       // steps in a proposed map
const MAX_READ = 30;         // proposal files looked at per pipeline, newest first
const HISTORY_KEEP = 20;     // maps kept per pipeline

/** The same map always gives the same text, whatever order its keys were written in. */
const canonical = (v) => (v === undefined ? "" : Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(",")}}` : JSON.stringify(v));
const mapSha = (pipeline) => crypto.createHash("sha256").update(canonical(pipeline)).digest("hex");

const fail = (status, message) => Object.assign(new Error(message), { status });
function folder(dir, kind, project, pid) {
  if (![project, pid].every(plain)) throw fail(400, "This project or pipeline id cannot be used as a file name, so XPM keeps no proposals for it.");
  return path.join(dir, kind, project, pid);
}
// Words from a proposal are shown on the page: one line, no control characters, a fixed length.
const line = (v, max) => (typeof v === "string" || typeof v === "number" ? String(v).replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, max) : "");

/** The files the proposed steps point at, as they are now: "repo:path" -> sha256. */
function codeOf(pipeline, repos) {
  const out = {};
  for (const [k, v] of Object.entries(fingerprint(pipeline, repos).files)) if (v) out[k] = v.sha;
  return out;
}

/** A proposal ready to be written to a file. `pipeline` is the whole proposed map. */
function makeProposal(current, proposed, repos, { jobId, changes, unsure, model, promptVersion, now = new Date() } = {}) {
  return { v: 1, jobId, createdAt: now.toISOString(), basedOnMapSha: mapSha(current), basedOnCode: codeOf(proposed, repos), ...(model ? { model } : {}), ...(promptVersion ? { promptVersion } : {}), pipeline: proposed, ...(changes ? { changes } : {}), ...(unsure ? { unsure } : {}) };
}

/** One proposal, cleaned, or null when the file is not there or is not a proposal. */
function readProposal(dir, project, pid, jobId) {
  if (!plain(jobId)) return null;
  let raw;
  try {
    const file = path.join(folder(dir, "proposals", project, pid), `${jobId}.json`);
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (typeof raw.createdAt !== "string" || !Number.isFinite(Date.parse(raw.createdAt))) raw.createdAt = st.mtime.toISOString();
  } catch {
    return null;
  }
  const code = raw && raw.basedOnCode;
  if (!raw || raw.v !== 1 || typeof raw.basedOnMapSha !== "string" || !raw.pipeline || typeof raw.pipeline !== "object" || Array.isArray(raw.pipeline)) return null;
  if (!code || typeof code !== "object" || Array.isArray(code) || !Object.values(code).every((x) => typeof x === "string")) return null;
  const list = (x, n) => (Array.isArray(x) ? x.slice(0, n) : []);
  return {
    jobId, createdAt: raw.createdAt, basedOnMapSha: raw.basedOnMapSha, basedOnCode: code, model: line(raw.model, 80), promptVersion: line(raw.promptVersion, 80),
    pipeline: raw.pipeline,
    // What the proposal says about itself. Shown beside XPM's own comparison, never instead of it.
    changes: list(raw.changes, MAX_NODES).map((c) => ({ node: line(c?.node, 80), reason: line(c?.reason, 500), evidence: list(c?.evidence, 5).map((e) => ({ file: line(e?.file, 200), lines: line(e?.lines, 40) })).filter((e) => e.file) })).filter((c) => c.node && (c.reason || c.evidence.length)),
    unsure: list(raw.unsure, 20).map((u) => line(u, 300)).filter(Boolean),
  };
}

/** What differs between two maps, worked out here. Anything that differs lands in one of these lists. */
function diffPipelines(a, b) {
  const items = (list) => (Array.isArray(list) ? list.filter((x) => x && typeof x === "object") : []);
  const index = (list, key) => new Map(items(list).map((x) => [key(x), x]));
  const split = (A, B) => {
    const out = { added: [...B.keys()].filter((k) => !A.has(k)), removed: [...A.keys()].filter((k) => !B.has(k)), changed: [] };
    for (const [k, now] of B) {
      const was = A.get(k);
      if (!was || canonical(was) === canonical(now)) continue;
      out.changed.push({ id: k, fields: [...new Set([...Object.keys(was), ...Object.keys(now)])].filter((f) => canonical(was[f]) !== canonical(now[f])).sort() });
    }
    return out;
  };
  const nodes = split(index(a.nodes, (n) => n.id), index(b.nodes, (n) => n.id));
  const edges = split(index(a.edges, edgeId), index(b.edges, edgeId));
  const other = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((k) => k !== "nodes" && k !== "edges" && canonical(a[k]) !== canonical(b[k])).sort();
  // Same steps and links, written in another order: the drawing can still move.
  const order = (x, y, key) => { const keep = new Set(items(x).map(key)); const ys = items(y).map(key).filter((k) => keep.has(k)); const has = new Set(ys); return items(x).map(key).filter((k) => has.has(k)).join("\n") !== ys.join("\n"); };
  if (order(a.nodes, b.nodes, (n) => n.id)) other.push("the order of the steps");
  if (order(a.edges, b.edges, edgeId)) other.push("the order of the links");
  const count = (x) => x.added.length + x.removed.length + x.changed.length;
  return { nodes, edges, other, total: count(nodes) + count(edges) + other.length };
}

/**
 * Can this proposal take the place of the current map? Everything here is XPM's own reading:
 * stale (the map changed since it was made), codeMoved (the code did), errors (the new map does not hold together),
 * anchors (each step against the code), diff (what would change).
 */
function checkProposal(current, proposal, repos) {
  const next = proposal.pipeline;
  const errors = [];
  if (next.id !== current.id) errors.push(`the proposal is for pipeline ${line(next.id, 80) || "?"}, not ${current.id}`);
  errors.push(...validatePipeline(next));
  if (Array.isArray(next.nodes) && next.nodes.length > MAX_NODES) errors.push(`a map holds ${MAX_NODES} steps at most, this one has ${next.nodes.length}`);
  const sound = !errors.length;
  const diff = sound ? diffPipelines(current, next) : null;
  if (diff && !diff.total) errors.push("the proposal changes nothing");
  const anchors = sound ? checkAnchors(next, repos) : [];
  const now = sound ? codeOf(next, repos) : {};
  const codeMoved = sound ? [...new Set([...Object.keys(now), ...Object.keys(proposal.basedOnCode)])].filter((k) => now[k] !== proposal.basedOnCode[k]).sort() : [];
  const stale = proposal.basedOnMapSha !== mapSha(current);
  const bad = anchors.filter((x) => BAD.has(x.status)).length;
  return { stale, codeMoved, errors: errors.slice(0, 50), anchors, bad, diff, ok: !stale && !codeMoved.length && !errors.length && !bad };
}

/** Why a proposal cannot be accepted, in one sentence. Empty when it can. */
function whyNot(check) {
  if (check.errors.length) return `The proposed map does not hold together: ${check.errors[0]}.`;
  if (check.stale) return "The map was changed after this proposal was made, so it no longer fits.";
  if (check.bad) return `${check.bad} of its steps do not match the code.`;
  if (check.codeMoved.length) return "The code changed after this proposal was made.";
  return "";
}

const decisionsFile = (dir, project, pid) => fileFor(dir, "decisions", project, pid);
function decisions(dir, project, pid) {
  const d = readJson(() => decisionsFile(dir, project, pid), null);
  return d && d.decided && typeof d.decided === "object" ? d.decided : {};
}
function decide(dir, project, pid, jobId, what, by, now) {
  const all = decisions(dir, project, pid);
  if (what) all[jobId] = { what, at: now.toISOString(), by };
  else delete all[jobId];
  writeJson(decisionsFile(dir, project, pid), { v: 1, decided: all });
}

/** The proposals nobody decided on yet, newest first, each with what it would change. */
function listProposals(dir, project, pid, current, repos) {
  let names;
  const base = folder(dir, "proposals", project, pid);
  try {
    names = fs.readdirSync(base).filter((f) => f.endsWith(".json") && plain(f.slice(0, -5))).map((f) => ({ id: f.slice(0, -5), at: fs.statSync(path.join(base, f)).mtimeMs }));
  } catch {
    return { waiting: [], unreadable: 0 };
  }
  const done = decisions(dir, project, pid);
  const waiting = [];
  let unreadable = 0;
  for (const { id } of names.filter((n) => !done[n.id]).sort((x, y) => y.at - x.at).slice(0, MAX_READ)) {
    const p = readProposal(dir, project, pid, id);
    if (!p) { unreadable += 1; continue; }
    const c = checkProposal(current, p, repos);
    const n = (x) => (c.diff ? { added: c.diff[x].added.length, removed: c.diff[x].removed.length, changed: c.diff[x].changed.length } : null);
    waiting.push({ jobId: id, createdAt: p.createdAt, model: p.model, ok: c.ok, why: whyNot(c), nodes: n("nodes"), edges: n("edges"), other: c.diff ? c.diff.other.length : 0 });
  }
  return { waiting: waiting.sort((x, y) => String(y.createdAt).localeCompare(String(x.createdAt))), unreadable };
}

// The map file keeps its place, its indent and its mode. A reader never sees half a file.
function writeManifest(file, raw, manifest) {
  const real = fs.realpathSync(file);
  const indent = (raw.match(/^\s*[{[]\r?\n([ \t]+)\S/) || [])[1] ?? (raw.includes("\n") ? 2 : 0);
  const tmp = path.join(path.dirname(real), `.${path.basename(real)}.${process.pid}.${crypto.randomBytes(4).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, indent) + (raw.endsWith("\n") ? "\n" : ""), { mode: fs.statSync(real).mode & 0o777 });
    fs.renameSync(tmp, real);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* nothing to clean */ }
    throw fail(500, `XPM could not write the map file (${err.code || "error"}). The map is as it was.`);
  }
}

function openManifest(file, pid) {
  let raw, manifest;
  try { raw = fs.readFileSync(file, "utf-8"); manifest = JSON.parse(raw); } catch { throw fail(500, "XPM could not read the map file."); }
  const at = Array.isArray(manifest.pipelines) ? manifest.pipelines.findIndex((p) => p && p.id === pid) : -1;
  if (at < 0) throw fail(404, "Pipeline not found");
  const put = (pipeline) => writeManifest(file, raw, { ...manifest, pipelines: manifest.pipelines.map((p, i) => (i === at ? pipeline : p)) });
  return { current: manifest.pipelines[at], put };
}

const historyFiles = (dir, project, pid) => {
  const base = folder(dir, "history", project, pid);
  try { return fs.readdirSync(base).filter((f) => /^[\dTZ-]+\.json$/.test(f)).sort().map((f) => path.join(base, f)); } catch { return []; }
};
function lastAccept(dir, project, pid) {
  const file = historyFiles(dir, project, pid).pop();
  const entry = file ? readJson(() => file, null) : null;
  return entry && entry.v === 1 && entry.pipeline && typeof entry.afterSha === "string" ? { file, entry } : null;
}

/**
 * Put a proposal in place of the map. Checked again here, against the map file as it is at this moment.
 * The map as it was, and its check, are kept first; then the map file is written; then the new map is marked as checked,
 * because the proposal was made from exactly the code that is there now.
 */
function acceptProposal({ dir, project, pid, jobId, manifestFile, repos, by = "", codeVersion = null, now = new Date() }) {
  const { current, put } = openManifest(manifestFile, pid);
  const proposal = readProposal(dir, project, pid, jobId);
  if (!proposal) throw fail(404, "This proposal is not there any more.");
  const was = decisions(dir, project, pid)[jobId];
  if (was) throw fail(409, `This proposal was already ${was.what}.`);
  const check = checkProposal(current, proposal, repos);
  if (!check.ok) throw fail(409, whyNot(check));
  const stamp = readStamp(dir, project, pid);
  const kept = path.join(folder(dir, "history", project, pid), `${now.toISOString().replace(/[:.]/g, "-")}.json`);
  writeJson(kept, { v: 1, at: now.toISOString(), by, jobId, pipeline: current, stamp, afterSha: mapSha(proposal.pipeline) });
  try { put(proposal.pipeline); } catch (err) { try { fs.unlinkSync(kept); } catch { /* nothing to clean */ } throw err; }
  try {
    if (check.anchors.some((x) => x.status === "ok")) writeStamp(dir, project, pid, takeStamp(proposal.pipeline, repos, { by, how: "from a proposal", codeVersion, now }));
    decide(dir, project, pid, jobId, "accepted", by, now);
    for (const old of historyFiles(dir, project, pid).slice(0, -HISTORY_KEEP)) fs.unlinkSync(old);
  } catch (err) {
    throw fail(500, `The map was updated, but XPM could not finish recording it (${err.code || "error"}). Reload the page.`);
  }
  return proposal.pipeline;
}

/** The last accept, when it can still be undone: nobody changed the map since. */
function undoInfo(dir, project, pid, current) {
  const last = lastAccept(dir, project, pid);
  return last && !last.entry.undone && last.entry.afterSha === mapSha(current) ? { at: last.entry.at, by: last.entry.by || "", jobId: last.entry.jobId } : null;
}

/** Put back the map, and its check, as they were before the last accept. The proposal waits again. */
function undoAccept({ dir, project, pid, manifestFile, by = "", now = new Date() }) {
  const { current, put } = openManifest(manifestFile, pid);
  const last = lastAccept(dir, project, pid);
  if (!last || last.entry.undone) throw fail(409, "There is nothing to undo.");
  if (last.entry.afterSha !== mapSha(current)) throw fail(409, "The map was changed after that proposal was accepted, so XPM will not put the old one back over it.");
  put(last.entry.pipeline);
  try {
    if (last.entry.stamp) writeStamp(dir, project, pid, last.entry.stamp); else removeStamp(dir, project, pid);
    writeJson(last.file, { ...last.entry, undone: { at: now.toISOString(), by } });
    decide(dir, project, pid, last.entry.jobId, null, by, now);
  } catch (err) {
    throw fail(500, `The old map is back, but XPM could not finish recording it (${err.code || "error"}). Reload the page.`);
  }
  return last.entry.pipeline;
}

function discardProposal({ dir, project, pid, jobId, by = "", now = new Date() }) {
  if (!readProposal(dir, project, pid, jobId)) throw fail(404, "This proposal is not there any more.");
  const was = decisions(dir, project, pid)[jobId];
  if (was) throw fail(409, `This proposal was already ${was.what}.`);
  decide(dir, project, pid, jobId, "discarded", by, now);
}

/** Where a proposal file goes. */
const proposalFile = (dir, project, pid, jobId) => { if (!plain(jobId)) throw fail(400, "A proposal id is a plain name: letters, digits, dot, dash, underscore."); return path.join(folder(dir, "proposals", project, pid), `${jobId}.json`); };

module.exports = { canonical, mapSha, makeProposal, readProposal, diffPipelines, checkProposal, whyNot, listProposals, acceptProposal, undoInfo, undoAccept, discardProposal, proposalFile };
