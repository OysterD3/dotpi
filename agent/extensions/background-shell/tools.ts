/**
 * The three tools, shaped after Claude Code's background-shell surface:
 * `bash` grows a `run_in_background` flag, `bash_output` reads what is new
 * since the last check, `kill_shell` stops one.
 *
 * `bash` is a REPLACEMENT of pi's built-in — extension tools shadow built-ins
 * by name — and that is the point rather than a trick: because the name and
 * the `command` parameter stay the same, every `Bash(...)` permission rule and
 * the permissions extension's destructive-command gate keep applying to
 * background commands with no changes there. Foreground calls delegate to
 * pi's own definition (createBashToolDefinition, with the same settings.json
 * shellPath/shellCommandPrefix pi itself reads), so the everyday path is
 * byte-for-byte the built-in behaviour, rendering included.
 *
 * A background start returns immediately: a tool result is final once
 * execute() resolves, so the exit can only arrive as a later custom message —
 * index.ts delivers it, and the start text tells the model to wait for it
 * rather than invent it.
 */

import { delimiter, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, truncateTail } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { CONFIG, RESULT_MESSAGE } from "./config.ts";
import { commandLabel, startedText, statusLabel } from "./render.ts";
import { isSettled, newShellId, startShell, type ShellConfig, type ShellJob, type ShellMeta, type ShellRegistry } from "./shells.ts";

type BashDefinition = ReturnType<typeof createBashToolDefinition>;

export interface ToolsHost {
	/** pi's agent dir, read from only: it is where the managed bin/ lives. */
	agentDir: string;
	registry: ShellRegistry;
	/**
	 * Shell config for THIS call's cwd — resolved per context, not cached from
	 * session_start, or a background bash issued first after a cwd change would
	 * spawn under the previous project's shellPath/commandPrefix.
	 */
	shellConfig: (ctx: ExtensionContext) => ShellConfig;
	/** The built-in bash definition for this session's cwd — the foreground delegate. */
	builtinFor: (ctx: ExtensionContext) => BashDefinition;
	sessionId: () => string | undefined;
	/** Called once per shell after its meta is final: delivers the exit message. */
	onExit: (job: ShellJob) => void;
	/** Called when a shell starts, so the footer lines wake up. */
	onStarted: () => void;
}

/** Details a background start leaves on its tool result, for renderResult dispatch. */
export interface BackgroundStartDetails {
	background: true;
	shellId: string;
	command: string;
}

const isBackgroundDetails = (details: unknown): details is BackgroundStartDetails =>
	typeof details === "object" && details !== null && (details as { background?: unknown }).background === true;

function activeIds(registry: ShellRegistry): string {
	const ids = registry.all().map((job) => job.meta.shellId);
	return ids.length > 0 ? ids.join(", ") : "(none — no background shells in this session)";
}

const sleep = (ms: number) =>
	new Promise<void>((resolve) => {
		const timer = setTimeout(resolve, ms);
		(timer as { unref?: () => void }).unref?.();
	});

/**
 * The environment the built-in bash gives its children, rebuilt for the
 * background path: pi's managed-binaries dir (fd, rg) prepended to PATH, and
 * the PI_* session variables the tool's own promptGuidelines advertise. The
 * built-in does this via getShellEnv/resolveSpawnContext, neither exported
 * from the package root — but both are a handful of lines.
 */
function backgroundEnv(agentDir: string, ctx: ExtensionContext): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
	const binDir = join(agentDir, "bin");
	const entries = (env[pathKey] ?? "").split(delimiter).filter(Boolean);
	if (!entries.includes(binDir)) env[pathKey] = [binDir, ...entries].join(delimiter);
	delete env.PI_SESSION_ID;
	delete env.PI_SESSION_FILE;
	delete env.PI_PROVIDER;
	delete env.PI_MODEL;
	delete env.PI_REASONING_LEVEL;
	try {
		env.PI_SESSION_ID = ctx.sessionManager.getSessionId();
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (sessionFile) env.PI_SESSION_FILE = sessionFile;
		if (ctx.model) {
			env.PI_PROVIDER = ctx.model.provider;
			env.PI_MODEL = ctx.model.id;
		}
		if (ctx.thinkingLevel) env.PI_REASONING_LEVEL = ctx.thinkingLevel;
	} catch {
		/* session details are a courtesy, not a requirement */
	}
	return env;
}

