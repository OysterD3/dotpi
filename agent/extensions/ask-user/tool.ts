/**
 * The `ask_user` tool: the main agent puts one or more decisions back to the
 * human and waits.
 *
 * The interaction is a focused component (prompt.ts) over a pure state machine
 * (interaction.ts), not a stack of pi dialogs — Tab-to-annotate and ← / →
 * navigation only exist inside a component that owns its own key handling. It
 * takes the editor's place while it is up rather than floating over the chat.
 *
 * `executionMode` is "sequential" so it never runs alongside other tool calls —
 * it blocks on a human until intercom needs the agent. The question then stays
 * open, and its eventual answer is sent as a separate message. In a headless session it tells
 * the model no user is reachable rather than hanging.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { INCOMING_CHANNEL, type IncomingDelivery } from "../intercom/config.ts";
import { ASK_CHANNEL, CONFIG, TOOL_NAME } from "./config.ts";
import { ASK_USER_DESCRIPTION, ASK_USER_GUIDELINES, ASK_USER_SNIPPET } from "./guidance.ts";
import { type AskOption, type AskOutcome, type AskQuestion, AskSession, renderOutcomeText } from "./interaction.ts";
import { showAsk } from "./prompt.ts";

/**
 * A trailing "(Recommended)" written into the label itself.
 *
 * The common convention elsewhere is to have no recommendation field and to tell
 * the model to append exactly this to the label instead, so a model carrying that
 * habit over would put the marker in as literal text — beside our own badge, or
 * instead of it. Lifting it out means either shape produces the same rendered row.
 *
 * Deliberately only the bracketed form: a bare trailing word would also eat the
 * "recommended" out of a label like "Not recommended" and badge its opposite.
 */
const RECOMMENDED_IN_LABEL = /\s*[([]\s*recommended\s*[)\]]\s*$/i;

/** Coerce raw option params into clean options: labelled, trimmed, capped, deduped. */
export function normalizeOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const options: AskOption[] = [];
	let advised = false;
	for (const item of raw) {
		const given = typeof item?.label === "string" ? item.label.trim() : "";
		const stripped = given.replace(RECOMMENDED_IN_LABEL, "").trim();
		// Only treat the suffix as a marker when something is left to label.
		const marked = item?.recommended === true || (stripped.length > 0 && stripped !== given);
		const label = stripped || given;
		if (!label || seen.has(label)) continue;
		seen.add(label);
		// Descriptions are kept whole — the prompt wraps rather than truncates.
		const description =
			typeof item?.description === "string" && item.description.trim() ? item.description.trim() : undefined;
		// One recommendation per question: advice that names two answers is not
		// advice, so a second mark is dropped rather than shown alongside.
		const recommended = marked && !advised;
		if (recommended) advised = true;
		options.push({ label, description, recommended: recommended || undefined });
		if (options.length >= CONFIG.maxOptions) break;
	}
	return options;
}

/**
 * Clean the `questions` array: trimmed, blank entries dropped, capped.
 *
 * pi validates the call against the schema before `execute` runs, so the bounds
 * declared there — `questions` required, 1 to CONFIG.maxQuestions items — are
 * already guaranteed by the time this is reached. The cap below is kept as a
 * backstop against the schema and the constant drifting apart, not as a path
 * production takes; an earlier version of this function also accepted a bare
 * top-level `question`, which the schema now rejects outright, so that shim was
 * removed rather than left to look load-bearing.
 */
export function normalizeQuestions(params: Record<string, unknown>): AskQuestion[] {
	const raw = Array.isArray(params.questions) ? params.questions : [];

	const questions: AskQuestion[] = [];
	for (const item of raw as Record<string, unknown>[]) {
		const question = typeof item?.question === "string" ? item.question.trim() : "";
		if (!question) continue;
		const header = typeof item?.header === "string" && item.header.trim() ? item.header.trim() : undefined;
		questions.push({
			question,
			header,
			options: normalizeOptions(item?.options),
			multiSelect: item?.multiSelect === true,
		});
		if (questions.length >= CONFIG.maxQuestions) break;
	}
	return questions;
}

