/**
 * Resolving `agent({ agentType })` against the standing subagent definitions.
 *
 * A workflow can point an agent at a defined subagent instead of describing
 * the role inline. pi already keeps those definitions, as the `subagents`
 * extension's Markdown files, so a workflow can reach for "code-explorer" and
 * get its model, reasoning level, tool allowlist, and role prompt without
 * restating any of it:
 *
 *   ~/.pi/agent/agents/<name>.md    user agents, always
 *   <nearest>/.pi/agents/<name>.md  project agents, only in a trusted session
 *                                   AND with a saved trust decision for the
 *                                   folder holding .pi/agents (see
 *                                   projectTrusted); they replace a user agent
 *                                   of the same name
 *
 * Each file is YAML frontmatter (`name`, `description`, and optionally
 * `model`, `reasoning`, `tools` as a comma list or a YAML list) with the role
 * prompt as the body.
 *
 * Read with a local parser rather than by importing the subagents extension:
 * every extension here has to stay independently installable, so the file
 * format is a contract shared by shape, and this copy must agree with
 * subagents/registry.ts. A missing or malformed file degrades to "no such
 * agent type" rather than failing a run; the subagents extension is the one
 * that reports why.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter, ProjectTrustStore } from "@earendil-works/pi-coding-agent";

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
}

const AGENTS_DIR = "agents";
const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function asString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function asLevel(value: unknown): string | undefined {
	const level = asString(value)?.toLowerCase();
	return level && THINKING_LEVELS.has(level) ? level : undefined;
}

/**
 * One agent file's content to a definition, or undefined when it is not a
 * usable one. A `tools` value that is present but names nothing skips the
 * agent: treating it as absent would mean pi's default tools, bash, edit and
 * write among them, and a read-only role would come back able to edit.
 */
export function parseAgentTypeFile(content: string): AgentTypeDef | undefined {
	// pi strips a BOM itself only from 0.85; doing it here keeps older pi agreeing.
	const text = content.replace(/^\uFEFF/, "");
	if (!text.startsWith("---")) return undefined;
	let frontmatter: unknown;
	let body: string;
	try {
		({ frontmatter, body } = parseFrontmatter<Record<string, unknown>>(text));
	} catch {
		return undefined;
	}
	if (!frontmatter || typeof frontmatter !== "object" || Array.isArray(frontmatter)) return undefined;
	const record = frontmatter as Record<string, unknown>;
	const name = asString(record.name);
	const purpose = asString(record.description);
	if (!name || !purpose) return undefined;

	let tools: string[] | undefined;
	if (record.tools !== undefined) {
		const value = record.tools;
		const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) && value.every((tool) => typeof tool === "string") ? (value as string[]) : undefined;
		tools = raw?.map((tool) => tool.trim()).filter(Boolean) ?? [];
		if (tools.length === 0) return undefined;
	}

	return {
		name,
		model: asString(record.model),
		// The file calls it `reasoning`; pi's flag is --thinking.
		thinking: asLevel(record.reasoning),
		tools,
		prompt: body.trim() || undefined,
		purpose,
	};
}

function readDir(dir: string): AgentTypeDef[] {
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	const types: AgentTypeDef[] = [];
	for (const file of files) {
		try {
			const path = join(dir, file);
			if (!statSync(path).isFile()) continue;
			const type = parseAgentTypeFile(readFileSync(path, "utf8"));
			// First file wins on a duplicate name, as in subagents/registry.ts.
			if (type && !types.some((known) => known.name === type.name)) types.push(type);
		} catch {
			/* unreadable: not an agent type */
		}
	}
	return types;
}

function findProjectAgentsDir(cwd: string): string | undefined {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, CONFIG_DIR_NAME, AGENTS_DIR);
		try {
			if (statSync(candidate).isDirectory()) return candidate;
		} catch {
			/* not here; keep walking up */
		}
		const parent = dirname(dir);
		if (parent === dir) return undefined;
		dir = parent;
	}
}

/**
 * Whether a project's agent files may load. The session's trust is not enough:
 * pi reports a session trusted without asking when the project's `.pi/` holds
 * nothing pi itself gates (`agents/` is not on its list), and it checks only
 * the cwd while the agents folder is found by walking up. The folder holding
 * `.pi/agents` also needs a saved "trust" decision, for it or a parent, in
 * pi's own trust store (`/trust`) — something a repository cannot produce.
 * The same rule as subagents/registry.ts projectAgentsRefusal().
 */
function projectTrusted(agentDir: string, projectDir: string, sessionTrusted: boolean): boolean {
	if (!sessionTrusted) return false;
	try {
		return new ProjectTrustStore(agentDir).get(dirname(dirname(projectDir))) === true;
	} catch {
		return false;
	}
}

/** User agent files, then a trusted project's, which replace same-named ones. */
export function loadAgentTypes(agentDir: string, cwd: string, trusted: boolean): AgentTypeRegistry {
	const types = new Map<string, AgentTypeDef>();
	for (const type of readDir(join(agentDir, AGENTS_DIR))) types.set(type.name, type);
	const projectDir = findProjectAgentsDir(cwd);
	if (projectDir && projectTrusted(agentDir, projectDir, trusted)) {
		for (const type of readDir(projectDir)) types.set(type.name, type);
	}
	return { types };
}

/** The names a workflow may pass as agentType, for the tool description. */
export function agentTypeSummary(registry: AgentTypeRegistry): string {
	if (registry.types.size === 0) return "";
	return [...registry.types.values()].map((type) => (type.purpose ? `${type.name} (${type.purpose})` : type.name)).join(", ");
}
