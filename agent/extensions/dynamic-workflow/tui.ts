/**
 * The workflow control TUI: `/workflows` takes the editor's place and lists
 * every run the store knows about, drills into a run's phases and agents, and
 * drills again into one agent.
 *
 * It sits in the slot pi's own selector and the ask_user question use — framed
 * by a rule above and below, key hints under the lower one — rather than
 * floating over the middle of the chat. The transcript above stays put and
 * readable, and the statusline stands down for the duration (see
 * PANEL_OPEN_CHANNEL in config.ts), so the panel owns the prompt and the footer
 * between them. The price is that the prompt is gone while it is up: every view
 * must offer a way out, which is why `q` and ctrl+c close from anywhere and Esc
 * steps back a level and then closes.
 *
 * It is a control surface, not just a viewer. From here a run can be paused,
 * resumed, or cancelled; an agent's transcript can be exported to HTML; and a
 * dead run can be handed back to the model as a resume instruction.
 *
 * Two data sources, deliberately: a run this process is driving reads from the
 * live registry (sub-second updates), and everything else is reconstructed from
 * its journal on disk. That is why runs from previous sessions appear at all.
 *
 * The run view is two-pane on a wide enough terminal — modeled on Claude
 * Code's own workflow monitor — rather than the drill-down alone: a fixed-
 * width tree on the LEFT (phase headings, then one row per agent, cursor-
 * highlighted) beside a detail pane on the RIGHT for whichever agent the
 * cursor is on. pi-tui has no split-layout primitive, so the join is done BY
 * HAND: each side is built as its own array of already-styled, already-width-
 * clamped strings — truncateToWidth(…, pad: true) keeps every left row
 * exactly the tree's width, and wrapTextWithAnsi wraps the right column's
 * prose to ITS width without padding (it is always the last column, so
 * nothing sits to its right that needs the row square) — and the two arrays
 * are zipped index-for-index into single lines. That is what keeps the
 * invariant every other view in this file already depends on: every emitted
 * line is single-line and within the panel's total width, because the zip is
 * exact by construction rather than clipped after the fact (pi-tui crashes on
 * either violation in this slot — see the flatten-and-clamp pass in render()).
 * Below SPLIT_MIN_WIDTH columns there is not enough room to make a second
 * column worth having, so the panel falls back to the original single-pane
 * run → agent drill-down — and that fallback is not a separate
 * implementation: agentBody() draws from the same section-builders
 * (agentHeaderLines, promptSection, activitySection) the two-pane's right
 * column does, and both funnel through the same layoutDetail() for the
 * height budget itself, so a field added to one appears in both and a
 * budgeting fix applies to both.
 *
 * `resume` is the one action the TUI cannot perform itself — replaying a
 * journal means calling the workflow tool, which only the model can do. Pressing
 * `R` therefore hands the instruction back to the command handler as the
 * panel's result, and that writes it into the editor after pi has restored it.
 * Writing from in here would be undone on the way out (see PanelResult).
 * Nothing is dispatched behind the user's back either way.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG, PANEL_OPEN_CHANNEL } from "./config.ts";
import type { AgentRow, RunProgress, RunRegistry } from "./runs.ts";
import { formatElapsed, progressFromJournal, sessionRuns, startedLabel, statusMark } from "./panel.ts";
import { statSync } from "node:fs";
import {
	agentErrorPath,
	countToolCalls,
	journalPath,
	listRuns,
	readAgentPrompt,
	readJournalLines,
	runDir,
	sessionActivity,
	type RunMeta,
	type SessionEvent,
	type ToolCallTally,
} from "./store.ts";
import { piInvocation } from "./spawn.ts";

export interface TuiHost {
	agentDir: string;
	registry: RunRegistry;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	requestRender: () => void;
	rows: () => number;
	/** The pi session id, so the list can be scoped to this session's runs. */
	sessionId?: string;
	/**
	 * This session's project directory. Unresumed interrupted runs are shown
	 * across sessions but NOT across projects — the store is global, and
	 * resuming another repository's run would spawn its agents in this tree.
	 */
	cwd?: string;
	/**
	 * Called when the panel works out it no longer holds the editor slot.
	 *
	 * Deliberately NOT `done()`. See the watchdog in the constructor: resolving
	 * is how pi is told to restore the editor, and doing that while another
	 * component owns the slot destroys it.
	 */
	onDetached?: () => void;
}

/** What the panel hands back when it closes; undefined means "just closed". */
export interface PanelResult {
	/**
	 * Text for the editor. pi restores the editor's pre-mount text on the way
	 * out and only then resolves the promise, so anything written from inside
	 * the panel is overwritten — the caller writes this after the await instead.
	 */
	editorText: string;
	/** Notice explaining what just landed in the editor. */
	notice: string;
}

type View = "runs" | "run" | "agent";

/**
 * `q close` leads every list on purpose.
 *
 * The panel holds the editor's slot, so while it is up there is no prompt and
 * no visible way out except this line — and the line is the first thing a short
 * terminal or a narrow one clips. Putting the exit first means it survives both
 * the width packing in packHints and the height clipping in render().
 */
const HINTS: Record<View, string[]> = {
	runs: ["q close", "↑↓ select", "→ open", "p pause/resume", "c cancel", "R resume run"],
	run: ["q close", "↑↓ select", "→ open", "← back", "p pause/resume", "c cancel", "g logs", "x export", "e stderr path"],
	agent: ["q close", "↑↓ agent", "← back", "PgUp/PgDn scroll prompt", "live tail below", "x export transcript", "e stderr path"],
};

/**
 * The two-pane view's own hints — shown instead of HINTS.run/HINTS.agent once
 * isSplit() is true (see render()). There is no further "open": the detail
 * pane already shows whatever the tree's cursor is on. And no `g` log pane:
 * that is a run-level concept the split layout has no row budgeted for, so it
 * stays narrow-only rather than fighting the detail pane for space.
 */
const SPLIT_HINTS = ["q close", "↑↓ agent", "esc back", "PgUp/PgDn scroll prompt", "p pause/resume", "c cancel", "x export", "e stderr path"];

/**
 * Below this many total columns there is not enough room left over for a
 * right pane worth having once the left tree (LEFT_PANE_MIN..MAX below) and
 * the gutter are paid for, so the panel keeps the original single-pane
 * run → agent drill-down instead of splitting. Not measured against a specific
 * terminal — chosen with headroom over LEFT_PANE_MAX plus the gutter plus a
 * detail column still worth reading.
 */
export const SPLIT_MIN_WIDTH = 90;

/** Left tree column width: this fraction of the panel's interior, clamped so it is never a useless sliver nor most of a very wide terminal. */
const LEFT_PANE_FRACTION = 0.3;
const LEFT_PANE_MIN = 24;
const LEFT_PANE_MAX = 44;

/** Separates the tree from the detail pane; themed with the border colour, like the panel's own rules. Fixed 3-column width: " │ ". */
const GUTTER = " │ ";
const GUTTER_WIDTH = 3;

/** Prompt lines shown before "N more" — enough to read the gist without the section swallowing the whole detail pane. */
const PROMPT_PREVIEW_LINES = 12;

/**
 * How far the prompt preview may shrink to make room for the activity tail —
 * see layoutDetail. Not 0 or 1: promptSection always draws its own heading
 * line on top of whatever this allows, so a floor of 2 is what the doc
 * comment there means by "heading + 2 lines + a 'N more' indicator" as the
 * smallest preview that still reads as a preview rather than a stub.
 */
const PROMPT_MIN_LINES = 2;

/**
 * Rows the activity tail is guaranteed once the pane can spare them — see
 * layoutDetail. Four, because that is roughly the smallest window that still
 * shows a SEQUENCE of recent actions rather than one line that reads as a
 * status field with extra steps.
 */
const ACTIVITY_MIN_ROWS = 4;

/**
 * Consecutive refresh ticks with no render before the panel concludes it has
 * been detached. Three, so a slow frame cannot close a panel someone is
 * reading; see the watchdog in the constructor for what this is detecting.
 */
