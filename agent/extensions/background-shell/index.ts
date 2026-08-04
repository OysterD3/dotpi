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
 * that wakes an idle agent or rides the current turn as a follow-up), and its
 * panel protocol — with the tool surface copied from Claude Code so the model
 * already knows how to drive it.
 *
 * Nothing here is written to disk. Shells die with the session — every running
 * group is killed at session_shutdown, and a process-exit hook catches the
 * paths that never reach it — so a record outliving the process would be a
 * record nobody reads. The trade is deliberate: a pi killed outright (SIGKILL,
 * a closed terminal) leaves its detached groups running with nothing left to
 * report them, where the old on-disk store would have named them at the next
 * start. Everything else lives in memory and goes with the session.
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
import { commandLabel, exitPhrase, exitReport, footerLines, formatElapsed, runningReminder, systemReminder } from "./render.ts";
import { loadSettings } from "./settings.ts";
import { isSettled, ShellRegistry, type KilledBy, type ShellConfig, type ShellJob, type ShellMeta } from "./shells.ts";
import { registerShellTools } from "./tools.ts";
import { showShells } from "./tui.ts";

/** What the exit message carries: a meta snapshot plus the tail, so the renderer needs no lookup. */
interface ExitDetails {
	meta: ShellMeta;
	tail: string[];
	killedBy?: KilledBy;
}

function readShellBlock(path: string): { shellPath?: string; commandPrefix?: string } {
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
 * honoured. These two are read unconditionally from both files, mirroring
 * pi's own behaviour exactly — a project cannot do anything through them it
 * could not already do to pi's built-in bash tool.
 *
 * `foregroundIdleKillMs` is different: this extension invented that key, so
 * it goes through settings.ts's namespaced, trust-gated `backgroundShell`
 * block instead of a bare top-level read — see settings.ts's doc comment for
 * why an untrusted project must not be able to set it.
 */
function loadShellConfig(agentDir: string, cwd: string, projectTrusted: boolean): { config: ShellConfig; warnings: string[] } {
	const user = readShellBlock(join(agentDir, "settings.json"));
	const project = readShellBlock(join(cwd, ".pi", "settings.json"));
	const shellPath = project.shellPath ?? user.shellPath;
	const { settings, warnings } = loadSettings(agentDir, cwd, projectTrusted);
	return {
		config: {
			shellPath: shellPath?.replace(/^~(?=$|\/)/, homedir()),
			commandPrefix: project.commandPrefix ?? user.commandPrefix,
			foregroundIdleKillMs: settings.foregroundIdleKillMs,
		},
		warnings,
	};
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const registry = new ShellRegistry();

	let uiCtx: ExtensionContext | undefined;
	let sessionId: string | undefined;
	let shellConfig: ShellConfig = {};
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
			const tail = job.output.tail(CONFIG.exitTailBytes).slice(-CONFIG.exitTailLines);
			// Idle delivery is never queued behind a live turn: a panel kill goes
			// out as "nextTurn" (spliced into the next prompt()'s messages
			// unconditionally — clearAllQueues() never touches that array) and
			// anything else starts a fresh turn with this message as its seed
			// right now. Both are safe from the Escape/abort queue purge, so this
			// IS "actually injected" for exitAnnounced's purposes. Mid-turn
			// delivery always falls through to followUp — the exact queue an
			// abort clears whole — so it must NOT be marked here; only the
			// before_agent_start reminder's own (unconditional) injection may
			// confirm delivery for that case.
			if (idle) job.meta.exitAnnounced = true;
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
			/* a dead session cannot receive results, and nothing else needs them */
		}
	};

	const builtinFor = (ctx: ExtensionContext): ReturnType<typeof createBashToolDefinition> => {
		if (!builtin || builtin.cwd !== ctx.cwd) {
			// A cwd change moves which project settings file applies, so the
			// shell config travels with the delegate. Warnings are not
			// re-notified here: this reload also fires on the very first call
			// after session_start (builtin starts undefined there), which would
			// otherwise repeat the same warning session_start just showed.
			shellConfig = loadShellConfig(agentDir, ctx.cwd, ctx.isProjectTrusted()).config;
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
		const loaded = loadShellConfig(agentDir, ctx.cwd, ctx.isProjectTrusted());
		shellConfig = loaded.config;
		for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
		builtin = undefined;
		drawLines();
	});

	pi.on("before_agent_start", () => {
		const now = Date.now();
		// Every settled shell whose exit deliverExit could not confirm reached
		// the model (see exitAnnounced's doc comment) — most often one that went
		// out as a mid-turn followUp. That followUp is the COMMON case, and most
		// of the time it WAS drained and seen: deliverExit itself has no way to
		// know that afterward, but a delivered followUp persists in the session
		// branch as its own custom_message entry (RESULT_MESSAGE, carrying this
		// shell's id in `details`), so it can be confirmed here instead of
		// re-flagged. Only a shell with no such entry is the genuinely purged
		// case (an Escape/abort dropping the followUp queue whole before the
		// model ever saw it) this reminder exists for.
		const settled = registry.all().filter((job) => isSettled(job.meta.status) && !job.meta.exitAnnounced);
		if (settled.length > 0 && uiCtx) {
			try {
				for (const entry of uiCtx.sessionManager.getBranch()) {
					if (entry.type !== "custom_message" || entry.customType !== RESULT_MESSAGE) continue;
					const shellId = (entry.details as ExitDetails | undefined)?.meta?.shellId;
					if (!shellId) continue;
					const job = settled.find((candidate) => candidate.meta.shellId === shellId);
					if (job) job.meta.exitAnnounced = true;
				}
			} catch {
				// An unreadable branch confirms nothing; the reminder below still
				// catches every shell this pass could not clear.
			}
		}
		// This handler's own return, below, IS delivery — unlike a followUp it
		// is spliced into the next turn's messages unconditionally, so listing a
		// shell here is itself the confirmation, and only here (or the branch
		// scan above) is it safe to mark the flag.
		const unannounced = settled.filter((job) => !job.meta.exitAnnounced);
		const reminder = runningReminder(
			registry.running().map((job) => job.meta),
			unannounced.map((job) => job.meta),
			now,
		);
		if (!reminder) return;
		for (const job of unannounced) job.meta.exitAnnounced = true;
		return {
			message: {
				customType: REMINDER_MESSAGE,
				content: systemReminder(reminder),
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

	// The backstop for exits that never reach session_shutdown. With no store
	// left to record an orphan, a detached dev server surviving pi has nothing
	// to report it — so take the last synchronous chance to signal the group.
	// (SIGKILL still skips this; that case is simply out of reach.)
	process.on("exit", () => {
		registry.killAll("shutdown");
	});
}
