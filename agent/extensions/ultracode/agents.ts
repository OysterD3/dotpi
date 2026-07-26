/**
 * Resolving `agent({ agentType })` against the standing subagent definitions.
 *
 * Claude Code's Workflow tool can point an agent at a registered subagent type
 * instead of describing the role inline. pi already keeps that registry — the
 * `subagents` extension's agent/subagents.json — so a workflow can reach for
 * "code-explorer" and get its model, reasoning level, tool allowlist, and role
 * prompt without restating any of it.
 *
 * Read with a local parser rather than by importing the subagents extension:
 * every extension here has to stay independently installable, and a missing or
 * malformed registry must degrade to "no agent types" rather than fail a run.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface AgentTypeDef {
	name: string;
	model?: string;
	thinking?: string;
	tools?: string[];
	prompt?: string;
	purpose?: string;
}

export interface AgentTypeRegistry {
	types: Map<string, AgentTypeDef>;
	defaults: { model?: string; thinking?: string };
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asLevel(value: unknown): string | undefined {
	const level = asString(value)?.toLowerCase();
	return level && THINKING_LEVELS.has(level) ? level : undefined;
}

function asTools(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) return undefined;
	const tools = value.filter((tool): tool is string => typeof tool === "string").map((tool) => tool.trim()).filter(Boolean);
	return tools.length > 0 ? tools : undefined;
}

/** Parse a `{ defaults, agents }` block. Bad entries are dropped, not fatal. */
export function parseAgentTypes(raw: unknown): AgentTypeRegistry {
	const registry: AgentTypeRegistry = { types: new Map(), defaults: {} };
	if (!raw || typeof raw !== "object") return registry;
	const block = raw as Record<string, unknown>;

	const defaults = (block.defaults ?? {}) as Record<string, unknown>;
	registry.defaults = { model: asString(defaults.model), thinking: asLevel(defaults.reasoning) };

	const agents = Array.isArray(block.agents) ? block.agents : [];
	for (const entry of agents) {
		if (!entry || typeof entry !== "object") continue;
		const record = entry as Record<string, unknown>;
		const name = asString(record.name);
		if (!name) continue;
		registry.types.set(name, {
			name,
			model: asString(record.model),
			// The registry calls it `reasoning`; pi's flag is --thinking.
			thinking: asLevel(record.reasoning),
			tools: asTools(record.tools),
			prompt: asString(record.prompt),
			purpose: asString(record.purpose),
		});
	}
	return registry;
}

/** subagents.json first, then the settings.json `subagents` block. */
export function loadAgentTypes(agentDir: string): AgentTypeRegistry {
	try {
		return parseAgentTypes(JSON.parse(readFileSync(join(agentDir, "subagents.json"), "utf8")));
	} catch {
		/* fall through to settings.json */
	}
	try {
		const settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return parseAgentTypes(settings.subagents);
	} catch {
		return { types: new Map(), defaults: {} };
	}
}

/** The names a workflow may pass as agentType, for the tool description. */
export function agentTypeSummary(registry: AgentTypeRegistry): string {
	if (registry.types.size === 0) return "";
	return [...registry.types.values()].map((type) => (type.purpose ? `${type.name} (${type.purpose})` : type.name)).join(", ");
}
