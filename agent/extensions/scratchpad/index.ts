/**
 * scratchpad — a private working directory for files that are not the user's work.
 *
 * An agent constantly needs somewhere to put a file that is not part of the
 * project: a script to check a hypothesis, the output of a command too long to
 * read inline, an intermediate result carried across several steps. With nowhere
 * designated it uses two places, and both are wrong. `/tmp` is shared with every
 * other process and user on the machine. The project directory is worse: it is
 * usually a git repository, so the file lands in `git status`, gets swept in by
 * a directory-wide `git add`, and can be committed and pushed — which for a
 * public repo is a one-way door.
 *
 * So: one directory per session, outside every repository, private to the user,
 * pruned after a week, and — the part that actually matters — named in the
 * system prompt so the agent reaches for it by default.
 *
 *   config.ts    tunables
 *   store.ts     where it lives, creating it, listing, clearing, pruning
 *   prompt.ts    what the agent is told (pure)
 *   settings.ts  the `scratchpad` settings block
 *
 * Nothing here is a sandbox. The agent can still write anywhere it has
 * permission to; this makes the right place the easy place, which is the only
 * mechanism available to an extension that cannot intercept the filesystem.
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CONFIG } from "./config.ts";
import { scratchpadPrompt } from "./prompt.ts";
import { loadSettings, type ScratchpadSettings } from "./settings.ts";
import { clear, ensure, list, prune, rootFor } from "./store.ts";

function formatBytes(bytes: number): string {
	if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)}MB`;
	if (bytes >= 1000) return `${Math.round(bytes / 1000)}kB`;
	return `${bytes}B`;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings: ScratchpadSettings | undefined;
	let dir: string | undefined;
	let warnings: string[] = [];

	const start = (ctx: ExtensionContext) => {
		const loaded = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
		settings = loaded.settings;
		warnings = loaded.warnings;
		dir = undefined;

		if (!settings.enabled) return;

		const root = rootFor(settings.dir);

		// Housekeeping before the new directory is made, so a session that starts
		// and stops repeatedly cannot outrun its own cleanup.
		prune(root, Date.now(), settings.retainDays);

		// A session id is not available in every mode (a `--no-session` run has
		// none). Falling back to the process id keeps the feature working there
		// rather than switching it off — the directory is just not resumable,
		// which for scratch work is no loss.
		const sessionId = ctx.sessionManager.getSessionId() ?? `pid-${process.pid}`;
		dir = ensure(root, ctx.cwd, sessionId);

		if (!dir) warnings.push(`Could not create a scratchpad under ${root}; falling back to no scratchpad this session.`);
		if (warnings.length > 0) ctx.ui.notify(`Scratchpad:\n${warnings.join("\n")}`, "warning");
	};

	pi.on("session_start", (_event, ctx) => start(ctx));

	// Appended rather than replacing: `systemPrompt` results chain across
	// extensions, so overwriting would silently drop whatever memory, or any
	// other extension, had already contributed.
	pi.on("before_agent_start", (event) => {
		if (!dir) return undefined;
		return { systemPrompt: `${event.systemPrompt}\n\n${scratchpadPrompt(dir)}` };
	});

	pi.registerCommand("scratchpad", {
		description: "Show this session's scratchpad directory (path | clear)",

		getArgumentCompletions: (prefix) =>
			["path", "clear"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),

		handler: async (args, ctx) => {
			const text = args.trim();

			if (!settings?.enabled) {
				ctx.ui.notify(`Scratchpad is off (${"scratchpad"}.enabled is false).`, "info");
				return;
			}
			if (!dir) {
				ctx.ui.notify("No scratchpad this session — it could not be created. See the warning at startup.", "warning");
				return;
			}

			// Bare path, for piping or copying. Nothing else on the line.
			if (text === "path") {
				ctx.ui.notify(dir, "info");
				return;
			}

			if (text === "clear") {
				const removed = clear(dir);
				ctx.ui.notify(
					removed === 0 ? "Scratchpad was already empty." : `Removed ${removed} item(s) from the scratchpad.`,
					"info",
				);
				return;
			}

			const entries = list(dir);
			const shown = entries.slice(0, CONFIG.maxListed);
			const total = entries.reduce((sum, entry) => sum + entry.bytes, 0);

			const lines = [
				dir,
				"",
				entries.length === 0
					? "Empty."
					: `${entries.length} item(s), ${formatBytes(total)}:\n${shown
							.map((entry) => `  ${formatBytes(entry.bytes).padStart(7)}  ${entry.name}`)
							.join("\n")}${entries.length > shown.length ? `\n  …and ${entries.length - shown.length} more` : ""}`,
				"",
				`Kept for ${settings.retainDays} day(s) after last use, then pruned. /scratchpad clear empties it now.`,
			];

			// Only worth saying when something is actually gating writes there: in
			// `auto` mode every write the rules do not settle costs a model call, and
			// the scratchpad is the one directory where that is pure waste. The rule
			// is printed against the stable root rather than this session's directory,
			// so it keeps working tomorrow.
			lines.push(
				"",
				"If you run permissions in auto or askMutating mode, this is worth allowlisting:",
				`  "allow": ["Write(${rootFor(settings.dir)}/**)", "Edit(${rootFor(settings.dir)}/**)"]`,
			);

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
