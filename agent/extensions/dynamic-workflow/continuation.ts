/**
 * What the parent did with a workflow result it was handed.
 *
 * Delivery and reply are two different facts. deliverResult (tool.ts) can see
 * only the first: it hands the result to pi with `triggerTurn` and the turn
 * starts. A report from another machine showed the second one failing on its
 * own — the turn started, the model ended it with no text and no tool call, and
 * the agent looked stopped until the user typed. Nothing noticed, because
 * delivery was the only thing checked.
 *
 * So index.ts reads the reply at `agent_before_settle`, pi's hook for "the run
 * is about to settle, anything to add?". It fires after pi's own retries,
 * compaction and queued messages, never after the user cancels, and runs again
 * after every continuation it asks for — which is what bounds this to one
 * retry: the second look finds the retry message as the newest input of ours,
 * not the result.
 *
 * This file is the pure half: given the run's messages, what is called for.
 */

/** The retry message: visible, so the user can see why the model was asked again. */
export const CONTINUE_MESSAGE = "workflow-continue";

/** Where ask_user announces a question opening and closing (ask-user/config.ts). */
export const ASK_CHANNEL = "ask-user:asking";

/** Says what happened and what to do; not what to write (the user wants extensions to leave output alone). */
export const CONTINUE_TEXT =
	"The workflow result above arrived, but your reply to it was empty. Continue from it. It is not a reason to start another workflow.";

export const EMPTY_AGAIN_TEXT =
	"A workflow result arrived, but the model replied with nothing, even when asked again. Send a message to continue.";

/**
 * - `answered`: the reply has text or a tool call — nothing to do.
 * - `empty`: the reply to the result is empty — send one retry.
 * - `empty-again`: the reply to that retry is empty too — show an error.
 * - `not-ours`: there is no reply to a workflow result or its retry to judge.
 */
export type Reply = "answered" | "empty" | "empty-again" | "not-ours";

type Block = { type?: string; text?: unknown };
type Message = { role?: string; customType?: string; content?: unknown; details?: unknown };

/**
 * Find the newest workflow result (or retry) and read the reply to it.
 *
 * The reply is the model's messages after it (`assistant`, `toolResult`). Any
 * other message there is an input. Before the reply starts, only the user's
 * own input makes it theirs: a note another extension sent mid-run, which pi
 * adds after the settle hooks' entries, is not an answer to anything. After
 * the reply starts, any input — the answer to a question, a Stop hook's
 * feedback, another extension's message — owns the reply that follows it, and
 * the reply to this result was judged at the settle before it.
 *
 * `status` is the run's, from the result's details: "aborted" when the user
 * cancelled the workflow.
 */
export function replyToResult(messages: readonly unknown[], resultType: string): { reply: Reply; runId?: string; status?: string } {
	const list = messages as readonly Message[];
	const at = list.findLastIndex((message) => message.role === "custom" && (message.customType === resultType || message.customType === CONTINUE_MESSAGE));
	if (at < 0) return { reply: "not-ours" };
	const input = list[at]!;
	const runId = runIdOf(input.details);
	const status = (input.details as { status?: unknown } | undefined)?.status;

	const replies: Message[] = [];
	for (const message of list.slice(at + 1)) {
		if (message.role === "assistant") replies.push(message);
		else if (message.role !== "toolResult" && (message.role === "user" || replies.length > 0)) return { reply: "not-ours" };
	}
	// No reply at all is a run that never reached the model; pi reports those.
	if (replies.length === 0) return { reply: "not-ours" };
	const reply = replies.some(visible) ? "answered" : input.customType === CONTINUE_MESSAGE ? "empty-again" : "empty";
	return { reply, runId, status: typeof status === "string" ? status : undefined };
}

/** Text that is not blank, or a tool call. Thinking alone is not seen by the user. */
function visible(message: Message): boolean {
	if (!Array.isArray(message.content)) return typeof message.content === "string" && message.content.trim() !== "";
	return (message.content as Block[]).some(
		(block) => block?.type === "toolCall" || (block?.type === "text" && typeof block.text === "string" && block.text.trim() !== ""),
	);
}

function runIdOf(details: unknown): string | undefined {
	const runId = (details as { runId?: unknown } | undefined)?.runId;
	return typeof runId === "string" ? runId : undefined;
}
