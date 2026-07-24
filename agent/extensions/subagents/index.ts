/**
 * subagents — configurable named subagents, ported from Claude Code.
 *
 * You define a set of subagents, each with a model, a reasoning (thinking)
 * level, a purpose, and optionally a tool allowlist and a role prompt. The main
 * agent delegates a scoped task to one by name through the `task` tool (Claude
 * Code's `subagent_type`), which runs it as a headless pi subprocess (spawn.ts)
 * with those settings and returns its report. `/subagents` shows the table —
 * Subagent | Model | Reasoning | Purpose.
 *
 * Configuration lives inside pi: `/subagents add | edit | remove` walks through
 * pi's dialogs (manage.ts) and writes agent/subagents.json (registry.ts) — you
 * never hand-edit JSON. That file takes precedence over a settings.json
 * `subagents` block, which is kept only as a read fallback for manual/legacy
 * config; the first interactive edit migrates such a block into the store.
 *
 * The `task` tool is offered only when at least one subagent is configured
 * (active-tool sync, like the advisor extension), so an empty config adds
 * nothing to the prompt.
 *
 * Store file (agent/subagents.json), shape { defaults?, agents }:
 *   defaults  { model?, reasoning? } applied to agents that omit them
 *   agents    [ { name, purpose, model?, reasoning?, tools?, prompt? } ]
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SubagentsSettings, TOOL_NAME } from "./config.ts";
import { pickName, runWizard, type WizardCtx } from "./manage.ts";
import { formatReasoning, type PanelRow, tableLines } from "./panel.ts";
import { modelRef, resolveModelReference } from "./models.ts";
import { effective, findAgent, loadSubagents, type ParseResult, saveSubagents, storePath } from "./registry.ts";
import { registerTaskTool } from "./tool.ts";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let loaded: ParseResult = loadSubagents(agentDir);
	let settings: SubagentsSettings = loaded.settings;

	const registerTool = () => registerTaskTool(pi, { settings: () => settings });
	registerTool();

	const syncActive = (ctx: ExtensionContext): void => {
		const configured = settings.agents.length > 0;
		const active = pi.getActiveTools();
		const has = active.includes(TOOL_NAME);
		if (configured && !has) pi.setActiveTools([...new Set([...active, TOOL_NAME])]);
		else if (!configured && has) pi.setActiveTools(active.filter((name) => name !== TOOL_NAME));
		if (ctx.hasUI) ctx.ui.setStatus("subagents", configured ? `✦ subagents: ${settings.agents.length}` : undefined);
	};

	/** Reload from disk, refresh the tool's listing, and re-sync activation. */
	const reload = (ctx: ExtensionContext): void => {
		loaded = loadSubagents(agentDir);
		settings = loaded.settings;
		registerTool();
		syncActive(ctx);
	};

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

	const showTable = (ctx: ExtensionContext): void => {
		reload(ctx);
		const lines = tableLines(buildRows(ctx));
		lines.push("", "Configure: /subagents add · edit · remove");
		if (loaded.issues.length > 0) {
			lines.push("", "Issues:");
			for (const issue of loaded.issues) lines.push(`  • ${issue}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};

	/** Persist a new agent set to the store, then reload and show it. */
	const persist = (ctx: ExtensionContext, next: SubagentsSettings, done: string): void => {
		const migrating = loaded.source === "settings";
		saveSubagents(agentDir, next);
		reload(ctx);
		ctx.ui.notify(`${done}. Saved to ${storePath(agentDir)}${migrating ? " (migrated from settings.json)" : ""}.`, "info");
		showTable(ctx);
	};

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		if (loaded.issues.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`subagents: ${loaded.issues.length} config issue(s). Run /subagents to see them.`, "warning");
		}
	});

	pi.registerCommand("subagents", {
		description: "Show or configure subagents (/subagents [list|add|edit|remove])",
		getArgumentCompletions: (prefix: string) => {
			const names = settings.agents.map((agent) => agent.name);
			const options = [
				"list",
				"add",
				"edit",
				"remove",
				...names.map((name) => `edit ${name}`),
				...names.map((name) => `remove ${name}`),
			];
			return options.filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value }));
		},
		handler: async (args: string, ctx) => {
			const trimmed = args.trim();
			const [verb, ...rest] = trimmed.split(/\s+/);
			const sub = (verb ?? "").toLowerCase();
			const arg = rest.join(" ").trim() || undefined;

			if (sub === "" || sub === "list") return void showTable(ctx);

			// Interactive flows need the TUI dialogs.
			if (!ctx.hasUI) {
				ctx.ui.notify("Configuring subagents needs the interactive TUI.", "error");
				return;
			}
			const wctx = ctx as unknown as WizardCtx;

			if (sub === "add") {
				reload(ctx);
				const def = await runWizard(wctx, undefined, new Set(settings.agents.map((agent) => agent.name)));
				if (!def) return void ctx.ui.notify("Cancelled.", "info");
				persist(ctx, { ...settings, agents: [...settings.agents, def] }, `Added "${def.name}"`);
				return;
			}

			if (sub === "edit") {
				reload(ctx);
				const name = await pickName(wctx, settings.agents.map((agent) => agent.name), "edit", arg);
				if (!name) return;
				const def = await runWizard(wctx, findAgent(settings, name), new Set());
				if (!def) return void ctx.ui.notify("Cancelled.", "info");
				persist(ctx, { ...settings, agents: settings.agents.map((agent) => (agent.name === name ? def : agent)) }, `Updated "${name}"`);
				return;
			}

			if (sub === "remove") {
				reload(ctx);
				const name = await pickName(wctx, settings.agents.map((agent) => agent.name), "remove", arg);
				if (!name) return;
				const ok = await ctx.ui.confirm(`Remove "${name}"?`, "This deletes the subagent definition.");
				if (!ok) return void ctx.ui.notify("Cancelled.", "info");
				persist(ctx, { ...settings, agents: settings.agents.filter((agent) => agent.name !== name) }, `Removed "${name}"`);
				return;
			}

			ctx.ui.notify(`Unknown: ${verb}. Usage: /subagents [list | add | edit | remove].`, "error");
		},
	});
}
