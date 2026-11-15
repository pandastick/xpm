// Synthetic example code for `xpm check`. Not a real bot.
function fastPath(message, trace) {
  const command = message.text.startsWith("/");
  trace.decide(message.runId, "fast-path", { fast: command ? "yes" : "no" });
  return command;
}
function replyToCommand(message, trace) { trace.node(message.runId, "command-reply"); return `ran ${message.text}`; }
module.exports = { fastPath, replyToCommand };
