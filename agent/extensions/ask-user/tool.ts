/**
 * The `ask_user` tool: the main agent puts a decision back to the human and
 * waits for the answer. It composes pi's dialogs (interaction.ts) into a
 * select → optional-note flow with a free-text "Other" and a decline path, and
 * returns the user's choice (plus any note) as text to the model.
 *
 * The tool description and guidelines come from guidance.ts. `executionMode` is
 * "sequential" so it never runs alongside other tool calls — it blocks on a
 * human. In a headless session (no UI) it degrades gracefully: it tells the
 * model no user is reachable rather than hanging or erroring.
 */
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AskUserSettings, CONFIG, TOOL_NAME } from "./config.ts";
import { ASK_USER_DESCRIPTION, ASK_USER_GUIDELINES, ASK_USER_SNIPPET } from "./guidance.ts";
import { type AskOption, type AskRequest, renderOutcomeText, runAsk } from "./interaction.ts";

export interface AskUserToolOptions {
	/** Current settings, read fresh on every call. */
	settings: () => AskUserSettings;
}

/** Coerce raw tool params into clean options: labelled, trimmed, capped, deduped. */
export function normalizeOptions(raw: unknown): AskOption[] {
	if (!Array.isArray(raw)) return [];
	const seen = new Set<string>();
	const options: AskOption[] = [];
	for (const item of raw) {
		const label = typeof item?.label === "string" ? item.label.trim() : "";
		if (!label || seen.has(label)) continue;
		seen.add(label);
		const description = typeof item?.description === "string" && item.description.trim() ? item.description.trim() : undefined;
		options.push({ label, description });
		if (options.length >= CONFIG.maxOptions) break;
	}
	return options;
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
			question: Type.String({ description: "The question to ask. Be specific and end with a question mark." }),
			header: Type.Optional(Type.String({ description: "A short label (a few words) shown before the question, e.g. \"Auth method\"." })),
			options: Type.Optional(
				Type.Array(
					Type.Object({
						label: Type.String({ description: "Concise choice text (1-5 words)." }),
						description: Type.Optional(Type.String({ description: "What this option means or implies." })),
					}),
					{ description: "2-4 suggested, mutually exclusive answers. Omit for an open-ended question. An \"Other\" choice is always added — do not add one." },
				),
			),
			multiSelect: Type.Optional(Type.Boolean({ description: "Allow the user to select more than one option." })),
		}),

		async execute(_toolCallId, params, _signal, _onUpdate, ctx: ExtensionContext) {
			const question = String(params.question ?? "").trim();
			if (!question) throw new Error("ask_user needs a question.");

			// No interactive user (json/print mode): don't hang — tell the model.
			if (!ctx.hasUI) {
				return {
					content: [{ type: "text" as const, text: "No interactive user is available in this session (headless). Proceed using your best judgment." }],
					details: { question, mode: "headless" as const },
				};
			}

			const request: AskRequest = {
				question,
				header: typeof params.header === "string" && params.header.trim() ? params.header.trim() : undefined,
				options: normalizeOptions(params.options),
				multiSelect: params.multiSelect === true,
				allowNotes: options.settings().allowNotes,
			};

			const outcome = await runAsk(ctx.ui, request);
			return {
				content: [{ type: "text" as const, text: renderOutcomeText(outcome) }],
				details: {
					question,
					header: request.header,
					kind: outcome.kind,
					choices: outcome.kind === "answer" ? outcome.labels : [],
					freeform: outcome.kind === "answer" ? outcome.freeform : undefined,
					note: outcome.kind === "answer" || outcome.kind === "declined" ? outcome.note : undefined,
				},
			};
		},
	});
}
