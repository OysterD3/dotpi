/**
 * The `/skills` menu: one list, Space cycles a skill's state in place, Esc
 * saves.
 *
 * Claude Code's interaction, deliberately, for the same reason the settings key
 * is its key: the thing being configured is the same thing, and a second way of
 * driving it is a second thing to remember. It replaces two nested
 * `ctx.ui.select` dialogs — pick a skill, then pick a state from a five-item
 * list, then land back on the first dialog — which cost four keystrokes and a
 * screen change per skill and made "set six of these" a chore you did once and
 * never revisited.
 *
 * ## One save, not one per keystroke
 *
 * The old flow wrote settings.json after every single toggle. That was right
 * when a toggle was a whole dialog round trip and wrong now: cycling one skill
 * through to `preload` passes four intermediate states, and writing each of them
 * would be four writes and four git diffs for one decision. Esc saves the lot.
 * `q` and ctrl+c leave without writing, which is what makes cycling to look at
 * the options safe.
 *
 * ## Only what you changed is written
 *
 * The rows show the RESOLVED state of each skill, globs included — which is what
 * you want to see, and a trap for the save. Writing every row back as an exact
 * key would expand `"chrome-devtools-mcp:*": "off"` into six exact entries the
 * first time anyone pressed Esc, and the glob would never match a seventh member
 * again. So a row that was not touched writes nothing at all, and the map keeps
 * whatever shape it had. A row cycled back to where it started counts as
 * untouched.
 *
 * ## The `*` row
 *
 * Last in the list, under a rule: the default for everything not named. It is
 * the `"*"` key, which select.ts already resolves as the least specific glob, so
 * it needs no special case anywhere but here — and here it needs one, because
 * otherwise the only way to set a default is to hand-edit the file the picker
 * exists to save you from.
 */

import { matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MODE, MODE_LABEL, MODES, type Mode } from "./config.ts";

/** The `"*"` key, shown as a row of its own so the default is reachable here. */
export const DEFAULT_ROW = "*";

export type PickerRow = {
	name: string;
	/** The state it resolved to when the picker opened. */
	mode: Mode;
	/** What its entry costs in the prompt right now; 0 when it is not listed. */
	chars: number;
};

/** What Esc hands back: the new map, or undefined when nothing was changed. */
export type PickerResult = Record<string, Mode> | undefined;

/** The state after this one, wrapping. Space walks this; ← walks it backwards. */
export function cycle(mode: Mode, step: 1 | -1): Mode {
	const index = MODES.indexOf(mode);
	return MODES[(index + step + MODES.length) % MODES.length]!;
}

/**
 * The map to save, given what was on screen and what the file already said.
 *
 * Pure and exported because this is the part with a wrong answer in it — see the
 * header on why an untouched row must write nothing.
 */
export function nextSkills(
	rows: readonly PickerRow[],
	current: Readonly<Record<string, Mode>>,
	staged: readonly Mode[],
): Record<string, Mode> {
	const next: Record<string, Mode> = { ...current };
	rows.forEach((row, index) => {
		const mode = staged[index];
		if (mode === undefined || mode === row.mode) return;
		next[row.name] = mode;
	});
	return next;
}

const HINTS = "space/→ cycle  ·  ← back  ·  r reset all  ·  esc save  ·  q cancel";

/** Rows kept above the picker, so the transcript does not scroll away under it. */
const SCREEN_RESERVE = 6;
/** Assumed when the host cannot report a height (tests, odd terminals). */
const ASSUMED_ROWS = 24;

export class SkillsPicker {
	focused = false;

	/** The staged state of each row; only rows that differ from `rows[i].mode` are saved. */
	private staged: Mode[];
	private index = 0;

	constructor(
		private readonly rows: PickerRow[],
		private readonly current: Readonly<Record<string, Mode>>,
		private readonly theme: Theme,
		private readonly rowsAvailable: () => number,
		private readonly done: (result: PickerResult) => void,
	) {
		this.staged = rows.map((row) => row.mode);
	}

	invalidate(): void {
		/* nothing cached that a theme change would invalidate */
	}

	handleInput(data: string): void {
		// q and ctrl+c leave without saving. The panel holds the editor's slot, so
		// there is no prompt to escape to and every view has to offer a way out.
		if (data === "q" || matchesKey(data, "ctrl+c")) return void this.done(undefined);
		if (matchesKey(data, "escape")) return void this.save();

		if (matchesKey(data, "up") || data === "k") return void this.move(-1);
		if (matchesKey(data, "down") || data === "j") return void this.move(1);
		if (data === " " || matchesKey(data, "right") || data === "l") return void this.step(1);
		if (matchesKey(data, "left") || data === "h") return void this.step(-1);
		if (data === "r") {
			// Every row to the default, staged like any other edit — so `q` still
			// walks away from it and Esc is still the only thing that writes.
			this.staged = this.rows.map(() => DEFAULT_MODE);
		}
	}

