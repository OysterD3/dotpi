/**
 * scratchpad — a session-scoped temp directory the agent is told to use, and
 * that it is never asked for permission to write to.
 *
 * At session start it creates `<tmp>/pi-<uid>/<project>/<session>/scratchpad`
 * (paths.ts), announces the path on `scratchpad:dir` so the permissions
 * extension can stop prompting for writes that land inside it, and appends a
 * block to the system prompt telling the model what the directory is for
 * (prompt.ts). The `scratchpad` tool returns the path, the full rules and
 * the current contents on demand.
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

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, type Stats } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ANNOUNCE, CONFIG, defaultSettings, SETTINGS_KEY, type ScratchpadSettings } from "./config.ts";
import { expandRoot, scratchpadUnder, userRoot } from "./paths.ts";
import { buildPromptBlock, buildToolGuidance } from "./prompt.ts";

export function loadSettings(agentDir: string): ScratchpadSettings {
	const base = defaultSettings();
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : base.enabled,
			// Kept as written. Validation happens in session_start, which has a `ctx`
			// to warn through — a root silently swapped for the default here would
			// leave the user's setting looking like it took effect.
			root: typeof block?.root === "string" && block.root.trim() ? block.root.trim() : base.root,
		};
	} catch {
		return base;
	}
}

/**
 * Create the per-user root, and refuse to use one that is not ours.
 *
 * This is the security-load-bearing half of `prepare`, and it exists because
 * `mkdirSync(…, { recursive: true })` follows symlinks it finds on the way down.
 * The temp directory is shared, and every segment of the path above the session
 * id is predictable before pi ever runs: the uid is guessable and the project
 * slug is a pure function of the cwd. On Linux, or with the `/tmp` root the
 * settings offer, another local user can therefore pre-create `pi-<uid>` — or
 * `pi-<uid>/<project-slug>` — as a symlink into a directory they own. `mkdir`
 * follows it, the scratchpad is created inside their directory, and pi then
 * tells the model in its system prompt to write every intermediate result and
 * reproduction script there. Because the permission exemption is keyed on the
 * announced path, none of those writes would prompt.
 *
 * So the root is created first, on its own, and then checked: a real directory
 * (`lstat`, so a symlink fails rather than being followed), owned by us, and not
 * readable or writable by anyone else. Anything else refuses — and refusing is
 * cheap, because a session without a scratchpad is a working session.
 *
 * The mode check is not redundant with creating it 0700. `mkdirSync` only
 * applies that mode to directories it actually creates, so a root that already
 * existed — the interesting case — has whatever permissions it was given.
 */
export function prepareRoot(root: string): string | undefined {
	try {
		mkdirSync(root, { recursive: true, mode: 0o700 });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	let stats: Stats;
	try {
		stats = lstatSync(root);
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}

	if (!stats.isDirectory()) return "it is a symlink or a file, not a directory";

	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) return `it is owned by uid ${stats.uid}, not by you`;

	// Group and other bits. On Windows the mode is synthetic and this never fires,
	// which is correct: the check is about a shared POSIX temp directory.
	if (uid !== undefined && (stats.mode & 0o077) !== 0) return "it is accessible to other users on this machine";

	return undefined;
}

/**
 * Create the session directory under an already-verified root.
 *
 * Failure is survivable and must not be fatal: a read-only or missing TMPDIR is
 * rare but real (a locked-down CI image, a container with no /tmp mount), and
 * the right response is a session without a scratchpad, not a session that will
 * not start. When this returns an error the prompt block is withheld too — a
 * model told to always use a directory that does not exist is worse off than one
 * never told about it.
 *
 * 0700 for the same reason the root is: the system temp directory is shared, and
 * the default would let anyone read whatever the agent was working on.
 */
