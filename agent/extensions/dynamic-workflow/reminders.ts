/**
 * The four reminder texts: the keyword request, the full and sparse
 * session-mode reminders, and the exit notice. They are injected as
 * <system-reminder> blocks.
 */

/**
 * The keyword grants permission for the turn. It used to end "— use the
 * Workflow tool to fulfill the request", which reads as an order and got one:
 * a fleet for work that one context could hold, because the keyword was
 * present rather than because the task needed it. The session-mode reminder
 * below had already been corrected to say permission-not-instruction; the
 * per-turn one had not, so the loudest of the three was the only one still
 * mandating.
 */
export const KEYWORD_REMINDER =
	'The user included the keyword "ultracode", opting this turn into multi-agent orchestration. That is permission to run a workflow without asking first — not an instruction to run one. Judge whether the task\'s SHAPE needs a fleet: coverage wider than one context holds, independent verification of a claim you cannot check yourself, or a mechanical sweep over many files. If it does not, say so in one line and do the work inline. The keyword removes the need to ask, not the need to decide.';

/**
 * Delivered on the turn a workflow's result arrives.
 *
 * That is the moment the opt-in is most likely to be misread as "do that
 * again": a fleet has just landed, the mode is still on, and starting another
 * feels like momentum. It is not — reading the result is the work. Kept
 * separate from ENTER_SPARSE because the two say different things: that one
 * says the mode is still on, this one says finishing is not a trigger.
 */
export const AFTER_RUN =
	"A workflow's result has landed and the opt-in still stands, which is not a reason to start another one. Read what came back and answer from it. Run a second workflow only if the result itself surfaced work whose shape needs a fleet — a phase that could not begin until this one finished, or a gap too wide for one context — and say which. Following up inline is the normal case, and \"the last one went well\" is not a justification.";

export const ENTER_FULL =
	"Ultracode is on: you may run a workflow without asking first. That is permission, not an instruction to run one for every task. Reach for a fleet when the task's SHAPE needs it — coverage wider than one context holds, independent verification of a claim you cannot check yourself, or a mechanical sweep over many files — and work inline when it does not. When you do run one, give each agent a single deliverable and say what finishing looks like: an agent stops when it decides it is done, so its prompt is the only budget it has. See the Workflow tool's **Ultracode** and **Bounding an agent** sections.";

/**
 * The sparse reminder repeats the two rules that actually change behaviour
 * rather than only saying the mode is still on. Ten turns is long enough that
 * "still on" alone had stopped meaning anything by the time it arrived.
 */
export const ENTER_SPARSE =
	"Ultracode is still on — workflow when the task's shape needs breadth, independent verification, or scale beyond one context; inline otherwise. Give each agent one bounded deliverable.";

export const EXIT = "Ultracode is off — the Workflow tool's standard opt-in rule applies again.";

/**
 * Added when the triggering request names models. The mapping is in the
 * request itself, which the model can read; this only makes sure the routing
 * is applied to the workflow rather than treated as conversation.
 */
export function routingReminder(mentions: string[]): string {
	return `This request names models (${mentions.join(", ")}). Route the workflow accordingly: pass each agent whose role the request covers a matching model reference via the agent() model option, e.g. agent(prompt, { model: "${mentions[0]}" }).`;
}

/**
 * The edit-streak nudge: delivered mid-turn (see streak.ts and index.ts's
 * tool_call handler) once a run of consecutive edit/write calls with no
 * Workflow call between them crosses CONFIG.editStreakNudge. Deliberately
 * says "that includes you" — the measured failure was a model that would
 * itself have flagged 40+ turns of one subagent as a decomposition failure
 * (see tool.ts's own shape diagnostics) while running exactly that pattern
 * itself, unwatched, for two hours.
 */
export function editStreakReminder(count: number): string {
	return `You have made ${count} consecutive hand-edits. Per your own workflow doctrine, a bulleted list of deliverables IS the fan-out, and 40+ turns of one agent is a decomposition failure — that includes you. Split the remaining work: one agent per deliverable, shell()-gated.`;
}

export function systemReminder(text: string): string {
	return `<system-reminder>\n${text}\n</system-reminder>`;
}
