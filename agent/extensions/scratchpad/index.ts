/**
 * scratchpad — a session-scoped temp directory the agent is told to use, and
 * that it is never asked for permission to write to.
 *
 * At session start it creates `<tmp>/pi-<uid>/<project>/<session>/scratchpad`
 * (paths.ts), announces the path on `scratchpad:dir` so the permissions
 * extension can stop prompting for writes that land inside it, and appends a
 * block to the system prompt telling the model what the directory is for
 * (prompt.ts). `/scratchpad` shows the path and what is in it.
 *
 *   config.ts   settings, the announcement channel, tunables
 *   paths.ts    the layout and why each level of it exists (pure)
 *   prompt.ts   what the model is told, and why it is worded that way (pure)
 *
 * ## The two halves have to both be here
 *
 * Telling the model about a directory is cheap and half a feature. The half that
 * makes it get used is that writing there does not stop to ask: in `auto` mode
 * every `write` to a path pi has no rule for costs a classifier call and can
 * come back as a prompt, and a scratch file that might interrupt the user is one
 * the model reasonably decides not to write. So the announcement is not a nicety
 * — it is what makes the prompt block above true.
 *
 * The allow has to live inside permissions rather than here, because pi's
 * `tool_call` result can only carry `block` — an extension can veto a call, and
 * has no way to clear one. Hence the channel: this extension owns the directory
 * and publishes it; permissions owns the decision and consumes it.
 *
 * ## Nothing is ever deleted
 *
 * There is deliberately no cleanup pass. Everything here is under the system
 * temp directory, which the OS already reaps on its own schedule (a reboot on
 * Linux, a few days without access on macOS), and a recursive delete run at
 * session start is the one thing in this feature that could destroy a *live*
 * concurrent session's files if its idea of "old" were ever wrong. Trading a few
 * kilobytes of stale scratch for never having that code is the right way round.
 *
 * Settings (agent settings.json):
 *   scratchpad.enabled  boolean, default true
 *   scratchpad.root     string, default "" — the parent for `pi-<uid>`; empty
 *                       means os.tmpdir(). Set to "/tmp" for a shorter path.
 */

import { mkdirSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ANNOUNCE, CONFIG, defaultSettings, SETTINGS_KEY, type ScratchpadSettings } from "./config.ts";
import { scratchpadPath } from "./paths.ts";
import { buildPromptBlock } from "./prompt.ts";

export function loadSettings(agentDir: string): ScratchpadSettings {
	const base = defaultSettings();
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : base.enabled,
			root: typeof block?.root === "string" && block.root.trim() ? block.root.trim() : base.root,
		};
	} catch {
		return base;
	}
}

/**
 * Create the directory, or explain why not.
 *
 * Failure is survivable and must not be fatal: a read-only or missing TMPDIR is
 * rare but real (a locked-down CI image, a container with no /tmp mount), and
 * the right response is a session without a scratchpad, not a session that will
 * not start. When this returns an error the prompt block is withheld too — a
 * model told to always use a directory that does not exist is worse off than one
 * never told about it.
 *
 * 0700 because the system temp directory is shared: on a multi-user machine the
 * default would let anyone read whatever the agent was working on.
 */
export function prepare(dir: string): { dir: string } | { error: string } {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return { dir };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);
	let dir: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		dir = undefined;

		if (settings.enabled) {
			const wanted = scratchpadPath({
				tmp: settings.root || tmpdir(),
				uid: process.getuid?.(),
				cwd: ctx.cwd,
				sessionId: ctx.sessionManager.getSessionId(),
			});

			const prepared = prepare(wanted);
			if ("error" in prepared) {
				ctx.ui.notify(`Scratchpad: could not create ${wanted} — ${prepared.error}. Continuing without one.`, "warning");
			} else {
				dir = prepared.dir;
			}
		}

		// Announced on every session start, including the ones with nothing to
		// announce. Two halves of one requirement: a resume is a fresh process
		// whose permissions extension has forgotten the path, so silence there
		// would cost the exemption for the whole session; and a `/new` into a
		// session that turned the scratchpad off, or could not create one, has to
		// take the previous session's exemption *away* — a subscriber that only
		// ever hears about directories that exist keeps honouring a dead one.
		//
		// Sending it from here rather than having permissions clear on its own
		// session_start is what avoids the race: handler order across extensions is
		// nothing either side controls, and a clear over there could land after
		// this announcement rather than before it.
		pi.events.emit(ANNOUNCE.channel, { dir });
	});

	pi.on("before_agent_start", (event) => {
		if (!dir) return;
		return { systemPrompt: event.systemPrompt + buildPromptBlock(dir) };
	});

	const status = (): string => {
		if (!settings.enabled) return "Scratchpad is off (scratchpad.enabled is false).";
		if (!dir) return "No scratchpad this session — it could not be created. See the warning at startup.";
		return [
			dir,
			"",
			describeContents(list(dir)),
			"",
			"Session-scoped and outside the project. Writes here are pre-approved and never prompt.",
		].join("\n");
	};

	pi.registerCommand("scratchpad", {
		description: "Show this session's scratchpad directory and what is in it",
		handler: async (_args, ctx) => {
			ctx.ui.notify(status(), "info");
		},
	});
}

/** The indented listing `/scratchpad` prints, capped at CONFIG.listLimit. */
export function describeContents(entries: string[]): string {
	if (entries.length === 0) return "  (empty)";
	const shown = entries.slice(0, CONFIG.listLimit).map((entry) => `  ${entry}`);
	if (entries.length > shown.length) shown.push(`  …and ${entries.length - shown.length} more`);
	return shown.join("\n");
}

/** Top-level entries, directories marked with a trailing slash. Empty on any error. */
export function list(dir: string): string[] {
	let names: string[];
	try {
		names = readdirSync(dir);
	} catch {
		return [];
	}

	return names.sort().map((name) => {
		try {
			return statSync(join(dir, name)).isDirectory() ? `${name}/` : name;
		} catch {
			return name;
		}
	});
}
