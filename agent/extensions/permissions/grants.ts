/**
 * Approvals remembered for the rest of the session.
 *
 * A grant only ever downgrades an **ask** to an allow. It can never override a
 * deny rule — deny is decided before grants are consulted, so no amount of
 * clicking can talk the agent past a hard block.
 *
 * Grants come in grains because "don't ask me again" means different things:
 *
 *   exact    this command string, and only this one
 *   pattern  everything that trips the same destructive pattern (all recursive
 *            deletes, all force-pushes) — the useful grain when you are mid-task
 *            and about to run twenty variations of the same dangerous thing
 *   rule     everything matching the `ask` rule that stopped this call
 *   tool     the whole tool, no questions for the rest of the session
 *
 * Nothing here is persisted. A new session starts with an empty set, on purpose:
 * a standing approval should be a deliberate edit to settings.json, not
 * something that accumulates invisibly from clicking through prompts.
 */

import type { Finding } from "./destructive.ts";

export type Grant =
	| { kind: "exact"; tool: string; target: string }
	| { kind: "pattern"; patternId: string; reason: string }
	| { kind: "rule"; rule: string }
	| { kind: "tool"; tool: string };

export type GrantContext = {
	tool: string;
	target: string;
	findings: Finding[];
	rule?: string;
};

function key(grant: Grant): string {
	switch (grant.kind) {
		case "exact":
			return `exact:${grant.tool}:${grant.target}`;
		case "pattern":
			return `pattern:${grant.patternId}`;
		case "rule":
			return `rule:${grant.rule}`;
		case "tool":
			return `tool:${grant.tool}`;
	}
}

export class SessionGrants {
	private readonly grants = new Map<string, Grant>();

	add(grant: Grant): void {
		this.grants.set(key(grant), grant);
	}

	/** Add every grant implied by "allow this kind of thing" for a given call. */
	addPatternGrants(findings: Finding[]): void {
		for (const finding of findings) {
			this.add({ kind: "pattern", patternId: finding.id, reason: finding.reason });
		}
	}

	/** Is this call already covered by something the user approved earlier? */
	covers(context: GrantContext): Grant | undefined {
		for (const grant of this.grants.values()) {
			switch (grant.kind) {
				case "tool":
					if (grant.tool === context.tool) return grant;
					break;
				case "exact":
					if (grant.tool === context.tool && grant.target === context.target) return grant;
					break;
				case "rule":
					if (context.rule !== undefined && grant.rule === context.rule) return grant;
					break;
				case "pattern":
					// Only a blanket pass if EVERY reason this was flagged is covered.
					// Otherwise approving "all recursive deletes" would silently also
					// approve the `sudo` in `sudo rm -rf /`.
					if (
						context.findings.length > 0 &&
						context.findings.every((finding) =>
							this.grants.has(`pattern:${finding.id}`),
						)
					) {
						return grant;
					}
					break;
			}
		}
		return undefined;
	}

	size(): number {
		return this.grants.size;
	}

	clear(): number {
		const count = this.grants.size;
		this.grants.clear();
		return count;
	}

	/** Human-readable list for `/permissions`. */
	describe(): string[] {
		return [...this.grants.values()].map((grant) => {
			switch (grant.kind) {
				case "exact":
					return `${grant.tool}: ${grant.target}`;
				case "pattern":
					return `any command that ${grant.reason} [${grant.patternId}]`;
				case "rule":
					return `anything matching ${grant.rule}`;
				case "tool":
					return `every ${grant.tool} call`;
			}
		});
	}
}
