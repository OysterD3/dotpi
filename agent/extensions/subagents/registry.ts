/**
 * Loading and validating the subagent definitions from settings.json.
 *
 * Parsing is split from file reading so it is testable without a session:
 * parseSubagents() takes already-parsed JSON and returns the clean set plus a
 * list of human-readable issues (a bad entry is dropped, not fatal — one typo
 * should not disable every other subagent). loadSubagents() wraps it with the
 * file read.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	DEFAULT_SETTINGS,
	SETTINGS_KEY,
	type SubagentDef,
	type SubagentDefaults,
	type SubagentsSettings,
	THINKING_LEVELS,
} from "./config.ts";

export interface ParseResult {
	settings: SubagentsSettings;
	issues: string[];
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

export function parseSubagents(raw: unknown): ParseResult {
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

export function loadSubagents(agentDir: string): ParseResult {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return parseSubagents(raw?.[SETTINGS_KEY]);
	} catch {
		return { settings: { ...DEFAULT_SETTINGS }, issues: [] };
	}
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
