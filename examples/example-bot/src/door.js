// Synthetic example code for `xpm check`. Not a real bot.
// Each step names itself to the tracer with the id the map uses, so Runs can light it.
function receiveUpdate(update, trace) { trace.node(update.runId, "receive"); return update; }
function isDuplicate(update, seen, trace) {
  const duplicate = seen.has(update.id);
  trace.decide(update.runId, "dedupe", { duplicate: duplicate ? "yes" : "no" });
  return duplicate;
}
module.exports = { receiveUpdate, isDuplicate };
