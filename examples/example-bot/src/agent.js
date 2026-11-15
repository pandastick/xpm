// Synthetic example code for `xpm check`. Not a real bot.
async function runAgent(message, trace) { trace.node(message.runId, "agent"); return `thinking about ${message.id}`; }
async function answerPrivately(message, trace) { trace.node(message.runId, "private-model"); return `private answer ${message.id}`; }
module.exports = { runAgent, answerPrivately };
