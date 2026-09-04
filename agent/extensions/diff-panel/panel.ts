/**
 * The panel itself: an overlay on the right-hand half of the screen, drawn
 * from a ChangeSet.
 *
 *     │ 2 files changed  +18 -1
 *     │
 *     │ src/components/Header.tsx                     +3 -1
 *     │ src/styles.css                                  +15
 *     │
 *     │ ── src/components/Header.tsx ─────────────────────
 *     │  27 -      position: 'relative',
 *     │  27 +      position: 'sticky',
 *     │ ───────────────────────────────────────────────────
 *     │ shift+→ drive  ·  /diff close
 *
 * Two ways of holding it. Unfocused, it FOLLOWS: the editor keeps the
 * keyboard, and every read scrolls the panel to the file the model touched
 * last, so what is on screen is what just happened. Focused, it is DRIVEN:
 * the keys below scroll it and the follow is suspended until esc gives the
 * keyboard back.
 *
 * Every rendered line is exactly `width` columns and holds no newline. The
 * overlay is composited over the chat cell by cell, so a short line would
 * let the chat show through it and a wide one is cut by pi-tui.
 */
import { renderDiff, type Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, sliceByColumn, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { CONFIG } from "./config.ts";
import type { Reading } from "./git.ts";
import { type ChangedFile, type ChangeSet, gutterWidth } from "./model.ts";

export interface PanelHost {
	requestRender(): void;
	rows(): number;
	/** Give the keyboard back to the editor; the panel stays up. */
	unfocus(): void;
	close(): void;
}

type View = Reading | { kind: "loading" };

interface Body {
	set: ChangeSet;
	width: number;
	lines: string[];
	/** Where each file's section starts, in body lines, in file order. */
	starts: Array<{ path: string; at: number }>;
}

/** `q close` leads the driving list so a narrow panel never clips the way out. */
const HINTS = {
	following: ["shift+→ drive", "/diff close"],
	driving: ["q close", "esc back", "↑↓ scroll", "⇥ next file", "g/G ends"],
};

/** Pack hint fragments into lines no wider than `width`, measured visibly. */
export function packHints(parts: readonly string[], width: number): string[] {
	const lines: string[] = [];
	let line = "";
	for (const part of parts) {
		const candidate = line ? `${line}  ·  ${part}` : part;
		if (line && visibleWidth(candidate) > width) {
			lines.push(line);
			line = part;
		} else {
			line = candidate;
		}
	}
	if (line) lines.push(line);
	return lines.length > 0 ? lines : [""];
}

/** A leading run of SGR codes, then whitespace: the break a wrap was made at. */
const LEADING_BLANK = /^((?:\x1b\[[0-9;]*m)*)\s+/;

/**
 * Wrap one painted diff line so its continuation hangs under the text rather
 * than under the line number. pi-tui's wrap drops the whitespace it broke at
 * and carries the colour across, so the head is taken from it and the rest is
 * sliced off by column and wrapped again, narrower by the gutter.
 */
export function wrapDiffLine(line: string, width: number, indent: number): string[] {
	if (visibleWidth(line) <= width) return [line];
	const head = wrapTextWithAnsi(line, width)[0];
	if (head === undefined || visibleWidth(head) === 0) return [truncateToWidth(line, width, "…")];
	const rest = sliceByColumn(line, visibleWidth(head), visibleWidth(line)).replace(LEADING_BLANK, "$1");
	if (visibleWidth(rest) === 0) return [head];
	const pad = " ".repeat(Math.min(indent, Math.max(0, width - 1)));
	return [head, ...wrapTextWithAnsi(rest, Math.max(1, width - pad.length)).map((piece) => pad + piece)];
}

/**
 * A path cut from the front, since the file name is the end you need. Cut by
 * column, not by character: git hands paths over unquoted, and a CJK or emoji
 * name is two columns a character.
 */
export function fitPath(path: string, width: number): string {
	const columns = visibleWidth(path);
	if (columns <= width) return path;
	if (width <= 1) return "…";
	return `…${sliceByColumn(path, columns - (width - 1), width - 1, true)}`;
}

export class DiffPanel {
	/** Set by pi-tui while the overlay holds the keyboard. */
	focused = false;

	private view: View = { kind: "loading" };
	/** The file the model touched last — what the panel follows. */
	private latest: string | undefined;
	private scroll = 0;
	/** Body rows shown at the last render; a page, for the page keys. */
	private page = 1;
	private memo: Body | undefined;

	constructor(
		private readonly host: PanelHost,
		private readonly theme: Theme,
	) {}

	dispose(): void {}

	/** A theme switch repaints everything; the memo holds painted lines. */
	invalidate(): void {
		this.memo = undefined;
	}

	update(reading: Reading, latest: string | undefined): void {
		// A miss keeps the last set on screen; only a panel that never had one
		// says so.
		if (reading.kind !== "unavailable" || this.view.kind === "loading") this.view = reading;
		if (latest !== undefined) this.latest = latest;
		this.host.requestRender();
	}

	handleInput(data: string): void {
		if (data === "q" || matchesKey(data, "ctrl+c") || matchesKey(data, CONFIG.key)) return void this.host.close();
		if (matchesKey(data, "escape")) return void this.host.unfocus();
		if (matchesKey(data, "up") || data === "k") this.scroll -= 1;
		else if (matchesKey(data, "down") || data === "j") this.scroll += 1;
		else if (matchesKey(data, "pageup") || data === "b") this.scroll -= this.page;
		else if (matchesKey(data, "pagedown") || data === " ") this.scroll += this.page;
		else if (data === "g") this.scroll = 0;
		else if (data === "G") this.scroll = Number.MAX_SAFE_INTEGER;
		else if (matchesKey(data, "tab") || data === "n") this.jump(1);
		else if (matchesKey(data, "shift+tab") || data === "p") this.jump(-1);
		else return;
		this.host.requestRender();
	}

	/** To the next (or previous) file's section, from wherever the top row is. */
	private jump(direction: 1 | -1): void {
		const starts = this.memo?.starts ?? [];
		if (direction > 0) {
			const next = starts.find((start) => start.at > this.scroll);
			if (next) this.scroll = next.at;
			return;
		}
		const previous = [...starts].reverse().find((start) => start.at < this.scroll);
		this.scroll = previous ? previous.at : 0;
	}

	private counts(added: number, removed: number): string {
		const parts: string[] = [];
		if (added > 0) parts.push(this.theme.fg("success", `+${added}`));
		if (removed > 0) parts.push(this.theme.fg("error", `-${removed}`));
		return parts.join(" ");
	}

	private title(width: number, scrolled: { total: number; budget: number }): string {
		const theme = this.theme;
		const text = this.titleText();
		if (scrolled.total <= scrolled.budget) return text;
		const position = `${this.scroll + 1}–${Math.min(scrolled.total, this.scroll + scrolled.budget)} of ${scrolled.total}`;
		const gap = width - visibleWidth(text) - visibleWidth(position);
		return gap < 2 ? text : `${text}${" ".repeat(gap)}${theme.fg("muted", position)}`;
	}

	private titleText(): string {
		const theme = this.theme;
		const view = this.view;
		switch (view.kind) {
			case "loading":
				return theme.fg("muted", "Reading the working tree…");
			case "unavailable":
				return theme.fg("muted", "git did not answer — trying again");
			case "no-repo":
				return theme.fg("muted", "Not a git repository — nothing to compare against");
			case "changes": {
				const count = view.set.files.length;
				if (count === 0) return theme.fg("muted", "No uncommitted changes");
				return `${theme.bold(`${count} file${count === 1 ? "" : "s"} changed`)}  ${this.counts(view.set.added, view.set.removed)}`;
			}
		}
	}

	/** `path …… +3 -1`: the counts flush right, the path cut from the front to make room. */
	private fileRow(file: ChangedFile, width: number): string {
		const theme = this.theme;
		const right = file.note ? theme.fg("muted", file.note) : this.counts(file.added, file.removed);
		const rightWidth = visibleWidth(right);
		const path = fitPath(file.path, Math.max(1, width - rightWidth - 2));
		const painted = file.status === "deleted" ? theme.fg("muted", path) : theme.fg("text", path);
		const gap = " ".repeat(Math.max(1, width - visibleWidth(path) - rightWidth));
		return `${painted}${gap}${right}`;
	}

	private sectionHeader(path: string, width: number): string {
		const theme = this.theme;
		const shown = fitPath(path, Math.max(1, width - 4));
		const rule = "─".repeat(Math.max(0, width - visibleWidth(shown) - 4));
		return `${theme.fg("border", "── ")}${theme.bold(theme.fg("text", shown))}${theme.fg("border", ` ${rule}`)}`;
	}

	/**
	 * The scrollable middle: the file list, then one section per file with a
	 * diff. Memoised on the set and the width — the reader hands back the same
	 * set object while nothing has changed, so a quiet poll costs no layout.
	 */
	private body(width: number): Body {
		const view = this.view;
		const set = view.kind === "changes" ? view.set : { files: [], added: 0, removed: 0 };
		if (this.memo !== undefined && this.memo.set === set && this.memo.width === width) return this.memo;

		const lines: string[] = [];
		const starts: Body["starts"] = [];
		for (const file of set.files) lines.push(this.fileRow(file, width));
		for (const file of set.files) {
			if (file.diff === undefined) continue;
			lines.push("");
			starts.push({ path: file.path, at: lines.length });
			lines.push(this.sectionHeader(file.path, width));
			const indent = gutterWidth(file.diff);
			for (const line of renderDiff(file.diff).split("\n")) lines.push(...wrapDiffLine(line, width, indent));
		}
		this.memo = { set, width, lines, starts };
		return this.memo;
	}

	render(width: number): string[] {
		const theme = this.theme;
		const inner = Math.max(1, width - 2);
		const height = Math.max(4, this.host.rows() - CONFIG.bottomReserve);
		const hints = packHints(this.focused ? HINTS.driving : HINTS.following, inner).map((line) => theme.fg("muted", line));
		// Title, rule and the hint rows; the body gets what is left, and always one row.
		const budget = Math.max(1, height - 2 - hints.length);
		this.page = budget;

		const body = this.body(inner);
		const max = Math.max(0, body.lines.length - budget);
		if (this.focused) {
			this.scroll = Math.max(0, Math.min(max, this.scroll));
		} else {
			// Following puts the followed section's header on the top row even
			// when that leaves blank rows under a short diff: the point of the
			// row is to say "this is what just happened", not to fill the panel.
			const start = this.latest === undefined ? undefined : body.starts.find((entry) => entry.path === this.latest);
			this.scroll = start === undefined ? 0 : start.at;
		}

		const shown = body.lines.slice(this.scroll, this.scroll + budget);
		// Short of content, the panel still has to cover the chat for its full height.
		while (shown.length < budget) shown.push("");

		const rows = [this.title(inner, { total: body.lines.length, budget }), ...shown, theme.fg("border", "─".repeat(inner)), ...hints];
		const gutter = `${theme.fg("border", "│")} `;
		return rows.map((row) => {
			// A control character in a row is a cursor movement the compositor
			// cannot see; the model strips line endings, and this is the backstop.
			const flat = /[\r\n]/.test(row) ? row.replace(/[\r\n]+/g, " ") : row;
			return gutter + truncateToWidth(flat, inner, "…", true);
		});
	}
}
