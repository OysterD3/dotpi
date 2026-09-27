/**
 * Loading hook configuration: four files, merged, every field checked.
 *
 *   ~/.pi/agent/settings.json    a "hooks" key, as in Claude Code's settings.json
 *   ~/.pi/agent/hooks.json       the same object on its own
 *   <cwd>/.pi/settings.json      the project's, trusted projects only
 *   <cwd>/.pi/hooks.json         the project's, trusted projects only
 *
 * A hooks.json may hold `{ "hooks": { … } }` — the shape of a Claude Code
 * plugin's hooks/hooks.json, `description` and all — or the event map bare.
 * Both are accepted because the failure mode of guessing wrong is a file whose
 * hooks all silently vanish.
 *
 * Files MERGE, they do not override: every file adds its matcher groups to the
 * event, as Claude Code does. The same handler written in two files runs once
 * (see `key`), so copying a hook into a project file does not double it.
 *
 * Project files are code you may not have written — a hook is a shell command
 * run on every tool call — so they load only for a trusted project. The trust
 * test is not simply `ctx.isProjectTrusted()`: pi decides trust from a fixed
 * list of project resources, `.pi/hooks.json` is not on it, and a repository
 * holding only that file reads as trusted without anyone having been asked.
 * index.ts computes the stricter answer and passes it in.
 *
 * Every bad value is a named warning, never a silent default. A hook that fails
 * to load is a guard that is not running, and the one thing worse than that is
 * not being told.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ALLOWED_TYPES, EVENTS, type EventName, MATCH_FIELD, TYPES, UNSUPPORTED } from "./config.ts";
import { compileMatcher, matches, type Matcher } from "./match.ts";

type Common = {
	/** Seconds. Absent means the per-type, per-event default in config.ts. */
	timeout?: number;
	/** Shown as the working message while the handler runs. */
	statusMessage?: string;
	/** Identity for de-duplication: the same handler from two files runs once. */
	key: string;
	/** The file it came from, for /hooks and for error messages. */
	source: string;
};

export type CommandHandler = Common & {
	type: "command";
	command: string;
	/** Exec form: `command` is spawned directly with these arguments and no shell. */
	args?: string[];
	/** Run in the background, with no deadline; its context reaches the model on the next request. */
	async: boolean;
};

export type HttpHandler = Common & {
	type: "http";
	url: string;
	headers: Record<string, string>;
	/** The only environment variables `headers` may interpolate. */
	allowedEnvVars: string[];
};

export type PromptHandler = Common & {
	type: "prompt";
	prompt: string;
	/** A model reference; absent means the session model. */
	model?: string;
	continueOnBlock: boolean;
};

export type Handler = CommandHandler | HttpHandler | PromptHandler;

export type Group = {
	matcher: Matcher;
	/** As written, for /hooks. */
	matcherText?: string;
	handlers: Handler[];
	source: string;
};

export type HookConfig = {
	events: Partial<Record<EventName, Group[]>>;
	/** `disableAllHooks: true` in a settings file. */
	disabled: boolean;
	/** Files that contributed, for /hooks. */
	sources: string[];
	warnings: string[];
};

/** The events Claude Code evaluates `if` on (PermissionDenied has no pi signal). */
const TOOL_EVENTS: ReadonlySet<EventName> = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest"]);

export const EMPTY: HookConfig = { events: {}, disabled: false, sources: [], warnings: [] };

export function hookPaths(agentDir: string, cwd: string) {
	return {
		userSettings: join(agentDir, "settings.json"),
		userHooks: join(agentDir, "hooks.json"),
		projectSettings: join(cwd, ".pi", "settings.json"),
		projectHooks: join(cwd, ".pi", "hooks.json"),
	};
}

export function loadHooks(agentDir: string, cwd: string, projectTrusted: boolean): HookConfig {
	const config: HookConfig = { events: {}, disabled: false, sources: [], warnings: [] };
	const paths = hookPaths(agentDir, cwd);

	readSettings(config, paths.userSettings);
	readHooksFile(config, paths.userHooks);

	// When the agent dir is <cwd>/.pi (PI_CODING_AGENT_DIR=~/.pi run from ~),
	// the project file IS the user file, and reading it twice would load every
	// hook twice before de-duplication.
	if (paths.projectSettings === paths.userSettings) return config;

	for (const path of [paths.projectSettings, paths.projectHooks]) {
		if (!existsSync(path)) continue;
		if (!projectTrusted) {
			const parsed = readJson(path, config.warnings);
			const holdsHooks =
				path === paths.projectHooks || (parsed !== undefined && (parsed.hooks !== undefined || parsed.disableAllHooks !== undefined));
			if (holdsHooks) {
				config.warnings.push(`${path}: ignoring its hooks — this project is not trusted (use /trust to trust it)`);
			}
			continue;
		}
		if (path === paths.projectSettings) readSettings(config, path);
		else readHooksFile(config, path);
	}

	return config;
}

