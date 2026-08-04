/**
 * Background shells for pi, shaped after Claude Code's: `bash` gains
 * `run_in_background`, a long-running command (dev server, watcher, slow
 * build) stops blocking the turn, and its exit comes back later as a message.
 * `bash_output` reads what is new since the last check, `kill_shell` stops a
 * shell, and shift+up opens a control panel in the editor's slot — list,
 * live output tail, kill — the way ultracode's /workflows panel works.
 *
 * pi has nothing like this: its bash tool always awaits exit, so a dev server
 * either eats the turn or gets backgrounded blind with `&`. The pieces here
 * are assembled from patterns already proven in this repo — ultracode's
 * detached-group spawning and kill ladder, its exit delivery (a custom message
 * that wakes an idle agent or rides the current turn as a follow-up), its
 * panel protocol, and the pid-reconciled disk store — with the tool surface
 * copied from Claude Code so the model already knows how to drive it.
 *
 * Shells die with the session: session_shutdown kills every running group.
 * What survives a crash is the record and the output on disk, and the next
 * session gets a hidden reminder naming what was left behind (including a
 * still-alive orphan's pid, the one fact worth acting on).
 *
 * index.ts is wiring only: lifecycle events, delivery, footer announcements,
 * the shortcut, renderers.
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG, LINES_CHANNEL, REMINDER_MESSAGE, RESULT_MESSAGE } from "./config.ts";
import {
	commandLabel,
	exitPhrase,
	exitReport,
	footerLines,
	formatElapsed,
	interruptedNotice,
	runningReminder,
	systemReminder,
} from "./render.ts";
import { ShellRegistry, type KilledBy, type ShellConfig, type ShellJob } from "./shells.ts";
import { ensureStore, listShells, pruneShells, reconcile, tailOutput, writeMeta, type ShellMeta } from "./store.ts";
import { registerShellTools } from "./tools.ts";
import { showShells } from "./tui.ts";

/** What the exit message carries: a meta snapshot plus the tail, so the renderer needs no fs. */
interface ExitDetails {
	meta: ShellMeta;
	tail: string[];
	killedBy?: KilledBy;
}

function readShellBlock(path: string): ShellConfig {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		return {
			shellPath: typeof raw.shellPath === "string" ? raw.shellPath : undefined,
			commandPrefix: typeof raw.shellCommandPrefix === "string" ? raw.shellCommandPrefix : undefined,
		};
	} catch {
		return {};
	}
}

/**
 * The `shellPath`/`shellCommandPrefix` pi's own bash tool uses, resolved the
 * way pi's SettingsManager resolves them: the project's `.pi/settings.json`
 * over the global file, and a leading `~` in shellPath expanded. Skipping
 * either would make the replaced bash silently ignore settings the built-in
 * honoured.
 */
