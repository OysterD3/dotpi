/**
 * Prompts for /goal.
 *
 * The exact wording here is load-bearing: it is what makes the judge quote
 * evidence instead of vibing, and what keeps "impossible" rare. Treat changes to
 * these strings as behaviour changes, not copy edits.
 */

/** System prompt for the evaluator. */
export const JUDGE_SYSTEM = `You are evaluating a stop-condition hook in pi. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".

Reply with the JSON object and nothing else.`;

/** The question put to the evaluator, after the transcript. */
export function judgeQuestion(condition: string): string {
	return `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`;
}

/**
 * Injected when a goal is set, to start work immediately instead of asking the
 * user what to do.
 */
export function goalSetInstruction(condition: string): string {
	return `A session-scoped goal check is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The check will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

/**
 * Fed back when the condition is not yet met, to resume work.
 *
 * The header names the mechanism and the brackets name the condition that
 * blocked, so the model can tell this apart from something the user typed. The
 * explicit "keep going" is needed because pi has no blocking channel: a blocked
 * stop would resume by definition, but a follow-up message does not.
 */
export function notMetInstruction(condition: string, reason: string): string {
	return `Goal check feedback:

[${condition}]: ${reason}

The goal is not met yet. Continue working toward it. Do not stop to ask the user what to do next.`;
}

/** Notice when the transcript had to be trimmed. */
export const TRUNCATION_NOTICE = (dropped: number) =>
	`[Earlier conversation truncated to fit the hook evaluator's context window — ${dropped} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`;

/**
 * System prompt for `goal.autoCapture`'s extraction call: reads one user
 * message (never a transcript — see judge.ts's extractCriteria) and decides
 * whether it already states a stop condition worth holding the agent to.
 *
 * "Err toward null" is the load-bearing instruction. A false negative costs
 * nothing pi did not already cost before this feature existed: the agent works
 * unchecked, as it always has. A false positive installs a stop-gate on a
 * chat message or a quick question, and every reply after it pays one judge
 * call before the agent is allowed to stop — a tax nobody asked for, on a
 * condition nobody stated.
 */
export const CAPTURE_SYSTEM = `You are reading a single message a user just sent to a coding agent, before any work has happened, to decide whether it already states a measurable stop condition.

Your response must be a JSON object with one of these shapes:
- {"criteria": "<a single measurable condition combining every explicit acceptance criterion in the message>"}
- {"criteria": null}

Return {"criteria": null} whenever the message is a quick question, a chat message, a vague or open-ended ask, or otherwise names no concrete, checkable finish line. Err toward null: a wrong "null" costs nothing, a wrong criteria installs a check that blocks the agent from stopping until something the user never actually asked for is satisfied.

When criteria is not null, phrase it as a condition a separate reviewer could check by reading a transcript and nothing else — e.g. "the login form validates email and password, submits to /api/login, and its tests pass" rather than "build a login form".

Reply with the JSON object and nothing else.`;

/** The question put to the extractor, after the message. */
export function captureQuestion(message: string): string {
	return `Does the following user message already state a measurable stop condition?\n\n<message>\n${message}\n</message>`;
}

/**
 * Re-injected after compaction, and after a resumed session restores an active
 * goal. Both events can leave the model without a legible copy of the
 * condition in context: compaction is free to summarize the original
 * goalSetInstruction message into prose with no directive weight, and a
 * restored goal comes from a custom entry the model never sees (state.ts's
 * persistence comment explains why). Short and imperative for the same reason
 * notMetInstruction is: it rides in hidden, with no chance to be asked about.
 */
export function reassertInstruction(condition: string): string {
	return `Active goal (survives compaction): ${condition}. The stop check will evaluate it — keep working toward it.`;
}

/** Wrap a reminder the way pi's own hidden-message reminders are wrapped. */
export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
