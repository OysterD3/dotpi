/**
 * The one thing pi's system prompt never says: independent tool calls belong in
 * the same message.
 *
 * This is not a style preference, it is the largest single cost in a long turn,
 * and it was measured rather than assumed. In the workflow agent that ran for
 * 53 minutes on this machine:
 *
 *   151 assistant messages
 *   142 of them made EXACTLY ONE tool call
 *     7 batched (three or four calls)
 *     2 made none
 *   166 tool calls total — 73 edit, 32 write, 25 bash, 19 read, 12 grep
 *
 * So the agent was not over-exploring; it was building, one round trip at a
 * time. And a round trip is not free: that run re-read 16,310,272 cached tokens
 * across 177 turns — about 92k tokens of context per turn, whether the turn
 * carried one grep or ten. Turns, not tool calls, are what a long task costs.
 *
 * The reads, greps, finds and ls calls (58 of the 166) are almost all mutually
 * independent, and edits to files that do not overlap are too. Batching those
 * removes turns one for one.
 *
 * pi already supports it: agent-loop.js dispatches the calls in one assistant
 * message through executeToolCallsParallel unless some tool in the batch
 * declares executionMode "sequential" (ask_user does, deliberately — it blocks
 * on a human). Nothing needed building. The model simply was never told.
 *
 * Claude Code carries this instruction in its own system prompt, which is part
 * of why the same task finished there in half an hour.
 */

export const TOOL_BATCHING_GUIDELINE = [
	"## Tool calls",
	"",
	"When several tool calls do not depend on each other, make them in ONE message instead of one per message. Reading four files, grepping three patterns, or editing five files that do not overlap is a single step each time — not four steps, or three, or five. pi runs the calls in one message concurrently.",
	"",
	"This is the difference between a task that takes twenty turns and the same task taking sixty. Every turn re-sends the entire conversation, so a turn spent on one grep costs as much context as a turn spent on ten, and the cost is paid again on every turn that follows.",
	"",
	"Serialise only on a real dependency: you cannot edit a file you have not read, and you cannot run the tests before writing the code. Needing the first result to decide the second call is a dependency. Doing them one at a time because it reads more tidily is not.",
].join("\n");

/**
 * The same rule for a headless subagent, compressed.
 *
 * Subagents spawn with --no-extensions, so no extension can reach their system
 * prompt; the only channel is --append-system-prompt, where every word competes
 * with the task itself. Hence three sentences rather than the section above —
 * and no mention of turns costing context, because a subagent has no /usage to
 * look at and cannot act on the number anyway.
 */
export const SUBAGENT_BATCHING_LINE =
	"Make independent tool calls in the same message rather than one per message — several reads, several greps, or edits to files that do not overlap all go together, and they run concurrently. Only wait for a result when the next call genuinely depends on it.";
