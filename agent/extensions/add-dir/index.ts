/**
 * /add-dir — bring another directory into the workspace.
 *
 * A port of Claude Code's `/add-dir`, whose behaviour was read out of the shipped
 * binary (2.1.217): the validation result types and their exact wording, the
 * three-way answer ("this session" / "remember" / "no"), persisting under
 * `permissions.additionalDirectories`, and loading each added directory's
 * guidance file the way the project's own is loaded.
 *
 * What it means here is not quite what it means there, and the difference is
 * worth being clear about. In Claude Code the workspace is a permission boundary:
 * tools refuse paths outside it, so `/add-dir` unlocks access. pi has no such
 * fence — `read`, `edit` and `bash` already accept any absolute path. So this
 * does not grant anything. It tells the model the directory is in scope, and it
 * loads that directory's AGENTS.md. That is the whole of it, and it is the part
 * that was actually missing.
 *
 *   paths.ts      expansion and containment (pure)
 *   validate.ts   the checks and their messages (pure but for one stat)
 *   workspace.ts  the directory set and its session persistence
 *   settings.ts   reading and writing settings.json without losing pi's writes
 *   prompt.ts     what gets appended to the system prompt (pure but for reads)
 *   config.ts     caps and labels
 *
 * Companion command `/dirs` lists the workspace and removes directories from it,
 * which Claude Code folds into its `/permissions` UI.
 */

import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { CHOICES, CONFIG, type Choice } from "./config.ts";
import { displayPath, expandPath } from "./paths.ts";
import { buildPromptBlock } from "./prompt.ts";
import {
	loadPersisted,
	persist,
	projectSettingsPath,
	unpersist,
	userSettingsPath,
} from "./settings.ts";
import { describe, validateDirectory } from "./validate.ts";
import { restoreSessionDirs, Workspace } from "./workspace.ts";

const MANAGE_HINT = "/dirs to manage";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let workspace: Workspace | undefined;

	pi.on("session_start", (_event, ctx) => {
		workspace = new Workspace(pi, ctx.cwd);

		const loaded = loadPersisted(agentDir, ctx.cwd, ctx.isProjectTrusted());
		for (const source of loaded.sources) workspace.adoptPersisted(source.dirs, source.path);

		workspace.adoptSession(restoreSessionDirs(ctx.sessionManager.getBranch()));

		for (const warning of loaded.warnings) ctx.ui.notify(warning, "warning");
	});

	// Tell the model about the directories. Appended after pi's own
	// "Current working directory:" line so the two read together.
	pi.on("before_agent_start", (event) => {
		const dirs = workspace?.additional().map((entry) => entry.path) ?? [];
		if (dirs.length === 0) return;
		return { systemPrompt: event.systemPrompt + buildPromptBlock(dirs) };
	});

	pi.registerCommand("add-dir", {
		description: "Add a new working directory",
		getArgumentCompletions: (prefix) => completeDirectories(prefix, workspace?.cwd ?? process.cwd()),
		handler: async (args, ctx) => {
			if (!workspace) return;
			await addDirectory(workspace, args.trim(), ctx, agentDir);
		},
	});

	pi.registerCommand("dirs", {
		description: "List and remove the session's working directories",
		handler: async (_args, ctx) => {
			if (!workspace) return;
			await manageDirectories(workspace, ctx);
		},
	});
}

async function addDirectory(
	workspace: Workspace,
	initial: string,
	ctx: ExtensionCommandContext,
	agentDir: string,
): Promise<void> {
	let input = initial;
	if (!input) {
		if (!ctx.hasUI) {
			ctx.ui.notify("Usage: /add-dir <path>", "warning");
			return;
		}
		input = (await ctx.ui.input("Add directory to workspace", "path to a directory")) ?? "";
		if (!input.trim()) return;
	}

	const result = await validateDirectory(input.trim(), {
		workingDirs: workspace.paths(),
		cwd: workspace.cwd,
		additionalCount: workspace.additional().length,
	});

	if (result.resultType !== "success") {
		ctx.ui.notify(describe(result), result.resultType === "alreadyInWorkingDirectory" ? "info" : "warning");
		return;
	}

	const dir = result.absolutePath;

	// No dialogs available (print or JSON mode): the user asked for it explicitly
	// on the command line, so honour it for the session rather than refusing.
	if (!ctx.hasUI) {
		workspace.addSession(dir);
		ctx.ui.notify(`Added ${dir} as a working directory for this session`, "info");
		return;
	}

	const labels = CHOICES.map((choice) => choice.label);
	const picked = await ctx.ui.select(`Add ${displayPath(dir, workspace.cwd)} as a working directory?`, labels);
	const choice: Choice | undefined = CHOICES.find((c) => c.label === picked)?.value;

	if (choice === undefined || choice === "no") {
		ctx.ui.notify(`Did not add ${dir} as a working directory.`, "info");
		return;
	}

	if (choice === "session") {
		workspace.addSession(dir);
		ctx.ui.notify(`Added ${dir} as a working directory for this session · ${MANAGE_HINT}`, "info");
		return;
	}

	await remember(workspace, dir, ctx, agentDir);
}

