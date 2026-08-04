/**
 * The shells control panel: shift+up takes the editor's place and lists this
 * session's background shells; drilling into one shows a live tail of its
 * output. From here a shell can be killed, and its output path fetched for a
 * proper pager.
 *
 * The mechanics are ultracode's WorkflowsPanel, kept deliberately: the panel
 * sits in the editor slot (`overlay: false`) framed by rules with key hints
 * under the lower one; `q` and ctrl+c close from anywhere because the prompt —
 * and with it every app key handler — is gone while the panel is up; an orphan
 * watchdog notices when something else silently claims the slot (pi keeps no
 * bookkeeping of overlay:false components) and stands down WITHOUT resolving
 * done(), since resolving would evict the new owner; and the "ask-user:asking"
 * announcement closes the panel before a question mounts. Every rendered line
 * is flattened and width-clamped — an over-wide or multi-line line in the
 * editor slot crashes pi-tui.
 *
 * Output is read as a bounded tail of output.log, cached by file size (the
 * file is append-only, so size is a version number). Scrolling is an offset
 * from the bottom; 0 means "follow", which is where every open starts.
 */

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { ASK_CHANNEL, CONFIG, PANEL_OPEN_CHANNEL } from "./config.ts";
import { commandLabel, formatElapsed, statusLabel, statusMark } from "./render.ts";
import type { ShellJob, ShellRegistry } from "./shells.ts";
import { outputPath, outputSize, tailOutput } from "./store.ts";

export interface TuiHost {
	agentDir: string;
	registry: ShellRegistry;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	requestRender: () => void;
	rows: () => number;
	/** Detach without resolving — see the watchdog. Emits the stand-down. */
	onDetached?: () => void;
}

type View = "list" | "detail";

/** `q close` leads every list so width packing and height clipping never drop the exit. */
const HINTS: Record<View, string[]> = {
	list: ["q close", "↑↓ select", "→ open", "c kill", "e output path"],
	detail: ["q close", "← back", "↑↓ scroll", "G follow", "c kill", "e output path"],
};

/** Refresh ticks with no render before concluding the slot was lost. */
export const ORPHAN_TICKS = 3;

