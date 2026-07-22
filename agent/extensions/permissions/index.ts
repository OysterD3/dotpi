/**
 * Tool permissions for pi, in Claude Code's `settings.json` shape.
 *
 * pi ships nothing like this. Its security documentation is explicit: "Pi does
 * not include a built-in sandbox. Built-in tools can read files, write files,
 * edit files, and run shell commands with the permissions of the pi process."
 * The only gate available to an extension is the `tool_call` event, which can
 * block a call before it runs — that is what this uses.
 *
 * Rules use Claude Code's syntax so a settings file can be carried across:
 *
 *   { "permissions": {
 *       "defaultMode": "askDestructive",
 *       "deny":  ["Read(**\/.env)", "Bash(curl * | sh)"],
 *       "ask":   ["Bash(git push *)"],
 *       "allow": ["Bash(git status)", "Bash(pnpm test *)"]
 *   } }
 *
 * The default mode is `askDestructive`: everything runs without a prompt except
 * commands that destroy work, publish, or escalate privilege. Those are matched
 * by a readable table in destructive.ts — deterministic, so it is fast, works
 * offline, costs nothing, and can be audited by reading it.
 *
 *   config.ts       modes and their ordering
 *   settings.ts     loading and layering the JSON files
 *   rules.ts        Claude Code rule syntax: parsing and matching
 *   glob.ts         path and command pattern matching
 *   destructive.ts  what counts as destructive, and why
 *   decide.ts       precedence: deny > destructive > ask > allow > mode
 *
 * Scope limit worth knowing: this gates tool calls pi routes through extensions.
 * It is a guardrail against an agent doing something you did not intend, not a
 * sandbox — it cannot contain code that is already running.
 */

import { getAgentDir, type ExtensionAPI, type ToolCallEvent } from "@earendil-works/pi-coding-agent";
import { CONFIG, MODE_HELP, MODE_ORDER } from "./config.ts";
import { decide, type CompiledPolicy, type Decision } from "./decide.ts";
import { findDestructive, PATTERNS } from "./destructive.ts";
import { type Grant, SessionGrants } from "./grants.ts";
import { parseRules, ruleTarget } from "./rules.ts";
import { loadSettings, projectSettingsPath, userSettingsPath } from "./settings.ts";

function compile(agentDir: string, cwd: string, trusted: boolean): { policy: CompiledPolicy; report: string[] } {
	const { settings, sources, warnings } = loadSettings(agentDir, cwd, trusted);

	const allow = parseRules(settings.allow);
	const ask = parseRules(settings.ask);
	const deny = parseRules(settings.deny);

	const known = new Set(PATTERNS.map((pattern) => pattern.id));
	known.add("dynamic-argument");
	const unknownIds = settings.allowDestructive.filter((id) => !known.has(id));

	return {
		policy: {
			allow: allow.rules,
			ask: ask.rules,
			deny: deny.rules,
			settings,
			allowDestructive: new Set(settings.allowDestructive),
		},
		report: [
			...warnings,
			...allow.errors.map((error) => `allow: ${error}`),
			...ask.errors.map((error) => `ask: ${error}`),
			...deny.errors.map((error) => `deny: ${error}`),
			...unknownIds.map((id) => `allowDestructive: unknown pattern id "${id}"`),
			...sources.map((source) => `loaded ${source}`),
		],
	};
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let policy: CompiledPolicy | undefined;
	let report: string[] = [];

	/** Approvals granted for the rest of the session. */
	const grants = new SessionGrants();

	const rebuild = (cwd: string, trusted: boolean) => {
		const built = compile(agentDir, cwd, trusted);
		policy = built.policy;
		report = built.report;
	};

	pi.on("session_start", (_event, ctx) => {
		rebuild(ctx.cwd, ctx.isProjectTrusted());
		const problems = report.filter((line) => !line.startsWith("loaded "));
		if (problems.length > 0) ctx.ui.notify(`Permissions:\n${problems.join("\n")}`, "warning");
	});

	pi.on("tool_call", async (event: ToolCallEvent, ctx) => {
		if (!policy) return undefined;

		const input = event.input as Record<string, unknown>;
		const call = { tool: event.toolName, input, cwd: ctx.cwd };
		const decision = decide(policy, call);

		if (decision.behavior === "allow") return undefined;

		if (decision.behavior === "deny") {
			ctx.ui.notify(`Blocked ${event.toolName}: ${decision.reason}`, "error");
			return { block: true, reason: `Permission denied — ${decision.reason}` };
		}

		const target = ruleTarget(event.toolName, input) ?? "";
		const findings = decision.findings ?? [];
		const grantContext = { tool: event.toolName, target, findings, rule: decision.rule };

		// Checked only after deny: a grant can lift an ask, never a hard block.
		if (grants.covers(grantContext)) return undefined;

		if (!ctx.hasUI) {
			if (policy.settings.askWithoutUi === "allow") return undefined;
			return {
				block: true,
				reason: `Permission required — ${decision.reason} — and there is no interactive session to approve it`,
			};
		}

		const options = buildOptions(event.toolName, target, decision);
		const choice = await ctx.ui.select(promptTitle(event.toolName, target, decision), options.map((o) => o.label));
		const picked = options.find((option) => option.label === choice);

		// Escape and an explicit Block both mean no. Failing closed is the only
		// safe reading of "the user did not say yes".
		if (!picked || picked.grant === "block") {
			return { block: true, reason: `Permission denied by user — ${decision.reason}` };
		}

		if (picked.grant === "once") return undefined;

		if (picked.grant === "pattern") grants.addPatternGrants(findings);
		else grants.add(picked.grant);

		return undefined;
	});

	pi.registerCommand("permissions", {
		description: "Show or test tool permission rules ([test <command>] | reload | patterns | grants | forget)",

		getArgumentCompletions: (prefix) =>
			["test ", "reload", "patterns", "grants", "forget"]
				.filter((option) => option.startsWith(prefix))
				.map((value) => ({ value, label: value.trim() })),

		handler: async (args, ctx) => {
			const text = args.trim();

			if (text === "grants") {
				const listed = grants.describe();
				ctx.ui.notify(
					listed.length === 0
						? "No session approvals. Every prompt is still being asked."
						: `Approved for this session (${listed.length}):\n${listed.map((line) => `  • ${line}`).join("\n")}\n\n/permissions forget revokes them.`,
					"info",
				);
				return;
			}

			if (text === "forget") {
				const count = grants.clear();
				ctx.ui.notify(
					count === 0 ? "There were no session approvals to revoke." : `Revoked ${count} session approval(s). You will be asked again.`,
					"info",
				);
				return;
			}

			if (text === "reload") {
				rebuild(ctx.cwd, ctx.isProjectTrusted());
				ctx.ui.notify(`Permissions reloaded.\n${report.join("\n") || "no settings files found"}`, "info");
				return;
			}

			if (text === "patterns") {
				const lines = PATTERNS.map((pattern) => `  ${pattern.id.padEnd(24)} ${pattern.reason}`);
				ctx.ui.notify(`Destructive patterns (${PATTERNS.length}):\n${lines.join("\n")}`, "info");
				return;
			}

			if (text.startsWith("test ")) {
				if (!policy) return;
				const command = text.slice(5).trim();
				const decision = decide(policy, { tool: "bash", input: { command }, cwd: ctx.cwd });
				const findings = findDestructive(command, policy.allowDestructive);
				const detail = findings.length
					? findings.map((finding) => `  - ${finding.id}: ${finding.reason}\n      ${finding.segment}`).join("\n")
					: "  (no destructive patterns matched)";
				ctx.ui.notify(
					`${command}\n\n=> ${decision.behavior.toUpperCase()} — ${decision.reason}\n${detail}`,
					decision.behavior === "allow" ? "info" : "warning",
				);
				return;
			}

			if (!policy) return;
			const { settings } = policy;
			ctx.ui.notify(
				[
					`Mode: ${settings.defaultMode} — ${MODE_HELP[settings.defaultMode]}`,
					`Rules: ${policy.deny.length} deny, ${policy.ask.length} ask, ${policy.allow.length} allow`,
					`Destructive overrides allow: ${settings.destructiveOverridesAllow}`,
					`Without a UI, "ask" becomes: ${settings.askWithoutUi}`,
					`Session approvals held: ${grants.size()} (/permissions grants to list, forget to revoke)`,
					"",
					`User file:    ${userSettingsPath(agentDir)}`,
					`Project file: ${projectSettingsPath(ctx.cwd)}`,
					"",
					`Modes: ${MODE_ORDER.join(" < ")}`,
					...report.map((line) => `  ${line}`),
				].join("\n"),
				"info",
			);
		},
	});
}

