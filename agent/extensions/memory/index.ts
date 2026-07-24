/**
 * memory — reads Claude Code's per-project memory and makes it pi's memory.
 *
 * At session start it finds the Claude Code memory directory that matches the
 * project cwd (locate.ts), reads MEMORY.md and the fact files (load.ts), and
 * assembles them within a budget. Each turn, before_agent_start appends that
 * block to the system prompt — so it is cached across the turn rather than
 * resent as a message. `/memory` shows what's loaded and where from.
 *
 * Settings (agent settings.json — per-machine):
 *   memory.enabled       boolean, default true
 *   memory.includeFacts  boolean, default true (full fact bodies, not just the index)
 *   memory.maxChars      number, default 24000 (budget for the injected block)
 *   memory.claudeHome    string, default ~/.claude
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type MemorySettings, SETTINGS_KEY, defaultSettings } from "./config.ts";
import { assemble, type Assembled, readMemory } from "./load.ts";
import { globalClaudeMd, memoryDirFor } from "./locate.ts";

export function loadSettings(agentDir: string): MemorySettings {
	const base = defaultSettings();
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : base.enabled,
			includeFacts: typeof block?.includeFacts === "boolean" ? block.includeFacts : base.includeFacts,
			maxChars: typeof block?.maxChars === "number" && Number.isFinite(block.maxChars) && block.maxChars > 0 ? Math.floor(block.maxChars) : base.maxChars,
			claudeHome: typeof block?.claudeHome === "string" && block.claudeHome.trim() ? block.claudeHome.trim() : base.claudeHome,
		};
	} catch {
		return base;
	}
}

export interface LoadedMemory extends Assembled {
	source?: string;
	globalSource?: string;
}

/** Locate, read, and assemble the memory for a cwd. Returns undefined when off/empty. */
export function loadMemoryFor(cwd: string, settings: MemorySettings): LoadedMemory | undefined {
	if (!settings.enabled) return undefined;
	const dir = memoryDirFor(cwd, settings.claudeHome);
	const globalPath = globalClaudeMd(settings.claudeHome);
	let globalText: string | undefined;
	if (globalPath) {
		try {
			globalText = readFileSync(globalPath, "utf8");
		} catch {
			globalText = undefined;
		}
	}
	const raw = dir ? readMemory(dir) : { facts: [] };
	const hasAnything = Boolean(raw.memoryMd) || raw.facts.length > 0 || Boolean(globalText?.trim());
	if (!hasAnything) return undefined;

	const assembled = assemble({
		memoryMd: raw.memoryMd,
		facts: raw.facts,
		globalClaudeMd: globalText,
		includeFacts: settings.includeFacts,
		maxChars: settings.maxChars,
	});
	return { ...assembled, source: dir, globalSource: globalPath };
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);
	let loaded: LoadedMemory | undefined;

	const refresh = (ctx: ExtensionContext): void => {
		settings = loadSettings(agentDir);
		loaded = loadMemoryFor(ctx.cwd, settings);
		if (ctx.hasUI) {
			ctx.ui.setStatus("memory", loaded ? `✦ memory${loaded.factCount > 0 ? `: ${loaded.factCount}` : ""}` : undefined);
		}
	};

	pi.on("session_start", (_event, ctx) => refresh(ctx));

	pi.on("before_agent_start", (event) => {
		if (!settings.enabled || !loaded?.text) return;
		return { systemPrompt: `${event.systemPrompt}\n\n${loaded.text}` };
	});

	const status = (ctx: ExtensionContext): string => {
		if (!settings.enabled) return "Memory is off (memory.enabled is false).";
		if (!loaded) return `No Claude Code memory found for ${ctx.cwd}. (Looked in ${settings.claudeHome}/projects/…/memory.)`;
		const bits = [`${loaded.factCount} fact${loaded.factCount === 1 ? "" : "s"}`, `${loaded.text.length} chars`];
		if (loaded.hasIndex) bits.push("index");
		if (loaded.globalSource) bits.push("global CLAUDE.md");
		if (loaded.truncated) bits.push("truncated to budget");
		return `Memory loaded (${bits.join(", ")}) from ${loaded.source ?? loaded.globalSource}.`;
	};

	pi.registerCommand("memory", {
		description: "Show the Claude Code memory loaded for this project (/memory [show|reload])",
		getArgumentCompletions: (prefix: string) =>
			["show", "reload", "status"].filter((o) => o.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const arg = args.trim().toLowerCase();
			if (arg === "reload") {
				refresh(ctx);
				ctx.ui.notify(status(ctx), "info");
				return;
			}
			if (arg === "show") {
				refresh(ctx);
				ctx.ui.notify(loaded?.text ?? status(ctx), "info");
				return;
			}
			ctx.ui.notify(status(ctx), "info");
		},
	});
}