/**
 * Persist a directory, after asking which settings file.
 *
 * Claude Code has no equivalent question because it always writes
 * `.claude/settings.local.json`, a per-project file its own setup gitignores. pi
 * has no local-settings tier, so the choice is between a file that may be
 * committed with the project and one that applies to every project. Both are
 * reasonable and neither is a safe default to pick silently.
 */
async function remember(
	workspace: Workspace,
	dir: string,
	ctx: ExtensionCommandContext,
	agentDir: string,
): Promise<void> {
	const projectPath = projectSettingsPath(workspace.cwd);
	const userPath = userSettingsPath(agentDir);

	const projectLabel = `This project (${displayPath(projectPath, workspace.cwd)})`;
	const userLabel = `Every project (${displayPath(userPath, workspace.cwd)})`;

	const scope = await ctx.ui.select("Remember it where?", [projectLabel, userLabel]);
	if (scope === undefined) {
		ctx.ui.notify(`Did not add ${dir} as a working directory.`, "info");
		return;
	}

	const toProject = scope === projectLabel;
	const target = toProject ? projectPath : userPath;

	// An untrusted project's settings are ignored on load, by the same rule that
	// stops a cloned repo granting itself permissions. Writing there anyway would
	// look like it worked and then quietly not.
	if (toProject && !ctx.isProjectTrusted()) {
		workspace.addSession(dir);
		ctx.ui.notify(
			`Added ${dir} for this session only. ${target} is ignored because this project is not trusted — run /trust first, then /add-dir again.`,
			"warning",
		);
		return;
	}

	try {
		persist(target, dir);
		workspace.addPersisted(dir, target);
		ctx.ui.notify(`Added ${dir} as a working directory and saved to ${target} · ${MANAGE_HINT}`, "info");
	} catch (error) {
		// Claude Code's fallback: the directory is still added, the failure is named.
		workspace.addSession(dir);
		const reason = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`Added ${dir} as a working directory. Failed to save to ${target}: ${reason}`, "warning");
	}
}

async function manageDirectories(workspace: Workspace, ctx: ExtensionCommandContext): Promise<void> {
	const additional = workspace.additional();

	if (!ctx.hasUI || additional.length === 0) {
		const lines = workspace
			.all()
			.map((entry) => `  ${entry.path}${entry.origin === "cwd" ? "  (current)" : `  (${entry.origin})`}`);
		ctx.ui.notify(
			additional.length === 0
				? `Working directory:\n${lines.join("\n")}\n\nAdd another with /add-dir <path>`
				: `Working directories:\n${lines.join("\n")}`,
			"info",
		);
		return;
	}

	const DONE = "Done";
	const labels = additional.map(
		(entry) => `${entry.path}  (${entry.origin === "session" ? "this session" : `saved in ${entry.source}`})`,
	);

	const picked = await ctx.ui.select("Remove a working directory?", [...labels, DONE]);
	if (picked === undefined || picked === DONE) return;

	const entry = additional[labels.indexOf(picked)];
	if (!entry) return;

	workspace.remove(entry.path);

	if (entry.origin === "persisted" && entry.source) {
		try {
			unpersist(entry.source, entry.path);
			ctx.ui.notify(`Removed ${entry.path} from the workspace and from ${entry.source}`, "info");
		} catch (error) {
			const reason = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(
				`Removed ${entry.path} for this session. Failed to update ${entry.source}: ${reason}`,
				"warning",
			);
		}
		return;
	}

	ctx.ui.notify(`Removed ${entry.path} from the workspace`, "info");
}

/**
 * Directory suggestions for `/add-dir <prefix>`.
 *
 * Only directories are offered, and the value keeps the user's own notation — a
 * `~/` prefix stays `~/` — so tabbing through does not rewrite what they typed.
 */
export function completeDirectories(prefix: string, cwd: string): AutocompleteItem[] | null {
	const slash = prefix.lastIndexOf("/");
	const head = slash === -1 ? "" : prefix.slice(0, slash + 1);
	const partial = slash === -1 ? prefix : prefix.slice(slash + 1);

	let scanDir: string;
	try {
		scanDir = head === "" ? cwd : resolve(expandPath(head, cwd));
	} catch {
		return null;
	}

	let entries: Dirent[];
	try {
		entries = readdirSync(scanDir, { withFileTypes: true });
	} catch {
		return null;
	}

	const showHidden = partial.startsWith(".");
	const items = entries
		.filter((entry) => entry.name.startsWith(partial))
		.filter((entry) => showHidden || !entry.name.startsWith("."))
		.filter((entry) => isDirectoryEntry(scanDir, entry))
		.map((entry) => entry.name)
		.sort()
		.slice(0, CONFIG.completionLimit)
		.map((name) => ({ value: `${head}${name}/`, label: `${head}${name}/` }));

	return items.length > 0 ? items : null;
}

/** A symlink is worth offering only if it points at a directory. */
function isDirectoryEntry(dir: string, entry: Dirent): boolean {
	if (entry.isDirectory()) return true;
	if (!entry.isSymbolicLink()) return false;
	try {
		return statSync(join(dir, entry.name)).isDirectory();
	} catch {
		return false;
	}
}
