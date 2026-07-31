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
import { scratchpadPrompt } from "./prompt.ts";
import { loadSettings } from "./settings.ts";
import { ensure, prune, rootFor } from "./store.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();

	/**
	 * This session's directory, and the only state worth holding: the settings
	 * and warnings behind it are read, used, and finished with inside start().
	 * `undefined` means there is no scratchpad — switched off, or the filesystem
	 * refused — and the prompt hook stays silent rather than naming a path that
	 * does not exist.
	 */
	let dir: string | undefined;

	const start = (ctx: ExtensionContext) => {
		const { settings, warnings } = loadSettings(agentDir, ctx.cwd, ctx.isProjectTrusted());
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
}
