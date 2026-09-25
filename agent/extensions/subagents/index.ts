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
 * for its own, which win on a shared name. Write them by hand, or create one
 * in chat: the subagent-creator skill (skills/subagent-creator/SKILL.md, next
 * to this file, and handed to pi through resources_discover so it travels
 * with the extension) asks for every value the request leaves out, shows the
 * file, and writes it on a yes.
 * `/subagents add [what you want]` starts that same skill, so there is one
 * way to create a subagent. `/subagents edit | remove` walk through pi's
 * dialogs (manage.ts) for user agents only: a project's agents belong to its
 * repository and are edited there.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type SubagentDef, TOOL_NAME } from "./config.ts";
import { pickName, runWizard, type WizardCtx } from "./manage.ts";
import { formatReasoning, type PanelRow, tableLines } from "./panel.ts";
import { resolveSuffixedReference } from "./models.ts";
import { deleteSubagent, effective, findAgent, type LoadResult, loadSubagents, userAgentsDir, writeSubagent } from "./registry.ts";
import { registerTaskTool } from "./tool.ts";

/** The skill that creates a subagent, as pi lists it among its slash commands. */
const CREATOR_SKILL = "skill:subagent-creator";

/** Where that skill's file is: it ships inside this extension. */
export const CREATOR_SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), "skills", "subagent-creator", "SKILL.md");

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

	// The creator skill ships with this extension, not in agent/skills/ (those
	// are links into a folder shared with other agents, and not in this repo).
	pi.on("resources_discover", () => ({ skillPaths: [CREATOR_SKILL_PATH] }));

	pi.registerCommand("subagents", {
		description: "Show or configure subagents (/subagents add [what you want] | list | edit | remove)",
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

			// Creating is a conversation: the skill asks for what the request
			// leaves out instead of guessing it, so add hands the words to it.
			// A command reaches the agent as a user message; expandPromptTemplates
			// makes pi expand "/skill:…" as if it were typed (scheduler/index.ts
			// has the probe that confirmed the option reaches prompt()).
			if (sub === "add") {
				const skill = pi.getCommands?.().some((command) => command.name === CREATOR_SKILL);
				if (skill === false) {
					ctx.ui.notify(`The subagent-creator skill is not loaded (${CREATOR_SKILL_PATH}). Write agent/agents/<name>.md by hand, or check /skills.`, "error");
					return;
				}
				const send = pi.sendUserMessage as (text: string, options: { deliverAs: "followUp"; expandPromptTemplates: true }) => void;
				send(`/${CREATOR_SKILL}${arg ? ` ${arg}` : ""}`, { deliverAs: "followUp", expandPromptTemplates: true });
				return;
			}

			// Edit and remove need the TUI dialogs.
			if (!ctx.hasUI) {
				ctx.ui.notify("Configuring subagents needs the interactive TUI.", "error");
				return;
			}
			const wctx = ctx as unknown as WizardCtx;

			if (sub === "edit") {
				reload(ctx);
				const current = await pickUserAgent(ctx, "edit", arg);
				if (!current) return;
				const def = await runWizard(wctx, current);
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