export function prepare(dir: string): string | undefined {
	try {
		mkdirSync(dir, { recursive: true, mode: 0o700 });
		return undefined;
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
}

/** Session files are named `<timestamp>_<uuid>.jsonl`; the id is the uuid. */
function sessionIdFromFile(file: string): string | undefined {
	const stem = basename(file).replace(/\.jsonl$/, "");
	const id = stem.split("_").pop();
	return id && id.length > 0 ? id : undefined;
}

/**
 * This session's scratchpad — inheriting the previous session's when there is
 * one to inherit.
 *
 * Keying on the session id is what makes two terminal tabs on one project not
 * collide, and it was quietly wrong across a fork. `/rewind` and branching fork
 * the session, which mints a *new* id while keeping the conversation: the model
 * would arrive holding tool results that name files under the old session
 * directory, be handed a system prompt naming a new empty one, and get
 * not-found for a file it correctly believed it had written. Worse quietly, the
 * old path was no longer the announced one, so calls against it stopped being
 * exempt and started prompting.
 *
 * A fork keeps the context, so it should keep the files. `previousSessionFile`
 * is present for "new", "resume" and "fork"; the `existsSync` is what makes it
 * safe to consult all three — a `/new` into an unrelated session finds no
 * scratchpad under this project's slug for that id and falls through to its own.
 * Two sessions sharing a directory after a fork is the intent, not a collision:
 * the forked-from session is the one that was abandoned.
 */
function sessionDir(
	root: string,
	cwd: string,
	sessionId: string | undefined,
	previousSessionFile: string | undefined,
): string {
	const own = scratchpadUnder(root, cwd, sessionId);

	const previous = previousSessionFile ? sessionIdFromFile(previousSessionFile) : undefined;
	if (previous && previous !== sessionId) {
		const inherited = scratchpadUnder(root, cwd, previous);
		if (existsSync(inherited)) return inherited;
	}

	return own;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	// Not read from disk here: `session_start` reloads before anything can read
	// it, and nothing else runs in between — `before_agent_start` looks only at
	// `dir`, and the tool cannot be called before the model has a turn.
	let settings = defaultSettings();
	let dir: string | undefined;

	pi.on("session_start", (event, ctx) => {
		settings = loadSettings(agentDir);
		dir = undefined;

		if (settings.enabled) {
			const configured = settings.root ? expandRoot(settings.root) : undefined;
			if (settings.root && !configured) {
				ctx.ui.notify(
					`Scratchpad: ignoring scratchpad.root "${settings.root}" — it must be an absolute path or start with "~/". Using ${tmpdir()}.`,
					"warning",
				);
			}

			const tmp = configured ?? tmpdir();
			const uid = process.getuid?.();
			const root = userRoot(tmp, uid);

			// Before anything is created under it. See prepareRoot: this is what
			// stops a symlink another user left in a shared temp directory from
			// becoming the place pi tells the model to put all its working files.
			const rootFailure = prepareRoot(root);
			if (rootFailure) {
				ctx.ui.notify(`Scratchpad: refusing to use ${root} — ${rootFailure}. Continuing without one.`, "warning");
			} else {
				const wanted = sessionDir(root, ctx.cwd, ctx.sessionManager.getSessionId(), event.previousSessionFile);
				const failure = prepare(wanted);
				if (failure) {
					ctx.ui.notify(`Scratchpad: could not create ${wanted} — ${failure}. Continuing without one.`, "warning");
				} else {
					dir = wanted;
				}
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

	// The long guidance lives here rather than in every request. `dir` is read at
	// call time, not captured: a `/new` can replace or remove it mid-session, and
	// a tool closed over the old value would hand out a path nothing announced.
	pi.registerTool({
		name: "scratchpad",
		label: "Scratchpad",
		description:
			"Return this session's scratchpad directory: where to put temporary files, the rules for using it, " +
			"and what is currently in it. The path is already in your system prompt — call this when you want the " +
			"full rules, or to see what you have written there so far.",
		promptSnippet: "Get the session scratchpad path, its rules, and its current contents",
		promptGuidelines: [
			"Write temporary files into the scratchpad directory named in your system prompt rather than /tmp or the user's project.",
			"Call scratchpad with action \"list\" to see what you already wrote there, instead of re-deriving it.",
		],
		parameters: Type.Object({
			action: Type.Optional(
				Type.Union([Type.Literal("path"), Type.Literal("list")], {
					description:
						'"path" (default) returns the directory and the full rules for using it; ' +
						'"list" returns the directory and what is currently in it.',
				}),
			),
		}),

		async execute(_toolCallId, params) {
			// Not an error: a session without a scratchpad is a supported state
			// (disabled, or the directory could not be created and the user was
			// warned at startup). Saying so plainly is what stops the model
			// retrying, or writing to a path that does not exist.
			if (!settings.enabled) {
				return {
					content: [{ type: "text", text: "No scratchpad: it is turned off (scratchpad.enabled is false). Use /tmp for temporary files." }],
					details: { action: params.action ?? "path", dir: null },
				};
			}
			if (!dir) {
				return {
					content: [{ type: "text", text: "No scratchpad this session — it could not be created; the user was warned at startup. Use /tmp for temporary files." }],
					details: { action: params.action ?? "path", dir: null },
				};
			}

			const action = params.action ?? "path";
			const entries = action === "list" ? list(dir) : undefined;
			const text =
				action === "list"
					? `Scratchpad directory for this session:\n\`${dir}\`\n\nContents:\n${describeContents(entries!)}`
					: buildToolGuidance(dir);

			return {
				content: [{ type: "text", text }],
				details: { action, dir, count: entries?.length },
			};
		},
	});
}

/** The indented listing the `scratchpad` tool returns, capped at CONFIG.listLimit. */
export function describeContents(entries: string[]): string {
	if (entries.length === 0) return "  (empty)";
	const shown = entries.slice(0, CONFIG.listLimit).map((entry) => `  ${entry}`);
	if (entries.length > shown.length) shown.push(`  …and ${entries.length - shown.length} more`);
	return shown.join("\n");
}

/**
 * Top-level entries, directories marked with a trailing slash. Empty on any error.
 *
 * `withFileTypes` rather than a `statSync` per name: the listing is capped at
 * twenty lines, and stat-ing every entry to render twenty of them costs one
 * syscall per file in a directory an agent may have filled. The one difference
 * is that a symlink pointing at a directory no longer gets its trailing slash,
 * which is cosmetic.
 */
export function list(dir: string): string[] {
	try {
		return readdirSync(dir, { withFileTypes: true })
			.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
			.sort();
	} catch {
		return [];
	}
}
