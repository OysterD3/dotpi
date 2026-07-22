/**
 * The decision engine. Pure, so the whole policy is testable as a table.
 *
 * Order of evaluation:
 *
 *   1. deny rules                     — always win, nothing overrides them
 *   2. destructive check              — when the mode asks for it (see below)
 *   3. ask rules
 *   4. allow rules
 *   5. the mode's default
 *
 * Claude Code evaluates deny, then ask, then allow. Step 2 is inserted ahead of
 * allow deliberately, and it is the one place this departs from Claude Code.
 * The reason is a trap Claude Code documents in its own guidance: prefix rules
 * are string matches with no flag analysis, so `Bash(git *)` also permits
 * `git push --force` and `git reset --hard`. Someone who allowlists `git` to
 * stop being nagged about `git status` has not agreed to silent history
 * rewrites. Set `destructiveOverridesAllow: false` for strict Claude Code order.
 */

import { findDestructive, type Finding } from "./destructive.ts";
import { firstMatch, type Rule } from "./rules.ts";
import type { PermissionSettings } from "./settings.ts";
import { MUTATING_TOOLS } from "./tools.ts";

export type Behavior = "allow" | "ask" | "deny";

export type Decision = {
	behavior: Behavior;
	/** One line explaining why, shown to the user and to the model when blocked. */
	reason: string;
	/** The rule responsible, when a rule was. */
	rule?: string;
	/** Destructive findings, when that is what triggered the prompt. */
	findings?: Finding[];
};

export type CompiledPolicy = {
	allow: Rule[];
	ask: Rule[];
	deny: Rule[];
	settings: PermissionSettings;
	allowDestructive: ReadonlySet<string>;
};

export type Call = {
	tool: string;
	input: Record<string, unknown>;
	cwd: string;
};

export function decide(policy: CompiledPolicy, call: Call): Decision {
	const { tool, input, cwd } = call;

	const denied = firstMatch(policy.deny, tool, input, cwd);
	if (denied) {
		return { behavior: "deny", reason: `blocked by deny rule ${denied.source}`, rule: denied.source };
	}

	const mode = policy.settings.defaultMode;
	const command = tool === "bash" && typeof input.command === "string" ? input.command : undefined;

	const findings =
		mode === "askDestructive" && command !== undefined
			? findDestructive(command, policy.allowDestructive)
			: [];

	if (findings.length > 0 && policy.settings.destructiveOverridesAllow) {
		return { behavior: "ask", reason: describe(findings), findings };
	}

	const asked = firstMatch(policy.ask, tool, input, cwd);
	if (asked) {
		return { behavior: "ask", reason: `matched ask rule ${asked.source}`, rule: asked.source };
	}

	const allowed = firstMatch(policy.allow, tool, input, cwd);
	if (allowed) {
		return { behavior: "allow", reason: `allowed by rule ${allowed.source}`, rule: allowed.source };
	}

	if (findings.length > 0) {
		return { behavior: "ask", reason: describe(findings), findings };
	}

	switch (mode) {
		case "allowAll":
		case "askDestructive":
			return { behavior: "allow", reason: "no rule matched" };
		case "askMutating":
			return MUTATING_TOOLS.has(tool)
				? { behavior: "ask", reason: `${tool} can modify files` }
				: { behavior: "allow", reason: "read-only tool" };
		case "askAll":
			return { behavior: "ask", reason: "askAll mode" };
		case "denyAll":
			return { behavior: "deny", reason: "denyAll mode: no allow rule matched" };
	}
}

/** "deletes files recursively; force-pushes, overwriting published history" */
export function describe(findings: Finding[]): string {
	const reasons = [...new Set(findings.map((finding) => finding.reason))];
	return reasons.join("; ");
}