export function registerShellTools(pi: ExtensionAPI, host: ToolsHost): void {
	// Description and renderer donor. cwd only matters to execute(), which
	// always goes through builtinFor(ctx) instead.
	const donor = createBashToolDefinition(process.cwd());

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: [
			donor.description,
			"",
			"Set run_in_background: true to run the command in a detached background shell and return immediately with a shell id — for long-running processes (dev servers, watchers) and anything you want running while you keep working. Read new output with bash_output; stop it with kill_shell. Do NOT use it to simulate parallelism for quick commands.",
		].join("\n"),
		promptSnippet: donor.promptSnippet,
		promptGuidelines: donor.promptGuidelines,
		executionMode: "sequential",
		parameters: Type.Object({
			command: Type.String({ description: "Bash command to execute" }),
			timeout: Type.Optional(Type.Number({ description: "Timeout in seconds (optional, no default timeout)" })),
			run_in_background: Type.Optional(
				Type.Boolean({
					description:
						"Run the command in a background shell and return immediately with a shell id. Output is captured; a message arrives when it exits.",
				}),
			),
		}),
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			if (params.run_in_background !== true) {
				return host.builtinFor(ctx).execute(
					toolCallId,
					{ command: params.command, timeout: params.timeout },
					signal,
					onUpdate,
					ctx,
				);
			}

			// The built-in validates its timeout; the background path must too,
			// or Node clamps an overflowing delay to 1ms and the "timed out"
			// kill lands before the dev server finishes printing its banner.
			if (params.timeout !== undefined && (!Number.isFinite(params.timeout) || params.timeout <= 0)) {
				throw new Error("Invalid timeout: must be a positive, finite number of seconds");
			}
			if (params.timeout !== undefined && params.timeout * 1000 > CONFIG.maxTimeoutMs) {
				throw new Error(`Invalid timeout: maximum is ${CONFIG.maxTimeoutMs / 1000} seconds`);
			}

			// Background: the turn's abort signal is deliberately NOT wired up —
			// outliving the turn is the feature.
			const meta: ShellMeta = {
				shellId: newShellId(),
				command: params.command,
				cwd: ctx.cwd,
				pid: undefined,
				sessionId: host.sessionId(),
				status: "running",
				startedAt: Date.now(),
			};
			const job = startShell({
				meta,
				config: host.shellConfig(ctx),
				env: backgroundEnv(host.agentDir, ctx),
				timeoutSeconds: params.timeout,
				onExit: host.onExit,
			});
			host.registry.add(job);
			host.onStarted();
			return {
				content: [{ type: "text" as const, text: startedText(meta, RESULT_MESSAGE) }],
				details: { background: true, shellId: meta.shellId, command: meta.command } satisfies BackgroundStartDetails,
			};
		},
		renderCall(args, theme, context) {
			if (args.run_in_background === true) {
				// Streaming renders arrive with partially parsed args, so
				// command may not exist yet — the donor guards the same way.
				const label = typeof args.command === "string" ? commandLabel(args.command, 100) : "…";
				return new Text(`${theme.fg("accent", "$")} ${label} ${theme.fg("muted", "(background)")}`, 0, 0);
			}
			return donor.renderCall!(args, theme, context);
		},
		renderResult(result, options, theme, context) {
			if (isBackgroundDetails(result.details)) {
				// The registry is the only record there is, and it holds this
				// session's shells alone. A row re-rendered after /new or a
				// resume says so rather than claiming the shell just "started",
				// which is what a long-dead dev server would otherwise read as.
				const meta = host.registry.get(result.details.shellId)?.meta;
				const label = meta ? statusLabel(meta, Date.now()) : "no longer tracked";
				const mark = !meta || meta.status !== "running" ? theme.fg("muted", "◆") : theme.fg("accent", "◆");
				return new Text(`${mark} background shell ${result.details.shellId} ${theme.fg("muted", `· ${label}`)}`, 0, 0);
			}
			return donor.renderResult!(result as never, options, theme, context);
		},
	});

	pi.registerTool({
		name: "bash_output",
		label: "bash output",
		description:
			"Read output a background shell produced since your last bash_output call for it (first call reads from the start). Also reports the shell's status and exit code. Use it to poll a shell started with bash run_in_background.",
		parameters: Type.Object({
			shell_id: Type.String({ description: "The shell id a run_in_background bash call returned" }),
			filter: Type.Optional(
				Type.String({
					description:
						"Optional JavaScript regex; only output lines matching it are returned. Non-matching lines from this read are skipped and will not be shown again.",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = host.registry.get(params.shell_id);
			if (!job) throw new Error(`Unknown shell id "${params.shell_id}". Known shells: ${activeIds(host.registry)}`);

			let regex: RegExp | undefined;
			if (params.filter !== undefined) {
				try {
					regex = new RegExp(params.filter);
				} catch (error) {
					throw new Error(`Invalid filter regex: ${String(error)}`);
				}
			}

			// Unfiltered reads only ever keep truncateTail's own tail, so reading
			// the full window would be decode work thrown straight away; the
			// skip note reports whatever the smaller window leaves behind.
			const cap = regex ? CONFIG.readCapBytes : CONFIG.unfilteredReadCapBytes;
			const read = job.output.read(job.readOffset, cap);
			job.readOffset = read.nextOffset;

			let text = read.text;
			// Pipes flush in blocks, so a read routinely ends mid-line. Without
			// a filter that is harmless — the model concatenates. With one, the
			// fragment would be judged as if it were a whole line and lost for
			// good, so hold the cursor back and re-read it complete next time.
			// The rewind target is lastLineStart, a BYTE offset the store found —
			// recomputing it from the decoded fragment overcounts when the read
			// tore a multibyte character, and a cursor pushed negative that way
			// would pin every later read on ERR_OUT_OF_RANGE.
			if (regex && job.meta.status === "running" && text.length > 0 && !text.endsWith("\n") && read.lastLineStart < read.nextOffset) {
				text = text.slice(0, text.lastIndexOf("\n") + 1);
				job.readOffset = read.lastLineStart;
			}
			if (regex) {
				text = text
					.split("\n")
					.filter((line) => regex.test(line))
					.join("\n");
			}
			const clipped = truncateTail(text, {});

			const parts = [`Shell ${job.meta.shellId} (\`${commandLabel(job.meta.command)}\`): ${statusLabel(job.meta, Date.now())}`];
			if (read.skipped > 0) parts.push(`[skipped ${read.skipped} bytes of older unread output]`);
			if (clipped.truncated) parts.push(`[showing the last ${clipped.outputLines} of ${clipped.totalLines} new lines]`);
			parts.push("", clipped.content.length > 0 ? clipped.content : "(no new output)");
			return {
				content: [{ type: "text" as const, text: parts.join("\n") }],
				details: { shellId: job.meta.shellId, status: job.meta.status, exitCode: job.meta.exitCode },
			};
		},
	});

	pi.registerTool({
		name: "kill_shell",
		label: "kill shell",
		description:
			"Kill a background shell started with bash run_in_background: SIGTERM to its process group, SIGKILL after a few seconds if it lingers. Reports the final state.",
		parameters: Type.Object({
			shell_id: Type.String({ description: "The shell id to kill" }),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const job = host.registry.get(params.shell_id);
			if (!job) throw new Error(`Unknown shell id "${params.shell_id}". Known shells: ${activeIds(host.registry)}`);
			if (isSettled(job.meta.status)) {
				return {
					content: [{ type: "text" as const, text: `Shell ${job.meta.shellId} had already finished: ${statusLabel(job.meta, Date.now())}.` }],
					details: { shellId: job.meta.shellId, status: job.meta.status, exitCode: job.meta.exitCode },
				};
			}

			// Suppress-then-maybe-restore, in that order: the exit can land at
			// any moment once the kill is signalled, and finalize() runs
			// synchronously inside the close handler — so the flag must be up
			// BEFORE the wait, or a death during it gets both this result and
			// an exit message. If the shell outlives the wait instead, the flag
			// comes back down and the exit message keeps the promise the text
			// below makes. This also silences the duplicate when kill_shell is
			// called on a shell already dying of a timeout or panel kill.
			host.registry.kill(job.meta.shellId, "tool");
			job.suppressExit = true;
			await Promise.race([job.settled, sleep(CONFIG.killWaitCapMs)]);
			// Restore only while the shell's own session is still the live one:
			// a /new during this wait ran session_shutdown, which suppressed
			// every job on purpose — un-silencing it here would let a
			// stubborn group's eventual death post into the next session.
			if (!isSettled(job.meta.status) && job.meta.sessionId === host.sessionId()) job.suppressExit = false;

			const text = isSettled(job.meta.status)
				? `Killed shell ${job.meta.shellId} (\`${commandLabel(job.meta.command)}\`): ${statusLabel(job.meta, Date.now())}.`
				: `SIGTERM and SIGKILL sent to shell ${job.meta.shellId}, but its process group has not fully exited yet. It will be reported when it does.`;
			return {
				content: [{ type: "text" as const, text }],
				details: { shellId: job.meta.shellId, status: job.meta.status, exitCode: job.meta.exitCode },
			};
		},
	});
}