export const ORPHAN_TICKS = 3;

/**
 * Clip to `budget` lines, keeping the last line and the caret.
 *
 * Two lines have to survive a squeeze, and they are at opposite ends. The run
 * view appends the log pane and the run's error LAST, and the error is the
 * reason someone opens a failed run — so a plain `slice(0, n)` drops exactly
 * the line they came for. But keeping the head instead drops the selected row,
 * and the caret is not decoration: `x`, `e` and `↑↓` all act on whatever it is
 * on, so a hidden caret means keys operating on an agent the user cannot see.
 *
 * `keep` is the index that must remain visible. The window slides to hold it,
 * the tail is always kept, and the marker says how much went missing so the
 * clip is visible rather than merely survivable.
 */
export function clipKeepingTail(lines: string[], budget: number, marker: (hidden: number) => string, keep?: number): string[] {
	if (lines.length <= budget) return lines;
	const last = lines.length - 1;
	const anchor = keep !== undefined && keep >= 0 && keep < last ? keep : 0;
	if (budget <= 1) return [lines[last]!];
	if (budget === 2) return [lines[anchor]!, lines[last]!];
	// One row for the marker, one for the tail; the rest is a window over the
	// body that contains the anchor.
	const room = budget - 2;
	const start = Math.max(0, Math.min(anchor - Math.floor(room / 2), last - room));
	const window = lines.slice(start, start + room);
	return [...window, marker(last - window.length), lines[last]!];
}

/**
 * Pack hint fragments into lines no wider than `width`.
 *
 * The hints stand in for the footer, so they must survive a narrow terminal:
 * one long joined string would simply be cut, taking the exit key with it.
 * Measured with `visibleWidth` because the separator and the fragments are
 * styled by the caller.
 */
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

/**
 * An agent that will not change state again on its own. "running" excludes it
 * (still working) and so does "queued" (see AgentRow.status in runs.ts) —
 * counting a queued agent as settled is what over-reported a phase's progress
 * fraction before this existed, since a slot-starved agent has not started
 * doing anything yet, only been asked to.
 */
export function isAgentSettled(status: AgentRow["status"]): boolean {
	return status !== "running" && status !== "queued";
}

/** ✓ done, ✗ failed, ⟲ replayed, ● running, ⧖ queued — see AgentRow.status. */
export function agentStatusIcon(status: AgentRow["status"], theme: Theme): string {
	switch (status) {
		case "done":
			return theme.fg("success", "✓");
		case "replayed":
			return theme.fg("muted", "⟲");
		case "failed":
			return theme.fg("error", "✗");
		case "queued":
			return theme.fg("muted", "⧖");
		default:
			return theme.fg("warning", "●");
	}
}

/**
 * Zip a left tree column and a right detail column into single lines.
 *
 * Exported and pure so the width invariant it exists to guarantee is testable
 * without a running panel: every joined line is `left[i]` (already exactly
 * `leftWidth` wide — truncateToWidth(…, pad: true) guarantees that on the way
 * in) plus `gutter` plus `right[i]` (already <= its own budgeted width —
 * wrapTextWithAnsi guarantees that), so the total never exceeds the width the
 * two columns were given. Whichever array is shorter is padded on ITS side
 * only — with blank leftWidth-wide space on the left, with nothing on the
 * right, since the right is always the last column and nothing sits past it
 * that needs the row square — so a tall tree beside a short detail pane (or
 * the reverse) zips instead of truncating.
 */
export function zipColumns(left: string[], right: string[], leftWidth: number, gutter: string): string[] {
	const blankLeft = " ".repeat(leftWidth);
	const rows = Math.max(left.length, right.length);
	const lines: string[] = [];
	for (let i = 0; i < rows; i++) {
		lines.push(`${left[i] ?? blankLeft}${gutter}${right[i] ?? ""}`);
	}
	return lines;
}

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

/**
 * `$0.1234` below $100, `$12.34` at or above — same shape as /usage's own
 * formatCost, reimplemented here rather than imported: extensions in this repo
 * are self-contained, and this is one line.
 *
 * Shown per agent in the detail pane, where the run-level views deliberately
 * do not show money (see runTail): those are clipped-width lines meant for a
 * glance, and a live dollar figure there is a thing to watch rather than read.
 * This is a detail view someone opened to understand ONE agent, and the
 * aggregate total still lives in /usage either way.
 */
