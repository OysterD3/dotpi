/**
 * The interactive ask_user flow, expressed as a small state machine over pi's
 * dialog primitives (select / input / confirm). Kept free of pi imports and
 * driven through the `AskUI` interface so the whole thing can be exercised by a
 * scripted fake in tests.
 *
 * Behaviour (mirrors Claude Code's AskUserQuestion as far as pi's dialogs allow):
 *   - suggested options are shown as a selector, each `label — description`;
 *   - an "Other" entry always lets the user type a custom answer;
 *   - a "Decline" entry records a refusal, with an optional reason;
 *   - after any answer (or a decline) the user may attach a note — this is the
 *     "yes with notes" / "decline with note" affordance. Claude Code binds a key
 *     ("n") inside its own component for this; pi cannot bind keys inside a
 *     dialog, so the note is offered as a follow-up confirm+input.
 *   - multiSelect loops the selector, accumulating picks until "Done".
 *
 * Every dialog can be dismissed (Esc). A dismissed *primary* question yields
 * `{ kind: "dismissed" }` so the caller can tell the model no answer was given.
 */

export interface AskOption {
	label: string;
	description?: string;
}

export interface AskRequest {
	question: string;
	header?: string;
	options: AskOption[];
	multiSelect: boolean;
	/** When false, the note follow-up is skipped entirely. */
	allowNotes: boolean;
}

export type AskOutcome =
	| { kind: "answer"; labels: string[]; freeform?: string; note?: string }
	| { kind: "declined"; note?: string }
	| { kind: "dismissed" };

/** The slice of pi's ExtensionUIContext the flow needs; loose so tests can fake it. */
export interface AskUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	confirm(title: string, message: string): Promise<boolean>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}

export const DECLINE = "✗ Decline to answer";
export const DONE = "✓ Done — submit these";
const MAX_DESC = 72;

function truncate(text: string, max = MAX_DESC): string {
	const clean = text.replace(/\s+/g, " ").trim();
	return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean;
}

/** The selector row for an option: "label — description", description trimmed. */
export function formatEntry(option: AskOption): string {
	const desc = option.description?.trim();
	return desc ? `${option.label} — ${truncate(desc)}` : option.label;
}

/** Label for the free-text entry; "Other" reads oddly with no options to be "other" than. */
export function otherLabel(hasOptions: boolean): string {
	return hasOptions ? "✎ Other (type my own answer)" : "✎ Type an answer";
}

/** The dialog title: the question, prefixed with the short header when present. */
export function title(request: AskRequest): string {
	const header = request.header?.trim();
	return header ? `[${header}] ${request.question}` : request.question;
}

/** Offer an optional note. Returns the trimmed note, or undefined to skip. */
async function askNote(ui: AskUI, request: AskRequest, prompt: string): Promise<string | undefined> {
	if (!request.allowNotes) return undefined;
	const want = await ui.confirm("Add a note?", `${prompt} (or press Enter to skip).`);
	if (!want) return undefined;
	const text = await ui.input("Note", "");
	const trimmed = (text ?? "").trim();
	return trimmed || undefined;
}

/** Ask for a free-text answer. Returns the trimmed text, or undefined if empty/cancelled. */
async function askFreeform(ui: AskUI): Promise<string | undefined> {
	const text = await ui.input("Your answer", "");
	const trimmed = (text ?? "").trim();
	return trimmed || undefined;
}

/** Match a chosen selector row back to its option label. */
function labelForEntry(entry: string, options: AskOption[]): string | undefined {
	const option = options.find((candidate) => formatEntry(candidate) === entry);
	return option?.label;
}

async function runSingle(ui: AskUI, request: AskRequest): Promise<AskOutcome> {
	const hasOptions = request.options.length > 0;
	const other = otherLabel(hasOptions);
	const entries = [...request.options.map(formatEntry), other, DECLINE];

	const pick = await ui.select(title(request), entries);
	if (pick === undefined) return { kind: "dismissed" };

	if (pick === DECLINE) {
		const note = await askNote(ui, request, "Add a reason for declining");
		return { kind: "declined", note };
	}

	if (pick === other) {
		const freeform = await askFreeform(ui);
		if (!freeform) return { kind: "dismissed" };
		const note = await askNote(ui, request, "Add a note to your answer");
		return { kind: "answer", labels: [], freeform, note };
	}

	const label = labelForEntry(pick, request.options);
	if (!label) return { kind: "dismissed" };
	const note = await askNote(ui, request, "Add a note to your answer");
	return { kind: "answer", labels: [label], note };
}

async function runMulti(ui: AskUI, request: AskRequest): Promise<AskOutcome> {
	const other = otherLabel(request.options.length > 0);
	const chosen: string[] = [];
	const freeforms: string[] = [];

	for (;;) {
		const remaining = request.options.filter((option) => !chosen.includes(option.label));
		const picked = chosen.length + freeforms.length;
		const entries: string[] = [];
		if (picked > 0) entries.push(DONE);
		entries.push(...remaining.map(formatEntry), other, DECLINE);

		const heading = picked > 0 ? `${title(request)}  (${picked} selected)` : title(request);
		const pick = await ui.select(heading, entries);

		// Esc finishes when something is already selected, otherwise cancels.
		if (pick === undefined) {
			if (picked > 0) break;
			return { kind: "dismissed" };
		}
		if (pick === DONE) break;
		if (pick === DECLINE) {
			const note = await askNote(ui, request, "Add a reason for declining");
			return { kind: "declined", note };
		}
		if (pick === other) {
			const freeform = await askFreeform(ui);
			if (freeform) freeforms.push(freeform);
			continue;
		}
		const label = labelForEntry(pick, request.options);
		if (label && !chosen.includes(label)) chosen.push(label);
		// Nothing left to pick and no "Other" wanted — submit.
		if (chosen.length === request.options.length && request.options.length > 0) break;
	}

	if (chosen.length === 0 && freeforms.length === 0) return { kind: "dismissed" };
	const note = await askNote(ui, request, "Add a note to your answer");
	return {
		kind: "answer",
		labels: chosen,
		freeform: freeforms.length > 0 ? freeforms.join("; ") : undefined,
		note,
	};
}

/** Drive the whole interaction and return a structured outcome. */
export async function runAsk(ui: AskUI, request: AskRequest): Promise<AskOutcome> {
	return request.multiSelect ? runMulti(ui, request) : runSingle(ui, request);
}

/** Render the outcome as the text returned to the model. */
export function renderOutcomeText(outcome: AskOutcome): string {
	if (outcome.kind === "dismissed") {
		return "The user dismissed the question without answering. Proceed using your best judgment, or ask again only if a decision is truly required.";
	}
	if (outcome.kind === "declined") {
		const base = "The user declined to answer.";
		return outcome.note ? `${base}\nTheir note: ${outcome.note}` : base;
	}

	const parts: string[] = [];
	for (const label of outcome.labels) parts.push(`"${label}"`);
	if (outcome.freeform) parts.push(`"${outcome.freeform}" (custom answer)`);

	let line: string;
	if (parts.length === 0) line = "The user answered (with no selection).";
	else if (outcome.labels.length === 0 && outcome.freeform) line = `The user answered: ${parts.join(", ")}.`;
	else if (parts.length === 1) line = `The user chose: ${parts[0]}.`;
	else line = `The user chose: ${parts.join(", ")}.`;

	return outcome.note ? `${line}\nTheir note: ${outcome.note}` : line;
}
