/**
 * Reminder texts, verbatim from Claude Code 2.1.217's attachment registry
 * (workflow_keyword_request, ultra_effort_enter full/sparse, ultra_effort_exit).
 * They are injected as <system-reminder> blocks, which is also how Claude Code
 * delivers them.
 */

export const KEYWORD_REMINDER =
	'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.';

export const ENTER_FULL =
	"Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool's **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.";

export const ENTER_SPARSE = "Ultracode is still on — use the Workflow tool; see its Ultracode section.";

export const EXIT = "Ultracode is off — the Workflow tool's standard opt-in rule applies again.";

/**
 * Added when the triggering request names models. The mapping is in the
 * request itself, which the model can read; this only makes sure the routing
 * is applied to the workflow rather than treated as conversation.
 */
export function routingReminder(mentions: string[]): string {
	return `This request names models (${mentions.join(", ")}). Route the workflow accordingly: pass each agent whose role the request covers a matching model reference via the agent() model option, e.g. agent(prompt, { model: "${mentions[0]}" }).`;
}

export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
