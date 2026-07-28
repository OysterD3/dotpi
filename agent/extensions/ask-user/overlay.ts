/**
 * The ask_user overlay: a focused TUI component driving an AskSession.
 *
 * This exists because pi's select/input/confirm dialogs cannot bind keys inside
 * themselves, and every affordance here is a key: Tab to annotate the focused
 * answer in place, ← / → to walk between questions, typing straight into the
 * free-text row. `ctx.ui.custom()` gives a component that owns its own input,
 * which is the only way to express that (same mechanism as /workflows).
 *
 * Rendering never truncates. Long option text and long descriptions wrap; the
 * user is being asked to make a decision and hiding half the sentence behind an
 * ellipsis is exactly the wrong trade.
 */
import { CURSOR_MARKER, matchesKey } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
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

export class AskOverlay {
	focused = true;

	constructor(
		private readonly session: AskSession,
		private readonly theme: Theme,
		private readonly done: (outcome: AskOutcome) => void,
		private readonly requestRender: () => void,
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
			session.toggle();
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

	render(width: number): string[] {
		const inner = Math.max(20, width - 2);
		return this.session.phase === "review" ? this.renderReview(inner) : this.renderQuestion(inner);
	}

	private renderQuestion(width: number): string[] {
		const theme = this.theme;
		const session = this.session;
		const question = session.question;
		const lines: string[] = [];

		lines.push(...this.progressHeader(width));
		lines.push("");

		if (question.header) {
			lines.push(theme.fg("accent", `[${question.header}]`));
		}
		for (const line of wrap(question.question, width)) {
			lines.push(theme.bold(line));
		}
		if (question.multiSelect) {
			lines.push(theme.fg("muted", "Select all that apply."));
		}
		lines.push("");

		const rows = session.rows();
		rows.forEach((row, index) => {
			lines.push(...this.renderRow(row, index === session.cursor, width));
		});

		lines.push("");
		lines.push(...this.hints(width));
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

	private renderReview(width: number): string[] {
		const theme = this.theme;
		const lines: string[] = [];
		lines.push(theme.bold("Review your answers"));
		lines.push("");

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
			lines.push("");
		});

		lines.push(
			theme.fg("muted", "Enter") +
				theme.fg("muted", " send  ") +
				theme.fg("muted", "←") +
				theme.fg("muted", " back  ") +
				theme.fg("muted", "Esc") +
				theme.fg("muted", " cancel"),
		);
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
		} else {
			parts.push("↑↓ move", session.question.multiSelect ? "Space toggle" : "Space/Enter select");
			parts.push("Tab add note");
			if (session.questions.length > 1 || session.isLastQuestion) {
				parts.push(session.isLastQuestion ? "→ review" : "←→ question");
			}
			parts.push("Esc cancel");
		}
		return wrap(parts.join("  ·  "), width).map((line) => theme.fg("muted", line));
	}
}
