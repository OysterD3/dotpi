/**
 * Loading and validating the subagent definitions from settings.json.
 *
 * Parsing is split from file reading so it is testable without a session:
 * parseSubagents() takes already-parsed JSON and returns the clean set plus a
 * list of human-readable issues (a bad entry is dropped, not fatal — one typo
 * should not disable every other subagent). loadSubagents() wraps it with the
 * file read.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	SETTINGS_KEY,
	STORE_FILE,
	type SubagentDef,
	type SubagentDefaults,
	type SubagentsSettings,
	THINKING_LEVELS,
} from "./config.ts";

export interface ParseResult {
	settings: SubagentsSettings;
	/** "store" = agent/subagents.json, "settings" = the settings.json fallback, "none" = neither. */
	source: "store" | "settings" | "none";
	issues: string[];
}

/** Absolute path of the pi-managed store file. */
export function storePath(agentDir: string): string {
	return join(agentDir, STORE_FILE);
}

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function parseReasoning(value: unknown, label: string, issues: string[]): string | undefined {
	const level = asString(value)?.toLowerCase();
	if (level === undefined) return undefined;
	if (!THINKING_LEVELS.has(level)) {
		issues.push(`${label}: reasoning "${value}" is not a thinking level (off, minimal, low, medium, high, xhigh, max) — ignored`);
		return undefined;
	}
	return level;
}

function parseTools(value: unknown, label: string, issues: string[]): string[] | undefined {
	if (value === undefined) return undefined;
	if (!Array.isArray(value) || value.some((tool) => typeof tool !== "string")) {
		issues.push(`${label}: tools must be an array of strings — ignored`);
		return undefined;
	}
	const tools = (value as string[]).map((tool) => tool.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

function parseDefaults(raw: unknown, issues: string[]): SubagentDefaults {
	if (!raw || typeof raw !== "object") return {};
	const block = raw as Record<string, unknown>;
	return {
		model: asString(block.model),
		reasoning: parseReasoning(block.reasoning, "defaults", issues),
	};
}

export interface Parsed {
	settings: SubagentsSettings;
	issues: string[];
}

export function parseSubagents(raw: unknown): Parsed {
	const issues: string[] = [];
	if (!raw || typeof raw !== "object") return { settings: { ...DEFAULT_SETTINGS }, issues };
	const block = raw as Record<string, unknown>;

	const defaults = parseDefaults(block.defaults, issues);

	const rawAgents = Array.isArray(block.agents) ? block.agents : [];
	if (block.agents !== undefined && !Array.isArray(block.agents)) {
		issues.push("subagents.agents must be an array — ignored");
	}

	const agents: SubagentDef[] = [];
	const seen = new Set<string>();
	for (let i = 0; i < rawAgents.length; i++) {
		const entry = rawAgents[i];
		const label = `agent #${i + 1}`;
		if (!entry || typeof entry !== "object") {
			issues.push(`${label}: not an object — dropped`);
			continue;
		}
		const record = entry as Record<string, unknown>;
		const name = asString(record.name);
		const purpose = asString(record.purpose);
		if (!name) {
			issues.push(`${label}: missing name — dropped`);
			continue;
		}
		if (!purpose) {
			issues.push(`"${name}": missing purpose — dropped`);
			continue;
		}
		if (seen.has(name)) {
			issues.push(`"${name}": duplicate name — later one dropped`);
			continue;
		}
		seen.add(name);
		agents.push({
			name,
			purpose,
			model: asString(record.model),
			reasoning: parseReasoning(record.reasoning, `"${name}"`, issues),
			tools: parseTools(record.tools, `"${name}"`, issues),
			prompt: asString(record.prompt),
		});
	}

	return { settings: { defaults, agents }, issues };
}

/**
 * Load the subagents, file first. The pi-managed agent/subagents.json wins; if
 * it is absent the settings.json `subagents` block is read as a fallback (so
 * manually-authored config and anything that predates the store still work). A
 * present-but-malformed store is reported, not silently bypassed.
 */
export function loadSubagents(agentDir: string): ParseResult {
	const path = storePath(agentDir);
	if (existsSync(path)) {
		try {
			const raw = JSON.parse(readFileSync(path, "utf8"));
			const parsed = parseSubagents(raw);
			return { ...parsed, source: "store" };
		} catch {
			return { settings: { ...DEFAULT_SETTINGS }, source: "store", issues: [`${STORE_FILE} is not valid JSON — fix it or remove it`] };
		}
	}
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		if (raw?.[SETTINGS_KEY] !== undefined) {
			const parsed = parseSubagents(raw[SETTINGS_KEY]);
			return { ...parsed, source: "settings" };
		}
	} catch {
		/* no readable settings.json — treat as no config */
	}
	return { settings: { ...DEFAULT_SETTINGS }, source: "none", issues: [] };
}

/** Serialize a subagent, omitting empty optional fields for a clean store file. */
function cleanAgent(agent: SubagentDef): Record<string, unknown> {
	const out: Record<string, unknown> = { name: agent.name };
	if (agent.model) out.model = agent.model;
	if (agent.reasoning) out.reasoning = agent.reasoning;
	out.purpose = agent.purpose;
	if (agent.tools && agent.tools.length > 0) out.tools = agent.tools;
	if (agent.prompt) out.prompt = agent.prompt;
	return out;
}

/** Write the block to agent/subagents.json (pretty, trailing newline, git-friendly). */
export function saveSubagents(agentDir: string, settings: SubagentsSettings): void {
	const out: Record<string, unknown> = {};
	if (settings.defaults.model || settings.defaults.reasoning) {
		const defaults: Record<string, unknown> = {};
		if (settings.defaults.model) defaults.model = settings.defaults.model;
		if (settings.defaults.reasoning) defaults.reasoning = settings.defaults.reasoning;
		out.defaults = defaults;
	}
	out.agents = settings.agents.map(cleanAgent);
	writeFileSync(storePath(agentDir), `${JSON.stringify(out, null, 2)}\n`);
}

/** The model/reasoning a subagent will actually run with, applying defaults. */
export function effective(agent: SubagentDef, defaults: SubagentDefaults): { model?: string; reasoning?: string } {
	return {
		model: agent.model ?? defaults.model,
		reasoning: agent.reasoning ?? defaults.reasoning,
	};
}

export function findAgent(settings: SubagentsSettings, name: string): SubagentDef | undefined {
	return settings.agents.find((agent) => agent.name === name);
}