/** Pack hint fragments into lines no wider than `width`; measured visibly, since they are styled. */
export function packHints(parts: string[], width: number): string[] {
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

export class ShellsPanel {
	focused = false;

	private view: View = "list";
	private jobs: ShellJob[] = [];
	private index = 0;
	/** The selected shell's id, so a refresh follows the shell and not the row. */
	private selectedId: string | undefined;
	/** Detail scroll, in lines up from the bottom. 0 = follow the live tail. */
	private scroll = 0;
	private status = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Tail cache for the detail view, invalidated by file size. */
	private tail: { shellId: string; size: number; lines: string[] } | undefined;
	/** Renders served, and the count at the last tick — the orphan watchdog's input. */
	private renders = 0;
	private rendersAtLastTick = -1;
	private idleTicks = 0;

	constructor(
		private readonly host: TuiHost,
		private readonly theme: Theme,
		private readonly done: (value: undefined) => void,
	) {
		this.refresh();
		this.timer = setInterval(() => {
			const drew = this.renders !== this.rendersAtLastTick;
			this.rendersAtLastTick = this.renders;
			if (drew) {
				this.idleTicks = 0;
			} else if (++this.idleTicks >= ORPHAN_TICKS) {
				// Stand down WITHOUT resolving. done() would evict whatever
				// component actually holds the slot now.
				this.dispose();
				this.host.onDetached?.();
				return;
			}
			this.refresh();
			this.host.requestRender();
		}, CONFIG.tickMs);
		(this.timer as { unref?: () => void }).unref?.();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.status = "";

		if (data === "q") return void this.close();
		// While the panel holds the editor slot the app's own key handlers are
		// dead — an unhandled ctrl+c would feel like being trapped in here.
		if (matchesKey(data, "ctrl+c")) return void this.close();
		if (matchesKey(data, "escape")) {
			if (this.view === "detail") this.view = "list";
			else this.close();
			return;
		}
		if (matchesKey(data, "up") || data === "k") return void this.move(-1);
		if (matchesKey(data, "down") || data === "j") return void this.move(1);
		if (matchesKey(data, "left") || data === "h") {
			if (this.view === "detail") this.view = "list";
			return;
		}
		if (matchesKey(data, "right") || matchesKey(data, "return") || data === "l") {
			if (this.view === "list" && this.current()) {
				this.view = "detail";
				this.scroll = 0;
			}
			return;
		}
		if (data === "G") {
			this.scroll = 0;
			return;
		}
		if (data === "c") return void this.kill();
		if (data === "e") return void this.showOutputPath();
	}

	private close(): void {
		this.dispose();
		this.done(undefined);
	}

	private current(): ShellJob | undefined {
		return this.jobs[this.index];
	}

	private move(delta: number): void {
		if (this.view === "detail") {
			// Up increases distance from the bottom; down walks back toward the tail.
			const max = Math.max(0, this.tailLines().length - 1);
			this.scroll = Math.max(0, Math.min(max, this.scroll + (delta < 0 ? 1 : -1)));
			return;
		}
		if (this.jobs.length === 0) return;
		this.index = Math.max(0, Math.min(this.jobs.length - 1, this.index + delta));
		this.selectedId = this.jobs[this.index]?.meta.shellId;
	}

	private kill(): void {
		const job = this.current();
		if (!job) return;
		const outcome = this.host.registry.kill(job.meta.shellId, "panel");
		this.status =
			outcome === "killed"
				? `killing ${commandLabel(job.meta.command, 32)}`
				: outcome === "not-running"
					? `already finished`
					: `not running in this session`;
		this.refresh();
	}

	private showOutputPath(): void {
		const job = this.current();
		if (!job) return;
		this.status = outputPath(this.host.agentDir, job.meta.shellId);
	}

	private refresh(): void {
		this.jobs = this.host.registry.all();
		const found = this.selectedId ? this.jobs.findIndex((job) => job.meta.shellId === this.selectedId) : -1;
		this.index = found >= 0 ? found : Math.min(this.index, Math.max(0, this.jobs.length - 1));
		this.selectedId = this.jobs[this.index]?.meta.shellId;
	}

	private tailLines(): string[] {
		const job = this.current();
		if (!job) return [];
		const id = job.meta.shellId;
		const size = outputSize(this.host.agentDir, id);
		if (this.tail?.shellId !== id || this.tail.size !== size) {
			this.tail = { shellId: id, size, lines: tailOutput(this.host.agentDir, id, CONFIG.panelTailBytes) };
		}
		return this.tail.lines;
	}

	private title(): string {
		const theme = this.theme;
		if (this.view === "detail") {
			const job = this.current();
			if (!job) return theme.bold("background shells");
			return `${theme.bold(commandLabel(job.meta.command, 60))}  ${theme.fg("muted", statusLabel(job.meta, Date.now()))}`;
		}
		const running = this.jobs.filter((job) => job.meta.status === "running").length;
		return `${theme.bold("background shells")}  ${theme.fg("muted", `${running} running · ${this.jobs.length} total`)}`;
	}

	/** Body lines for the current view, at most `budget` of them. */
	private body(budget: number): string[] {
		const theme = this.theme;
		if (this.view === "detail") {
			const lines = this.tailLines();
			if (lines.length === 0) return [theme.fg("muted", "(no output yet)")];
			// The tail window's line count can shrink between refreshes (long
			// lines displacing many short ones), so a scroll set at keypress
			// time is re-clamped here, where the current count is known.
			this.scroll = Math.min(this.scroll, Math.max(0, lines.length - 1));
			// When scrolled, one budget row is spent on the marker — content
			// filling all of them would push the marker past render()'s clamp.
			const room = this.scroll > 0 ? Math.max(1, budget - 1) : budget;
			const end = Math.max(1, lines.length - this.scroll);
			const start = Math.max(0, end - room);
			const shown = lines.slice(start, end).map((line) => theme.fg("text", line));
			if (this.scroll > 0) shown.push(theme.fg("muted", `  ↓ ${this.scroll} more (G follows the tail)`));
			return shown;
		}
		if (this.jobs.length === 0) {
			return [
				theme.fg("muted", "No background shells in this session."),
				theme.fg("muted", "Ask pi to run a command with run_in_background: true."),
			];
		}
		const now = Date.now();
		// Window the list around the caret when it outgrows the budget. The
		// window pre-pays a row for each potential "more" marker — content
		// filling the whole budget would push the markers (and, sliced from
		// the bottom, the caret itself) past render()'s clamp.
		const total = this.jobs.length;
		const room = total > budget ? Math.max(1, budget - 2) : budget;
		const start = Math.max(0, Math.min(this.index - Math.floor(room / 2), total - room));
		const end = Math.min(total, start + room);
		const rows: string[] = [];
		for (let i = start; i < end; i++) {
			const job = this.jobs[i]!;
			const caret = i === this.index ? theme.fg("accent", "❯ ") : "  ";
			const mark = job.meta.status === "running" ? theme.fg("accent", statusMark("running")) : theme.fg("muted", statusMark(job.meta.status));
			const label = i === this.index ? theme.bold(commandLabel(job.meta.command)) : commandLabel(job.meta.command);
			rows.push(`${caret}${mark} ${label}  ${theme.fg("muted", `·  ${statusLabel(job.meta, now)}`)}`);
		}
		if (start > 0) rows.unshift(theme.fg("muted", `  ↑ ${start} more`));
		if (end < this.jobs.length) rows.push(theme.fg("muted", `  ↓ ${this.jobs.length - end} more`));
		return rows;
	}

	render(width: number): string[] {
		// The watchdog's heartbeat: being asked to draw is the only evidence
		// this component still holds the editor slot.
		this.renders++;
		const theme = this.theme;
		const inner = Math.max(1, width - 2);
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		const row = (text: string) => ` ${truncateToWidth(text, inner)}`;
		const hints = packHints(HINTS[this.view], inner).map((line) => theme.fg("muted", line));
		const footer = this.status ? [theme.fg("warning", this.status), ...hints] : hints;

		const available = this.host.rows() - CONFIG.screenReserve - 3;
		const room = Math.max(1, available - 3);
		// Height pressure must never clip the way out: when the footer cannot
		// fit whole and a status is up, the exit hint shares the status row.
		const shown =
			footer.length <= room
				? footer
				: this.status
					? [`${theme.fg("muted", HINTS[this.view][0]!)}  ·  ${theme.fg("warning", this.status)}`, ...hints].slice(0, room)
					: hints.slice(0, room);
		const budget = Math.max(3, available - shown.length);
		const body = this.body(budget).slice(0, budget);

		const lines = [rule, row(this.title()), ...body.map(row), rule, ...shown.map(row)];
		return lines.map((line) => {
			const flat = line.includes("\n") ? line.replace(/\r?\n/g, " ") : line;
			return visibleWidth(flat) > width ? truncateToWidth(flat, width, "") : flat;
		});
	}
}

/**
 * Open the panel in the editor slot and run the full open/close protocol:
 * stand-down announcement around the whole thing (in a finally — an eviction
 * or a throw must not leave the statusline standing down forever), and
 * self-close before an ask_user question mounts.
 */
export async function showShells(pi: ExtensionAPI, ctx: ExtensionContext, host: Omit<TuiHost, "requestRender" | "rows">): Promise<void> {
	pi.events.emit(PANEL_OPEN_CHANNEL, { active: true });

	let close: ((value: undefined) => void) | undefined;
	const unsubscribe = pi.events.on(ASK_CHANNEL, (data) => {
		if ((data as { active?: boolean } | undefined)?.active !== true) return;
		close?.(undefined);
	});

	try {
		await ctx.ui.custom<undefined>(
			(tui, theme, _keybindings, done) => {
				close = done;
				return new ShellsPanel(
					{
						...host,
						requestRender: () => tui.requestRender(),
						rows: () => tui.terminal?.rows ?? CONFIG.assumedRows,
						onDetached: () => pi.events.emit(PANEL_OPEN_CHANNEL, { active: false }),
					},
					theme,
					done,
				);
			},
			{ overlay: false },
		);
	} finally {
		unsubscribe();
		pi.events.emit(PANEL_OPEN_CHANNEL, { active: false });
	}
}
