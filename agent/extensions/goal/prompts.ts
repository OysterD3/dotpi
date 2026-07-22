/**
 * Prompts for /goal.
 *
 * These are transcribed from the strings embedded in the Claude Code binary
 * (2.1.217) so the judging behaviour matches rather than merely resembles it.
 * Only the product name is changed: Claude Code says "in Claude Code", and the
 * set-acknowledgement calls the mechanism a "Stop hook" because that is what it
 * literally is there. pi has no Stop hook, so the wording names the same idea in
 * pi's terms without changing what the model is asked to do.
 */

/** System prompt for the evaluator. Verbatim apart from the product name. */
export const JUDGE_SYSTEM = `You are evaluating a stop-condition hook in pi. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".

Reply with the JSON object and nothing else.`;

/** The question put to the evaluator, after the transcript. Verbatim. */
export function judgeQuestion(condition: string): string {
	return `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.

Condition: ${condition}`;
}

/**
 * Injected when a goal is set, to start work immediately instead of asking the
 * user what to do. Verbatim apart from naming the mechanism.
 */
export function goalSetInstruction(condition: string): string {
	return `A session-scoped goal check is now active with condition: "${condition}". Briefly acknowledge the goal, then immediately start (or continue) working toward it — treat the condition itself as your directive and do not pause to ask the user what to do. The check will block stopping until the condition holds. It auto-clears once the condition is met — do not tell the user to run \`/goal clear\` after success; that's only for clearing a goal early.`;
}

/**
 * Fed back when the condition is not yet met, to resume work.
 *
 * Claude Code phrases the blocking error as `[<condition>]: <reason>`; pi has no
 * blocking channel, so the same content is delivered as a follow-up message and
 * needs the explicit "keep going" that Claude Code gets from the hook semantics.
 */
export function notMetInstruction(condition: string, reason: string): string {
	return `[${condition}]: ${reason}

The goal is not met yet. Continue working toward it. Do not stop to ask the user what to do next.`;
}

/** Notice when the transcript had to be trimmed. Verbatim. */
export const TRUNCATION_NOTICE = (dropped: number) =>
	`[Earlier conversation truncated to fit the hook evaluator's context window — ${dropped} earlier messages omitted. Evaluate the condition against the recent transcript below; if the required evidence may be in the omitted prefix, return {"ok": false, "reason": "insufficient evidence in transcript"}.]`;