function loadShellConfig(agentDir: string, cwd: string): ShellConfig {
	const user = readShellBlock(join(agentDir, "settings.json"));
	const project = readShellBlock(join(cwd, ".pi", "settings.json"));
	const shellPath = project.shellPath ?? user.shellPath;
	return {
		shellPath: shellPath?.replace(/^~(?=$|\/)/, homedir()),
		commandPrefix: project.commandPrefix ?? user.commandPrefix,
	};
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const registry = new ShellRegistry();

	let uiCtx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let shellConfig: ShellConfig = {};
	let interruptedNote: string | undefined;
	let owedInterrupted: ShellMeta[] = [];
	let linesTimer: ReturnType<typeof setInterval> | undefined;
	let builtin: { cwd: string; def: ReturnType<typeof createBashToolDefinition> } | undefined;

	const stopLinesTimer = () => {
		if (linesTimer) clearInterval(linesTimer);
		linesTimer = undefined;
	};

	/**
	 * Announce one footer line per running shell; the statusline draws them.
	 * Self-ticking while any shell runs so elapsed times move; a dead context
	 * just stops announcing.
	 */
	const drawLines = () => {
		try {
			if (!uiCtx?.hasUI) return;
			const lines = footerLines(
				registry.running().map((job) => job.meta),
				Date.now(),
			);
			pi.events.emit(LINES_CHANNEL, { lines });
			if (lines && !linesTimer) {
				linesTimer = setInterval(drawLines, CONFIG.linesTickMs);
				(linesTimer as { unref?: () => void }).unref?.();
			} else if (!lines) {
				stopLinesTimer();
			}
		} catch {
			uiCtx = undefined;
			stopLinesTimer();
		}
	};

	/**
	 * Hand a finished shell's outcome to the agent. Idle: wake it, the way a
	 * task notification would. Mid-turn: ride the current run as a follow-up.
	 * A user-initiated (panel) kill is quieter — the user was there for it, so
	 * it waits for the next turn rather than starting one.
	 */
	const deliverExit = (job: ShellJob) => {
		drawLines();
		// Covers kill_shell's inline report AND every shell flagged at
		// session_shutdown — including one already dying of a panel kill when
		// /new arrived, whose killedBy label a shutdown check would miss and
		// whose late exit would otherwise land in the NEXT session.
		if (job.suppressExit) return;
		// And the flag-race backstop: whatever the suppression flags say, an
		// exit may only be delivered to the session that started the shell.
		// uiCtx rebinds on every session_start, so a straggler dying after
		// /new would otherwise post into a session that never knew it.
		if (job.meta.sessionId !== sessionId) return;
		const ctx = uiCtx;
		if (!ctx) return;
		try {
			const idle = ctx.isIdle();
			const tail = tailOutput(agentDir, job.meta.shellId, CONFIG.exitTailBytes).slice(-CONFIG.exitTailLines);
			pi.sendMessage<ExitDetails>(
				{
					customType: RESULT_MESSAGE,
					content: exitReport(job.meta, tail, job.killedBy),
					display: true,
					details: { meta: { ...job.meta }, tail, killedBy: job.killedBy },
				},
				job.killedBy === "panel"
					? idle
						? { deliverAs: "nextTurn" }
						: { deliverAs: "followUp" }
					: idle
						? { triggerTurn: true }
						: { deliverAs: "followUp" },
			);
		} catch {
			/* a dead session cannot receive results; the store still has everything */
		}
	};

	const builtinFor = (ctx: ExtensionContext): ReturnType<typeof createBashToolDefinition> => {
		if (!builtin || builtin.cwd !== ctx.cwd) {
			// A cwd change moves which project settings file applies, so the
			// shell config travels with the delegate.
			shellConfig = loadShellConfig(agentDir, ctx.cwd);
			builtin = {
				cwd: ctx.cwd,
				def: createBashToolDefinition(ctx.cwd, {
					shellPath: shellConfig.shellPath,
					commandPrefix: shellConfig.commandPrefix,
				}),
			};
		}
		return builtin.def;
	};

	registerShellTools(pi, {
		agentDir,
		registry,
		// Route through builtinFor so a cwd change reloads the project's shell
		// settings before the background spawn, exactly as it would for a
		// foreground delegation.
		shellConfig: (ctx) => {
			builtinFor(ctx);
			return shellConfig;
		},
		builtinFor,
		sessionId: () => sessionId,
		onExit: deliverExit,
		onStarted: drawLines,
	});

	pi.registerMessageRenderer<ExitDetails>(RESULT_MESSAGE, (message, _options, theme) => {
		const details = message.details;
		if (!details) return undefined;
		const meta = details.meta;
		const mark =
			meta.status === "done" ? theme.fg("success", "✓") : meta.status === "killed" ? theme.fg("warning", "◼") : theme.fg("error", "✗");
		const elapsed = formatElapsed((meta.endedAt ?? meta.startedAt) - meta.startedAt);
		const lines = [
			`${mark} background shell ${theme.bold(commandLabel(meta.command))} ${theme.fg("muted", `· ${exitPhrase(meta)} · ${elapsed}`)}`,
		];
		for (const line of details.tail.slice(-5)) lines.push(theme.fg("dim", `  ${line}`));
		return new Text(lines.join("\n"), 0, 0);
	});

	const openPanel = async (ctx: ExtensionContext) => {
		await showShells(pi, ctx, {
			agentDir,
			registry,
			notify: (message, level) => ctx.ui.notify(message, level ?? "info"),
		});
		drawLines();
	};

	pi.registerShortcut("shift+up", {
		description: "Open the background shells panel",
		handler: (ctx) => openPanel(ctx),
	});

	pi.on("session_start", (_event, ctx) => {
		uiCtx = ctx;
		sessionId = ctx.sessionManager.getSessionId();
		shellConfig = loadShellConfig(agentDir, ctx.cwd);
		builtin = undefined;
		ensureStore(agentDir);
		reconcile(agentDir);
		pruneShells(agentDir, CONFIG.retainShells);
		// What this session owes the model comes from the STORE, not from
		// reconcile's return value: the store is global, so another project's
		// session may have already reconciled this one's dead shells — the
		// notice belongs to whichever session of the OWNING project shows up
		// first, and the `reported` flag is what hands it over exactly once.
		owedInterrupted = listShells(agentDir).filter(
			(meta) => meta.status === "interrupted" && meta.cwd === ctx.cwd && !meta.reported,
		);
		interruptedNote = interruptedNotice(owedInterrupted);
		drawLines();
	});

	pi.on("before_agent_start", () => {
		const parts: string[] = [];
		if (interruptedNote) {
			parts.push(interruptedNote);
			interruptedNote = undefined;
			for (const meta of owedInterrupted) writeMeta(agentDir, { ...meta, reported: true });
			owedInterrupted = [];
		}
		const reminder = runningReminder(
			registry.running().map((job) => job.meta),
			Date.now(),
		);
		if (reminder) parts.push(reminder);
		if (parts.length === 0) return;
		return {
			message: {
				customType: REMINDER_MESSAGE,
				content: parts.map(systemReminder).join("\n"),
				display: false,
			},
		};
	});

	pi.on("session_shutdown", () => {
		// /new reuses this process: without the kill+clear the fresh session
		// would inherit the old session's shells, and without the clearing
		// emit the footer would freeze on stale lines. Every job — not just
		// the ones killAll signals — is silenced first, so a shell already
		// dying of an earlier kill cannot post its exit into the next session.
		for (const job of registry.all()) job.suppressExit = true;
		registry.killAll("shutdown");
		registry.clear();
		pi.events.emit(LINES_CHANNEL, { lines: undefined });
		stopLinesTimer();
		uiCtx = undefined;
	});
}
