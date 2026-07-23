/**
 * ultracode — Claude Code's workflow orchestration trigger, ported to pi.
 *
 * Two halves, matching Claude Code 2.1.217:
 *
 *   1. The `workflow` tool (tool.ts + engine.ts + spawn.ts): a script that
 *      orchestrates headless pi subagents with agent()/parallel()/pipeline().
 *   2. The triggers that opt the model into using it:
 *      - the "ultracode" KEYWORD in a typed prompt opts in that single turn
 *        (detector and reminder text verbatim from the binary; the keyword
 *        changes nothing else — no effort bump, prompt not rewritten);
 *      - `/ultracode` turns the mode on for the session: thinking is raised to
 *        xhigh (Claude Code: "xhigh + dynamic workflow orchestration, this
 *        session only") and standing reminders follow Claude Code's cadence —
 *        full on entry, "still on" every 10th user turn, exit notice once when
 *        it goes off. Changing the thinking level away from xhigh exits the
 *        mode, exactly as choosing another effort level does in Claude Code.
 *
 * Reminders are injected as hidden custom messages (display: false) via
 * before_agent_start — pi's own plan-mode pattern — so they reach the model as
 * <system-reminder> blocks without appearing in the transcript UI.
 *
 * Deviations from Claude Code, documented in README.md: no resume/journal for
 * workflow runs, no worktree isolation, no alt+w keyword dismissal, and the
 * keyword is detected on the pre-expansion text of interactive input only.
 *
 * Settings (agent settings.json):
 *   ultracode.keywordTrigger  boolean, default true (Claude Code:
 *                             workflowKeywordTriggerEnabled)
 *   ultracode.model           "provider/model-id" for workflow subagents;
 *                             defaults to the session model
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { DEFAULT_SETTINGS, ENTRY_TYPE, SETTINGS_KEY, type UltracodeSettings } from "./config.ts";
import { hasUltracodeKeyword } from "./keyword.ts";
import { UltracodeMode } from "./mode.ts";
import { KEYWORD_REMINDER, systemReminder } from "./reminders.ts";
import { registerWorkflowTool } from "./tool.ts";

const BADGE = "✦ ultracode";

interface ToggleEntry {
	action: "on" | "off";
	/** Thinking level to restore on /ultracode off; survives session resume. */
	previousLevel?: string;
}

