/**
 * subagents — named subagents, one Markdown file each, plus one-time agents.
 *
 * You define a set of subagents, each with a model, a reasoning (thinking)
 * level, a purpose, and optionally a tool allowlist and a role prompt. The main
 * agent delegates a scoped task to one by name through the `task` tool, which
 * runs it as a headless pi subprocess (spawn.ts)
 * with those settings and returns its report. Naming none runs a one-time
 * agent on the model, level and tools the call itself gives (tool.ts), so
 * `task` is always offered, files or not. `/subagents` shows the table —
 * Subagent | Model | Reasoning | Purpose.
 *
 * Each subagent is a file, `<name>.md` with YAML frontmatter (registry.ts has
 * the format): agent/agents/ for yours, and a trusted project's `.pi/agents/`
 * for its own, which win on a shared name. Write them by hand, or let
 * `/subagents add | edit | remove` walk through pi's dialogs (manage.ts) and
 * write them for you. The dialogs touch user agents only: a project's agents
 * belong to its repository and are edited there.
 */
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { existsSync } from "node:fs";
import { CONFIG, type SubagentDef, TOOL_NAME } from "./config.ts";
import { buildCatalog, draftSubagent } from "./draft.ts";
import { pickName, runWizard, summary, type WizardCtx } from "./manage.ts";
import { formatReasoning, type PanelRow, tableLines } from "./panel.ts";
import { resolveSuffixedReference } from "./models.ts";
import { deleteSubagent, effective, findAgent, type LoadResult, loadSubagents, userAgentPath, userAgentsDir, writeSubagent } from "./registry.ts";
import { registerTaskTool } from "./tool.ts";

/**
 * pi.events channel for announcing model spend — the shared string contract, so
 * the draft call shows up in /usage instead of being spend nothing can see.
 */
