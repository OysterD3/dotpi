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
 * `auto` mode adds a sixth outcome, `classify`, at step 5 and nowhere else. That
 * placement is the whole safety argument for putting a model in a security
 * control: the classifier is reached only by calls that steps 1–4 already
 * cleared, so it can add a prompt and nothing else. It never sees a call a deny
 * rule caught, and it cannot clear one. Note that step 4 short-circuits it — an
 * `allow` rule means no model call and no bill, which is what makes the mode
 * affordable on a repo with a decent allowlist.
 *
 * The conventional order is deny, then ask, then allow. Step 2 is inserted ahead
 * of allow deliberately, and it is the one place this departs from that. The
 * reason is a trap in the conventional order: prefix rules are string matches
 * with no flag analysis, so `Bash(git *)` also permits `git push --force` and
 * `git reset --hard`. Someone who allowlists `git` to stop being nagged about
 * `git status` has not agreed to silent history rewrites. Set
 * `destructiveOverridesAllow: false` for the strict conventional order.
 */

import { findDestructive, type Finding } from "./destructive.ts";
import { firstMatch, type Rule } from "./rules.ts";
import type { PermissionSettings } from "./settings.ts";
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from "./tools.ts";

/**
 * `classify` is not a verdict — it is "the deterministic policy has nothing to
 * say, ask the model". Only `auto` mode produces it, and index.ts is the only
 * caller that can resolve it, because resolving it costs a network round trip
 * and this file is pure.
 */
export type Behavior = "allow" | "ask" | "deny" | "classify";

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

	// The table runs in every mode except `allowAll`, which is the one mode where
	// the user asked not to be prompted at all.
	//
	// It used to run only for `askDestructive` and `auto`, and that was a hole
	// rather than an optimisation. Findings are checked ahead of `allow` rules
	// (see the header); skipping them in `askMutating`/`askAll` meant an allow
	// rule short-circuited first, so `Bash(git *)` silently re-permitted
	// `git push --force` in the two modes a user reaches by trying to be MORE
	// careful. Both Shift+Tab and an untrusted project could walk a session into
	// that state, which made "tightening" a way to loosen.
	//
	// `denyAll` runs it too, for the same reason: its allow rules are the only
	// thing that can let anything through, and a destructive command should not
	// be one of them without a prompt.
	const usesTable = mode !== "allowAll";
	const findings =
		usesTable && command !== undefined ? findDestructive(command, policy.allowDestructive) : [];

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
		case "auto":
			// Kept inline rather than imported from auto.ts, which would drag the AI
			// SDK into this file and into the corpus test that exercises it. This
			// file stays pure; auto.ts does the calling.
			return policy.settings.auto.skipReadOnly && READ_ONLY_TOOLS.has(tool)
				? { behavior: "allow", reason: "read-only tool" }
				: { behavior: "classify", reason: "no rule matched — asking the classifier" };
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
