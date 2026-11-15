// Does the code report the steps the map shows?
// Runs can only light a step when the product's code names that step, with the same id, in a trace call.
// This reads the code for those calls and compares the ids with the map. It reads text, it runs nothing:
// an id built at run time is not seen, so "no trace call" means "none that names this step in plain text".

const fs = require("fs");
const path = require("path");

// The drop-in writers: trace.node(runId, "step"), trace.fail(...), trace.decide(...). Python reads the same.
const DEFAULT_PATTERN = String.raw`\.(?:node|fail|decide)\(\s*[^,()]*,\s*["']([^"']+)["']`;
const CODE = /\.(ts|tsx|js|mjs|cjs|py)$/;
const SKIP = new Set(["node_modules", "__pycache__", "venv", "dist", "build", "fixtures", "tests", "test"]);
const MAX_FILES = 2000, MAX_BYTES = 2 << 20, MAX_LINE = 2000, MAX_LISTED = 200;
const inside = (x) => typeof x === "string" && x.length > 0 && !x.startsWith("-") && !x.split("/").includes("..") && !path.isAbsolute(x);

/** Problems with a profile's traces.calls, as sentences. Empty means it can be used. */
function validateCalls(calls) {
  if (calls === undefined) return [];
  if (!Array.isArray(calls) || !calls.length) return ["traces.calls is a list of places to read, for example [{ \"path\": \"src\" }]"];
  const errors = [];
  calls.forEach((c, i) => {
    const where = `traces.calls[${i}]`;
    if (!c || typeof c !== "object" || !inside(c.path)) return errors.push(`${where}.path must be a file or folder inside the truth repo`);
    if (c.pipeline !== undefined && (typeof c.pipeline !== "string" || !c.pipeline)) errors.push(`${where}.pipeline must be a pipeline id`);
    if (c.pattern === undefined) return;
    if (typeof c.pattern !== "string" || !c.pattern || c.pattern.length > 300) return errors.push(`${where}.pattern must be a regular expression of up to 300 characters`);
    try {
      // One pair of brackets must catch the step id.
      if (new RegExp(`${c.pattern}|`).exec("").length < 2) errors.push(`${where}.pattern needs one group in brackets that catches the step id`);
    } catch {
      errors.push(`${where}.pattern is not a regular expression`);
    }
  });
  return errors;
}

function filesUnder(root, rel, out) {
  if (out.length >= MAX_FILES) return;
  const abs = path.join(root, rel);
  let st;
  try { st = fs.statSync(abs); } catch { return; }
  if (st.isFile()) { if (st.size <= MAX_BYTES) out.push(rel); return; }
  if (!st.isDirectory() || rel.split("/").length > 8) return;
  let names;
  try { names = fs.readdirSync(abs).sort(); } catch { return; }
  for (const name of names) {
    if (name.startsWith(".") || SKIP.has(name) || /backup/i.test(name)) continue;
    const r = `${rel}/${name}`;
    let s;
    try { s = fs.statSync(path.join(root, r)); } catch { continue; }
    if (s.isDirectory()) filesUnder(root, r, out);
    else if (s.isFile() && CODE.test(name) && s.size <= MAX_BYTES && out.length < MAX_FILES) out.push(r);
  }
}

/**
 * calls: [{ path, pattern?, pipeline? }] from the profile; root: the truth repo's folder.
 * unknown: step ids the code reports that the map does not have (a run would show them as ghosts).
 * untraced: steps on the map that no call names (Runs can never light them).
 * Returns null when the profile names no calls for this pipeline.
 */
function traceCalls(pipeline, root, calls) {
  const mine = (Array.isArray(calls) ? calls : []).filter((c) => c && (!c.pipeline || c.pipeline === pipeline.id));
  if (!mine.length) return null;
  if (validateCalls(mine).length) return { error: "the profile's traces.calls has problems. See Setup." };
  if (!root || !fs.existsSync(root)) return { error: "the truth repo is not on this machine, so its trace calls cannot be read" };
  const base = path.resolve(root);
  const found = new Map(); // id -> first place it is named
  const seen = new Set();
  const missing = [];
  for (const c of mine) {
    const abs = path.resolve(base, c.path);
    if (!abs.startsWith(base + path.sep) || !fs.existsSync(abs)) { missing.push(c.path); continue; }
    const files = [];
    filesUnder(base, c.path.replace(/\/+$/, ""), files);
    const re = new RegExp(c.pattern || DEFAULT_PATTERN, "g");
    for (const rel of files) {
      seen.add(rel);
      let text;
      try { text = fs.readFileSync(path.join(base, rel), "utf-8"); } catch { continue; }
      text.split("\n").forEach((line, i) => {
        if (line.length > MAX_LINE) return;
        for (const m of line.matchAll(re)) {
          const id = m[1];
          if (typeof id === "string" && id && id.length <= 120 && !found.has(id)) found.set(id, { id, file: rel, line: i + 1 });
        }
      });
    }
  }
  if (missing.length) return { error: `traces.calls names ${missing.map((x) => JSON.stringify(x)).join(", ")}, which is not in the truth repo` };
  const ids = new Set(pipeline.nodes.map((n) => n.id));
  const all = [...found.values()];
  const unknown = all.filter((c) => !ids.has(c.id));
  return {
    files: seen.size,
    traced: all.filter((c) => ids.has(c.id)),
    unknown: unknown.slice(0, MAX_LISTED),
    unknownCount: unknown.length,
    untraced: pipeline.nodes.map((n) => n.id).filter((id) => !found.has(id)),
  };
}

module.exports = { traceCalls, validateCalls, DEFAULT_PATTERN };