function readSettings(config: HookConfig, path: string): void {
	const parsed = readJson(path, config.warnings);
	if (!parsed) return;
	if (parsed.disableAllHooks !== undefined) {
		// Later files win, so a trusted project can switch hooks back on for itself.
		if (typeof parsed.disableAllHooks === "boolean") config.disabled = parsed.disableAllHooks;
		else config.warnings.push(`${path}: disableAllHooks must be true or false`);
	}
	if (parsed.hooks === undefined) return;
	if (!isObject(parsed.hooks)) {
		config.warnings.push(`${path}: "hooks" must be an object of event names`);
		return;
	}
	config.sources.push(path);
	readEvents(config, parsed.hooks, path);
}

function readHooksFile(config: HookConfig, path: string): void {
	const parsed = readJson(path, config.warnings);
	if (!parsed) return;
	config.sources.push(path);
	if (parsed.hooks !== undefined) {
		if (isObject(parsed.hooks)) readEvents(config, parsed.hooks, path);
		else config.warnings.push(`${path}: "hooks" must be an object of event names`);
		return;
	}
	const { description: _description, ...events } = parsed;
	readEvents(config, events, path);
}

function readEvents(config: HookConfig, block: Record<string, unknown>, path: string): void {
	for (const [event, groups] of Object.entries(block)) {
		if (!(EVENTS as readonly string[]).includes(event)) {
			const why = UNSUPPORTED[event];
			config.warnings.push(why ? `${path}: ${event} never fires in pi — ${why}` : `${path}: unknown hook event "${event}"`);
			continue;
		}
		const name = event as EventName;
		if (!Array.isArray(groups)) {
			config.warnings.push(`${path}: ${name} must be an array of matcher groups`);
			continue;
		}
		groups.forEach((raw, index) => {
			const where = `${path}: ${name}[${index}]`;
			const group = readGroup(raw, name, where, path, config.warnings);
			if (group) (config.events[name] ??= []).push(group);
		});
	}
}

function readGroup(raw: unknown, event: EventName, where: string, path: string, warnings: string[]): Group | undefined {
	if (!isObject(raw) || !Array.isArray(raw.hooks)) {
		warnings.push(`${where}: needs a "hooks" array`);
		return undefined;
	}
	if (raw.matcher !== undefined && typeof raw.matcher !== "string") {
		warnings.push(`${where}: matcher must be a string`);
		return undefined;
	}
	const matcherText = raw.matcher as string | undefined;

	// On an event without matcher support the matcher is ignored, not an error —
	// the same file may be shared with an agent where it means something.
	let matcher: Matcher = { kind: "all" };
	if (MATCH_FIELD[event] !== undefined) {
		const compiled = compileMatcher(matcherText, event === "StopFailure");
		if ("error" in compiled) {
			warnings.push(`${where}: ${compiled.error} — group skipped`);
			return undefined;
		}
		matcher = compiled;
	}

	const handlers = raw.hooks
		.map((handler, index) => readHandler(handler, event, `${where}.hooks[${index}]`, path, warnings))
		.filter((handler): handler is Handler => handler !== undefined);
	if (handlers.length === 0) return undefined;
	return { matcher, matcherText, handlers, source: path };
}