export function loadSettings(agentDir: string): UltracodeSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		return {
			keywordTrigger: typeof block?.keywordTrigger === "boolean" ? block.keywordTrigger : DEFAULT_SETTINGS.keywordTrigger,
			model: typeof block?.model === "string" ? block.model : undefined,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * Rebuild mode state from a resumed branch: toggle entries (type "custom") and
 * delivered reminders, which pi persists as type "custom_message" entries —
 * that is how before_agent_start-injected messages land in the session file.
 * Returns the thinking level to restore on /ultracode off, if the mode is on.
 */
export function restoreFromBranch(
	mode: UltracodeMode,
	branch: Array<Record<string, any>>,
): string | undefined {
	let on = false;
	let announced = false;
	let turns = 0;
	let previousLevel: string | undefined;
	for (const entry of branch) {
		if (entry.type === "custom" && entry.customType === ENTRY_TYPE) {
			const data = entry.data as ToggleEntry | undefined;
			on = data?.action === "on";
			previousLevel = on ? data?.previousLevel : undefined;
		} else if (entry.type === "custom_message" && entry.customType === ENTRY_TYPE) {
			const content = entry.content;
			const text =
				typeof content === "string"
					? content
					: Array.isArray(content)
						? content.map((block: { text?: string }) => block.text ?? "").join("\n")
						: "";
			if (text.includes("Ultracode is off")) announced = false;
			else if (text.includes("Ultracode is")) {
				announced = true;
				turns = 0;
			}
		} else if (entry.type === "message" && entry.message?.role === "user" && on && announced) {
			turns++;
		}
	}
	// A pending exit: the mode is off but the model was told it is on and the
	// exit notice never went out before the session ended.
	mode.restore({ on, announced, turnsSinceReminder: turns, exitPending: announced });
	return on ? previousLevel : undefined;
}

export default function (pi: ExtensionAPI) {
	const agentDir = getAgentDir();
	const mode = new UltracodeMode();
	let settings: UltracodeSettings = { ...DEFAULT_SETTINGS };
	let keywordThisTurn = false;
	let settingLevel = false;
	let previousLevel: string | undefined;
	/** The level ultracode actually applied ("xhigh", or "max" when clamped up). */
	let appliedLevel: string | undefined;

	registerWorkflowTool(pi, { subagentModel: () => settings.model });

	pi.registerEntryRenderer<ToggleEntry>(ENTRY_TYPE, (entry, _options, theme) =>
		entry.data ? new Text(theme.fg("accent", `✦ ultracode ${entry.data.action}`), 0, 0) : undefined,
	);

	const setBadge = (ctx: { ui: { setStatus: (key: string, text: string | undefined) => void }; hasUI: boolean }) => {
		if (ctx.hasUI) ctx.ui.setStatus("ultracode", mode.isOn() ? BADGE : undefined);
	};

	pi.on("session_start", (_event, ctx) => {
		settings = loadSettings(agentDir);
		keywordThisTurn = false;
		previousLevel = restoreFromBranch(mode, ctx.sessionManager.getBranch() as Array<Record<string, any>>);
		appliedLevel = mode.isOn() ? pi.getThinkingLevel() : undefined;
		setBadge(ctx);
	});

	// Claude Code scans the text as typed, before any command expansion, and
	// only for human prompts. pi's input event is exactly that point. Prompts
	// steered into a running turn never reach before_agent_start, so they must
	// not touch the flag (deviation from Claude Code, which queues them as full
	// turns; documented in README.md).
	pi.on("input", (event) => {
		if (event.streamingBehavior !== undefined) return { action: "continue" };
		keywordThisTurn = event.source === "interactive" && hasUltracodeKeyword(event.text);
		return { action: "continue" };
	});

	// Reminders ride the turn as one hidden custom message, in Claude Code's
	// attachment order: keyword first, then the session-mode reminder.
	pi.on("before_agent_start", () => {
		const parts: string[] = [];
		if (keywordThisTurn && settings.keywordTrigger) parts.push(KEYWORD_REMINDER);
		keywordThisTurn = false;
		const modeReminder = mode.reminderForTurn();
		if (modeReminder) parts.push(modeReminder);
		if (parts.length === 0) return;
		return {
			message: {
				customType: ENTRY_TYPE,
				content: parts.map(systemReminder).join("\n"),
				display: false,
			},
		};
	});

	// Leaving the applied level exits the mode, the way choosing another
	// /effort level does in Claude Code. Our own setThinkingLevel call is
	// guarded out. The user's explicit choice stands: no restore.
	pi.on("thinking_level_select", (event, ctx) => {
		if (settingLevel || !mode.isOn()) return;
		if (event.level === appliedLevel) return;
		mode.disable();
		previousLevel = undefined;
		appliedLevel = undefined;
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "off" });
		setBadge(ctx);
		if (ctx.hasUI) ctx.ui.notify(`Ultracode off — thinking level changed to ${event.level}`, "info");
	});

	const setLevel = (level: string) => {
		settingLevel = true;
		try {
			pi.setThinkingLevel(level as Parameters<typeof pi.setThinkingLevel>[0]);
		} finally {
			settingLevel = false;
		}
	};

	const enable = (ctx: ExtensionContext) => {
		if (mode.isOn()) {
			ctx.ui.notify("Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)", "info");
			return;
		}
		const model = ctx.model;
		if (!model) {
			ctx.ui.notify("Ultracode needs a model selected.", "error");
			return;
		}
		// pi clamps the requested level to the model's supported set (upward
		// first, so models without xhigh but with max get max). Anything below
		// xhigh is a refusal, mirroring Claude Code's "Ultracode runs at xhigh
		// effort, which <model> doesn't support — switch to an xhigh-capable
		// model."
		const before = pi.getThinkingLevel();
		setLevel("xhigh");
		const applied = pi.getThinkingLevel();
		if (applied !== "xhigh" && applied !== "max") {
			setLevel(before);
			ctx.ui.notify(`Ultracode runs at xhigh thinking, which ${model.id} doesn't support — switch to an xhigh-capable model.`, "error");
			return;
		}
		previousLevel = before;
		appliedLevel = applied;
		mode.enable();
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "on", previousLevel });
		setBadge(ctx);
		ctx.ui.notify(`Set effort level to ultracode (this session only): ${applied} + dynamic workflow orchestration`, "info");
	};

	const disable = (ctx: ExtensionContext) => {
		if (!mode.isOn()) {
			ctx.ui.notify("Ultracode is not on.", "info");
			return;
		}
		mode.disable();
		pi.appendEntry<ToggleEntry>(ENTRY_TYPE, { action: "off" });
		if (previousLevel && previousLevel !== appliedLevel) {
			setLevel(previousLevel);
			ctx.ui.notify(`Ultracode off — thinking level restored to ${previousLevel}`, "info");
		} else {
			ctx.ui.notify("Ultracode off", "info");
		}
		previousLevel = undefined;
		appliedLevel = undefined;
		setBadge(ctx);
	};

	pi.registerCommand("ultracode", {
		description: "Toggle ultracode: xhigh thinking + standing workflow orchestration",
		getArgumentCompletions: (prefix: string) =>
			["on", "off", "status"].filter((option) => option.startsWith(prefix)).map((value) => ({ value, label: value })),
		handler: async (args: string, ctx) => {
			const argument = args.trim().toLowerCase();
			if (argument === "" ) {
				if (mode.isOn()) disable(ctx);
				else enable(ctx);
				return;
			}
			if (argument === "on") return void enable(ctx);
			if (argument === "off") return void disable(ctx);
			if (argument === "status") {
				ctx.ui.notify(
					mode.isOn()
						? "Current effort level: ultracode (xhigh + dynamic workflow orchestration; this session only)"
						: "Ultracode is off. /ultracode to turn it on.",
					"info",
				);
				return;
			}
			ctx.ui.notify(`Invalid argument: ${argument}. Valid options are: on, off, status`, "error");
		},
	});
}
