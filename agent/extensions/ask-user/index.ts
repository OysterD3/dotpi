/**
 * ask-user — a structured question tool for the main agent.
 *
 * Gives the main agent an `ask_user` tool to pause and put decisions back to the
 * human: up to four questions at once, each with 2-4 suggested options plus a
 * free-text row, any answer annotatable with a note, and a review step before
 * anything is sent.
 *
 * This needs a bespoke component with in-component key bindings. pi's
 * select/input/confirm dialogs cannot bind keys inside themselves, so this uses
 * `ctx.ui.custom()`: a focused component (prompt.ts) over a pure state machine
 * (interaction.ts). That is what makes Tab-to-annotate and ← / → possible at
 * all — as dialogs, each would have to become another modal prompt. The
 * component stands in for the editor while it is up, so the question arrives
 * where the answer would have been typed.
 *
 * The tool is offered only in an interactive session (it needs a real user) and
 * only while enabled — active-tool sync, like the advisor/subagents extensions —
 * so a headless run or a disabled setting adds nothing to the prompt.
 *
 * Settings (agent settings.json, key "askUser"):
 *   askUser.enabled     boolean, default true. Kill switch.
 *   askUser.allowNotes  boolean, default true. Whether Tab attaches a note.
 *
 * Session control: `/ask-user [status | on | off | test]`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AskUserSettings, DEFAULT_SETTINGS, SETTINGS_KEY, TOOL_NAME } from "./config.ts";
import { type AskQuestion, AskSession, renderOutcomeText } from "./interaction.ts";
import { showAsk } from "./prompt.ts";
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
		return `ask_user is on. Notes (Tab) are ${settings.allowNotes ? "on" : "off"}. The agent can ask you when it hits a decision only you can make.`;
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
				// Two questions on purpose: the test should exercise ← / → and the
				// review step, not just a single selector. The first carries a
				// recommendation, so the badge and the pre-focused row are visible too.
				const questions: AskQuestion[] = [
					{
						question: "This is a test of ask_user. How does it look?",
						header: "Test",
						options: [
							{
								label: "Looks good",
								description: "Selection, the free-text row, and notes all behave",
								recommended: true,
							},
							{ label: "Needs tweaks", description: "Something feels off — press Tab here and say what" },
						],
						multiSelect: false,
					},
					{
						question: "Which parts did you try?",
						header: "Coverage",
						options: [
							{ label: "Arrow navigation", description: "← / → between questions" },
							{ label: "Tab note", description: "Annotating an answer in place" },
							{ label: "Free-text row", description: "Typing an answer of your own" },
						],
						multiSelect: true,
					},
				];
				const session = new AskSession(questions, settings.allowNotes);
				// Not blocking: the user opened this themselves and the agent is not
				// waiting on it, so the turn clock and the cmux bell stay out of it.
				ctx.ui.notify(renderOutcomeText(await showAsk(pi, ctx, session, false)), "info");
				return;
			}

			// "" or "status" or anything else: report status.
			ctx.ui.notify(describeStatus(ctx), "info");
		},
	});
}
