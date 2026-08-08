/**
 * advisor — consult a stronger reviewer model on the whole session so far.
 *
 * The advisor lets the main agent pause and consult a stronger reviewer model
 * on the whole session so far, at the moments that matter (before committing to
 * an approach, when stuck, before declaring done). The natural shape is a
 * server-side tool that the API forwards to the configured model; pi has no such
 * server tool, so tool.ts does the forwarding in the client — it flattens the
 * session branch and runs the reviewer as a tool-less headless pi call
 * (spawn.ts).
 *
 * The reviewer model is configurable and required — that is the whole feature.
 * With no model set the tool is not offered at all. It can be set three ways, in
 * priority order:
 *   1. `/advisor <model>`      a session override (also `/advisor off` / `on`)
 *   2. `--advisor <model>`     a CLI flag for one run
 *   3. `advisor.model` setting the durable default in agent/settings.json
 *
 * One rule you might expect is deliberately NOT enforced (see models.ts): that
 * an advisor cannot be the very model it advises. A same-model advisor still
 * reads the whole session with a clean context, which is the useful part, and
 * refusing it leaves a single-model setup with no advisor at all. An "at least as
 * capable" rank check reduces to allow, because pi's registry carries no
 * capability rank for arbitrary providers.
 *
 * Settings (agent settings.json):
 *   advisor.model               string, a pi model reference for the reviewer
 *                                (required to enable the tool).
 *   advisor.enabled              boolean, default true. Kill switch.
 *   advisor.resurface.enabled    boolean, default true. Resurfacing kill switch —
 *                                independent of advisor.enabled, see resurface.ts.
 *   advisor.resurface.afterCalls number, default 15. Mutating tool calls after a
 *                                consult before the standing advice resurfaces.
 *
 * See guidance.ts for both prompts: the main-agent guidance that rides in the
 * tool description, and the authored reviewer-side prompt. See resurface.ts for
 * the advice-resurfacing mechanism wired into the event handlers below.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { type AdvisorSettings, DEFAULT_RESURFACE_SETTINGS, DEFAULT_SETTINGS, SETTINGS_KEY, TOOL_NAME } from "./config.ts";
import { modelRef, resolveModelReference, sameModel, resolveRole } from "./models.ts";
import {
	type AdviceState,
	appendClosingLine,
	isMutatingTool,
	markResurfaced,
	onConsult,
	recordMutatingCall,
	resurfaceReminder,
	shouldResurface,
	systemReminder,
} from "./resurface.ts";
import { registerAdvisorTool } from "./tool.ts";

/** Custom-message type for the hidden resurface follow-up. Not rendered (display: false), so no message renderer is registered for it. */
const RESURFACE_MESSAGE = "advisor_resurface";

