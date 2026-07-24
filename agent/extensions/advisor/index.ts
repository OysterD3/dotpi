/**
 * advisor — Claude Code's Advisor Tool, ported to pi.
 *
 * The advisor lets the main agent pause and consult a stronger reviewer model
 * on the whole session so far, at the moments that matter (before committing to
 * an approach, when stuck, before declaring done). In Claude Code this is a
 * server-side beta tool (`advisor_20260301`) that the API forwards to the
 * configured model; pi has no such server tool, so tool.ts does the forwarding
 * in the client — it flattens the session branch and runs the reviewer as a
 * tool-less headless pi call (spawn.ts).
 *
 * The reviewer model is configurable and required — that is the whole feature.
 * With no model set the tool is not offered, mirroring Claude Code, where the
 * advisor tool is only attached when `advisorModel` is configured (Lyo()). It
 * can be set three ways, in priority order:
 *   1. `/advisor <model>`      a session override (also `/advisor off` / `on`)
 *   2. `--advisor <model>`     a CLI flag for one run (Claude Code: --advisor)
 *   3. `advisor.model` setting the durable default in agent/settings.json
 *
 * Validation follows Claude Code as far as it ports (see models.ts): the one
 * provider-agnostic hard rule — an advisor cannot be the very model it advises
 * (Claude Code's Czg) — is enforced at call time; the "at least as capable"
 * rank check reduces to allow because pi's registry carries no advisor_rank.
 *
 * Settings (agent settings.json):
 *   advisor.model    string, a pi model reference for the reviewer (required to
 *                    enable the tool). Claude Code: advisorModel.
 *   advisor.enabled  boolean, default true. Kill switch; Claude Code:
 *                    CLAUDE_CODE_DISABLE_ADVISOR_TOOL / the rY() gate.
 *
 * The reviewer-side prompt is authored, not transcribed: Claude Code runs the
 * reviewer server-side so its instructions do not ship in the client. See
 * guidance.ts (REVIEWER_PROMPT). The main-agent guidance IS verbatim.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AdvisorSettings, DEFAULT_SETTINGS, SETTINGS_KEY, TOOL_NAME } from "./config.ts";
import { modelRef, resolveModelReference, sameModel } from "./models.ts";
import { registerAdvisorTool } from "./tool.ts";

export function loadSettings(agentDir: string): AdvisorSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			model: typeof block?.model === "string" && block.model.trim() ? block.model.trim() : undefined,
			enabled: typeof block?.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);
	// Session-scoped overrides from /advisor. `sessionOff` forces the feature
	// off for the session even when a model is configured (/advisor off).
	let sessionModel: string | undefined;
	let sessionOff = false;

	pi.registerFlag("advisor", {
		description: "Reviewer model for the advisor tool (e.g. --advisor opus)",
		type: "string",
	});

	/** The reference in effect right now, or undefined when the advisor is off. */
	const effectiveReference = (): string | undefined => {
		if (!settings.enabled) return undefined;
		if (sessionOff) return undefined;
		return sessionModel ?? settings.model;
	};

	registerAdvisorTool(pi, { reference: effectiveReference });

	/**
	 * Keep the `advisor` tool active exactly when a reference is set AND resolves
	 * to a real model. An unresolvable or absent reference deactivates it, so the
	 * guidance never sits in the prompt for a tool that cannot run. Returns the
	 * resolved model id when active, for the status chip and messages.
	 */
	const syncActive = (ctx: ExtensionContext): string | undefined => {
		const reference = effectiveReference();
		let activeId: string | undefined;
		if (reference) {
			const resolved = resolveModelReference(reference, ctx.modelRegistry.getAll());
			if (resolved.ok) activeId = resolved.model.id;
		}
		const active = pi.getActiveTools();
		const has = active.includes(TOOL_NAME);
		if (activeId && !has) pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
		else if (!activeId && has) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		if (ctx.hasUI) ctx.ui.setStatus("advisor", activeId ? `✦ advisor: ${activeId}` : undefined);
		return activeId;
	};

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		// A --advisor flag seeds the session override for this run.
		const flag = pi.getFlag("advisor");
		if (typeof flag === "string" && flag.trim()) sessionModel = flag.trim();

		const reference = effectiveReference();
		const activeId = syncActive(ctx);
		// A configured-but-unavailable model is worth one clear word: otherwise the
		// advisor silently never appears and the user assumes it is broken.
		if (reference && !activeId && ctx.hasUI) {
			ctx.ui.notify(`Advisor model "${reference}" is not available — advisor is off. Set advisor.model to a valid model.`, "warn");
		}
	});

	const describeStatus = (ctx: ExtensionContext): string => {
		if (!settings.enabled) return "Advisor is disabled (advisor.enabled is false in settings).";
		const reference = effectiveReference();
		if (!reference) return "Advisor is off. Set a reviewer model with /advisor <model>, or advisor.model in settings.";
		const resolved = resolveModelReference(reference, ctx.modelRegistry.getAll());
		if (!resolved.ok) return `Advisor model "${reference}" is not available: ${resolved.error}.`;
		const source = sessionModel ? "session override" : pi.getFlag("advisor") ? "--advisor flag" : "advisor.model setting";
		const selfNote = sameModel(resolved.model, ctx.model)
			? " — but it equals the current session model, so it cannot advise until you switch the main model"
			: "";
		return `Advisor is on: ${modelRef(resolved.model)} (${source})${selfNote}. Call it before committing to an approach and before declaring done.`;
	};

	pi.registerCommand("advisor", {
		description: "Set or toggle the advisor reviewer model (/advisor <model|off|on|status>)",
		getArgumentCompletions: (prefix: string) =>
			["off", "on", "status"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const arg = args.trim();
			const lower = arg.toLowerCase();

			if (arg === "" || lower === "status") {
				ctx.ui.notify(describeStatus(ctx), "info");
				return;
			}

			if (lower === "off") {
				sessionOff = true;
				syncActive(ctx);
				ctx.ui.notify("Advisor off for this session.", "info");
				return;
			}

			if (lower === "on") {
				sessionOff = false;
				if (!effectiveReference()) {
					ctx.ui.notify("No advisor model configured. Use /advisor <model> to set one.", "warn");
					return;
				}
				const activeId = syncActive(ctx);
				ctx.ui.notify(activeId ? `Advisor on: ${activeId}` : describeStatus(ctx), activeId ? "info" : "warn");
				return;
			}

			// Otherwise the argument is a model reference to set for the session.
			const resolved = resolveModelReference(arg, ctx.modelRegistry.getAll());
			if (!resolved.ok) {
				ctx.ui.notify(`Cannot use "${arg}" as an advisor: ${resolved.error}.`, "error");
				return;
			}
			sessionModel = modelRef(resolved.model);
			sessionOff = false;
			syncActive(ctx);
			if (sameModel(resolved.model, ctx.model)) {
				ctx.ui.notify(
					`Advisor set to ${resolved.model.id}, but that is the current session model — switch the main model for it to advise.`,
					"warn",
				);
				return;
			}
			ctx.ui.notify(`Advisor set to ${resolved.model.id}.`, "info");
		},
	});
}
