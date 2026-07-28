/**
 * The ask_user prompt: a focused TUI component driving an AskSession.
 *
 * It takes the editor's place at the bottom of the screen — pi's own select and
 * input do the same — rather than floating over the middle of the chat. A
 * question is answered where you would have typed the answer anyway, the
 * transcript above it stays put and readable, and while it is up the footer
 * stands down too (see ASK_CHANNEL in config.ts), so the question owns the
 * prompt and the footer between them.
 *
 * This exists because pi's select/input/confirm dialogs cannot bind keys inside
 * themselves, and every affordance here is a key: Enter to commit an answer and
 * move on, Tab to annotate the focused answer in place, ← / → to walk between
 * questions, typing straight into the free-text row. `ctx.ui.custom()` gives a
 * component that owns its own input, which is the only way to express that (same
 * mechanism as /workflows).
 *
 * Rendering never truncates. Long option text and long descriptions wrap; the
 * user is being asked to make a decision and hiding half the sentence behind an
 * ellipsis is exactly the wrong trade. What the screen cannot fit scrolls
 * instead: the option list windows around the focused row and says how many rows
 * are out of view, so no answer is ever silently unreachable.
 */
import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { ASK_CHANNEL, CONFIG } from "./config.ts";
import { type AskOutcome, AskSession, type Row } from "./interaction.ts";

