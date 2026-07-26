/**
 * The workflow control TUI: `/workflows` opens a floating overlay that lists
 * every run the store knows about, drills into a run's phases and agents, and
 * drills again into one agent.
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
 * `R` therefore writes the instruction into the editor and closes, leaving the
 * user to send it. Nothing is dispatched behind their back.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import type { AgentRow, RunProgress, RunRegistry } from "./runs.ts";
import { formatElapsed, progressFromJournal, statusMark } from "./panel.ts";
import { agentErrorPath, listRuns, readJournalLines, runDir, type RunMeta } from "./store.ts";
import { piInvocation } from "./spawn.ts";

export interface TuiHost {
	agentDir: string;
	registry: RunRegistry;
	notify: (message: string, level?: "info" | "warning" | "error") => void;
	setEditorText: (text: string) => void;
	requestRender: () => void;
	rows: () => number;
}

type View = "runs" | "run" | "agent";

const HELP: Record<View, string> = {
	runs: "↑↓ select · → open · p pause/resume · c cancel · R resume run · q close",
	run: "↑↓ select · → open · ← back · p pause/resume · c cancel · g logs · q close",
	agent: "← back · x export transcript · e stderr path · q close",
};

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

export class WorkflowsOverlay {
	focused = false;

	private view: View = "runs";
	private metas: RunMeta[] = [];
	private runIndex = 0;
	private agentIndex = 0;
	private showLogs = false;
	private status = "";
	private timer: ReturnType<typeof setInterval> | undefined;
	/** Cache of the reconstructed progress for the run being viewed. */
	private viewed: { runId: string; progress: RunProgress } | undefined;

	constructor(
		private readonly host: TuiHost,
		private readonly theme: Theme,
		private readonly done: (value: undefined) => void,
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

	private refresh(): void {
		this.metas = listRuns(this.host.agentDir);
		if (this.runIndex >= this.metas.length) this.runIndex = Math.max(0, this.metas.length - 1);
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
		// q always closes; escape steps back one level and closes at the top.
		if (data === "q") return void this.done(undefined);
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
			this.agentIndex = 0;
			this.viewed = undefined;
		} else if (this.view === "run") {
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
		this.host.setEditorText(
			`Resume workflow run ${meta.runId} ("${meta.name}"): call the workflow tool with resumeFromRunId: "${meta.runId}" so the agents that already succeeded are replayed rather than re-run.`,
		);
		this.host.notify(`Resume instruction for ${meta.runId} put in the editor — press enter to send it.`, "info");
		this.done(undefined);
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

	render(width: number): string[] {
		const theme = this.theme;
		const outer = Math.max(40, Math.min(width, 100));
		const inner = outer - 2;
		const lines: string[] = [];
		const pad = (text: string) => {
			const clipped = truncateToWidth(text, inner - 1);
			return `${clipped}${" ".repeat(Math.max(0, inner - 1 - visibleWidth(clipped)))}`;
		};
		const row = (text: string) => `${theme.fg("border", "│")} ${pad(text)}${theme.fg("border", "│")}`;

		lines.push(theme.fg("border", `╭${"─".repeat(inner)}╮`));
		lines.push(row(this.title()));
		lines.push(theme.fg("border", `├${"─".repeat(inner)}┤`));

		// Leave room for the frame, the title, the help footer and the status.
		const budget = Math.max(4, this.host.rows() - 12);
		for (const line of this.body(budget)) lines.push(row(line));

		lines.push(theme.fg("border", `├${"─".repeat(inner)}┤`));
		if (this.status) lines.push(row(theme.fg("warning", this.status)));
		lines.push(row(theme.fg("muted", HELP[this.view])));
		lines.push(theme.fg("border", `╰${"─".repeat(inner)}╯`));
		return lines;
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
		return this.agentBody();
	}

	private runsBody(budget: number): string[] {
		const theme = this.theme;
		if (this.metas.length === 0) return [theme.fg("muted", "No workflow runs recorded yet.")];
		const window = this.windowFor(this.runIndex, this.metas.length, budget);
		const lines: string[] = [];
		for (let i = window.start; i < window.end; i++) {
			const meta = this.metas[i]!;
			const selected = i === this.runIndex;
			const mark = this.colourMark(meta.status);
			const name = theme.fg(selected ? "text" : "muted", meta.name);
			const tail = theme.fg("muted", this.runTail(meta));
			lines.push(`${selected ? theme.fg("accent", "▸") : " "} ${mark} ${theme.fg("accent", meta.runId)} ${name}  ${tail}`);
		}
		if (window.more) lines.push(theme.fg("muted", `  … ${this.metas.length - (window.end - window.start)} more`));
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
			// One flat, selectable list, with a heading whenever the phase changes.
			const window = this.windowFor(this.agentIndex, agents.length, Math.max(3, budget - logBudget - 2));
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
			if (window.more) lines.push(theme.fg("muted", `  … ${agents.length - (window.end - window.start)} more`));
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

	private agentBody(): string[] {
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

	/** Scroll window that keeps `selected` visible without jumping around. */
	private windowFor(selected: number, total: number, budget: number): { start: number; end: number; more: boolean } {
		const size = Math.max(1, Math.min(total, budget));
		let start = Math.max(0, Math.min(selected - Math.floor(size / 2), total - size));
		start = Math.max(0, start);
		return { start, end: Math.min(total, start + size), more: total > size };
	}
}