const SPEND_CHANNEL = "usage:spend";

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	// Empty until session_start: project agents need the cwd and the trust
	// decision, and only a ctx carries those.
	let loaded: LoadResult = { agents: [], user: [], issues: [] };

	const load = (ctx: ExtensionContext): LoadResult => loadSubagents(agentDir, ctx.cwd, ctx.isProjectTrusted?.() ?? false);

	const registerTool = () => registerTaskTool(pi, { agents: loaded.agents, load: (ctx) => load(ctx).agents });
	registerTool();

	const syncActive = (ctx: ExtensionContext): void => {
		// Always offered: with no agent files, a one-time agent still works.
		const active = pi.getActiveTools();
		if (!active.includes(TOOL_NAME)) pi.setActiveTools([...active, TOOL_NAME]);
		// No status chip: clear any a prior version left on the bar.
		if (ctx.hasUI) ctx.ui.setStatus("subagents", undefined);
	};

	/** Reload from disk, refresh the tool's listing, and re-sync activation. */
	const reload = (ctx: ExtensionContext): void => {
		loaded = load(ctx);
		registerTool();
		syncActive(ctx);
	};

	const buildRows = (ctx: ExtensionContext): PanelRow[] => {
		const models = ctx.modelRegistry.getAll();
		return loaded.agents.map((agent) => {
			let model: string;
			// The Reasoning column shows what a spawn would use, so a carried
			// `:level` folds in with the same precedence as tool.ts; on a failed
			// resolution no level is knowable and the configured one stands.
			let reasoning = agent.reasoning;
			if (agent.model) {
				// The panel shows the resolved model's own id, so a reference's
				// `:level` suffix never reaches the table; the raw reference appears
				// only when resolution failed and naming what the user configured is
				// the point.
				const resolved = resolveSuffixedReference(agent.model, models);
				model = resolved.ok ? resolved.model.id : `⚠ ${agent.model}`;
				if (resolved.ok) reasoning = effective(agent, resolved.thinking).reasoning;
			} else {
				model = "(session default)";
			}
			const name = agent.source === "project" ? `${agent.name} (project)` : agent.name;
			return { name, model, reasoning: formatReasoning(reasoning), purpose: agent.purpose };
		});
	};

	const showTable = (ctx: ExtensionContext): void => {
		reload(ctx);
		const lines = tableLines(buildRows(ctx));
		const project = loaded.projectDir ? ` · project: ${loaded.projectDir}` : "";
		lines.push("", `Files: ${userAgentsDir(agentDir)}${project}`, "Configure: /subagents add · edit · remove");
		if (loaded.issues.length > 0) {
			lines.push("", "Issues:");
			for (const issue of loaded.issues) lines.push(`  • ${issue}`);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	};

	/** Write one agent file, then reload and show the table. */
	const save = (ctx: ExtensionContext, filePath: string, def: SubagentDef, done: string): void => {
		writeSubagent(filePath, def);
		reload(ctx);
		ctx.ui.notify(`${done}. Saved to ${filePath}.`, "info");
		showTable(ctx);
	};

	/**
	 * The user agent `arg` names for edit/remove, or undefined after saying why
	 * not. A project agent is refused by name rather than as "no such agent":
	 * it exists, it just lives in a repository these dialogs do not write to.
	 */
	const pickUserAgent = async (ctx: ExtensionContext, verb: string, arg: string | undefined) => {
		const project = arg ? loaded.agents.find((agent) => agent.name === arg && agent.source === "project") : undefined;
		if (project && !findAgent(loaded.user, arg!)) {
			ctx.ui.notify(`"${arg}" is a project agent. To ${verb} it, change ${project.filePath} in its repository.`, "info");
			return undefined;
		}
		const name = await pickName(ctx as unknown as WizardCtx, loaded.user.map((agent) => agent.name), verb, arg);
		return name ? findAgent(loaded.user, name) : undefined;
	};

	pi.on("session_start", (_event, ctx) => {
		reload(ctx);
		if (loaded.issues.length > 0 && ctx.hasUI) {
			ctx.ui.notify(`subagents: ${loaded.issues.length} config issue(s). Run /subagents to see them.`, "warning");
		}
	});

	/**
	 * Draft from a description, then one confirm.
	 *
	 * Declining does not throw the draft away: the wizard opens with every
	 * field pre-seeded, so a draft that got one thing wrong costs an edit
	 * rather than a retype. Returns undefined when the user backed out or the
	 * draft failed — the caller has already been told why.
	 */
	const draftFrom = async (ctx: ExtensionContext, description: string, taken: string[]) => {
		ctx.ui.notify(`Drafting a subagent from "${description}"…`, "info");
		const catalog = buildCatalog(ctx.modelRegistry.getAll(), taken);
		const outcome = await draftSubagent(ctx as never, description, catalog, CONFIG.draftTimeoutMs, (spend) =>
			pi.events.emit(SPEND_CHANNEL, { source: "subagents", usage: spend, calls: 1 }),
		);
		if (!outcome.ok) {
			ctx.ui.notify(`Could not draft that: ${outcome.error}. Run /subagents add with no description for the wizard.`, "warning");
			return undefined;
		}
		const detail = [summary(outcome.def), outcome.why ? `\n${outcome.why}` : "", ...outcome.notes.map((note) => `\n⚠ ${note}`)]
			.filter(Boolean)
			.join("");
		if (await ctx.ui.confirm(`Save "${outcome.def.name}"?`, detail)) return outcome.def;
		if (await ctx.ui.confirm("Adjust it instead?", "Opens the wizard with this draft pre-filled.")) {
			return await runWizard(ctx as unknown as WizardCtx, outcome.def, new Set());
		}
		ctx.ui.notify("Cancelled.", "info");
		return undefined;
	};

	pi.registerCommand("subagents", {
		description: "Show or configure subagents (/subagents add <describe it> | list | edit | remove)",
		getArgumentCompletions: (prefix: string) => {
			const names = loaded.user.map((agent) => agent.name);
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
				// Project names too: a user agent under one of them would be
				// shadowed in that repository the moment it was saved.
				const taken = new Set([...loaded.agents, ...loaded.user].map((agent) => agent.name));

				// A description turns the seven-dialog wizard into one confirm. With
				// no description there is nothing to draft from, so the wizard runs.
				let def = arg ? await draftFrom(ctx, arg, [...taken]) : undefined;
				if (arg && !def) return;
				if (!def) def = await runWizard(wctx, undefined, taken);
				if (!def) return void ctx.ui.notify("Cancelled.", "info");
				const filePath = userAgentPath(agentDir, def.name);
				// A file that failed to parse is not in `taken`, and is still not ours to overwrite.
				if (existsSync(filePath)) return void ctx.ui.notify(`${filePath} already exists. Fix or remove that file first.`, "error");
				save(ctx, filePath, def, `Added "${def.name}"`);
				return;
			}

			if (sub === "edit") {
				reload(ctx);
				const current = await pickUserAgent(ctx, "edit", arg);
				if (!current) return;
				const def = await runWizard(wctx, current, new Set());
				if (!def) return void ctx.ui.notify("Cancelled.", "info");
				save(ctx, current.filePath, def, `Updated "${current.name}"`);
				return;
			}

			if (sub === "remove") {
				reload(ctx);
				const current = await pickUserAgent(ctx, "remove", arg);
				if (!current) return;
				const ok = await ctx.ui.confirm(`Remove "${current.name}"?`, `This deletes ${current.filePath}.`);
				if (!ok) return void ctx.ui.notify("Cancelled.", "info");
				deleteSubagent(current.filePath);
				reload(ctx);
				ctx.ui.notify(`Removed "${current.name}".`, "info");
				showTable(ctx);
				return;
			}

			ctx.ui.notify(`Unknown: ${verb}. Usage: /subagents [list | add | edit | remove].`, "error");
		},
	});
}