/** Word-wrap to `width`, hard-splitting any word longer than the line. */
export function wrap(text: string, width: number): string[] {
	if (width <= 1) return [text];
	const lines: string[] = [];
	let line = "";
	for (const word of text.split(/\s+/).filter(Boolean)) {
		let candidate = word;
		while (candidate.length > width) {
			if (line) {
				lines.push(line);
				line = "";
			}
			lines.push(candidate.slice(0, width));
			candidate = candidate.slice(width);
		}
		if (!line) line = candidate;
		else if (line.length + 1 + candidate.length <= width) line += ` ${candidate}`;
		else {
			lines.push(line);
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

/** True for ordinary typed text (not an escape sequence or control byte). */
export function isPrintable(data: string): boolean {
	if (data.length === 0) return false;
	if (data.startsWith("\x1b")) return false;
	for (const char of data) {
		const code = char.codePointAt(0) ?? 0;
		if (code < 0x20 || code === 0x7f) return false;
	}
	return true;
}

export interface Window {
	lines: string[];
	/** Rows scrolled off the top / bottom, for the "… n more" markers. */
	hiddenBefore: number;
	hiddenAfter: number;
}

/** Lines the option list keeps even on a terminal too short for the question. */
const MIN_OPTION_LINES = 3;

/**
 * Fit variable-height blocks into `budget` lines, keeping block `focused` whole
 * and visible.
 *
 * Blocks rather than lines because an option and its description are one thing:
 * a window that cut between them would show a description under the wrong row.
 * The focused block wins even when it alone overruns the budget — the user has
 * to be able to read the row they are about to pick.
 */
export function windowBlocks(blocks: string[][], focused: number, budget: number): Window {
	if (blocks.length === 0) return { lines: [], hiddenBefore: 0, hiddenAfter: 0 };

	const flat = blocks.flat();
	if (flat.length <= budget) return { lines: flat, hiddenBefore: 0, hiddenAfter: 0 };

	const index = Math.min(Math.max(0, focused), blocks.length - 1);
	let start = index;
	let end = index + 1;
	// One line of the budget goes to each "… n more" marker that will be drawn.
	const markers = () => (start > 0 ? 1 : 0) + (end < blocks.length ? 1 : 0);
	let used = blocks[index]!.length;

	// Grow downward first (reading order), then upward, a whole block at a time.
	for (let grew = true; grew; ) {
		grew = false;
		if (end < blocks.length && used + blocks[end]!.length + markers() <= budget) {
			used += blocks[end]!.length;
			end += 1;
			grew = true;
		}
		if (start > 0 && used + blocks[start - 1]!.length + markers() <= budget) {
			used += blocks[start - 1]!.length;
			start -= 1;
			grew = true;
		}
	}

	const lines = blocks.slice(start, end).flat();
	const room = Math.max(1, budget - markers());
	return {
		// Only bites when the focused block alone is taller than the screen can hold.
		lines: lines.length > room ? lines.slice(0, room) : lines,
		hiddenBefore: start,
		hiddenAfter: blocks.length - end,
	};
}

export class AskPrompt {
	focused = true;

	constructor(
		private readonly session: AskSession,
		private readonly theme: Theme,
		private readonly done: (outcome: AskOutcome) => void,
		private readonly requestRender: () => void,
		/** Terminal height, so a tall question scrolls instead of eating the screen. */
		private readonly rows: () => number = () => CONFIG.assumedRows,
	) {}

	invalidate(): void {
		/* nothing cached that a theme change would invalidate */
	}

	// ------------------------------------------------------------------ input

	handleInput(data: string): void {
		const session = this.session;

		// While editing, almost everything is text: only Esc, Enter and Backspace
		// are control. Arrow keys deliberately do NOT navigate mid-note, or a
		// stray cursor key would abandon what was being typed.
		if (session.editing) {
			if (matchesKey(data, "escape")) session.cancelEdit();
			else if (matchesKey(data, "return") || matchesKey(data, "enter")) session.commitEdit();
			else if (matchesKey(data, "backspace")) session.backspace();
			else if (isPrintable(data)) session.type(data);
			this.requestRender();
			return;
		}

		if (matchesKey(data, "escape")) {
			session.dismiss();
			this.finish();
			return;
		}
		if (matchesKey(data, "up")) session.moveCursor(-1);
		else if (matchesKey(data, "down")) session.moveCursor(1);
		else if (matchesKey(data, "left")) session.goPrev();
		else if (matchesKey(data, "right")) session.goNext();
		else if (matchesKey(data, "tab")) session.startNote();
		else if (matchesKey(data, "return") || matchesKey(data, "enter")) {
			if (session.phase === "review") {
				session.submit();
				this.finish();
				return;
			}
			// Picks the focused answer and moves on when only one may be chosen.
			session.confirm();
		} else if (data === " ") {
			session.toggle();
		} else if (isPrintable(data) && session.phase === "answering" && session.focusedRow.kind === "custom") {
			// Typing on the free-text row starts the answer straight away, with no
			// "select Other first" step.
			session.editing = { target: "custom" };
			session.type(data);
		}

		this.requestRender();
	}

	private finish(): void {
		const outcome = this.session.result;
		if (outcome) this.done(outcome);
	}

	// ----------------------------------------------------------------- render

	/**
	 * A rule above and below the question, the way pi frames its own in-editor
	 * selector, with the key hints under the lower rule — where the footer would
	 * be, since the footer is standing down for us.
	 */
	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(20, width - 2);
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		const hints = this.hints(inner);
		const budget = this.bodyBudget(hints.length);
		const body = this.session.phase === "review" ? this.reviewBody(inner, budget) : this.questionBody(inner, budget);

		return [rule, ...body.map((line) => ` ${line}`), rule, ...hints.map((line) => ` ${line}`)];
	}

	/** Lines the body may use: the screen, less the frame, the hints, and room to read. */
	private bodyBudget(hintLines: number): number {
		return Math.max(4, this.rows() - CONFIG.screenReserve - 2 - hintLines);
	}

	private questionBody(width: number, budget: number): string[] {
		const theme = this.theme;
		const session = this.session;
		const question = session.question;
		const head: string[] = [];

		head.push(...this.progressHeader(width));
		if (question.header) head.push(theme.fg("accent", `[${question.header}]`));
		for (const line of wrap(question.question, width)) head.push(theme.bold(line));
		if (question.multiSelect) head.push(theme.fg("muted", "Select all that apply."));

		// A wordy question on a short terminal must not squeeze the answers out:
		// the options keep a floor, and the question says how much of it is cut.
		// This is the one place text is clipped, and it announces itself.
		const headRoom = Math.max(1, budget - MIN_OPTION_LINES);
		const shown =
			head.length > headRoom
				? [...head.slice(0, headRoom - 1), theme.fg("muted", `  ↓ ${head.length - headRoom + 1} more lines`)]
				: head;

		const blocks = session.rows().map((row, index) => this.renderRow(row, index === session.cursor, width));
		const view = windowBlocks(blocks, session.cursor, Math.max(MIN_OPTION_LINES, budget - shown.length));

		const lines = [...shown];
		if (view.hiddenBefore > 0) lines.push(theme.fg("muted", `  ↑ ${view.hiddenBefore} more`));
		lines.push(...view.lines);
		if (view.hiddenAfter > 0) lines.push(theme.fg("muted", `  ↓ ${view.hiddenAfter} more`));
		return lines;
	}

	private renderRow(row: Row, focused: boolean, width: number): string[] {
		const theme = this.theme;
		const session = this.session;
		const lines: string[] = [];
		const caret = focused ? theme.fg("accent", "▸") : " ";
		const selected = session.isSelected(row);
		const editingCustom = session.editing?.target === "custom" && row.kind === "custom";
		const noteKey = session.rowKey(row);
		const editingNote = session.editing?.target === "note" && session.editing.key === noteKey;

		if (row.kind === "custom") {
			const text = session.state.custom;
			const glyph = theme.fg(selected ? "success" : "muted", selected ? "◉" : "✎");
			let body: string;
			if (editingCustom) {
				body = theme.fg("text", text) + CURSOR_MARKER;
			} else if (text) {
				body = theme.fg("text", text);
			} else {
				// The placeholder IS the affordance — there is no "Other" to pick.
				body = theme.fg("muted", CONFIG.customPlaceholder);
			}
			lines.push(`${caret} ${glyph} ${body}`);
		} else {
			const option = session.question.options[row.index]!;
			const box = session.question.multiSelect ? (selected ? "◉" : "○") : selected ? "●" : "○";
			const glyph = theme.fg(selected ? "success" : "muted", box);
			const labelLines = wrap(option.label, width - 4);
			labelLines.forEach((line, index) => {
				const prefix = index === 0 ? `${caret} ${glyph} ` : "     ";
				lines.push(prefix + (selected ? theme.bold(line) : theme.fg("text", line)));
			});
			if (option.recommended) {
				// Rides on the end of the label when there is room, so the badge reads
				// as a mark on that answer rather than as a line of its own.
				const badge = theme.fg("accent", CONFIG.recommendedBadge);
				const last = labelLines.at(-1) ?? "";
				if (last.length + 2 + CONFIG.recommendedBadge.length <= width - 4) {
					lines[lines.length - 1] += `  ${badge}`;
				} else {
					lines.push(`     ${badge}`);
				}
			}
			if (option.description) {
				// Never truncated: the description is often what the choice turns on.
				for (const line of wrap(option.description, width - 6)) {
					lines.push(`     ${theme.fg("muted", line)}`);
				}
			}
		}

		const note = session.noteFor(row);
		if (note !== undefined || editingNote) {
			const text = note ?? "";
			const shown = editingNote ? theme.fg("text", text) + CURSOR_MARKER : theme.fg("text", text);
			lines.push(`     ${theme.fg("warning", "↳ note:")} ${shown}`);
		}
		return lines;
	}

	private reviewBody(width: number, budget: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(theme.bold("Review your answers"));

		this.session.collect().forEach((answer, index) => {
			const heading = answer.header ? `[${answer.header}] ${answer.question}` : answer.question;
			for (const line of wrap(`${index + 1}. ${heading}`, width)) {
				lines.push(theme.fg("muted", line));
			}
			const picks: string[] = [...answer.labels];
			if (answer.custom) picks.push(answer.custom);
			if (picks.length === 0) {
				lines.push(`   ${theme.fg("error", "(not answered)")}`);
			} else {
				for (const pick of picks) {
					for (const [i, line] of wrap(pick, width - 5).entries()) {
						lines.push(i === 0 ? `   ${theme.fg("success", "•")} ${theme.bold(line)}` : `     ${line}`);
					}
					const note = answer.notes.find((entry) => entry.answer === pick);
					if (note) {
						for (const line of wrap(`note: ${note.note}`, width - 7)) {
							lines.push(`     ${theme.fg("warning", line)}`);
						}
					}
				}
			}
		});

		// Four annotated questions can outrun a short terminal. ← goes back to the
		// answers themselves, so the tail is the safe end to clip.
		if (lines.length > budget) {
			const kept = lines.slice(0, Math.max(1, budget - 1));
			kept.push(theme.fg("muted", `  ↓ ${lines.length - kept.length} more lines`));
			return kept;
		}
		return lines;
	}

	private progressHeader(width: number): string[] {
		const theme = this.theme;
		const session = this.session;
		const total = session.questions.length;
		if (total === 1) return [theme.fg("muted", "Question")];

		const dots = session.questions
			.map((_, index) => {
				if (index === session.index) return theme.fg("accent", "●");
				return session.isAnswered(index) ? theme.fg("success", "●") : theme.fg("muted", "○");
			})
			.join(" ");
		const label = theme.fg("muted", `Question ${session.index + 1} of ${total}`);
		return [`${label}   ${dots}`.slice(0, Math.max(0, width + 64))];
	}

	private hints(width: number): string[] {
		const theme = this.theme;
		const session = this.session;
		const parts: string[] = [];

		if (session.editing) {
			parts.push("Enter save", "Esc discard");
		} else if (session.phase === "review") {
			parts.push("Enter send", "← back", "Esc cancel");
		} else {
			parts.push("↑↓ move");
			// Enter means different things on the two question types, so it is named
			// per type rather than lumped in with Space. Multi-select needs a
			// separate "done" key named, since Enter is busy toggling; single-select
			// does not, which is the whole point of the change.
			if (session.question.multiSelect) {
				parts.push("Space/Enter toggle", "Tab note", session.isLastQuestion ? "→ review" : "→ next");
				if (session.questions.length > 1) parts.push("← back");
			} else {
				parts.push(session.isLastQuestion ? "Enter pick & review" : "Enter pick & next", "Space pick", "Tab note");
				if (session.questions.length > 1) parts.push("←→ question");
			}
			parts.push("Esc cancel");
		}
		return wrap(parts.join("  ·  "), width).map((line) => theme.fg("muted", line));
	}
}

/**
 * Put a session's questions to the user, in the prompt's place, and wait.
 *
 * `overlay: false` is the whole placement decision: pi swaps this component into
 * the editor's slot (and restores the editor, with whatever was typed in it, on
 * the way out) instead of floating it over the chat. The ASK_CHANNEL
 * announcement is what lets the footer stand down for the duration — see the
 * note on that constant for why this extension must not swap the footer itself.
 */
export async function showAsk(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	session: AskSession,
	/**
	 * False for the `/ask-user test` demo: the prompt is on screen, but the agent
	 * is not stuck behind it. Subscribers that act on "the agent has stopped and
	 * is waiting on a human" — the turn clock, the cmux bell — must not fire for
	 * a prompt the user opened themselves while the agent carries on working.
	 */
	blocking = true,
): Promise<AskOutcome> {
	const first = session.questions[0];
	pi.events.emit(ASK_CHANNEL, {
		active: true,
		blocking,
		// Enough for a subscriber to say what is being waited on, not just that
		// something is: cmux-notify puts the question itself in its banner.
		question: first?.question ?? "",
		header: first?.header,
		count: session.questions.length,
		sessionId: ctx.sessionManager?.getSessionId() ?? undefined,
		cwd: ctx.cwd,
	});
	try {
		const outcome = await ctx.ui.custom<AskOutcome>(
			(tui, theme, _keybindings, done) =>
				new AskPrompt(
					session,
					theme,
					done,
					() => tui.requestRender(),
					() => tui.terminal?.rows ?? CONFIG.assumedRows,
				),
			{ overlay: false },
		);
		// The component always resolves through done(), but a host that tore it
		// down some other way would leave this undefined.
		return outcome ?? { kind: "dismissed" };
	} finally {
		pi.events.emit(ASK_CHANNEL, { active: false, blocking });
	}
}
