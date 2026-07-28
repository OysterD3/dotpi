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
 * it blocks on a human. In a headless session it degrades gracefully: it tells
 * the model no user is reachable rather than hanging.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AskUserSettings, CONFIG, TOOL_NAME } from "./config.ts";
import { ASK_USER_DESCRIPTION, ASK_USER_GUIDELINES, ASK_USER_SNIPPET } from "./guidance.ts";
import { type AskOption, type AskQuestion, AskSession, renderOutcomeText } from "./interaction.ts";
import { showAsk } from "./prompt.ts";

export interface AskUserToolOptions {
	/** Current settings, read fresh on every call. */
	settings: () => AskUserSettings;
}

/**
 * A trailing "(Recommended)" written into the label itself.
 *
 * Claude Code's tool has no recommendation field and tells the model to append
 * exactly this to the label instead, so a model carrying that habit over would
 * put the marker in as literal text — beside our own badge, or instead of it.
 * Lifting it out means either shape produces the same rendered row.
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
 * Accepts the `questions` array, and tolerates a single top-level question so a
 * model that reaches for the older shape still gets through.
 */
export function normalizeQuestions(params: Record<string, unknown>): AskQuestion[] {
	const raw = Array.isArray(params.questions)
		? params.questions
		: typeof params.question === "string"
			? [params]
			: [];

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

export function registerAskUserTool(pi: ExtensionAPI, options: AskUserToolOptions): void {
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
						"1-4 questions asked together. The user answers them in one pass, moving between them with the arrow keys, and reviews everything before it is sent.",
				},
			),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
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

			const session = new AskSession(questions, options.settings().allowNotes);
			const settled = await showAsk(pi, ctx, session);

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
