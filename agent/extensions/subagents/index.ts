/**
 * subagents — configurable named subagents, ported from Claude Code.
 *
 * You define a set of subagents in agent/settings.json, each with a model, a
 * reasoning (thinking) level, a purpose, and optionally a tool allowlist and a
 * role prompt. The main agent delegates to one by name through the `task` tool
 * (Claude Code's `subagent_type`), which runs it as a headless pi subprocess
 * (spawn.ts) with those settings and returns its report. `/subagents` shows the
 * table — Subagent | Model | Reasoning | Purpose.
 *
 * The `task` tool is offered only when at least one subagent is configured
 * (active-tool sync, like the advisor extension), so an empty config adds
 * nothing to the prompt.
 *
 * Settings (agent settings.json):
 *   subagents.defaults  { model?, reasoning? } applied to agents that omit them
 *   subagents.agents    [ { name, purpose, model?, reasoning?, tools?, prompt? } ]
 *
 * Example:
 *   {
 *     "subagents": {
 *       "defaults": { "model": "gpt-5.6-luna", "reasoning": "high" },
 *       "agents": [
 *         { "name": "code-explorer", "reasoning": "high", "tools": ["read","grep","find","ls"],
 *           "purpose": "Read-only codebase discovery and investigation" },
 *         { "name": "code-reviewer", "model": "gpt-5.6-sol", "reasoning": "low",
 *           "purpose": "Review diffs for correctness, security, and quality" }
 *       ]
 *     }
 *   }
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SubagentsSettings, TOOL_NAME } from "./config.ts";
import { formatReasoning, type PanelRow, tableLines } from "./panel.ts";
import { modelRef, resolveModelReference } from "./models.ts";
import { effective, loadSubagents } from "./registry.ts";
import { registerTaskTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let loaded = loadSubagents(agentDir);
	let settings: SubagentsSettings = loaded.settings;

	// Registered once; execute always reads the live `settings`. The description
	// lists the subagents known at load — edit settings.json then /reload to
	// refresh the listing (dispatch itself always uses the current set).
	registerTaskTool(pi, { settings: () => settings });

	const syncActive = (ctx: ExtensionContext): void => {
		const configured = settings.agents.length > 0;
		const active = pi.getActiveTools();
		const has = active.includes(TOOL_NAME);
		if (configured && !has) pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
		else if (!configured && has) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		if (ctx.hasUI) ctx.ui.setStatus("subagents", configured ? `✦ subagents: ${settings.agents.length}` : undefined);
	};

	/** Resolve each subagent's effective model/reasoning to display strings. */
	const buildRows = (ctx: ExtensionContext): PanelRow[] => {
		const models = ctx.modelRegistry.getAll();
		return settings.agents.map((agent) => {
			const eff = effective(agent, settings.defaults);
			let model: string;
			if (eff.model) {
				const resolved = resolveModelReference(eff.model, models);
				model = resolved.ok ? resolved.model.id : `⚠ ${eff.model}`;
			} else {
				model = "(session default)";
			}
			return { name: agent.name, model, reasoning: formatReasoning(eff.reasoning), purpose: agent.purpose };
		});
	};

	pi.on("session_start", (_event, ctx) => {
		loaded = loadSubagents(agentDir);
		settings = loaded.settings;
		syncActive(ctx);
		if (loaded.issues.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`subagents: ${loaded.issues.length} config issue(s). Run /subagents to see them.`, "warn");
		}
	});

	pi.registerCommand("subagents", {
		description: "Show the configured subagents (Subagent | Model | Reasoning | Purpose)",
		handler: async (_args: string, ctx) => {
			loaded = loadSubagents(agentDir);
			settings = loaded.settings;
			syncActive(ctx);
			const lines = tableLines(buildRows(ctx));
			if (loaded.issues.length > 0) {
				lines.push("", "Issues:");
				for (const issue of loaded.issues) lines.push(`  • ${issue}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