export function loadSettings(agentDir: string): AdvisorSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		const block = raw?.[SETTINGS_KEY] as Record<string, unknown> | undefined;
		const resurfaceBlock = block?.resurface as Record<string, unknown> | undefined;
		return {
			model: typeof block?.model === "string" && block.model.trim() ? block.model.trim() : undefined,
			enabled: typeof block?.enabled === "boolean" ? block.enabled : DEFAULT_SETTINGS.enabled,
			resurface: {
				enabled: typeof resurfaceBlock?.enabled === "boolean" ? resurfaceBlock.enabled : DEFAULT_RESURFACE_SETTINGS.enabled,
				// Integer-only and >0: a fractional or zero-or-negative value has no
				// sane reading as "calls to wait" and would either never fire cleanly
				// or fire on the very next mutating call, indistinguishable from a typo.
				afterCalls:
					typeof resurfaceBlock?.afterCalls === "number" &&
					Number.isInteger(resurfaceBlock.afterCalls) &&
					resurfaceBlock.afterCalls > 0
						? resurfaceBlock.afterCalls
						: DEFAULT_RESURFACE_SETTINGS.afterCalls,
			},
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

	// Advice resurfacing (resurface.ts): the standing advice from the most
	// recent successful consult, and how many mutating tool calls have landed
	// since. Session-scoped like sessionModel/sessionOff above, and reset the
	// same way — by the whole module reinitializing, since pi tears down and
	// rebuilds the extension runtime on every /resume (and /reload).
	let adviceState: AdviceState | undefined;
	// Every tool call, not just mutating ones — gives AdviceState.atCall an
	// audit position ("advised at call 12") independent of the
	// mutatingCallsSince count that actually gates the resurface.
	let toolCallCount = 0;

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
			const resolved = resolveModelReference(resolveRole(reference, getAgentDir()), ctx.modelRegistry.getAll());
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
		const resolved = resolveModelReference(resolveRole(reference, getAgentDir()), ctx.modelRegistry.getAll());
		if (!resolved.ok) return `Advisor model "${reference}" is not available: ${resolved.error}.`;
		const source = sessionModel ? "session override" : pi.getFlag("advisor") ? "--advisor flag" : "advisor.model setting";
		// As words, never as a `:level` suffix on the id — the suffix is
		// configuration syntax, not part of any model reference shown to the user.
		const levelNote = resolved.thinking ? ` at ${resolved.thinking} thinking` : "";
		const selfNote = sameModel(resolved.model, ctx.model)
			? " — the same model driving this session, so it reviews its own transcript with a clean context"
			: "";
		return `Advisor is on: ${modelRef(resolved.model)}${levelNote} (${source})${selfNote}. Call it before committing to an approach and before declaring done.`;
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
			const resolved = resolveModelReference(resolveRole(arg, getAgentDir()), ctx.modelRegistry.getAll());
			if (!resolved.ok) {
				ctx.ui.notify(`Cannot use "${arg}" as an advisor: ${resolved.error}.`, "error");
				return;
			}
			// The override is stored AS TYPED, the same contract as the --advisor
			// flag above. Canonicalizing would have to reattach a carried level to
			// the canonical id, and "provider/id:level" can collide with a
			// registry id that literally ends in a level name — the full-first
			// rule would then match that other model on every later resolve and
			// drop the level. The typed string re-resolves by the same rules each
			// time, so what was validated here is what the spawn gets.
			sessionModel = arg;
			sessionOff = false;
			syncActive(ctx);
			ctx.ui.notify(
				sameModel(resolved.model, ctx.model)
					? `Advisor set to ${resolved.model.id} — the same model driving this session, so it reviews its own transcript with a clean context.`
					: `Advisor set to ${resolved.model.id}.`,
				"info",
			);
		},
	});

	// Capture the standing advice from every successful consult, and append the
	// closing line that forces the next message to engage with it. Fires for
	// every tool, so the advisor's own toolName is checked first.
	pi.on("tool_result", (event) => {
		if (event.toolName !== TOOL_NAME) return;

		// tool.ts's SubagentError branch does not throw — it returns a normal
		// result carrying `details.error` — so `isError` alone (which reflects
		// whether execute() threw) does not catch it. Neither "no model
		// configured" nor "reviewer unreachable" left any advice to hold or
		// restate, so both are skipped the same way.
		if (event.isError || (event.details as { error?: string } | undefined)?.error) return;

		const advice = event.content
			.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (!advice) return;

		adviceState = onConsult(toolCallCount, advice);
		return { content: [{ type: "text", text: appendClosingLine(advice) }] };
	});

	// Watch every tool call to count mutating ones since the last consult, and
	// resurface the standing advice once the threshold passes with no newer
	// consult in between.
	pi.on("tool_call", (event, ctx) => {
		toolCallCount++;
		if (!adviceState || !isMutatingTool(event.toolName)) return;

		adviceState = recordMutatingCall(adviceState);
		if (!shouldResurface(adviceState, settings.resurface)) return;

		adviceState = markResurfaced(adviceState);
		pi.sendMessage(
			{ customType: RESURFACE_MESSAGE, content: systemReminder(resurfaceReminder(adviceState.adviceHead)), display: false },
			// Same idiom as goal/stalled-turn: a tool call always lands mid-turn,
			// so this is followUp in practice, but isIdle() is checked anyway
			// rather than assumed, matching every other extension that injects a
			// message from inside a running turn.
			ctx.isIdle() ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
	});
}
