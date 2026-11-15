// Synthetic example code for `xpm check`. Not a real bot.
async function sendReply(chat, text, runId, trace) { trace.node(runId, "reply"); return { chat, text }; }
module.exports = { sendReply };
