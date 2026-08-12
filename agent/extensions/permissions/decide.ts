/**
 * The decision engine. Pure, so the whole policy is testable as a table.
 *
 * Order of evaluation:
 *
 *   1. deny rules                     — always win, nothing overrides them
 *   1b. hard findings                 — a refusal; no rule, mode or grant lifts it
 *   2. destructive check              — when the mode asks for it (see below)
 *   3. ask rules
 *   4. allow rules
 *   5. the mode's default
 *
 * Step 1b is the only outcome here that cannot be configured. A couple of
 * patterns in destructive.ts are marked `hard`, meaning the exposure they create
 * outlives the command and cannot be undone by whoever approved it — a public
 * tunnel is the case it was added for. Everything else in this file is policy
 * the user sets; that step is a decision taken once, in code, so it is not
 * retaken per command at the moment it is least likely to be weighed carefully.
 * It sits beside the deny rules rather than after the table because it must fire
 * in `allowAll` too, where the rest of the table deliberately does not.
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
 *
 * Step 4 has one member that is not in any settings file: a path tool writing
 * inside the session scratchpad. It sits at the allow step precisely so it
 * inherits that step's bounds — deny rules and the destructive table have both
 * already run — and it is excluded from `denyAll`. See scratch.ts.
 */

import { findDestructive, type Finding } from "./destructive.ts";
import { firstMatch, type Rule } from "./rules.ts";
import { targetsScratchpad } from "./scratch.ts";
import type { PermissionSettings } from "./settings.ts";
import { MUTATING_TOOLS, READ_ONLY_TOOLS } from "./tools.ts";
import { isTrivial } from "./trivial.ts";

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
	/**
	 * Set when the scratchpad exemption is what produced this allow.
	 *
	 * The caller has one more thing to do that this file cannot: confirm against
	 * the filesystem that the path is really inside the scratchpad and not a
	 * symlink out of it (see escapesScratchpad in scratch.ts). A marker rather
	 * than matching on `reason`, which is display text and would be a silent
	 * failure the day someone reworded it.
	 */
	scratch?: true;
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
	/**
	 * This session's scratchpad, as last announced by the scratchpad extension.
	 * Absent when that extension is not installed, which is the only difference
	 * its absence makes: nothing else here consults it.
	 */
	scratchDir?: string;
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
	// The table runs in EVERY mode, including allowAll, because of the hard
	// findings below: a refusal that a mode switch turns off is not one. The
	// soft findings are still filtered out for allowAll immediately after, which
	// keeps that mode's promise — it asks about nothing.
	const all = command !== undefined ? findDestructive(command, policy.allowDestructive) : [];
	const hard = all.filter((finding) => finding.hard === true);
	const findings = mode === "allowAll" ? [] : all;

	// Not a prompt. Ahead of ask, allow and the mode entirely, so there is no
	// rule, no mode and no grant that reaches past it — index.ts consults
	// remembered approvals only after a deny, and builds no options for one.
	if (hard.length > 0) {
		return { behavior: "deny", reason: describe(hard), findings: hard };
	}

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

	// The scratchpad, at the allow step and under the allow step's bounds. Not in
	// `denyAll`: there, an explicit allow rule is the only thing that lets
	// anything run, and an implicit one written in no settings file should not
	// join that list. Everywhere else the directory was created by this session
	// for this session, outside the project, and the model was told in its system
	// prompt to put scratch files there — so a prompt here is one the user would
	// approve every time, which is the kind that teaches them to stop reading.
	//
	// Below the findings re-check rather than above it, though the two cannot
	// interact — findings exist only for bash, which is not a path tool. Ordering
	// it this way means "it is bounded by everything an allow rule is bounded by"
	// can be read off the file instead of proved.
	if (mode !== "denyAll" && targetsScratchpad(call)) {
		return { behavior: "allow", reason: "inside this session's scratchpad", scratch: true };
	}

	switch (mode) {
		case "allowAll":
		case "askDestructive":
			return { behavior: "allow", reason: "no rule matched" };
		case "auto":
			// Kept inline rather than imported from auto.ts, which would drag the AI
			// SDK into this file and into the corpus test that exercises it. This
			// file stays pure; auto.ts does the calling.
			//
			// Both skips are the same cost decision under the same knob: things an
			// agent does hundreds of times a turn, where a model call per occurrence
			// makes the mode unusable — and, for the trivial-command table, where a
			// conservative cheap classifier turned `printf` into a prompt. Both are
			// reached only by calls that deny, the destructive table, and ask rules
			// have already let past.
			if (policy.settings.auto.skipReadOnly) {
				if (READ_ONLY_TOOLS.has(tool)) return { behavior: "allow", reason: "read-only tool" };
				if (command !== undefined && isTrivial(command)) return { behavior: "allow", reason: "trivially safe command" };
			}
			return { behavior: "classify", reason: "no rule matched — asking the classifier" };
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
