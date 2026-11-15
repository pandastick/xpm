// Has the code moved on since someone last said "this map matches it"?
// A stamp keeps one fingerprint per file the steps point at. Comparing fingerprints is exact and reads no meaning:
// it says WHICH files changed, never whether the map is still right. That is for a person (or a proposal they accept).

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const keyOf = (a) => `${a.repo}:${a.path}`;
const sha = (buf) => crypto.createHash("sha256").update(buf).digest("hex");

/** The file an anchor points at, or null when it is not a readable file inside its repo. */
function anchorFile(anchor, repos) {
  const root = repos[anchor.repo];
  if (!root) return null;
  const abs = path.resolve(root, anchor.path);
  if (!abs.startsWith(path.resolve(root) + path.sep)) return null;
  try {
    const st = fs.statSync(abs);
    return st.isFile() ? { abs, mtime: st.mtime.toISOString() } : null;
  } catch {
    return null;
  }
}

/** files: "repo:path" -> { sha, mtime } or null when unreadable. nodes: step id -> "repo:path". */
function fingerprint(pipeline, repos) {
  const files = {}, nodes = {};
  for (const n of pipeline.nodes) {
    if (!n.anchor) continue;
    const k = keyOf(n.anchor);
    nodes[n.id] = k;
    if (k in files) continue;
    const f = anchorFile(n.anchor, repos);
    try { files[k] = f ? { sha: sha(fs.readFileSync(f.abs)), mtime: f.mtime } : null; } catch { files[k] = null; }
  }
  return { files, nodes };
}

/** A stamp: "at this moment the map matched the code", with who said so and how. */
function takeStamp(pipeline, repos, { by = "", how = "by hand", codeVersion = null, now = new Date() } = {}) {
  const fp = fingerprint(pipeline, repos);
  const files = {};
  for (const [k, v] of Object.entries(fp.files)) if (v) files[k] = v.sha;
  return { v: 1, pipeline: pipeline.id, takenAt: now.toISOString(), by, how, codeVersion, files, nodes: fp.nodes };
}

/**
 * What differs from the stamp, per file and per step.
 * changed: steps whose file has other bytes now, or is gone. uncovered: steps the stamp never saw at this anchor
 * (added to the map, or pointed at another file, after the check).
 */
function compareStamp(pipeline, repos, stamp) {
  const now = fingerprint(pipeline, repos);
  const byFile = new Map();
  const changed = [], uncovered = [];
  for (const n of pipeline.nodes) {
    const k = now.nodes[n.id];
    if (!k) continue;
    if ((stamp.nodes || {})[n.id] !== k || !(k in (stamp.files || {}))) { uncovered.push(n.id); continue; }
    const cur = now.files[k];
    if (cur && cur.sha === stamp.files[k]) continue;
    changed.push(n.id);
    if (!byFile.has(k)) byFile.set(k, { file: k, state: cur ? "changed" : "gone", changedAt: cur ? cur.mtime : null, nodes: [] });
    byFile.get(k).nodes.push(n.id);
  }
  return { changed, uncovered, files: [...byFile.values()].sort((a, b) => a.file.localeCompare(b.file)) };
}

/**
 * The release the code says it is, when it says so in a file: package.json's "version", or the first thing
 * that reads like a version number in a VERSION file (or the file the profile names). Null when it does not say.
 */
function codeVersion(root, versionFile) {
  if (!root) return null;
  for (const rel of versionFile ? [versionFile] : ["package.json", "VERSION"]) {
    const abs = path.resolve(root, rel);
    if (!abs.startsWith(path.resolve(root) + path.sep)) continue;
    let text;
    try {
      if (!fs.statSync(abs).isFile()) continue;
      const fd = fs.openSync(abs, "r");
      const buf = Buffer.alloc(65536);
      text = buf.toString("utf-8", 0, fs.readSync(fd, buf, 0, buf.length, 0));
      fs.closeSync(fd);
    } catch {
      continue;
    }
    let found = null;
    if (rel.endsWith(".json")) { try { found = JSON.parse(text).version; } catch { found = null; } }
    else found = (text.slice(0, 2000).match(/(?<![\w.])v?\d+(?:\.\d+){1,3}(?:-[A-Za-z0-9.]{1,16})?(?![\w])/) || [])[0];
    if (typeof found === "string" && /^[\w.+-]{1,40}$/.test(found)) return found.replace(/^v/, "");
  }
  return null;
}

module.exports = { fingerprint, takeStamp, compareStamp, codeVersion };
