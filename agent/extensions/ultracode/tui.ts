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
 * `resume` is the one action the TUI cannot perform itself — replaying a
 * journal means calling the workflow tool, which only the model can do. Pressing
 * `R` therefore hands the instruction back to the command handler as the
 * panel's result, and that writes it into the editor after pi has restored it.
 * Writing from in here would be undone on the way out (see PanelResult).
 * Nothing is dispatched behind the user's back either way.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { CONFIG, PANEL_OPEN_CHANNEL } from "./config.ts";
import type { AgentRow, RunProgress, RunRegistry } from "./runs.ts";
import { formatElapsed, progressFromJournal, statusMark } from "./panel.ts";
import { agentErrorPath, listRuns, readJournalLines, runDir, type RunMeta } from "./store.ts";
import { piInvocation } from "./spawn.ts";

export interface TuiHost {
	agentDir: string;
	registry: RunRegistry;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	requestRender: () => void;
	rows: () => number;
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

const HINTS: Record<View, string[]> = {
	runs: ["↑↓ select", "→ open", "p pause/resume", "c cancel", "R resume run", "q close"],
	run: ["↑↓ select", "→ open", "← back", "p pause/resume", "c cancel", "g logs", "x export", "e stderr path", "q close"],
	agent: ["↑↓ agent", "← back", "x export transcript", "e stderr path", "q close"],
};

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

function formatTokens(count: number): string {
	if (count < 1000) return String(count);
	if (count < 1_000_000) return `${(count / 1000).toFixed(1)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
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
	/** Cache of the reconstructed progress for the run being viewed. */
	private viewed: { runId: string; progress: RunProgress } | undefined;

	constructor(
		private readonly host: TuiHost,
		private readonly theme: Theme,
		private readonly done: (value: PanelResult | undefined) => void,
	) {
		this.refresh();
		this.timer = setInterval(() => {
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
		this.metas = listRuns(this.host.agentDir);
		const found = this.selectedRunId ? this.metas.findIndex((meta) => meta.runId === this.selectedRunId) : -1;
		this.runIndex = found >= 0 ? found : Math.min(this.runIndex, Math.max(0, this.metas.length - 1));
		this.selectedRunId = this.metas[this.runIndex]?.runId;
		this.viewed = undefined;
	}

	private currentMeta(): RunMeta | undefined {
		return this.metas[this.runIndex];
	}

	/** Live progress when this process owns the run, else read the journal. */
	private currentProgress(): RunProgress | undefined {
		const meta = this.currentMeta();
		if (!meta) return undefined;
		const live = this.host.registry.get(meta.runId);
		if (live) return live.progress;
		if (this.viewed?.runId === meta.runId) return this.viewed.progress;
		const progress = progressFromJournal(meta, readJournalLines(this.host.agentDir, meta.runId));
		this.viewed = { runId: meta.runId, progress };
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
			if (this.view === "agent") this.view = "run";
			else if (this.view === "run") this.view = "runs";
			else this.done(undefined);
			return;
		}
		if (matchesKey(data, "up") || data === "k") return void this.move(-1);
		if (matchesKey(data, "down") || data === "j") return void this.move(1);
		if (matchesKey(data, "left") || data === "h") return void this.back();
		if (matchesKey(data, "right") || matchesKey(data, "return") || data === "l") return void this.forward();
		if (data === "p") return void this.togglePause();
		if (data === "c") return void this.cancel();
		if (data === "R") return void this.resumeRun();
		if (data === "g") {
			this.showLogs = !this.showLogs;
			return;
		}
		if (data === "x") return void this.exportAgent();
		if (data === "e") return void this.showStderrPath();
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
		}
	}

	private forward(): void {
		if (this.view === "runs" && this.currentMeta()) {
			this.view = "run";
			this.agentIndex = 0;
		} else if (this.view === "run" && this.agents().length > 0) {
			this.view = "agent";
		}
	}

	private back(): void {
		if (this.view === "agent") this.view = "run";
		else if (this.view === "run") this.view = "runs";
	}

	private togglePause(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		const registry = this.host.registry;
		const outcome = meta.status === "paused" ? registry.resume(meta.runId) : registry.pause(meta.runId);
		this.status =
			outcome === "paused"
				? `${meta.runId} pausing — in-flight agents finish, new ones wait`
				: outcome === "resumed"
					? `${meta.runId} resumed`
					: outcome === "unknown"
						? `${meta.runId} is not running in this session`
						: `${meta.runId} is ${meta.status}`;
		this.refresh();
	}

	private cancel(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		const outcome = this.host.registry.cancel(meta.runId);
		this.status =
			outcome === "cancelled"
				? `cancelling ${meta.runId}`
				: outcome === "unknown"
					? `${meta.runId} is not running in this session`
					: `${meta.runId} already finished`;
		this.refresh();
	}

	private resumeRun(): void {
		const meta = this.currentMeta();
		if (!meta) return;
		this.done({
			editorText: `Resume workflow run ${meta.runId} ("${meta.name}"): call the workflow tool with resumeFromRunId: "${meta.runId}" so the agents that already succeeded are replayed rather than re-run.`,
			notice: `Resume instruction for ${meta.runId} put in the editor — press enter to send it.`,
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
			this.host.notify(this.status, result.ok ? "info" : "error");
			this.host.requestRender();
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
		const theme = this.theme;
		const inner = Math.max(1, width - 2);
		const rule = theme.fg("border", "─".repeat(Math.max(1, width)));
		const row = (text: string) => ` ${truncateToWidth(text, inner)}`;
		const hints = packHints(HINTS[this.view], inner).map((line) => theme.fg("muted", line));
		const footer = this.status ? [theme.fg("warning", this.status), ...hints] : hints;

		// 2 rules + title + body + footer <= rows - screenReserve, so that many rows
		// of transcript survive above the panel. Both floors below are escape
		// hatches for a terminal too short to honour that at all: under roughly
		// 12 + footer rows the panel is taller than its share and the transcript
		// scrolls instead. Three rows of panel still beat none, and pi-tui scrolls
		// rather than throwing, so this is a squeeze and not a crash.
		const available = this.host.rows() - CONFIG.screenReserve - 3;
		// Hints go before the body does: a list with nothing in it is useless,
		// whereas the keys are recoverable by pressing one.
		const shown = available - footer.length >= 3 ? footer : footer.slice(0, Math.max(1, available - 3));
		const budget = Math.max(3, available - shown.length);
		// Each view keeps its own floor (a list never shrinks below three rows, an
		// open log pane keeps its rule), and on a very short terminal those floors
		// can outrun the budget; clipping here is what keeps the arithmetic above
		// true rather than aspirational.
		const body = this.body(budget).slice(0, budget);

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
		if (this.view === "run") {
			return `${theme.fg("accent", theme.bold(`${statusMark(meta.status)} ${meta.runId}`))} ${theme.fg("text", meta.name)}  ${theme.fg("muted", this.runTail(meta))}`;
		}
		const agent = this.selectedAgent();
		return `${theme.fg("accent", theme.bold("↩ agent"))} ${theme.fg("text", agent?.label ?? "")}`;
	}

	private runTail(meta: RunMeta): string {
		const elapsed = formatElapsed((meta.endedAt ?? Date.now()) - meta.startedAt);
		return `${meta.status} · ${meta.agentCount} agent(s) · $${meta.usage.cost.toFixed(4)} · ${elapsed}`;
	}

	private body(budget: number): string[] {
		if (this.view === "runs") return this.runsBody(budget);
		if (this.view === "run") return this.runBody(budget);
		return this.agentBody(budget);
	}

	private runsBody(budget: number): string[] {
		const theme = this.theme;
		if (this.metas.length === 0) return [theme.fg("muted", "No workflow runs recorded yet.")];
		const window = this.windowFor(this.runIndex, this.metas.length, budget);
		const lines: string[] = [];
		if (window.before > 0) lines.push(theme.fg("muted", `  ↑ ${window.before} more`));
		for (let i = window.start; i < window.end; i++) {
			const meta = this.metas[i]!;
			const selected = i === this.runIndex;
			const mark = this.colourMark(meta.status);
			const name = theme.fg(selected ? "text" : "muted", meta.name);
			const tail = theme.fg("muted", this.runTail(meta));
			lines.push(`${selected ? theme.fg("accent", "▸") : " "} ${mark} ${theme.fg("accent", meta.runId)} ${name}  ${tail}`);
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
					const settled = inPhase.filter((other) => other.status !== "running").length;
					lines.push(theme.fg("accent", `${phase}  ${settled}/${inPhase.length}`));
				}
				const selected = i === this.agentIndex;
				const elapsed = agent.endedAt ? formatElapsed(agent.endedAt - agent.startedAt) : formatElapsed(Date.now() - agent.startedAt);
				const detail = [agent.model?.split("/").at(-1), elapsed].filter(Boolean).join(" · ");
				lines.push(
					`${selected ? theme.fg("accent", "▸") : " "} ${this.agentMark(agent.status)} ${theme.fg(selected ? "text" : "muted", agent.label)}  ${theme.fg("muted", detail)}`,
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

	private agentBody(budget: number): string[] {
		const theme = this.theme;
		const agent = this.selectedAgent();
		if (!agent) return [theme.fg("muted", "No agent selected.")];
		const field = (label: string, value: string) => `${theme.fg("muted", label.padEnd(9))}${value}`;
		const lines: string[] = [];
		lines.push(field("status", `${this.agentMark(agent.status)} ${agent.status}`));
		lines.push(field("phase", agent.phase ?? "—"));
		lines.push(field("model", agent.model ?? "(run default)"));
		if (agent.agentType) lines.push(field("type", agent.agentType));
		if (agent.options?.tools) lines.push(field("tools", agent.options.tools.join(", ")));
		if (agent.options?.context) lines.push(field("context", JSON.stringify(agent.options.context)));
		lines.push(
			field("elapsed", agent.endedAt ? formatElapsed(agent.endedAt - agent.startedAt) : `${formatElapsed(Date.now() - agent.startedAt)} (running)`),
		);
		if (agent.usage) {
			lines.push(
				field(
					"tokens",
					`${formatTokens(agent.usage.input)} in / ${formatTokens(agent.usage.output)} out · ${agent.usage.turns} turn(s) · $${agent.usage.cost.toFixed(4)}`,
				),
			);
		}
		lines.push(field("session", agent.sessionFile ?? theme.fg("muted", "none")));
		if (agent.error) lines.push(theme.fg("error", field("error", agent.error)));

		// Bounded, but not by much: tools and context can each be long. ← goes back
		// to the list, so the tail is the safe end to clip.
		if (lines.length > budget) {
			const kept = lines.slice(0, Math.max(1, budget - 1));
			kept.push(theme.fg("muted", `  ↓ ${lines.length - kept.length} more lines`));
			return kept;
		}
		return lines;
	}

	private colourMark(status: RunMeta["status"]): string {
		const mark = statusMark(status);
		if (status === "done") return this.theme.fg("success", mark);
		if (status === "running" || status === "paused") return this.theme.fg("warning", mark);
		return this.theme.fg("error", mark);
	}

	private agentMark(status: AgentRow["status"]): string {
		switch (status) {
			case "done":
				return this.theme.fg("success", "✓");
			case "replayed":
				return this.theme.fg("muted", "⟲");
			case "failed":
				return this.theme.fg("error", "✗");
			default:
				return this.theme.fg("warning", "…");
		}
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
					{ ...host, requestRender: () => tui.requestRender(), rows: () => tui.terminal?.rows ?? CONFIG.assumedRows },
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
