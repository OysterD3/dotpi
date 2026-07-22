/**
 * Permission rule parsing and matching — Claude Code's `settings.json` syntax.
 *
 *   Bash(git status)      exact command
 *   Bash(git log *)       prefix; the space enforces a word boundary
 *   Bash(git log:*)       the legacy spelling of the same thing
 *   Read(src/**)          path glob
 *   Write(**\/*.env)      path glob
 *   Bash                  the whole tool, any input
 *
 * Rules taken verbatim from Claude Code's own validator: tool names start with a
 * capital, `:*` may only appear at the end, `:*` is Bash-only, and the prefix
 * before `:*` may not be empty.
 *
 * Pure: no filesystem, no pi APIs.
 */

import { matchCommandPattern, matchGlob } from "./glob.ts";
import { PATH_TOOLS, resolveToolName } from "./tools.ts";

export type Rule = {
	/** pi's tool name, lower-case (e.g. "bash"). */
	tool: string;
	/** Text inside the parentheses, or undefined for a whole-tool rule. */
	content?: string;
	/** The rule exactly as written, for error messages and audit output. */
	source: string;
};

export type ParseResult = { rule: Rule } | { error: string };

const RULE_SHAPE = /^([A-Za-z_][A-Za-z0-9_]*)(?:\((.*)\))?$/s;

export function parseRule(raw: string): ParseResult {
	const text = raw.trim();
	if (text.length === 0) return { error: "Rule is empty" };

	const match = RULE_SHAPE.exec(text);
	if (!match) return { error: `Rule "${raw}" is not of the form Tool or Tool(pattern)` };

	const [, name, content] = match;

	// Claude Code requires this, and it usefully catches `bash(...)` typos that
	// would otherwise silently never match.
	if (name[0] !== name[0].toUpperCase()) {
		return { error: `Tool names must start with uppercase — did you mean "${name[0].toUpperCase()}${name.slice(1)}"?` };
	}

	const tool = resolveToolName(name);
	if (!tool) return { error: `Rule "${raw}" matches no known tool — check for typos` };

	if (content !== undefined) {
		if (content.includes(":*")) {
			if (tool !== "bash") {
				return { error: `The ":*" syntax is only for Bash prefix rules — use glob patterns like "*" or "**" for file matching` };
			}
			if (!content.endsWith(":*")) return { error: `The ":*" pattern must be at the end of "${raw}"` };
			if (content === ":*") return { error: `Specify a command prefix before ":*"` };
		}
	}

	return { rule: { tool, content, source: text } };
}

/** Parse a list, separating usable rules from ones to report. */
export function parseRules(raws: string[]): { rules: Rule[]; errors: string[] } {
	const rules: Rule[] = [];
	const errors: string[] = [];

	for (const raw of raws) {
		const result = parseRule(raw);
		if ("error" in result) errors.push(result.error);
		else rules.push(result.rule);
	}

	return { rules, errors };
}

/** The part of a tool call a rule is matched against. */
export function ruleTarget(tool: string, input: Record<string, unknown>): string | undefined {
	if (tool === "bash") return typeof input.command === "string" ? input.command : undefined;
	if (PATH_TOOLS.has(tool)) return typeof input.path === "string" ? input.path : undefined;
	return undefined;
}

function matchBash(pattern: string, command: string): boolean {
	const normalized = command.trim();

	// `git log:*` is the legacy spelling of `git log *`.
	const expanded = pattern.endsWith(":*") ? `${pattern.slice(0, -2)} *` : pattern;

	// A trailing " *" means "this command, with or without arguments", so the
	// bare command must match too: `git log *` covers plain `git log`.
	if (expanded.endsWith(" *")) {
		const prefix = expanded.slice(0, -2);
		if (normalized === prefix) return true;
	}

	return matchCommandPattern(expanded, normalized);
}

/**
 * Does this rule match this call?
 *
 * A rule with no content matches every use of the tool. A rule with content only
 * matches when the call actually exposes a target — a bash rule can never match
 * a read, and vice versa.
 */
export function matchRule(rule: Rule, tool: string, input: Record<string, unknown>, cwd: string): boolean {
	if (rule.tool !== tool) return false;
	if (rule.content === undefined) return true;

	const target = ruleTarget(tool, input);
	if (target === undefined) return false;

	if (tool === "bash") return matchBash(rule.content, target);

	return matchPath(rule.content, target, cwd);
}

/**
 * Match a path rule.
 *
 * Both the absolute path and the path relative to cwd are tried, so `Read(src/**)`
 * works the way a user expects without them having to know which form the model
 * happened to pass. A relative pattern is also anchored at cwd so that
 * `Write(.env)` cannot be dodged by passing an absolute path to the same file.
 */
export function matchPath(pattern: string, path: string, cwd: string): boolean {
	const normalized = pattern.replace(/^\.\//, "");
	const candidates = new Set<string>([path]);

	if (path.startsWith(`${cwd}/`)) candidates.add(path.slice(cwd.length + 1));
	if (!path.startsWith("/")) candidates.add(`${cwd}/${path}`);

	const patterns = new Set<string>([normalized]);
	if (!normalized.startsWith("/") && !normalized.startsWith("**")) {
		patterns.add(`${cwd}/${normalized}`);
	}

	for (const candidate of candidates) {
		for (const candidatePattern of patterns) {
			if (matchGlob(candidatePattern, candidate)) return true;
		}
	}

	return false;
}

/** First matching rule, or undefined. */
export function firstMatch(
	rules: Rule[],
	tool: string,
	input: Record<string, unknown>,
	cwd: string,
): Rule | undefined {
	return rules.find((rule) => matchRule(rule, tool, input, cwd));
}
