// Synthetic example code for `xpm check`. Not a real bot.
function currentMode(chat, runId, trace) {
  const mode = chat.mode || "normal";
  trace.decide(runId, "mode-gate", { mode });
  return mode;
}
function holdForPlanner(message, queue, trace) { trace.node(message.runId, "planner-hold"); queue.push(message); }
module.exports = { currentMode, holdForPlanner };