export function registerAskUserTool(pi: ExtensionAPI): void {
	let pending: { interrupt: () => void; cancel: () => void } | undefined;
	const pendingResult = () => ({
		content: [{ type: "text" as const, text: "The user question is still open, with their draft saved. No answer or permission has been given. Handle the incoming intercom message, then stop and wait for the user. Their answer will arrive automatically. Do not call ask_user again or continue work that depends on their answer." }],
		details: { kind: "pending" as const, answers: [] },
	});
	const unsubscribe = pi.events.on(INCOMING_CHANNEL, (data) => {
		if (!pending) return;
		(data as IncomingDelivery).steer = true;
		pending.interrupt();
	});
	pi.on("session_shutdown", () => {
		unsubscribe();
		pending?.cancel();
	});

	pi.registerTool({
		name: TOOL_NAME,
		label: "Ask User",
		description: ASK_USER_DESCRIPTION,
		promptSnippet: ASK_USER_SNIPPET,
		promptGuidelines: ASK_USER_GUIDELINES,
		executionMode: "sequential",
		parameters: Type.Object({
			questions: Type.Array(
				Type.Object({
					question: Type.String({ description: "The question to ask. Be specific and end with a question mark." }),
					header: Type.Optional(
						Type.String({ description: 'A short label (a few words) shown above the question, e.g. "Auth method".' }),
					),
					options: Type.Optional(
						Type.Array(
							Type.Object({
								label: Type.String({ description: "Concise choice text (1-5 words)." }),
								description: Type.Optional(Type.String({ description: "What this option means or implies." })),
								recommended: Type.Optional(
									Type.Boolean({
										description:
											"Set on the single option you would pick, when you do lean one way. It is badged \"Recommended\" and starts focused, so the user can accept it with one key — say why in its description. Leave it off every option when you have no real preference, and never write \"(Recommended)\" into the label yourself.",
									}),
								),
							}),
							{
								description:
									"2-4 suggested, mutually exclusive answers. Omit for an open-ended question. A free-text row is always present — do not add an \"Other\" option.",
							},
						),
					),
					multiSelect: Type.Optional(Type.Boolean({ description: "Allow more than one option to be selected." })),
				}),
				{
					description:
						"Every decision you are blocked on right now, asked together — not one call per question. The user answers them in a single pass, moving between them with the arrow keys, and reviews everything before it is sent.",
					// Structural, not just prose: pi compiles this schema and validates
					// against it, so the bound is enforced and a model that reads schemas
					// more carefully than descriptions still sees that several fit. An
					// over-long call is now rejected and retried rather than silently
					// truncated to the first four — losing questions the model believes
					// it asked is worse than an error it can correct.
					minItems: 1,
					maxItems: CONFIG.maxQuestions,
				},
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx: ExtensionContext) {
			const questions = normalizeQuestions(params as Record<string, unknown>);
			if (questions.length === 0) throw new Error("ask_user needs at least one question.");

			// No interactive user (json/print mode): don't hang — tell the model.
			if (!ctx.hasUI) {
				return {
					content: [
						{
							type: "text" as const,
							text: "No interactive user is available in this session (headless). Proceed using your best judgment.",
						},
					],
					details: { questions: questions.map((entry) => entry.question), mode: "headless" as const },
				};
			}

			// Never replace a still-open question or its partially entered answer.
			if (pending) return pendingResult();
			const session = new AskSession(questions);
			const controller = new AbortController();
			const cancel = () => controller.abort();
			signal?.addEventListener("abort", cancel, { once: true });
			if (signal?.aborted) cancel();
			let detached = false;
			const settled = await new Promise<AskOutcome | undefined>((resolve, reject) => {
				const current = {
					cancel,
					interrupt: () => {
						if (detached || controller.signal.aborted || session.result) return;
						detached = true;
						// End the blocking span for the clock, then keep the footer
						// hidden for the question that still owns the editor.
						pi.events.emit(ASK_CHANNEL, { active: false, blocking: true });
						pi.events.emit(ASK_CHANNEL, { active: true, blocking: false });
						resolve(undefined);
					},
				};
				pending = current;
				const cleanup = () => {
					signal?.removeEventListener("abort", cancel);
					if (pending === current) pending = undefined;
				};
				void showAsk(pi, ctx, session, true, controller.signal).then((outcome) => {
					cleanup();
					if (!detached || controller.signal.aborted) {
						resolve(outcome);
						return;
					}
					pi.sendMessage({
						customType: "ask-user-answer",
						content: renderOutcomeText(outcome),
						display: true,
						details: outcome,
					}, { triggerTurn: true, deliverAs: "steer" });
				}).catch((error) => {
					cleanup();
					if (detached) ctx.ui.notify(`Could not finish the user question: ${error}`, "error");
					else reject(error);
				});
			});
			if (!settled) return pendingResult();

			return {
				content: [{ type: "text" as const, text: renderOutcomeText(settled) }],
				details: {
					kind: settled.kind,
					answers: settled.kind === "answered" ? settled.answers : [],
				},
			};
		},
	});
}
