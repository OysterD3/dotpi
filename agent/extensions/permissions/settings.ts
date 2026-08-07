/**
 * Loading and layering permission settings.
 *
 * Rules live under a `permissions` key in pi's own settings files, the same
 * place the conventional `settings.json` puts them:
 *
 *   ~/.pi/agent/settings.json    yours, applies everywhere
 *   <cwd>/.pi/settings.json      the project's
 *
 * pi's `Settings` type has no `permissions` field, so this had to be checked
 * rather than assumed: pi rewrites settings.json by merging its modified fields
 * over the parsed current file (`{ ...currentFileSettings }`), so unknown keys
 * survive. Verified against the real SettingsManager — a `/theme` change leaves
 * the permissions block intact. If a future pi version starts pruning unknown
 * keys, that guarantee breaks; `/permissions` reports the file it loaded so the
 * loss would at least be visible.
 *
 * Layering is not a plain merge, because a project file is content you may not
 * have written. Denies and asks from a project always apply — a repo is welcome
 * to ask for *more* caution. Its `allow` rules and any loosening of the mode are
 * ignored unless the project is trusted, so cloning a hostile repo cannot
 * silently grant itself permission to run anything. pi already gates config
 * loading behind project trust for the same reason.
 */

import { existsSync, readFileSync } from "node:fs";
import { AUTO, CONFIG, MODE_ORDER, type Mode, STRICTER_THAN_AUTO, isMode } from "./config.ts";
import { join } from "node:path";

/**
 * The `permissions.auto` block: what `auto` mode does when it is the mode.
 *
 * Every field here can loosen something — `onError: "allow"` most obviously, but
 * `skipReadOnly` widens what is never looked at and `model` decides where your
 * command text is sent. So the whole block is trusted-only, the way `allow` is.
 */
export type AutoSettings = {
	/**
	 * Model reference for the classifier, or undefined to use the session's.
	 *
	 * Worth setting. This is one bounded judgement about a few hundred characters,
	 * it runs in front of tool calls, and paying frontier prices and frontier
	 * latency for it is the difference between a mode you keep on and one you
	 * switch off after an hour.
	 */
	model?: string;
	/** Skip pi's read-only built-ins and trivially safe bash commands (echo, printf, ls, …) without asking the model. See tools.ts and trivial.ts. */
	skipReadOnly: boolean;
	/**
	 * What an unreachable or unreadable classifier means.
	 *
	 * `allow` — the default — degrades auto mode to `askDestructive`, which is the
	 * mode directly below it and the one this repo ships as standard. Offline, out
	 * of quota, or misconfigured, you get the deterministic table and a warning,
	 * not a session where every command needs a keystroke. `ask` is the paranoid
	 * setting: no verdict, no silent pass.
	 */
	onError: "allow" | "ask";
	/** Per-call budget. Past this the call is an error and `onError` decides. */
	timeoutMs: number;
};

export type PermissionSettings = {
	defaultMode: Mode;
	allow: string[];
	ask: string[];
	deny: string[];
	/**
	 * Extra directories that count as "inside the project", shared with the
	 * add-dir extension, which owns the key and the `/add-dir` command that
	 * writes it. Auto mode's classifier is shown the whole list — without it,
	 * every write to a second repo reads as an escape from the first.
	 *
	 * Trusted-only, exactly like `allow`, and for the same reason: a directory in
	 * this list is one the classifier stops objecting to, so a cloned repo must
	 * not be able to nominate one.
	 */
	additionalDirectories: string[];
	/** Destructive pattern ids to stop asking about. */
	allowDestructive: string[];
	/** Whether a destructive command asks even when an allow rule matches it. */
	destructiveOverridesAllow: boolean;
	/** What an "ask" becomes when there is no UI to ask with. */
	askWithoutUi: "deny" | "allow";
	/**
	 * How long the human approval prompt waits before giving up, in ms. 0 waits
	 * forever — the behaviour every session had before this setting existed.
	 *
	 * On expiry the call is BLOCKed, not allowed: with nobody confirmed to be
	 * watching, failing open is not a safe direction to guess in, and a model
	 * left running past the deadline needs a reason it can act on rather than a
	 * fresh prompt it will also never see answered. See `timeoutReason` in
	 * index.ts for what it is actually told.
	 */
	promptTimeoutMs: number;
	/** Tunables for `auto` mode. Ignored unless `defaultMode` is `auto`. */
	auto: AutoSettings;
};

export type LoadResult = {
	settings: PermissionSettings;
	/** Files that contributed, for `/permissions` to report. */
	sources: string[];
	/** Problems worth showing the user rather than swallowing. */
	warnings: string[];
};