	private move(delta: number): void {
		if (this.rows.length === 0) return;
		this.index = Math.min(this.rows.length - 1, Math.max(0, this.index + delta));
	}

	private step(direction: 1 | -1): void {
		const mode = this.staged[this.index];
		if (mode === undefined) return;
		this.staged[this.index] = cycle(mode, direction);
	}

	private save(): void {
		const changed = this.rows.some((row, index) => this.staged[index] !== row.mode);
		// Undefined, not the unchanged map: it lets the caller skip the write
		// entirely rather than rewriting settings.json byte-for-byte on every Esc.
		this.done(changed ? nextSkills(this.rows, this.current, this.staged) : undefined);
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(1, width - 2);
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		const row = (text: string) => ` ${truncateToWidth(text, inner)}`;

		// Two rules, the title, and the hint line, all outside the list's budget.
		const budget = Math.max(3, this.rowsAvailable() - SCREEN_RESERVE - 4);
		const lines: string[] = [];

		if (this.rows.length === 0) {
			lines.push(theme.fg("muted", "No skills are loaded, so there is nothing to tune."));
		} else {
			const window = this.windowFor(budget);
			if (window.start > 0) lines.push(theme.fg("muted", `  ↑ ${window.start} more`));
			for (let i = window.start; i < window.end; i++) {
				// The default's rule sits above the last row, which is always `*`.
				if (this.rows[i]!.name === DEFAULT_ROW) lines.push(theme.fg("border", "  " + "─".repeat(Math.max(4, Math.min(46, inner - 2)))));
				lines.push(this.rowLine(this.rows[i]!, this.staged[i]!, i === this.index));
			}
			if (window.end < this.rows.length) lines.push(theme.fg("muted", `  ↓ ${this.rows.length - window.end} more`));
		}

		const title = `${theme.fg("accent", theme.bold("✦ Skills"))}  ${theme.fg("muted", this.subtitle())}`;
		const out = [rule, row(title), ...lines.map(row), rule, row(theme.fg("muted", HINTS))];
		// A line wider than the terminal tears down the TUI in this slot, and an
		// embedded newline desynchronises it — the same clamp every other
		// editor-slot component in this repo ends with, for the same reason.
		return out.map((line) => truncateToWidth(line.includes("\n") ? line.replace(/\r?\n/g, " ") : line, width, ""));
	}

	private subtitle(): string {
		const changed = this.rows.filter((row, index) => this.staged[index] !== row.mode).length;
		return changed === 0 ? "space cycles a skill's state · esc saves" : `${changed} change${changed === 1 ? "" : "s"} · esc to save`;
	}

	private rowLine(row: PickerRow, mode: Mode, selected: boolean): string {
		const theme = this.theme;
		const caret = selected ? theme.fg("accent", "▸") : " ";
		const edited = mode !== row.mode;
		// The staged state takes the accent when it differs from what is saved, so
		// the rows you have touched are visible before you commit to them.
		const state = theme.fg(edited ? "warning" : "muted", `[${MODE_LABEL[mode]}]`.padEnd(13));
		const name = row.name === DEFAULT_ROW ? `${DEFAULT_ROW}  (everything else)` : row.name;
		const tail = row.name === DEFAULT_ROW ? "" : `  ${theme.fg("muted", row.chars > 0 ? `${row.chars} chars` : "not listed")}`;
		return `${caret} ${state}${theme.fg(selected ? "text" : "muted", name)}${tail}`;
	}

	/** A window over the rows that keeps the cursor visible. */
	private windowFor(budget: number): { start: number; end: number } {
		// One line is spent on the `*` row's rule whenever that row is in view, and
		// one on each "N more" marker; charging for all three is a row of slack in
		// the worst case and never an overrun, which is the direction that matters.
		const room = Math.max(1, budget - 3);
		if (this.rows.length <= room) return { start: 0, end: this.rows.length };
		const start = Math.max(0, Math.min(this.index - Math.floor(room / 2), this.rows.length - room));
		return { start, end: start + room };
	}
}

/** Rows for the picker: every loaded skill, then the `*` default. */
export function pickerRows(listed: ReadonlyArray<PickerRow>, defaultMode: Mode): PickerRow[] {
	return [...listed, { name: DEFAULT_ROW, mode: defaultMode, chars: 0 }];
}

export const PICKER_ROWS_FALLBACK = ASSUMED_ROWS;
