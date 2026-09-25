/**
 * Finding, parsing and writing the subagent definition files.
 *
 * One agent per Markdown file, `<name>.md`:
 *
 *   ---
 *   name: code-reviewer
 *   description: Review diffs for correctness, security, and quality
 *   model: openai-codex/gpt-6-astra  (optional: a model reference; absent = the session model)
 *   reasoning: low                   (optional: a pi thinking level)
 *   tools: read, grep, find          (optional: a comma list or a YAML list; absent = pi's default tools)
 *   ---
 *
 *   Optional role prompt. The body becomes the subagent's system-prompt preamble.
 *
 * `name` and `description` are required, the same keys pi's example subagent
 * extension and Claude Code read, so a file moves between them; `reasoning`
 * is this extension's own. A Markdown file with no frontmatter at all (a
 * README beside the agents) is not an agent and is passed over silently.
 *
 * Two places are scanned:
 *   - agent/agents/*.md: user agents, always;
 *   - the nearest `.pi/agents/` at or above the cwd: project agents, only when
 *     the project is trusted (projectAgentsRefusal() says what that takes),
 *     because a repo's agent file is a prompt the repo wrote and the subagent
 *     runs it with bash. A project agent replaces a user agent of the same name.
 *
 * A bad file or field is reported, not fatal: one typo should not disable
 * every other agent, and the reason shows under /subagents. A malformed
 * `tools` skips the whole agent rather than dropping the field, because a
 * dropped allowlist means pi's default tools, bash, edit and write among them,
 * and a read-only reviewer would come back able to edit.
 *
 * parseSubagentFile() and serializeSubagent() are pure; the rest wraps them
 * with file access.
 */

import { mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { CONFIG_DIR_NAME, parseFrontmatter, ProjectTrustStore } from "@earendil-works/pi-coding-agent";
import { AGENTS_DIR, type LoadedSubagent, type SubagentDef, THINKING_LEVELS } from "./config.ts";

export interface LoadResult {
	/** What `task` can run: user agents, with project agents replacing same-named ones. */
	agents: LoadedSubagent[];
	/** User agents alone, shadowed ones included: the only ones /subagents edits. */
	user: LoadedSubagent[];
	/** The project agents directory that was found, trusted or not. */
	projectDir?: string;
	issues: string[];
}

/** Absolute path of the user agents directory. */
export function userAgentsDir(agentDir: string): string {
	return join(agentDir, AGENTS_DIR);
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

/** Absent means pi's default tools. Anything present has to name at least one. */
function parseTools(value: unknown): string[] | undefined | "invalid" {
	if (value === undefined) return undefined;
	const raw = typeof value === "string" ? value.split(",") : Array.isArray(value) && value.every((tool) => typeof tool === "string") ? (value as string[]) : undefined;
	const tools = raw?.map((tool) => tool.trim()).filter(Boolean) ?? [];
	return tools.length > 0 ? tools : "invalid";
}

/** One agent file's content to a definition, plus anything wrong with it. */
export function parseSubagentFile(content: string, label: string): { def?: SubagentDef; issues: string[] } {
	// pi strips a BOM itself only from 0.85; doing it here keeps older pi agreeing.
	const text = content.replace(/^\uFEFF/, "");
	if (!text.startsWith("---")) return { issues: [] };

	let frontmatter: Record<string, unknown>;
	let body: string;
	try {
		const parsed = parseFrontmatter<Record<string, unknown>>(text);
		const fm = parsed.frontmatter as unknown;
		frontmatter = fm && typeof fm === "object" && !Array.isArray(fm) ? (fm as Record<string, unknown>) : {};
		body = parsed.body;
	} catch (error) {
		const reason = error instanceof Error ? error.message.split("\n")[0] : String(error);
		return { issues: [`${label}: frontmatter is not valid YAML (${reason}) — skipped`] };
	}

	const name = asString(frontmatter.name);
	if (!name) return { issues: [`${label}: missing name — skipped`] };
	const purpose = asString(frontmatter.description);
	if (!purpose) return { issues: [`${label}: missing description — skipped`] };
	const tools = parseTools(frontmatter.tools);
	if (tools === "invalid") {
		return { issues: [`${label}: tools must name at least one tool, as a comma list or a YAML list — skipped, since ignoring it would grant pi's default tools`] };
	}

	const issues: string[] = [];
	const def: SubagentDef = {
		name,
		purpose,
		model: asString(frontmatter.model),
		reasoning: parseReasoning(frontmatter.reasoning, label, issues),
		tools,
		prompt: body.trim() || undefined,
	};
	return { def, issues };
}

function loadDir(dir: string, source: LoadedSubagent["source"], issues: string[]): LoadedSubagent[] {
	let files: string[];
	try {
		files = readdirSync(dir)
			.filter((file) => file.endsWith(".md"))
			.sort();
	} catch {
		return [];
	}
	const agents: LoadedSubagent[] = [];
	for (const file of files) {
		const filePath = join(dir, file);
		let content: string;
		try {
			// statSync follows a symlink, so a linked-in agent file counts.
			if (!statSync(filePath).isFile()) continue;
			content = readFileSync(filePath, "utf8");
		} catch {
			continue;
		}
		const parsed = parseSubagentFile(content, filePath);
		issues.push(...parsed.issues);
		if (!parsed.def) continue;
		if (agents.some((agent) => agent.name === parsed.def!.name)) {
			issues.push(`${filePath}: duplicate name "${parsed.def.name}" — skipped`);
			continue;
		}
		agents.push({ ...parsed.def, source, filePath });
	}
	return agents;
}

/** The nearest `.pi/agents/` directory at or above `cwd`, if there is one. */
export function findProjectAgentsDir(cwd: string): string | undefined {
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
 * Why a project's agent files may not load, or undefined when they may.
 *
 * The session's trust is not enough on its own. pi reports a session trusted
 * without asking when the project's `.pi/` holds nothing pi itself gates, and
 * `agents/` is not on its list; it also checks only the cwd, while the agents
 * folder is found by walking up. So a cloned repo holding just `.pi/agents/`,
 * or a parent folder the user once refused, would pass. What a repo cannot
 * produce is a decision the user saved: the folder that holds `.pi/agents`
 * needs a "trust" entry in pi's own trust store, for it or a parent (`/trust`).
 */
export function projectAgentsRefusal(agentDir: string, projectDir: string, sessionTrusted: boolean): string | undefined {
	if (!sessionTrusted) return "this project is not trusted";
	const root = dirname(dirname(projectDir));
	let decision: boolean | null;
	try {
		decision = new ProjectTrustStore(agentDir).get(root);
	} catch (error) {
		return `pi's trust store could not be read (${error instanceof Error ? error.message : String(error)})`;
	}
	if (decision === true) return undefined;
	if (decision === false) return `${root} is saved as not trusted`;
	return `${root} has no saved trust decision; run /trust there to allow them`;
}

/**
 * Every agent `task` can run from `cwd`. Read from disk on each call, so a
 * file added or edited mid-session is picked up without a restart.
 * `trusted` is the session's trust (ctx.isProjectTrusted()).
 */
export function loadSubagents(agentDir: string, cwd: string, trusted: boolean): LoadResult {
	const issues: string[] = [];
	const user = loadDir(userAgentsDir(agentDir), "user", issues);
	const byName = new Map(user.map((agent) => [agent.name, agent]));
	const projectDir = findProjectAgentsDir(cwd);
	if (projectDir) {
		const refusal = projectAgentsRefusal(agentDir, projectDir, trusted);
		if (refusal) issues.push(`${projectDir}: project agents skipped — ${refusal}`);
		else for (const agent of loadDir(projectDir, "project", issues)) byName.set(agent.name, agent);
	}
	return { agents: [...byName.values()], user, projectDir, issues };
}

/**
 * A YAML scalar for one frontmatter value: plain when it cannot be misread,
 * JSON-quoted otherwise. A JSON string is a valid YAML double-quoted scalar, so
 * a description holding ": ", "#" or a leading quote still round-trips, and a
 * value that plain YAML would turn into a boolean, null or number stays a
 * string.
 */
function scalar(value: string): string {
	const plain = /^[A-Za-z0-9][\w .,()/+-]*$/.test(value) && !/^(true|false|null|yes|no|on|off|y|n)$/i.test(value) && Number.isNaN(Number(value));
	return plain ? value : JSON.stringify(value);
}

/** A definition as the Markdown file /subagents writes. */
export function serializeSubagent(def: SubagentDef): string {
	const lines = ["---", `name: ${scalar(def.name)}`, `description: ${scalar(def.purpose)}`];
	if (def.model) lines.push(`model: ${scalar(def.model)}`);
	if (def.reasoning) lines.push(`reasoning: ${scalar(def.reasoning)}`);
	if (def.tools && def.tools.length > 0) lines.push(`tools: ${scalar(def.tools.join(", "))}`);
	lines.push("---");
	return `${lines.join("\n")}\n${def.prompt ? `\n${def.prompt}\n` : ""}`;
}

export function writeSubagent(filePath: string, def: SubagentDef): void {
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, serializeSubagent(def));
}

export function deleteSubagent(filePath: string): void {
	rmSync(filePath, { force: true });
}

/**
 * The model/reasoning a subagent will actually run with. `carried` is the
 * `:level` the model reference resolved with (models.ts), known only after
 * resolution, which is why callers apply it in a second pass. The per-agent
 * pin stays strongest because it names this exact subagent.
 */
export function effective(agent: SubagentDef, carried?: string): { model?: string; reasoning?: string } {
	return { model: agent.model, reasoning: agent.reasoning ?? carried };
}

export function findAgent<T extends SubagentDef>(agents: readonly T[], name: string): T | undefined {
	return agents.find((agent) => agent.name === name);
}