export const BUILTIN: PermissionSettings = {
	defaultMode: "askDestructive",
	allow: [],
	ask: [],
	deny: [],
	additionalDirectories: [],
	allowDestructive: [],
	destructiveOverridesAllow: true,
	askWithoutUi: "deny",
	promptTimeoutMs: CONFIG.promptTimeoutMs,
	auto: { model: undefined, skipReadOnly: true, onError: "allow", timeoutMs: AUTO.timeoutMs },
};

/**
 * Read the `permissions` block out of a settings file.
 *
 * `standalone` files (the older permissions.json) may also hold the block at the
 * top level, since that is how they were written.
 */
function readFile(
	path: string,
	warnings: string[],
	standalone = false,
): Partial<PermissionSettings> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		const nested = parsed.permissions;
		if (nested && typeof nested === "object") return nested as Partial<PermissionSettings>;
		if (standalone) return parsed as Partial<PermissionSettings>;
		return undefined; // settings.json with no permissions block
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
		return undefined;
	}
}

function stringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Is `candidate` at least as restrictive as `current`?
 *
 * The ladder answers this everywhere except at `auto`, which is not a subset of
 * the mode above it: `askMutating` prompts for every write but says nothing at
 * all about custom tools, which `auto` judges. So a project moving a session off
 * `auto` would be trading prompts, not adding them — and a repo that wanted an
 * MCP tool to run unwatched could do it by "tightening" the mode. Only the two
 * modes that stop everything qualify as an upgrade from `auto`.
 */
function atLeastAsStrict(candidate: Mode, current: Mode): boolean {
	// A project may never switch a session INTO auto. It is the one mode that
	// costs money and sends data: every unrecognised tool call becomes a model
	// call, and the command text, write paths and MCP arguments of that repo go
	// to a provider. Because the `auto` block is trusted-only, a project that
	// flipped the mode could not even name a cheap model for it, so the bill
	// lands on the session's frontier model. The ladder called it a tightening —
	// it prompts more — which is true and beside the point.
	if (candidate === "auto") return false;
	if (current === "auto") return STRICTER_THAN_AUTO.has(candidate);
	return MODE_ORDER.indexOf(candidate) >= MODE_ORDER.indexOf(current);
}

export function userSettingsPath(agentDir: string): string {
	return join(agentDir, "settings.json");
}

export function projectSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

/** Pre-merge location, still honoured so an old policy cannot silently lapse. */
export function legacyUserPath(agentDir: string): string {
	return join(agentDir, "permissions.json");
}

export function legacyProjectPath(cwd: string): string {
	return join(cwd, ".pi", "permissions.json");
}

export function loadSettings(agentDir: string, cwd: string, projectTrusted: boolean): LoadResult {
	const warnings: string[] = [];
	const sources: string[] = [];
	// Every mutable field is rebuilt rather than shared with BUILTIN — including
	// `auto`, which is an object: a spread would alias it, and the first project
	// file to set `auto.onError` would edit the defaults for every later reload.
	const settings: PermissionSettings = {
		...BUILTIN,
		allow: [],
		ask: [],
		deny: [],
		additionalDirectories: [],
		allowDestructive: [],
		auto: { ...BUILTIN.auto },
	};

	// Legacy standalone file first, so settings.json wins on conflict. Silently
	// ignoring it would turn a policy someone still relies on into no policy.
	const legacyUser = legacyUserPath(agentDir);
	const legacy = readFile(legacyUser, warnings, true);
	if (legacy) {
		sources.push(legacyUser);
		warnings.push(`${legacyUser} is deprecated — move its contents under a "permissions" key in ${userSettingsPath(agentDir)}`);
		applyFull(settings, legacy, warnings, legacyUser);
	}

	const userPath = userSettingsPath(agentDir);
	const user = readFile(userPath, warnings);
	if (user) {
		sources.push(userPath);
		applyFull(settings, user, warnings, userPath);
	}

	const projectPath = projectSettingsPath(cwd);
	if (projectPath !== userPath) {
		const legacyProject = readFile(legacyProjectPath(cwd), warnings, true);
		const project = readFile(projectPath, warnings) ?? legacyProject;
		if (project) {
			sources.push(projectTrusted ? projectPath : `${projectPath} (untrusted: deny/ask only)`);
			if (projectTrusted) {
				applyFull(settings, project, warnings, projectPath);
			} else {
				// Restrictions only.
				settings.deny.push(...stringArray(project.deny));
				settings.ask.push(...stringArray(project.ask));
				if (isMode(project.defaultMode) && atLeastAsStrict(project.defaultMode, settings.defaultMode)) {
					settings.defaultMode = project.defaultMode;
				} else if (project.defaultMode !== undefined) {
					warnings.push(
						`${projectPath}: ignoring defaultMode "${String(project.defaultMode)}" — an untrusted project cannot loosen permissions`,
					);
				}
				if (project.allow !== undefined || project.allowDestructive !== undefined) {
					warnings.push(`${projectPath}: ignoring allow rules — project is not trusted`);
				}
				// Same rule the add-dir extension applies to this key, and it has to
				// be applied here too or reading it a second time would be the hole:
				// a directory on this list is one auto mode's classifier stops
				// objecting to, so a cloned repo naming ~/.ssh would be widening the
				// definition of "inside the project" from a file you did not write.
				if (project.additionalDirectories !== undefined) {
					warnings.push(`${projectPath}: ignoring additionalDirectories — project is not trusted`);
				}
				// Named separately rather than folded into the line above: every key in
				// the auto block can loosen something, and a repo quietly pointing the
				// classifier at another model — or switching it off with
				// `skipReadOnly` — should be visible, not merely ineffective.
				if (project.auto !== undefined) {
					warnings.push(`${projectPath}: ignoring the auto block — project is not trusted`);
				}
			}
		}
	}

	return { settings, sources, warnings };
}