type PromptOption = { label: string; grant: Grant | "once" | "block" | "pattern" };

/**
 * The choices offered for one prompt.
 *
 * The grains are deliberately different sizes. "This exact command" is the safe
 * default for a one-off. The pattern grain is the one that actually saves you
 * during real work: when you are deleting twenty build directories, being asked
 * about each distinct path is the same nag with extra steps — what you want to
 * say is "yes, recursive deletes are fine right now".
 *
 * Only offered when it can be described precisely, so the user always knows the
 * exact scope of what they are approving.
 */
export function buildOptions(tool: string, target: string, decision: Decision): PromptOption[] {
	const options: PromptOption[] = [{ label: "Allow once", grant: "once" }];

	if (target.length > 0) {
		options.push({
			label: `Allow this exact command for the rest of this session`,
			grant: { kind: "exact", tool, target },
		});
	}

	const findings = decision.findings ?? [];
	if (findings.length > 0) {
		const reasons = [...new Set(findings.map((finding) => finding.reason))];
		const described =
			reasons.length === 1
				? `anything that ${reasons[0]}`
				: `anything that ${reasons.slice(0, 2).join(" or ")}${reasons.length > 2 ? ` (+${reasons.length - 2} more)` : ""}`;
		options.push({ label: `Allow ${described} for the rest of this session`, grant: "pattern" });
	} else if (decision.rule !== undefined) {
		options.push({
			label: `Allow anything matching ${decision.rule} for the rest of this session`,
			grant: { kind: "rule", rule: decision.rule },
		});
	}

	options.push({
		label: `Allow every ${tool} call for the rest of this session`,
		grant: { kind: "tool", tool },
	});

	options.push({ label: "Block", grant: "block" });
	return options;
}

function promptTitle(tool: string, target: string, decision: Decision): string {
	const shown = target.length > CONFIG.promptCommandChars
		? `${target.slice(0, CONFIG.promptCommandChars)}…`
		: target;

	const reasons = decision.findings
		? [...new Set(decision.findings.map((finding) => finding.reason))]
		: [decision.reason];

	const listed = reasons.slice(0, CONFIG.maxReasonsShown).map((reason) => `  • ${reason}`);
	if (reasons.length > listed.length) listed.push(`  • …and ${reasons.length - listed.length} more`);

	return `Approve ${tool}?\n\n  ${shown}\n\n${listed.join("\n")}`;
}
