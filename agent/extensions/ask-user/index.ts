/**
 * ask-user — Claude Code's AskUserQuestion tool, ported to pi.
 *
 * Gives the main agent an `ask_user` tool to pause and put a decision back to
 * the human: a question with 2-4 suggested options, a free-text "Other" answer,
 * an optional note on any answer ("yes with notes"), and a decline path
 * ("decline with note"). Claude Code renders a bespoke component where you press
 * a key to add a note; pi has no such component, so the flow is composed from
 * pi's own dialogs and the note is a follow-up prompt (see interaction.ts).
 *
 * The tool is offered only in an interactive session (it needs a real user) and
 * only while enabled — active-tool sync, like the advisor/subagents extensions —
 * so a headless run or a disabled setting adds nothing to the prompt.
 *
 * Settings (agent settings.json, key "askUser"):
 *   askUser.enabled     boolean, default true. Kill switch.
 *   askUser.allowNotes  boolean, default true. Offer the optional note step.
 *
 * Session control: `/ask-user [status | on | off | test]`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AskUserSettings, DEFAULT_SETTINGS, SETTINGS_KEY, TOOL_NAME } from "./config.ts";
import { type AskRequest, renderOutcomeText, runAsk } from "./interaction.ts";
import { registerAskUserTool } from "./tool.ts";

export function loadSettings(agentDir: string): AskUserSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			enabled: typeof block?.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
			allowNotes: typeof block?.allowNotes === "boolean" ? block.allowNotes : DEFAULT_SETTINGS.allowNotes,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	let settings = loadSettings(agentDir);
	// Session-scoped off switch from `/ask-user off`, independent of the setting.
	let sessionOff = false;

	registerAskUserTool(pi, { settings: () => settings });

	/** Offer the tool exactly when enabled, not turned off for the session, and a real user is present. */
	const syncActive = (ctx: ExtensionContext): boolean => {
		const active = settings.enabled && !sessionOff && ctx.hasUI;
		const tools = pi.getActiveTools();
		const has = tools.includes(TOOL_NAME);
		if (active && !has) pi.setActiveTools([...new Set([...tools, TOOL_NAME])]);
		else if (!active && has) pi.setActiveTools(tools.filter((name) => name !== TOOL_NAME));
		// No status chip: whether ask_user is available is not worth a permanent
		// footer slot. Clear any chip a prior version left behind.
		if (ctx.hasUI) ctx.ui.setStatus("ask-user", undefined);
		return active;
	};

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		syncActive(ctx);
	});

	const describeStatus = (ctx: ExtensionContext): string => {
		if (!settings.enabled) return "ask_user is disabled (askUser.enabled is false in settings).";
		if (sessionOff) return "ask_user is off for this session (/ask-user on to re-enable).";
		if (!ctx.hasUI) return "ask_user is unavailable: this session has no interactive user.";
		return `ask_user is on. Notes are ${settings.allowNotes ? "offered" : "off"}. The agent can ask you a question when it hits a decision only you can make.`;
	};

	pi.registerCommand("ask-user", {
		description: "Show status or toggle the ask_user tool (/ask-user [status | on | off | test])",
		getArgumentCompletions: (prefix: string) =>
			["status", "on", "off", "test"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const arg = args.trim().toLowerCase();

			if (arg === "off") {
				sessionOff = true;
				syncActive(ctx);
				ctx.ui.notify("ask_user off for this session.", "info");
				return;
			}
			if (arg === "on") {
				sessionOff = false;
				const active = syncActive(ctx);
				ctx.ui.notify(active ? "ask_user on." : describeStatus(ctx), active ? "info" : "warning");
				return;
			}
			if (arg === "test") {
				if (!ctx.hasUI) return void ctx.ui.notify("The test needs the interactive TUI.", "error");
				const request: AskRequest = {
					question: "This is a test of ask_user. How does it look?",
					header: "Test",
					options: [
						{ label: "Looks good", description: "The selector, notes, and decline all work" },
						{ label: "Needs tweaks", description: "Something feels off" },
					],
					multiSelect: false,
					allowNotes: settings.allowNotes,
				};
				const outcome = await runAsk(ctx.ui, request);
				ctx.ui.notify(renderOutcomeText(outcome), "info");
				return;
			}

			// "" or "status" or anything else: report status.
			ctx.ui.notify(describeStatus(ctx), "info");
		},
	});
}