function readHandler(raw: unknown, event: EventName, where: string, path: string, warnings: string[]): Handler | undefined {
	if (!isObject(raw)) {
		warnings.push(`${where}: must be an object`);
		return undefined;
	}
	const type = raw.type;
	if (type === "agent" || type === "mcp_tool") {
		warnings.push(`${where}: "${type}" hooks are not supported in pi — skipped`);
		return undefined;
	}
	if (typeof type !== "string" || !(TYPES as readonly string[]).includes(type)) {
		warnings.push(`${where}: unknown type ${JSON.stringify(type)} — use command, http or prompt`);
		return undefined;
	}
	if (!(ALLOWED_TYPES[event] as readonly string[]).includes(type)) {
		warnings.push(`${where}: ${event} does not run "${type}" hooks — skipped`);
		return undefined;
	}

	if (raw.asyncRewake !== undefined) {
		warnings.push(`${where}: "asyncRewake" is not supported — skipped`);
		return undefined;
	}
	// Named because each changes what runs. `if` above all: a guard written to
	// fire on `Bash(git *)` now fires on every Bash call, which is safe for a
	// check and wrong for a side effect, and either way worth knowing. Off the
	// tool events Claude Code never runs a handler that has one, so neither
	// does this.
	if (raw.if !== undefined) {
		if (!TOOL_EVENTS.has(event)) {
			warnings.push(`${where}: a handler with "if" never runs on ${event} (only on tool events) — skipped`);
			return undefined;
		}
		warnings.push(`${where}: "if" is not supported — this handler runs for every ${event} its matcher selects`);
	}
	if (raw.once !== undefined) warnings.push(`${where}: "once" is ignored (Claude Code honours it only in skill frontmatter)`);
	if (raw.shell !== undefined) warnings.push(`${where}: "shell" is ignored — command hooks run with /bin/sh`);

	let timeout: number | undefined;
	if (raw.timeout !== undefined) {
		if (typeof raw.timeout === "number" && Number.isFinite(raw.timeout) && raw.timeout > 0) timeout = raw.timeout;
		else warnings.push(`${where}: timeout must be a positive number of seconds — using the default`);
	}
	let statusMessage: string | undefined;
	if (raw.statusMessage !== undefined) {
		if (typeof raw.statusMessage === "string") statusMessage = raw.statusMessage;
		else warnings.push(`${where}: statusMessage must be a string`);
	}

	if (type === "command") {
		if (typeof raw.command !== "string" || raw.command.trim().length === 0) {
			warnings.push(`${where}: a command hook needs a "command" string`);
			return undefined;
		}
		let args: string[] | undefined;
		if (raw.args !== undefined) {
			if (Array.isArray(raw.args) && raw.args.every((arg) => typeof arg === "string")) args = raw.args as string[];
			else {
				warnings.push(`${where}: args must be an array of strings`);
				return undefined;
			}
		}
		if (raw.async !== undefined && typeof raw.async !== "boolean") warnings.push(`${where}: async must be true or false`);
		// Nothing outlives the session, so a background SessionEnd hook would be
		// killed as it started; it runs inside the shutdown budget instead.
		if (raw.async === true && event === "SessionEnd") warnings.push(`${where}: async is ignored on SessionEnd — it runs inside the shutdown budget`);
		const async = raw.async === true && event !== "SessionEnd";
		const unset = [raw.command, ...(args ?? [])].join(" ").match(/CLAUDE_(PLUGIN_ROOT|PLUGIN_DATA|ENV_FILE)/g);
		if (unset) warnings.push(`${where}: ${[...new Set(unset)].join(", ")} is not set in pi`);
		return {
			type,
			command: raw.command,
			args,
			async,
			timeout,
			statusMessage,
			source: path,
			key: JSON.stringify([type, raw.command, args, async, timeout]),
		};
	}

	if (type === "http") {
		if (typeof raw.url !== "string" || !/^https?:\/\//i.test(raw.url)) {
			warnings.push(`${where}: an http hook needs an http(s) "url"`);
			return undefined;
		}
		const headers: Record<string, string> = {};
		if (raw.headers !== undefined) {
			if (!isObject(raw.headers) || !Object.values(raw.headers).every((value) => typeof value === "string")) {
				warnings.push(`${where}: headers must be an object of strings`);
				return undefined;
			}
			Object.assign(headers, raw.headers);
		}
		let allowedEnvVars: string[] = [];
		if (raw.allowedEnvVars !== undefined) {
			if (Array.isArray(raw.allowedEnvVars) && raw.allowedEnvVars.every((name) => typeof name === "string")) {
				allowedEnvVars = raw.allowedEnvVars as string[];
			} else warnings.push(`${where}: allowedEnvVars must be an array of names — no variables will be interpolated`);
		}
		return {
			type,
			url: raw.url,
			headers,
			allowedEnvVars,
			timeout,
			statusMessage,
			source: path,
			key: JSON.stringify([type, raw.url, headers, allowedEnvVars, timeout]),
		};
	}

	if (typeof raw.prompt !== "string" || raw.prompt.trim().length === 0) {
		warnings.push(`${where}: a prompt hook needs a "prompt" string`);
		return undefined;
	}
	if (raw.model !== undefined && (typeof raw.model !== "string" || raw.model.trim().length === 0)) {
		warnings.push(`${where}: model must be a non-empty string — using the session model`);
	}
	const model = typeof raw.model === "string" && raw.model.trim().length > 0 ? raw.model.trim() : undefined;
	if (raw.continueOnBlock !== undefined && typeof raw.continueOnBlock !== "boolean") {
		warnings.push(`${where}: continueOnBlock must be true or false`);
	}
	const continueOnBlock = raw.continueOnBlock === true;
	return {
		type: "prompt",
		prompt: raw.prompt,
		model,
		continueOnBlock,
		timeout,
		statusMessage,
		source: path,
		key: JSON.stringify(["prompt", raw.prompt, model, continueOnBlock, timeout]),
	};
}

function readJson(path: string, warnings: string[]): Record<string, unknown> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (isObject(parsed)) return parsed;
		warnings.push(`${path}: must hold a JSON object`);
	} catch (error) {
		warnings.push(`Ignoring ${path}: ${error instanceof Error ? error.message : String(error)}`);
	}
	return undefined;
}

export function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The handlers one firing runs: every group whose matcher accepts `value`, in
 * file order, with duplicates removed by `key`.
 */
export function select(groups: readonly Group[] | undefined, value: string): Handler[] {
	if (!groups) return [];
	const seen = new Set<string>();
	const picked: Handler[] = [];
	for (const group of groups) {
		if (!matches(group.matcher, value)) continue;
		for (const handler of group.handlers) {
			if (seen.has(handler.key)) continue;
			seen.add(handler.key);
			picked.push(handler);
		}
	}
	return picked;
}