function applyFull(
	target: PermissionSettings,
	source: Partial<PermissionSettings>,
	warnings: string[],
	path: string,
): void {
	if (source.defaultMode !== undefined) {
		if (isMode(source.defaultMode)) target.defaultMode = source.defaultMode;
		else warnings.push(`${path}: unknown defaultMode "${String(source.defaultMode)}"`);
	}

	target.allow.push(...stringArray(source.allow));
	target.ask.push(...stringArray(source.ask));
	target.deny.push(...stringArray(source.deny));
	target.additionalDirectories.push(...stringArray(source.additionalDirectories));
	target.allowDestructive.push(...stringArray(source.allowDestructive));

	if (typeof source.destructiveOverridesAllow === "boolean") {
		target.destructiveOverridesAllow = source.destructiveOverridesAllow;
	}
	if (source.askWithoutUi === "deny" || source.askWithoutUi === "allow") {
		target.askWithoutUi = source.askWithoutUi;
	}
	if (source.promptTimeoutMs !== undefined) {
		// Unlike permissions.auto.timeoutMs, 0 is accepted here rather than
		// rejected — it is this field's documented way to ask for the old
		// unbounded wait back, not a typo that would make every prompt fail
		// before a human could ever see it.
		if (typeof source.promptTimeoutMs === "number" && Number.isFinite(source.promptTimeoutMs) && source.promptTimeoutMs >= 0) {
			target.promptTimeoutMs = source.promptTimeoutMs;
		} else {
			warnings.push(`${path}: permissions.promptTimeoutMs must be a non-negative number of milliseconds (0 waits forever)`);
		}
	}
	if (source.auto !== undefined) applyAuto(target.auto, source.auto, warnings, path);
}

/**
 * Merge one file's `auto` block.
 *
 * Every field is validated and a bad value is a warning rather than a silent
 * fallback. Silence would be the worst outcome here: a typo in `onError` reading
 * as the default is exactly the case where someone believes they asked to fail
 * closed and did not.
 */
function applyAuto(target: AutoSettings, source: unknown, warnings: string[], path: string): void {
	if (!source || typeof source !== "object" || Array.isArray(source)) {
		warnings.push(`${path}: permissions.auto must be an object, e.g. { "auto": { "model": "..." } }`);
		return;
	}

	const block = source as Record<string, unknown>;

	if (block.model !== undefined) {
		if (typeof block.model === "string" && block.model.trim().length > 0) target.model = block.model.trim();
		else warnings.push(`${path}: permissions.auto.model must be a non-empty string`);
	}

	if (block.skipReadOnly !== undefined) {
		if (typeof block.skipReadOnly === "boolean") target.skipReadOnly = block.skipReadOnly;
		else warnings.push(`${path}: permissions.auto.skipReadOnly must be true or false`);
	}

	if (block.onError !== undefined) {
		if (block.onError === "allow" || block.onError === "ask") target.onError = block.onError;
		else warnings.push(`${path}: permissions.auto.onError must be "allow" or "ask"`);
	}

	if (block.timeoutMs !== undefined) {
		// A zero or negative timeout would make every call fail instantly and turn
		// the mode into whatever `onError` says, which is not what anyone typing a
		// number means.
		if (typeof block.timeoutMs === "number" && Number.isFinite(block.timeoutMs) && block.timeoutMs > 0) {
			target.timeoutMs = block.timeoutMs;
		} else {
			warnings.push(`${path}: permissions.auto.timeoutMs must be a positive number of milliseconds`);
		}
	}
}