function formatCost(cost: number): string {
	return cost >= 100 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(4)}`;
}

/** Export one agent session to HTML with pi's own exporter. */
export function exportSession(sessionFile: string, outPath: string): Promise<{ ok: boolean; detail: string }> {
	return new Promise((resolve) => {
		const invocation = piInvocation(["--export", sessionFile, outPath]);
		const child = spawn(invocation.command, invocation.args, { stdio: ["ignore", "ignore", "pipe"], shell: false });
		let stderr = "";
		child.stderr?.on("data", (data: Buffer) => {
			stderr = (stderr + data.toString()).slice(-2048);
		});
		child.on("error", (error) => resolve({ ok: false, detail: String(error) }));
		child.on("close", (code) =>
			resolve(code === 0 ? { ok: true, detail: outPath } : { ok: false, detail: stderr.trim().split("\n").at(-1) ?? `exit ${code}` }),
		);
	});
}

/** promptFor's cached shape — the task text plus whether it is a chain-opener fallback (see readAgentPrompt's ordinal). */
interface PromptCacheEntry {
	text: string;
	isChainOpenerFallback: boolean;
}

export class WorkflowsPanel {
	focused = false;

	private view: View = "runs";
	private metas: RunMeta[] = [];
	private runIndex = 0;
	/** The selected run's id, so a refresh follows the run and not the row. */
	private selectedRunId: string | undefined;
	private agentIndex = 0;
	private showLogs = false;
	private status = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	/**
	 * Cache of the reconstructed progress for the run being viewed, keyed on the
	 * journal file's own path and SIZE (statSync) rather than cleared on a
	 * timer — see refresh() and currentProgress(). Mirrors activityFor's own
	 * size gate below: these files are append-only, so size is enough of a
	 * version, and re-parsing on every one-second tick regardless — which
	 * unconditionally clearing this on every refresh() used to do — made
	 * resting on a foreign run's multi-megabyte journal cost a full re-read and
	 * JSON.parse every second for as long as the panel sat there.
	 */
	private viewed: { path: string; size: number; progress: RunProgress } | undefined;
	/** Renders served, and the count at the last tick — the orphan watchdog's input. */
	private renders = 0;
	private rendersAtLastTick = -1;
	private idleTicks = 0;
	/**
	 * The width the most recent render() was given. handleInput has no width of
	 * its own — pi-tui calls it separately from render() — so key handling that
	 * has to agree with what is currently on screen (isSplit(), below) reads it
	 * from here instead. 0 until the first render, which reads as narrow; a key
	 * cannot arrive before anything has drawn.
	 */
	private lastWidth = 0;
	/**
	 * Lines skipped from the top of the SELECTED agent's prompt (PgUp/PgDn); see
	 * promptSection(). Reset whenever the selection moves, in move() — a scroll
	 * position that survived a selection change would silently show the wrong
	 * agent's prompt starting mid-way through.
	 */
	private promptScroll = 0;
	/**
	 * A prompt never changes once written (see readAgentPrompt), so a hit is
	 * cached for the life of the panel rather than re-read on every tick. Keyed
	 * on sessionFile PLUS ordinal (see ordinalFor): a shared session's file
	 * carries one task per chained agent, so the file alone is not a unique key
	 * — every agent chained into it would otherwise share one cache entry and
	 * show whichever prompt was read first, no matter which of them it belongs
	 * to.
	 */
	private readonly promptCache = new Map<string, PromptCacheEntry>();
	/**
	 * Misses, cached by the file's SIZE at the time of the miss — re-attempted
	 * only once the file has grown or shrunk since (see promptEntryFor).
	 * Without this, a session whose task turn never lands within the head
	 * bound (or has none — see readAgentPrompt) was re-read at PROMPT_HEAD_BYTES
	 * on every tick for the rest of the panel's life. A file that does not
	 * exist AT ALL is deliberately kept OUT of this cache — see
	 * promptEntryFor's own comment for why that case stays as it was.
	 */
	private readonly promptMissCache = new Map<string, number>();
	/** Per-file incremental tool-call tally; see countToolCalls in store.ts. */
	private readonly toolCallCache = new Map<string, ToolCallTally>();

	constructor(
		private readonly host: TuiHost,
		private readonly theme: Theme,
		private readonly done: (value: PanelResult | undefined) => void,
	) {
		this.refresh();
		// Skip the runs list entirely when there is exactly one run to watch: the
		// common case for opening this panel at all is "I just started a workflow,
		// show me it", and making that cost a keypress on every single open is a
		// tax paid for a choice that is not there to make. "Active" mirrors the
		// runs-list header's own definition (see title()) — running or paused —
		// and reads meta.status (what the list itself displays), not the live
		// registry's progress.status, so this never disagrees with what `runIndex`
		// 0 would otherwise show. More than one active run leaves the picking to
		// the person, same as today.
		const active = this.metas.filter((meta) => meta.status === "running" || meta.status === "paused");
		if (active.length === 1) {
			const index = this.metas.indexOf(active[0]!);
			if (index >= 0) {
				this.runIndex = index;
				this.selectedRunId = active[0]!.runId;
				this.view = "run";
			}
		}
		this.timer = setInterval(() => {
			// Orphan watchdog.
			//
			// This component lives in pi's EDITOR container, and pi clears that
			// container from a dozen places — its model selector, its dialogs, and
			// `ctx.ui.select`, which the permissions extension calls from a
			// tool_call handler while the agent works. None of them announce, and
			// none of them put the panel back: they restore pi's editor. The panel
			// is then off-screen but alive, its `done` never fires, so the promise
			// in showWorkflows never settles, the footer it asked to stand down
			// never comes back, and this very timer runs for the rest of the
			// session re-reading every run.json.
			//
			// pi offers no "you lost the slot" signal, so infer it: a component in
			// the tree is rendered on every frame, and every tick below asks for a
			// frame. Ticks that produce no render mean nothing is drawing us.
			const drew = this.renders !== this.rendersAtLastTick;
			this.rendersAtLastTick = this.renders;
			if (drew) {
				this.idleTicks = 0;
			} else if (++this.idleTicks >= ORPHAN_TICKS) {
				// Stand down WITHOUT resolving.
				//
				// `done()` is pi's close(), and for an overlay:false component close()
				// runs restoreEditor(): editorContainer.clear(), re-add pi's editor,
				// setText(savedText), setFocus. Calling that here would clear away
				// whatever component actually holds the slot now — a permission
				// dialog, say — so its own promise would never resolve and the tool
				// call waiting on it would hang the turn. It would also overwrite the
				// prompt with whatever was typed when this panel opened.
				//
				// So: stop the timer, hand the footer back through the host, and
				// leave the promise pending. One dangling promise is a far smaller
				// price than evicting a live dialog, and pi restores the editor by
				// itself when the component that displaced us closes.
				//
				// (The ask_user path below is different and stays as it is: it
				// announces BEFORE mounting its prompt, so closing on that signal
				// happens while this panel still owns the slot.)
				this.dispose();
				this.host.onDetached?.();
				return;
			}
			this.refresh();
			this.host.requestRender();
		}, 1000);
		(this.timer as { unref?: () => void }).unref?.();
	}

	dispose(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
	}

	invalidate(): void {
		/* nothing cached that a theme change would invalidate */
	}

	/**
	 * Re-list the runs, keeping the caret on the run it was on.
	 *
	 * This fires every second and lists newest-first, so a run starting while
	 * the panel is open shifts every row down. Tracking the row index alone
	 * would silently move the selection onto a different run — and `c` cancels
	 * whatever the caret is on.
	 */
	private refresh(): void {
		this.metas = sessionRuns(
			listRuns(this.host.agentDir),
			this.host.sessionId,
			(runId) => this.host.registry.get(runId) !== undefined,
			this.host.cwd,
		);
		const found = this.selectedRunId ? this.metas.findIndex((meta) => meta.runId === this.selectedRunId) : -1;
		this.runIndex = found >= 0 ? found : Math.min(this.runIndex, Math.max(0, this.metas.length - 1));
		this.selectedRunId = this.metas[this.runIndex]?.runId;
		// `viewed` is deliberately NOT cleared here any more: it is keyed on the
		// journal's own path and size (see currentProgress()), which already
		// tells a different run — or the same run with a genuinely bigger
		// journal — apart from "nothing changed". Clearing it unconditionally on
		// every one-second tick, as this used to, defeated that cache entirely:
		// a foreign run's multi-megabyte journal.jsonl was re-read and
		// JSON.parsed every second for as long as the panel simply sat on it —
		// which the constructor's single-active-run jump makes the RESTING
		// state, not an edge case.
	}

	private currentMeta(): RunMeta | undefined {
		return this.metas[this.runIndex];
	}

	/**
	 * Live progress when this process owns the run, else the journal —
	 * re-parsed only when the journal has actually grown or shrunk since the
	 * last look, the same size-gate reasoning as activityFor below. These
	 * files are append-only, so size is enough of a version, and a foreign
	 * run's journal reaching megabytes makes an unconditional re-parse (this
	 * used to happen on every refresh() tick — see the comment there) a cost
	 * that scales with how long the panel has simply been resting on the run.
	 */
	private currentProgress(): RunProgress | undefined {
		const meta = this.currentMeta();
		if (!meta) return undefined;
		const live = this.host.registry.get(meta.runId);
		if (live) return live.progress;
		const path = journalPath(this.host.agentDir, meta.runId);
		let size = -1;
		try {
			size = statSync(path).size;
		} catch {
			/* no journal on disk yet (or any more); -1 reads as "not cached" below */
		}
		if (this.viewed && this.viewed.path === path && this.viewed.size === size) return this.viewed.progress;
		const progress = progressFromJournal(meta, readJournalLines(this.host.agentDir, meta.runId));
		this.viewed = { path, size, progress };
		return progress;
	}

	private agents(): AgentRow[] {
		const progress = this.currentProgress();
		if (!progress) return [];
		return progress.phases.flatMap((phase) => phase.agents);
	}

	// ------------------------------------------------------------------ input

	handleInput(data: string): void {
		// A status message answers the keystroke that caused it and nothing more,
		// so it survives exactly until the next one. Actions that have something
		// to say set it again further down this same dispatch.
		this.status = "";

		// q always closes; escape steps back one level and closes at the top.
		if (data === "q") return void this.done(undefined);
		// While the panel holds the editor slot the app's own key handlers are
		// dead — they hang off the editor, which is unmounted — so an unhandled
		// ctrl+c would feel like being trapped in here.
		if (matchesKey(data, "ctrl+c")) return void this.done(undefined);
		if (matchesKey(data, "escape")) {
			if (this.view === "runs") {
				this.done(undefined);
				return;
			}
			this.back();
			return;
		}
		if (matchesKey(data, "up") || data === "k") return void this.move(-1);
		if (matchesKey(data, "down") || data === "j") return void this.move(1);
		if (matchesKey(data, "left") || data === "h") return void this.back();
		if (matchesKey(data, "right") || matchesKey(data, "return") || data === "l") return void this.forward();
		if (matchesKey(data, "pageup")) return void this.scrollPrompt(-PROMPT_PREVIEW_LINES);
		if (matchesKey(data, "pagedown")) return void this.scrollPrompt(PROMPT_PREVIEW_LINES);
		if (data === "p") return void this.togglePause();
		if (data === "c") return void this.cancel();
		if (data === "R") return void this.resumeRun();
		if (data === "g") {
			// The log pane is a narrow-run-view concept only (see runBody() and the
			// SPLIT_HINTS comment on why the split layout has no row budgeted for
			// it). Toggling the flag in split mode, or in "runs"/"agent", used to
			// silently arm a pane that would only ever appear after backing out to
			// narrow "run" — a keypress with no visible effect where it was
			// pressed.
			if (this.view === "run" && !this.isSplit()) this.showLogs = !this.showLogs;
			return;
		}
		if (data === "x") return void this.exportAgent();
		if (data === "e") return void this.showStderrPath();
	}

	/** Whether the LAST render used the two-pane run layout; see lastWidth. */
	private isSplit(): boolean {
		return this.lastWidth >= SPLIT_MIN_WIDTH;
	}

	private move(delta: number): void {
		if (this.view === "runs") {
			if (this.metas.length === 0) return;
			this.runIndex = Math.min(this.metas.length - 1, Math.max(0, this.runIndex + delta));
			this.selectedRunId = this.metas[this.runIndex]?.runId;
			this.agentIndex = 0;
			this.viewed = undefined;
		} else if (this.view === "run" || this.view === "agent") {
			// The agent detail moves with the selection rather than scrolling: it
			// is a bounded handful of fields, so there is nothing in it to scroll,
			// while the agent list it belongs to is unbounded.
			const count = this.agents().length;
			if (count === 0) return;
			this.agentIndex = Math.min(count - 1, Math.max(0, this.agentIndex + delta));
			// A scroll position that survived the move would show the newly
			// selected agent's prompt starting wherever the previous one left off.
			this.promptScroll = 0;
		}
	}

	private forward(): void {
		if (this.view === "runs" && this.currentMeta()) {
			this.view = "run";
			this.agentIndex = 0;
			this.promptScroll = 0;
			return;
		}
		// Narrow fallback only: the two-pane layout already shows the selected
		// agent's detail beside the tree, so there is no further "open" — the
		// separate "agent" view exists only for the single-pane drill-down.
		if (!this.isSplit() && this.view === "run" && this.agents().length > 0) {
			this.view = "agent";
		}
	}

	/**
	 * One level back within a run; a no-op already at "runs" (h/left has never
	 * closed the panel — only q, ctrl+c and escape do, see handleInput).
	 *
	 * Two-pane collapses "run" and "agent" into one screen (see forward()), so
	 * either state steps back to the list in a single press — matching "Escape:
	 * two-pane → runs → close" — while the narrow fallback still steps back one
	 * level at a time.
	 */
	private back(): void {
		if (this.view === "runs") return;
		if (this.isSplit() || this.view === "run") {
			this.view = "runs";
			return;
		}
		this.view = "run";
	}

	private scrollPrompt(delta: number): void {
		// Only when the detail pane holding a prompt is actually ON SCREEN. Split
		// mode shows it beside the tree for either "run" or "agent" (they are one
		// screen there — see forward()/back()), but the narrow fallback's "run"
		// view is still the agent LIST: its detail pane, and the prompt inside
		// it, exist only once "agent" is entered. Scrolling before that mutated
		// promptScroll with nothing on screen to show it moved, so the agent you
		// opened next started pre-scrolled for no visible reason.
		const detailVisible = this.isSplit() ? this.view === "run" || this.view === "agent" : this.view === "agent";
		if (!detailVisible) return;
		const agent = this.selectedAgent();
		if (!agent) return;
		const total = this.promptFor(agent).split(/\r?\n/).length;
		this.promptScroll = Math.max(0, Math.min(Math.max(0, total - 1), this.promptScroll + delta));
	}

	private togglePause(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		const registry = this.host.registry;
		const outcome = meta.status === "paused" ? registry.resume(meta.runId) : registry.pause(meta.runId);
		// Named, not identified: these answer the key you just pressed on the row
		// you are looking at, so the name is unambiguous in context.
		this.status =
			outcome === "paused"
				? `${meta.name} pausing — in-flight agents finish, new ones wait`
				: outcome === "resumed"
					? `${meta.name} resumed`
					: outcome === "unknown"
						? `${meta.name} is not running in this session`
						: `${meta.name} is ${meta.status}`;
		this.refresh();
	}

	private cancel(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		const outcome = this.host.registry.cancel(meta.runId);
		this.status =
			outcome === "cancelled"
				? `cancelling ${meta.name}`
				: outcome === "unknown"
					? `${meta.name} is not running in this session`
					: `${meta.name} already finished`;
		this.refresh();
	}

	private resumeRun(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		// The editor text keeps the id: it is an instruction for the model, and
		// resumeFromRunId is the only handle that identifies a run to the tool.
		// The notice is for you, so it uses the name.
		this.done({
			editorText: `Resume workflow run ${meta.runId} ("${meta.name}"): call the workflow tool with resumeFromRunId: "${meta.runId}" so the agents that already succeeded are replayed rather than re-run.`,
			notice: `Resume instruction for "${meta.name}" put in the editor — press enter to send it.`,
		});
	}

	private selectedAgent(): AgentRow | undefined {
		return this.agents()[this.agentIndex];
	}

	private exportAgent(): void {
		const meta = this.currentMeta();
		const agent = this.selectedAgent();
		if (!meta || !agent) return;
		if (!agent.sessionFile) {
			this.status = "this agent has no transcript (it never started a session)";
			return;
		}
		const out = join(runDir(this.host.agentDir, meta.runId), `${agent.label.replace(/[^A-Za-z0-9._-]/g, "-")}.html`);
		this.status = "exporting…";
		void exportSession(agent.sessionFile, out).then((result) => {
			this.status = result.ok ? `exported to ${result.detail}` : `export failed: ${result.detail}`;
			// A big transcript can still be exporting after the panel closed and
			// the session was replaced, and every getter on a replaced context
			// throws. This is a floating promise, so an escape here is an
			// unhandled rejection — which ends the process and loses the session.
			// Same guard index.ts puts around drawPanel, for the same reason.
			try {
				this.host.notify(this.status, result.ok ? "info" : "error");
				this.host.requestRender();
			} catch {
				/* the export still finished; there is just nobody left to tell */
			}
		});
	}

	private showStderrPath(): void {
		const meta = this.currentMeta();
		const agent = this.selectedAgent();
		if (!meta || !agent) return;
		this.status = agentErrorPath(this.host.agentDir, meta.runId, agent.index);
	}

	// ----------------------------------------------------------------- render

	/**
	 * A rule above and below, the way pi frames its own in-editor selector, with
	 * the key hints under the lower rule — where the footer would be, since the
	 * footer is standing down for us.
	 */
	render(width: number): string[] {
		// The watchdog's heartbeat: being asked to draw is the only evidence this
		// component still holds the editor slot. See the constructor.
		this.renders++;
		// Recorded for handleInput, which runs between render() calls and has no
		// width of its own — see isSplit() and the field's own comment.
		this.lastWidth = width;
		const theme = this.theme;
		const inner = Math.max(1, width - 2);
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		const row = (text: string) => ` ${truncateToWidth(text, inner)}`;
		// The two-pane view replaces both HINTS.run and HINTS.agent with its own
		// set — see SPLIT_HINTS for why they differ (no further "open", no log
		// pane) — for either underlying view state, since isSplit() collapses them
		// into one screen (see forward()/back()).
		const hintParts = this.isSplit() && this.view !== "runs" ? SPLIT_HINTS : HINTS[this.view];
		const hints = packHints(hintParts, inner).map((line) => theme.fg("muted", line));
		const footer = this.status ? [theme.fg("warning", this.status), ...hints] : hints;

		// 2 rules + title + body + footer <= rows - screenReserve, so that many rows
		// of transcript survive above the panel. Both floors below are escape
		// hatches for a terminal too short to honour that at all: under roughly
		// 12 + footer rows the panel is taller than its share and the transcript
		// scrolls instead. Three rows of panel still beat none, and pi-tui scrolls
		// rather than throwing, so this is a squeeze and not a crash.
		const available = this.host.rows() - CONFIG.screenReserve - 3;
		// When only one footer row fits, it has to carry BOTH.
		//
		// Dropping the hints leaves a panel that holds the prompt's slot with
		// nothing saying how to get the prompt back. But dropping the status is
		// no better: `p`, `c` and `e` write only to `this.status` and never
		// notify, so the status line IS the entire output of those keys — losing
		// it makes them look dead, and `e`'s whole product is the path it prints.
		// So under pressure they share a line, exit hint last.
		const room = Math.max(1, available - 3);
		const shown =
			footer.length <= room
				? footer
				: this.status
					? // Exit FIRST on the shared line. `row()` truncates from the right,
						// so whichever half is last is the half a narrow terminal eats —
						// and a clipped stderr path is a nuisance where a clipped exit
						// key is a trap.
						[`${theme.fg("muted", hintParts[0]!)}  ·  ${theme.fg("warning", this.status)}`, ...hints].slice(0, room)
					: hints.slice(0, room);
		const budget = Math.max(3, available - shown.length);
		// Each view keeps its own floor (a list never shrinks below three rows, an
		// open log pane keeps its rule), and on a very short terminal those floors
		// can outrun the budget; clipping here is what keeps the arithmetic above
		// true rather than aspirational. From the middle, because the run view puts
		// the log pane and the run's error LAST and the error is what someone
		// opening a failed run came to read.
		const rendered = this.body(budget, width);
		const body = clipKeepingTail(rendered, budget, (hidden) => theme.fg("muted", `  ↕ ${hidden} more`), this.caretLine);

		const lines = [rule, row(this.title()), ...body.map(row), rule, ...shown.map(row)];
		// A line wider than the terminal is fatal in the editor slot: pi-tui tears
		// down the TUI and throws. The overlay compositor used to absorb that by
		// slicing every overlay line before compositing; a non-overlay child has no
		// such net. truncateToWidth is ANSI- and grapheme-aware and returns short
		// input untouched, so this is a no-op in the normal case and turns any
		// future composition mistake into a cosmetic clip.
		return lines.map((line) => {
			// An embedded newline is as damaging as an over-wide line and the width
			// check cannot see it: pi-tui appends each element to its buffer without
			// clearing the extra rows, so a multi-line agent error (engine.ts puts
			// Error.message in verbatim) leaves the display desynchronised. The
			// overlay compositor used to absorb this; a non-overlay child has no
			// such net, so flatten first, then clamp.
			const flat = line.includes("\n") ? line.replace(/\r?\n/g, " ") : line;
			return visibleWidth(flat) > width ? truncateToWidth(flat, width, "") : flat;
		});
	}

	private title(): string {
		const theme = this.theme;
		if (this.view === "runs") {
			const active = this.metas.filter((meta) => meta.status === "running" || meta.status === "paused").length;
			return `${theme.fg("accent", theme.bold("✦ Workflows"))}  ${theme.fg("muted", `${this.metas.length} run(s), ${active} active`)}`;
		}
		const meta = this.currentMeta();
		if (!meta) return theme.fg("accent", "✦ Workflows");
		// The two-pane layout shows the run's own title bar regardless of whether
		// the underlying state is "run" or "agent" (see forward()) — the selected
		// agent's own label is already the first line of its detail pane instead.
		if (this.view === "run" || this.isSplit()) {
			return `${theme.fg("accent", theme.bold(`${statusMark(meta.status)} ${meta.name}`))}  ${theme.fg("muted", this.runTail(meta))}`;
		}
		const agent = this.selectedAgent();
		return `${theme.fg("accent", theme.bold("↩ agent"))} ${theme.fg("text", agent?.label ?? "")}`;
	}

	private runTail(meta: RunMeta): string {
		const now = Date.now();
		const elapsed = formatElapsed((meta.endedAt ?? now) - meta.startedAt);
		// The registry first, the file second: run.json is written on a throttle
		// while a run is in flight, so a run this process is driving reports its
		// own agent count rather than the one it last managed to persist. A run
		// from another session has no registry entry and falls back to the file,
		// which is the best that exists.
		const live = this.host.registry.get(meta.runId)?.progress;
		const agents = live?.agentCount ?? meta.agentCount;
		// No cost here. What a run spent is still recorded — run.json keeps it and
		// ultracode announces it on `usage:spend` — but this panel is for
		// watching work, and money has a place of its own in `/usage`.
		//
		// The start time stands in for the run id the row used to carry: with
		// names alone, five `code-review` runs are indistinguishable, and `c`
		// cancels whichever one the caret is on.
		return `${meta.status} · ${agents} agent(s) · ${elapsed} · ${startedLabel(meta.startedAt, now)}`;
	}

	/**
	 * Index of the caret line in the last body() result, for the height clip.
	 *
	 * Recorded rather than searched for: only the view that draws the caret knows
	 * which of its lines carries it, and the clip has to keep that line whatever
	 * else it drops.
	 */
	private caretLine: number | undefined;

	private body(budget: number, width: number): string[] {
		this.caretLine = undefined;
		if (this.view === "runs") return this.runsBody(budget);
		if (width >= SPLIT_MIN_WIDTH) return this.twoPaneBody(budget, width);
		if (this.view === "run") return this.runBody(budget);
		return this.agentBody(budget);
	}

	private runsBody(budget: number): string[] {
		const theme = this.theme;
		if (this.metas.length === 0) return [theme.fg("muted", "No workflow runs in this session yet.")];
		const window = this.windowFor(this.runIndex, this.metas.length, budget);
		const lines: string[] = [];
		if (window.before > 0) lines.push(theme.fg("muted", `  ↑ ${window.before} more`));
		for (let i = window.start; i < window.end; i++) {
			const meta = this.metas[i]!;
			const selected = i === this.runIndex;
			const mark = this.colourMark(meta.status);
			// The name takes the accent the id used to hold: it is what the row is
			// for, and nothing in this panel is addressed by id — you select with
			// the arrows and act with a key. Selected rows keep the accent so the
			// caret is not the only thing marking them.
			const name = theme.fg(selected ? "accent" : "text", meta.name);
			const tail = theme.fg("muted", this.runTail(meta));
			if (selected) this.caretLine = lines.length;
			lines.push(`${selected ? theme.fg("accent", "▸") : " "} ${mark} ${name}  ${tail}`);
		}
		if (window.after > 0) lines.push(theme.fg("muted", `  ↓ ${window.after} more`));
		return lines;
	}

	private runBody(budget: number): string[] {
		const theme = this.theme;
		const progress = this.currentProgress();
		if (!progress) return [theme.fg("muted", "This run has no journal on disk.")];

		const logBudget = this.showLogs ? Math.min(8, Math.max(3, Math.floor(budget / 3))) : 0;
		const agents = this.agents();
		const lines: string[] = [];

		if (agents.length === 0) {
			lines.push(theme.fg("muted", "No agents recorded yet."));
		} else {
			// Pre-pay for every line the window itself knows nothing about: the log
			// pane and its rule, the error row, and one phase heading per phase.
			// Agents come from phases.flatMap(), so a phase's agents are contiguous
			// and its heading is drawn at most once — phases.length is a true upper
			// bound, not a guess. Counting them is what stops the list overrunning
			// the budget by a line per phase.
			const logChrome = logBudget > 0 ? logBudget + 1 : 0;
			const fixed = budget - logChrome - (progress.error ? 1 : 0);

			// Only the phases the window actually shows draw a heading, so only
			// those are pre-paid for. Charging for every phase in the run — as this
			// did — spent the whole budget on headings that were never drawn: a
			// 10-phase run on a 24-row terminal reserved 10 lines, leaving room for
			// one agent and ten blank rows under it.
			//
			// Window size and heading count depend on each other, so settle it by
			// iteration rather than by guessing. It converges immediately in
			// practice (a smaller window spans no more phases than a larger one);
			// the cap is only there so a pathological case cannot spin.
			let window = this.windowFor(this.agentIndex, agents.length, Math.max(3, fixed - 1));
			for (let pass = 0; pass < 4; pass++) {
				const headings = this.phasesIn(agents, window.start, window.end);
				const next = this.windowFor(this.agentIndex, agents.length, Math.max(3, fixed - headings));
				if (next.start === window.start && next.end === window.end) break;
				window = next;
			}
			if (window.before > 0) lines.push(theme.fg("muted", `  ↑ ${window.before} more`));
			let lastPhase: string | undefined;
			for (let i = window.start; i < window.end; i++) {
				const agent = agents[i]!;
				const phase = agent.phase ?? "Agents";
				if (phase !== lastPhase) {
					lastPhase = phase;
					const inPhase = agents.filter((other) => (other.phase ?? "Agents") === phase);
					const settled = inPhase.filter((other) => isAgentSettled(other.status)).length;
					lines.push(theme.fg("accent", `${phase}  ${settled}/${inPhase.length}`));
				}
				const selected = i === this.agentIndex;
				const elapsed = agent.endedAt ? formatElapsed(agent.endedAt - agent.startedAt) : formatElapsed(Date.now() - agent.startedAt);
				const detail = [agent.model?.split("/").at(-1), elapsed].filter(Boolean).join(" · ");
				if (selected) this.caretLine = lines.length;
				lines.push(
					`${selected ? theme.fg("accent", "▸") : " "} ${agentStatusIcon(agent.status, theme)} ${theme.fg(selected ? "text" : "muted", agent.label)}  ${theme.fg("muted", detail)}`,
				);
			}
			if (window.after > 0) lines.push(theme.fg("muted", `  ↓ ${window.after} more`));
		}

		if (logBudget > 0) {
			lines.push(theme.fg("border", "─".repeat(20)));
			const logs = progress.logs.slice(-logBudget);
			if (logs.length === 0) lines.push(theme.fg("muted", "no log lines"));
			for (const entry of logs) lines.push(theme.fg("muted", entry));
		}
		if (progress.error) lines.push(theme.fg("error", progress.error));
		return lines;
	}

	/**
	 * The fixed set of fields describing an agent — status through cost — as
	 * raw, unwrapped lines. Shared by both layouts: agentBody() (narrow) uses
	 * them as-is, one per row, truncated later by row(); the two-pane's
	 * detailLines() wraps each one to the right column's width instead of
	 * truncating. A field added here appears in both.
	 */
	private agentHeaderLines(agent: AgentRow): string[] {
		const theme = this.theme;
		const field = (label: string, value: string) => `${theme.fg("muted", label.padEnd(9))}${value}`;
		const lines: string[] = [];
		// "queued" alone reads as a status; the reason it stopped there does not,
		// and the reason is the whole point of the state (see AgentRow.status).
		const statusText = agent.status === "queued" ? "queued (slot wait)" : agent.status;
		lines.push(field("status", `${agentStatusIcon(agent.status, theme)} ${statusText}`));
		lines.push(field("phase", agent.phase ?? "—"));
		lines.push(field("model", agent.model ?? "(run default)"));
		if (agent.agentType) lines.push(field("type", agent.agentType));
		if (agent.options?.tools) lines.push(field("tools", agent.options.tools.join(", ")));
		if (agent.options?.context) lines.push(field("context", JSON.stringify(agent.options.context)));
		lines.push(
			field("elapsed", agent.endedAt ? formatElapsed(agent.endedAt - agent.startedAt) : `${formatElapsed(Date.now() - agent.startedAt)} (running)`),
		);
		if (agent.usage) {
			// totalTokens is the child's CURRENT context size, not a running total
			// (see applyTurn in spawn.ts) — exactly what "context" means here.
			const context = agent.usage.totalTokens > 0 ? ` · ${formatTokens(agent.usage.totalTokens)} context` : "";
			lines.push(field("tokens", `${formatTokens(agent.usage.input)} in / ${formatTokens(agent.usage.output)} out · ${agent.usage.turns} turn(s)${context}`));
			// Unlike the run-level rows (see runTail), this detail view was opened
			// to understand ONE agent, so its cost earns its line here.
			if (agent.usage.cost > 0) lines.push(field("cost", formatCost(agent.usage.cost)));
		}
		lines.push(field("session", agent.sessionFile ?? theme.fg("muted", "none")));
		if (agent.error) lines.push(theme.fg("error", field("error", agent.error)));
		return lines;
	}

	/**
	 * This agent's position (0-based) among every row that shares its session
	 * file, ordered oldest-first (ties by index) — the ordinal readAgentPrompt
	 * needs to pick the right task out of a shared session's chain (see
	 * promptEntryFor). A shared session's file carries one preamble-bearing
	 * task message per agent that ran in it, IN THE ORDER they ran, so a row's
	 * position among its sessionFile-mates is that same index — which is the
	 * only thing that told apart "my own task" from "whichever one got read
	 * first and cached", the bug caching by sessionFile alone had.
	 */
	private ordinalFor(agent: AgentRow): number {
		const sharing = this.agents()
			.filter((other) => other.sessionFile === agent.sessionFile)
			.sort((a, b) => a.startedAt - b.startedAt || a.index - b.index);
		const position = sharing.findIndex((other) => other.index === agent.index);
		return position >= 0 ? position : 0;
	}

	/**
	 * The task text an agent was actually given (see readAgentPrompt in
	 * store.ts), cached for the life of the panel keyed on sessionFile PLUS
	 * ordinal — a prompt never changes once written, so a hit never needs a
	 * second read, but the file alone is not a unique key once a session is
	 * shared (see the promptCache field comment).
	 */
	private promptEntryFor(agent: AgentRow): PromptCacheEntry {
		if (!agent.sessionFile) return { text: "prompt pending first turn", isChainOpenerFallback: false };
		const ordinal = this.ordinalFor(agent);
		// \0-joined rather than concatenated with a printable separator: a path
		// can legally contain nearly any character, so nothing printable is a
		// safe delimiter between the two halves of this key.
		const cacheKey = `${agent.sessionFile}\u0000${ordinal}`;
		const cached = this.promptCache.get(cacheKey);
		if (cached !== undefined) return cached;

		let size: number | undefined;
		try {
			size = statSync(agent.sessionFile).size;
		} catch {
			size = undefined;
		}
		// A file that does not exist at all is EXCLUDED from the miss cache: that
		// is a session merely not flushed yet (or genuinely gone — a foreign,
		// retention-pruned run), and it should keep being retried rather than
		// being told apart from "missing for good" on the very first miss. A
		// file that DOES exist but yields nothing usable is cached by its
		// current size, so it is only re-attempted once that size changes — see
		// the promptMissCache field comment for the regression this closes.
		if (size !== undefined && this.promptMissCache.get(cacheKey) === size) {
			return { text: "prompt unavailable (session file missing)", isChainOpenerFallback: false };
		}

		const found = readAgentPrompt(agent.sessionFile, ordinal);
		if (found === undefined) {
			if (size !== undefined) this.promptMissCache.set(cacheKey, size);
			return { text: "prompt unavailable (session file missing)", isChainOpenerFallback: false };
		}
		const entry: PromptCacheEntry = { text: found.text, isChainOpenerFallback: found.isChainOpenerFallback };
		this.promptCache.set(cacheKey, entry);
		this.promptMissCache.delete(cacheKey);
		return entry;
	}

	/** Just the text, for callers (scrollPrompt) that have no use for the chain-opener flag. */
	private promptFor(agent: AgentRow): string {
		return this.promptEntryFor(agent).text;
	}

	/**
	 * "Prompt · N lines": the task text, windowed to `maxLines` from
	 * `this.promptScroll` (PgUp/PgDn — see scrollPrompt()). Shared by both
	 * layouts, same reasoning as agentHeaderLines.
	 */
	private promptSection(agent: AgentRow, maxLines: number): string[] {
		const theme = this.theme;
		const entry = this.promptEntryFor(agent);
		const promptLines = entry.text.split(/\r?\n/);
		const total = promptLines.length;
		const start = Math.min(this.promptScroll, Math.max(0, total - 1));
		const shown = promptLines.slice(start, start + Math.max(1, maxLines));
		// The chain-opener fallback never lies silently: if this is not actually
		// this row's own task (see readAgentPrompt's ordinal), the heading says
		// so rather than passing another agent's task off as this one's.
		const suffix = entry.isChainOpenerFallback ? " (chain opener)" : "";
		const lines = [theme.fg("muted", `─ Prompt · ${total} line${total === 1 ? "" : "s"}${suffix} ─`), ...shown];
		const hiddenAfter = total - start - shown.length;
		if (hiddenAfter > 0) lines.push(theme.fg("muted", `  ↓ ${hiddenAfter} more line(s) — PgDn`));
		else if (start > 0) lines.push(theme.fg("muted", `  ↑ ${start} line(s) above — PgUp`));
		return lines;
	}

	/**
	 * "Activity · last K of M tool calls": the live tail from the agent's own
	 * session file. K is how many of the recent entries are shown — a mix of
	 * text, thinking and tool calls, same as sessionActivity has always
	 * returned, so the feed stays readable rather than tool-calls-only. M is
	 * the total tool calls ever made, from the incremental counter (see
	 * toolCallsFor / countToolCalls in store.ts), so it keeps growing even for
	 * calls that scrolled out of K — prefixed with "at least" (>=) when that
	 * counter itself started from a capped first tally (see
	 * ToolCallTally.capped), since M is then a known floor rather than an
	 * exact total. Shared by both layouts, same reasoning as agentHeaderLines.
	 */
	private activitySection(agent: AgentRow, room: number): string[] {
		const theme = this.theme;
		if (!agent.sessionFile || room <= 0) return [];
		const activity = this.activityFor(agent.sessionFile, room);
		if (activity.length === 0) return [];
		const tally = this.toolCallsFor(agent.sessionFile);
		// The counter can lag activityFor's own JSON-parsed view by the odd call
		// (see countToolCalls' boundary-split note), so M is never shown smaller
		// than what K itself demonstrably contains.
		const of = Math.max(tally.count, activity.length);
		const ofLabel = tally.capped ? `>= ${of}` : `${of}`;
		const plural = tally.capped || of !== 1;
		const lines: string[] = [
			theme.fg(
				"muted",
				`─ Activity · ${agent.endedAt ? "last activity" : "live"} · last ${activity.length} of ${ofLabel} tool call${plural ? "s" : ""} ─`,
			),
		];
		for (const event of activity) {
			const label =
				event.kind === "tool"
					? theme.fg("accent", event.name.padEnd(8))
					: theme.fg("muted", (event.kind === "thinking" ? "think" : event.kind).padEnd(8));
			lines.push(`  ${label} ${event.detail}`);
		}
		return lines;
	}

	/**
	 * Session activity, re-parsed only when the file has grown.
	 *
	 * The panel re-renders on every run event, and an agent's transcript reaches
	 * megabytes, so re-reading unconditionally would make the cost of watching
	 * grow with how long you have watched. Size is enough of a version: these
	 * files are append-only.
	 */
	private activityCache?: { file: string; size: number; limit: number; events: SessionEvent[] };

	private activityFor(file: string, limit: number): SessionEvent[] {
		let size = -1;
		try {
			size = statSync(file).size;
		} catch {
			return [];
		}
		const cached = this.activityCache;
		if (cached && cached.file === file && cached.size === size && cached.limit === limit) return cached.events;
		const events = sessionActivity(file, limit);
		this.activityCache = { file, size, limit, events };
		return events;
	}

	/**
	 * countToolCalls resumes from a per-file offset, so the tally itself is the
	 * cache — there is nothing to gate on size the way activityFor does above
	 * (countToolCalls already skips the read itself when the size has not
	 * moved; see its own comment).
	 */
	private toolCallsFor(file: string): ToolCallTally {
		const tally = countToolCalls(file, this.toolCallCache.get(file));
		this.toolCallCache.set(file, tally);
		return tally;
	}

	/**
	 * Lay out one agent's detail — header, prompt preview, activity tail — to
	 * `budget` ROWS, whatever `measure` counts a row as: wrapTextWithAnsi's
	 * wrapped output for the two-pane's right column (detailLines), or the
	 * identity function for the narrow fallback (agentBody), where render()'s
	 * own row() truncates each raw line to exactly one terminal row rather than
	 * wrapping it. Shared because the invariant is the same either way, and
	 * budgeting the UNWRAPPED line count — as this used to, independently in
	 * each of the two callers — routinely under-counted a pane by 2-3x on a
	 * normal terminal width: a wrapped header field alone could eat the whole
	 * budget before the activity section was ever asked for a single row,
	 * which is what made the live tail disappear entirely on a 24-row
	 * terminal, a regression next to the single-pane view it replaced.
	 *
	 * What is DOING right now (the activity tail) outranks what it was ASKED
	 * to do (the prompt preview) once space runs short — the preview is
	 * re-readable any time by paging PgUp, while the tail is the live thing
	 * this pane exists to show — so the prompt gives way FIRST, shrinking from
	 * PROMPT_PREVIEW_LINES down to a floor of PROMPT_MIN_LINES (its own
	 * heading plus that many lines plus, usually, a "N more" indicator) before
	 * the activity tail is ever asked to go below ACTIVITY_MIN_ROWS.
	 */
	private layoutDetail(agent: AgentRow, budget: number, measure: (lines: string[]) => string[], prefix: string[] = []): string[] {
		const theme = this.theme;
		const header = measure([...prefix, ...this.agentHeaderLines(agent)]);

		let promptLines = PROMPT_PREVIEW_LINES;
		let prompt = measure(this.promptSection(agent, promptLines));
		while (promptLines > PROMPT_MIN_LINES && header.length + prompt.length + ACTIVITY_MIN_ROWS > budget) {
			promptLines--;
			prompt = measure(this.promptSection(agent, promptLines));
		}

		const headerAndPrompt = [...header, ...prompt];
		const activityRoom = Math.max(0, budget - headerAndPrompt.length);
		// activitySection's own `room` parameter becomes sessionActivity's EVENT
		// limit, and it always draws one extra line on top of that for its own
		// heading (see activitySection) — so asking for activityRoom itself would
		// routinely hand back activityRoom + 1 raw lines. Reserving one row here
		// is what keeps the heading ("last K of M tool calls") on screen in the
		// ordinary case instead of it being the first thing the trim below drops.
		let activity = measure(this.activitySection(agent, Math.max(0, activityRoom - 1)));
		if (activity.length > activityRoom) {
			// wrapTextWithAnsi can expand a raw line into more than one row (a long
			// single tool-call detail, say), which the `room` handed to
			// activitySection above — a raw-line estimate — could not see coming.
			// Trimmed to fit here, keeping the NEWEST lines: this is a live tail,
			// and "what is happening right now" is the entire reason this pane is
			// open, so the oldest of the shown events is what goes, not the
			// newest.
			activity = activityRoom > 0 ? activity.slice(activity.length - activityRoom) : [];
		}

		const combined = [...headerAndPrompt, ...activity];
		if (combined.length <= budget) return combined;
		// Still over — the header and prompt alone outgrew the budget even at the
		// prompt's floor (an unusually wide "session" path or "tools" list on a
		// narrow pane). Keep the TAIL here too, for the same reason: the newest
		// activity is what a cramped pane should sacrifice last, not first.
		const keepCount = Math.max(0, budget - 1);
		const kept = combined.slice(combined.length - keepCount);
		return [theme.fg("muted", `↑ ${combined.length - kept.length} more`), ...kept];
	}

	private agentBody(budget: number): string[] {
		const theme = this.theme;
		const agent = this.selectedAgent();
		if (!agent) return [theme.fg("muted", "No agent selected.")];
		return this.layoutDetail(agent, budget, (lines) => lines);
	}

	/**
	 * The two-pane run view: a fixed-width tree on the left (treeLines) beside
	 * the selected agent's detail on the right (detailLines), joined by hand —
	 * see the header comment for why pi-tui leaves no other way. Both sides are
	 * built to `budget` rows independently and then zipped index-for-index;
	 * whichever is shorter is padded on that side only; render()'s own
	 * clipKeepingTail is the backstop if either still overran.
	 */
	private twoPaneBody(budget: number, width: number): string[] {
		const theme = this.theme;
		const progress = this.currentProgress();
		if (!progress) return [theme.fg("muted", "This run has no journal on disk.")];
		const agents = this.agents();
		if (agents.length === 0) return [theme.fg("muted", "No agents recorded yet.")];

		const inner = Math.max(1, width - 2);
		const leftWidth = Math.min(LEFT_PANE_MAX, Math.max(LEFT_PANE_MIN, Math.round(inner * LEFT_PANE_FRACTION)));
		const rightWidth = Math.max(10, inner - leftWidth - GUTTER_WIDTH);

		const left = this.treeLines(agents, progress, leftWidth, budget);
		const right = this.detailLines(this.selectedAgent(), rightWidth, budget);
		return zipColumns(left, right, leftWidth, theme.fg("border", GUTTER));
	}

	/**
	 * The two-pane's LEFT column: phase headings, then one row per agent —
	 * status icon and label, cursor-highlighted. Every row goes through
	 * truncateToWidth(…, pad: true) so it is exactly `width` wide, which is
	 * what makes the zip in twoPaneBody exact rather than clipped after the
	 * fact.
	 */
	private treeLines(agents: AgentRow[], progress: RunProgress, width: number, budget: number): string[] {
		const theme = this.theme;
		const errorRows = progress.error ? 1 : 0;
		const fixed = Math.max(1, budget - errorRows);

		// Same converging-window approach as runBody, at the tree's own width —
		// see the comment there for why this cannot be pre-paid in one pass.
		let window = this.windowFor(this.agentIndex, agents.length, Math.max(3, fixed - 1));
		for (let pass = 0; pass < 4; pass++) {
			const headings = this.phasesIn(agents, window.start, window.end);
			const next = this.windowFor(this.agentIndex, agents.length, Math.max(3, fixed - headings));
			if (next.start === window.start && next.end === window.end) break;
			window = next;
		}

		const lines: string[] = [];
		const push = (text: string) => lines.push(truncateToWidth(text, width, "", true));
		if (window.before > 0) push(theme.fg("muted", `↑ ${window.before} more`));
		let lastPhase: string | undefined;
		for (let i = window.start; i < window.end; i++) {
			const agent = agents[i]!;
			const phase = agent.phase ?? "Agents";
			if (phase !== lastPhase) {
				lastPhase = phase;
				const inPhase = agents.filter((other) => (other.phase ?? "Agents") === phase);
				const settled = inPhase.filter((other) => isAgentSettled(other.status)).length;
				push(theme.fg("accent", `${phase}  ${settled}/${inPhase.length}`));
			}
			const selected = i === this.agentIndex;
			if (selected) this.caretLine = lines.length;
			const caret = selected ? theme.fg("accent", "▸") : " ";
			push(`${caret} ${agentStatusIcon(agent.status, theme)} ${theme.fg(selected ? "text" : "muted", agent.label)}`);
		}
		if (window.after > 0) push(theme.fg("muted", `↓ ${window.after} more`));
		if (progress.error) push(theme.fg("error", progress.error));
		return lines;
	}

	/**
	 * The two-pane's RIGHT column: the selected agent's own label, then the
	 * same sections agentBody() draws for the narrow fallback (agentHeaderLines,
	 * promptSection, activitySection), wrapped to `width` with wrapTextWithAnsi
	 * rather than truncated — and NOT padded, since this is always the last
	 * column in the zip (see the header comment).
	 */
	private detailLines(agent: AgentRow | undefined, width: number, budget: number): string[] {
		const theme = this.theme;
		if (!agent) return [theme.fg("muted", "No agent selected.")];
		const wrap = (lines: string[]) => lines.flatMap((line) => wrapTextWithAnsi(line, width));
		return this.layoutDetail(agent, budget, wrap, [theme.fg("accent", theme.bold(agent.label))]);
	}

	private colourMark(status: RunMeta["status"]): string {
		const mark = statusMark(status);
		if (status === "done") return this.theme.fg("success", mark);
		if (status === "running" || status === "paused") return this.theme.fg("warning", mark);
		return this.theme.fg("error", mark);
	}

	/**
	 * Scroll window that keeps `selected` visible without jumping around, and
	 * says how many rows are out of view on each side.
	 *
	 * Budget-exact: when the list does not fit, one line is pre-paid for each of
	 * the two markers, so rows + markers never exceed `budget`. At either end of
	 * the list one of those reserved rows goes unused — a blank row is cheaper
	 * than solving the window twice per render to reclaim it.
	 */
	/** Distinct phases spanned by agents[start, end) — one heading is drawn per phase. */
	private phasesIn(agents: { phase?: string }[], start: number, end: number): number {
		let count = 0;
		let last: string | undefined;
		for (let i = start; i < end; i++) {
			const phase = agents[i]?.phase ?? "Agents";
			if (phase !== last) count++;
			last = phase;
		}
		return count;
	}

	private windowFor(selected: number, total: number, budget: number): { start: number; end: number; before: number; after: number } {
		if (total <= budget) return { start: 0, end: total, before: 0, after: 0 };
		const size = Math.max(1, budget - 2);
		const start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
		const end = Math.min(total, start + size);
		return { start, end, before: start, after: total - end };
	}
}

/**
 * Open the control panel in the prompt's place and wait for it to close.
 *
 * `overlay: false` is the whole placement decision: pi swaps this component
 * into the editor's slot (and restores the editor, with whatever was typed in
 * it, on the way out) instead of floating it over the chat. The
 * PANEL_OPEN_CHANNEL announcement is what lets the footer stand down for the
 * duration — see the note on that constant for why this extension must not swap
 * the footer itself.
 */
export async function showWorkflows(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	host: Omit<TuiHost, "requestRender" | "rows">,
): Promise<PanelResult | undefined> {
	pi.events.emit(PANEL_OPEN_CHANNEL, { active: true });

	// Stand down if something else claims the editor slot.
	//
	// pi keeps no bookkeeping of an already-mounted overlay:false component: the
	// non-overlay path clears the container and adds the newcomer, so a question
	// raised while this panel is up simply draws over it and the panel is never
	// told. Its done() would then never fire, which means the finally below never
	// runs — the footer stays stood down for the rest of the session and the
	// refresh timer keeps reading the run store forever.
	//
	// Closing on the announcement rather than waiting to be told is the only
	// option available: an extension cannot see that it lost focus. ask_user is
	// the realistic collision (the agent asks something while you are watching a
	// run), and it announces itself; a future overlay:false component that does
	// not announce would orphan this again.
	let close: ((value: PanelResult | undefined) => void) | undefined;
	const unsubscribe = pi.events.on("ask-user:asking", (data) => {
		if ((data as { active?: boolean } | undefined)?.active !== true) return;
		close?.(undefined);
	});

	try {
		return await ctx.ui.custom<PanelResult | undefined>(
			(tui, theme, _keybindings, done) => {
				close = done;
				return new WorkflowsPanel(
					{
						...host,
						requestRender: () => tui.requestRender(),
						rows: () => tui.terminal?.rows ?? CONFIG.assumedRows,
						// Detached by something that took the slot without saying so.
						// Hand the footer back here rather than resolving: resolving is
						// what makes pi restore the editor, which would evict whatever
						// is up now. This promise stays pending on purpose.
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
		// finally, not a trailing statement: a component that throws on the way up
		// must still hand the footer back, or the statusline stays blank for the
		// rest of the session.
		pi.events.emit(PANEL_OPEN_CHANNEL, { active: false });
	}
}
