#!/usr/bin/env node
// XPM command line. Same engine as the web view.
//   xpm check    <manifest.json> [--repos .xpm-repos.json] [--projects .xpm-projects.json]
//   xpm runs     <manifest.json> --pipeline ID --events DIR
//   xpm simulate <manifest.json> --pipeline ID --events DIR --draft draft.json [--spec out.md]
//   xpm propose  <manifest.json> --pipeline ID --file proposed.json --state DIR [--repos FILE] [--job ID]
//                (puts a new map in the state folder as a proposal; the page shows it and a person accepts it)
//   xpm prune    <events-dir> --days 14          (deletes old events AND previews)

const fs = require("fs");
const path = require("path");
const xpm = require("../lib/pipeline");

const ROOT = path.join(__dirname, "..");

function args(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith("--")) out[argv[i].slice(2)] = argv[i + 1], i++;
    else out._.push(argv[i]);
  }
  return out;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf-8"));
}

function pipelineOf(manifest, id) {
  const p = (manifest.pipelines || []).find((x) => x.id === id) || (!id && manifest.pipelines?.[0]);
  if (!p) throw new Error(`pipeline ${id || "(first)"} not found`);
  return p;
}

function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const a = args(rest);
  const manifestFile = a._[0];
  if (!cmd || !manifestFile) {
    console.log("usage: xpm check|runs|simulate|propose <manifest.json> [options]");
    return 2;
  }
  if (cmd === "prune") {
    const days = Number(a.days);
    if (!Number.isFinite(days) || days < 1) throw new Error("--days must be 1 or more");
    const gone = xpm.prune(manifestFile, days);
    console.log(gone.length ? gone.map((f) => `deleted ${f}`).join("\n") : "nothing older than that");
    return 0;
  }
  const manifest = readJson(manifestFile);

  if (cmd === "check") {
    const repos = xpm.loadRepos(a.repos || process.env.XPM_REPOS || path.join(ROOT, ".xpm-repos.json"));
    const report = xpm.checkManifest(manifest, repos);
    // With a profile that says where the trace calls are, the step ids in the code are compared with the map too.
    const profile = xpm.loadProfiles(a.projects || process.env.XPM_PROJECTS || path.join(ROOT, ".xpm-projects.json"))[manifest.id];
    const calls = profile && !xpm.validateProfile(profile).length ? profile.traces?.calls : null;
    for (const r of report) {
      const p = manifest.pipelines.find((x) => x.id === r.pipeline);
      const t = calls && !r.errors.length ? xpm.traceCalls(p, repos[profile.truth.repo], calls) : null;
      if (t && (t.error || t.unknownCount)) r.ok = false;
      console.log(`${r.ok ? "OK  " : "FAIL"} ${r.pipeline}`);
      r.errors.forEach((e) => console.log(`     schema: ${e}`));
      r.anchors.filter((x) => x.status !== "ok").forEach((x) => console.log(`     ${x.status}: ${x.node}${x.detail ? ` (${x.detail})` : ""}`));
      if (!t) continue;
      if (t.error) { console.log(`     trace calls: ${t.error}`); continue; }
      t.unknown.forEach((c) => console.log(`     traced-not-on-map: ${c.id} (${c.file}:${c.line})`));
      if (t.untraced.length) console.log(`     note: ${t.untraced.length} of ${p.nodes.length} steps have no trace call: ${t.untraced.join(", ")}`);
    }
    return report.every((r) => r.ok) ? 0 : 1;
  }

  if (cmd === "propose") {
    if (!a.file || !a.state) throw new Error("propose needs --file (the proposed map) and --state (XPM's state folder)");
    const current = pipelineOf(manifest, a.pipeline);
    const repos = xpm.loadRepos(a.repos || process.env.XPM_REPOS || path.join(ROOT, ".xpm-repos.json"));
    // The file is the proposed pipeline itself, or { pipeline, changes, unsure, model }.
    const given = readJson(a.file);
    const { pipeline: proposed, ...about } = given && given.pipeline && !given.nodes ? given : { pipeline: given };
    const jobId = a.job || `hand-${new Date().toISOString().replace(/[-:]|\..*/g, "")}`;
    const proposal = xpm.makeProposal(current, proposed, repos, { ...about, jobId });
    const out = xpm.proposalFile(a.state, manifest.id, current.id, jobId);
    if (fs.existsSync(out)) throw new Error(`a proposal named ${jobId} is already there`);
    const check = xpm.checkProposal(current, proposal, repos);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.writeFileSync(out, JSON.stringify(proposal, null, 1), { mode: 0o600 });
    console.log(`proposal ${jobId} written to ${out}`);
    if (check.diff) {
      const n = check.diff.nodes, e = check.diff.edges;
      console.log(`     steps: ${n.added.length} added, ${n.removed.length} removed, ${n.changed.length} changed · links: ${e.added.length} added, ${e.removed.length} removed, ${e.changed.length} changed${check.diff.other.length ? ` · also: ${check.diff.other.join(", ")}` : ""}`);
    }
    console.log(check.ok ? "     it can be accepted on the page" : `     it cannot be accepted: ${xpm.whyNot(check)}`);
    return check.ok ? 0 : 1;
  }

  const p = pipelineOf(manifest, a.pipeline);
  const { events, rejected, scrubbed } = xpm.loadEvents(a.events, p.id, { pipeline: p });
  if (rejected.length) console.error(`${rejected.length} event lines rejected (first: ${rejected[0].reason})`);
  if (scrubbed) console.error(`${scrubbed} decision values dropped or read as "other" (not a label this map names)`);
  const runs = xpm.foldRuns(events);

  if (cmd === "runs") {
    console.log(JSON.stringify(xpm.overlay(p, runs), null, 2));
    return 0;
  }
  if (cmd === "simulate") {
    const draft = readJson(a.draft);
    const result = xpm.simulate(p, draft, runs);
    if (!result.ok) {
      result.errors.forEach((e) => console.error(`draft: ${e}`));
      return 1;
    }
    const spec = xpm.draftToSpec(p, draft, result);
    if (a.spec) fs.writeFileSync(a.spec, spec);
    console.log(spec);
    return 0;
  }
  console.log(`unknown command ${cmd}`);
  return 2;
}

try {
  process.exitCode = main();
} catch (err) {
  console.error(err.message);
  process.exitCode = 2;
}
