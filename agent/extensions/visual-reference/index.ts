/**
 * visual-reference — look at the thing you are copying, before you copy it.
 *
 * Three parts of one failure, all measured in real GUI builds:
 *
 *   detect.ts     pi's read tool refuses an oversized line and suggests `sed`.
 *                 For a bundled HTML document that advice is a dead end, and
 *                 the agent's only impression of the mockup was its loader.
 *   guideline.ts  the reference was rendered 12 tool calls AFTER the agent
 *                 started writing its own UI, and looked at a quarter as often
 *                 as the agent's own app.
 *   verify.ts     a separate session made its last twelve UI edits in its
 *                 final five minutes and stopped without ever rebuilding,
 *                 rendering, or screenshotting the result — the guideline
 *                 above was in every request that whole time and changed
 *                 nothing, because it is advice, not a gate. verify.ts is the
 *                 gate: it counts unrendered edits from tool_result and, on
 *                 agent_end, resumes the agent instead of letting it stop.
 *
 * Settings (agent settings.json — per-machine):
 *   visualReference.enabled     boolean, default true
 *   visualReference.readAdvice  boolean, default true (rewrite read refusals)
 *   visualReference.guideline   boolean, default true (system-prompt rule)
 *   visualReference.verifyGate  boolean, default true (block stopping on unrendered UI edits)
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { adviseOnReadResult } from "./detect.ts";
import { VISUAL_REFERENCE_GUIDELINE } from "./guideline.ts";
import {
	isDirtyUiPath,
	isRenderEvidenceCommand,
	referencesRenderableFileUrl,
	resultReturnsImage,
	VerifyGate,
	wasUserAborted,
} from "./verify.ts";

export const SETTINGS_KEY = "visualReference";

export interface VisualReferenceSettings {
	enabled: boolean;
	readAdvice: boolean;
	guideline: boolean;
	verifyGate: boolean;
}

export const DEFAULT_SETTINGS: VisualReferenceSettings = {
	enabled: true,
	readAdvice: true,
	guideline: true,
	verifyGate: true,
};

export function resolveSettings(raw: unknown): VisualReferenceSettings {
	if (!raw || typeof raw !== "object") return { ...DEFAULT_SETTINGS };
	const block = raw as Record<string, unknown>;
	const flag = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);
	return {
		enabled: flag(block.enabled, DEFAULT_SETTINGS.enabled),
		readAdvice: flag(block.readAdvice, DEFAULT_SETTINGS.readAdvice),
		guideline: flag(block.guideline, DEFAULT_SETTINGS.guideline),
		verifyGate: flag(block.verifyGate, DEFAULT_SETTINGS.verifyGate),
	};
}

export function loadSettings(agentDir: string): VisualReferenceSettings {
	try {
		const raw = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8")) as Record<string, unknown>;
		return resolveSettings(raw?.[SETTINGS_KEY]);
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

/**
 * pi.events channel asking context-diet to protect a reference screenshot from
 * its image eviction (context-diet keeps only the newest `keepImages` images —
 * see its config.ts). A literal string rather than an import: the two
 * extensions install independently, so they share a channel name, not a
 * module — the same contract goal's SPEND_CHANNEL documents for `usage:spend`.
 * With no subscriber (context-diet's own pin support is a separate change) the
 * event goes nowhere.
 */
const PIN_CHANNEL = "context-diet:pin";

/** Custom message type for the verify-gate follow-up. */
const VERIFY_MESSAGE = "verify_gate";

export default function (pi: ExtensionAPI) {
	const settings = loadSettings(getAgentDir());
	if (!settings.enabled) return;

	if (settings.readAdvice) {
		pi.on("tool_result", (event) => {
			if (event.toolName !== "read") return;
			const blocks = event.content as Array<{ type?: string; text?: string }>;
			const index = blocks.findIndex((b) => b?.type === "text" && typeof b.text === "string");
			if (index === -1) return;
			const advised = adviseOnReadResult(blocks[index]!.text!);
			if (!advised) return;
			const next = blocks.map((b, i) => (i === index ? { ...b, text: advised } : b));
			// EVERY field is echoed back. pi rebuilds the result from this return
			// value wholesale, so an omitted `details` blanks the renderer and an
			// omitted `usage` loses the call's spend — only `isError` has a
			// fallback. Returning content alone looks right and deletes the rest.
			return { content: next as never, details: event.details, isError: event.isError, usage: event.usage };
		});
	}

	if (settings.guideline) {
		// Appended to the system prompt rather than sent as a message, so it is
		// cached across the turn — the pattern memory/ uses. Never replaces:
		// several extensions chain here.
		pi.on("before_agent_start", (event) => ({
			systemPrompt: `${event.systemPrompt}\n\n${VISUAL_REFERENCE_GUIDELINE}`,
		}));
	}

	if (settings.verifyGate) {
		// A second, independent `tool_result` registration — pi dispatches every
		// handler registered for an event and chains their results (see
		// runner.js's emitToolResult), so this coexists with readAdvice's handler
		// above without either one seeing the other's return value.
		const gate = new VerifyGate();

		pi.on("tool_result", (event) => {
			// A failed call is not evidence of anything: a failed edit changed no
			// file, and a failed bash/read call did not render or read back an image.
			if (event.isError) return;

			if (event.toolName === "edit" || event.toolName === "write") {
				const path = event.input?.path;
				if (typeof path === "string" && isDirtyUiPath(path)) gate.recordDirtyEdit(path);
				return;
			}

			if (event.toolName === "bash") {
				const command = event.input?.command;
				if (typeof command !== "string") return;
				if (isRenderEvidenceCommand(command)) gate.clearDirty();
				if (referencesRenderableFileUrl(command)) gate.armPin();
				return;
			}

			if (event.toolName === "read" && resultReturnsImage(event.content)) {
				gate.clearDirty();
				// PIN CONTRACT (producer side): a screenshot of the reference just came
				// back as an image. Announce it so context-diet can protect this
				// specific tool result from its image-eviction pass — see PIN_CHANNEL.
				const toolCallId = gate.consumePin(event.toolCallId);
				if (toolCallId) pi.events.emit(PIN_CHANNEL, { toolCallId });
			}
		});

		pi.on("agent_end", (event) => {
			// agent_end fires when the user hits Escape too, and a follow-up
			// queued here resumes the agent via agent.continue() regardless of
			// why the run ended — so without this check the gate would override
			// the user's abort with its own "keep going" message. Dirty state is
			// left exactly as it is: an aborted turn's unrendered edits are still
			// unrendered, and the next NATURAL stop is what should ask about them.
			if (wasUserAborted(event.messages)) return;

			const message = gate.takeFollowUp();
			if (!message) return;
			// Mirrors goal's notMetInstruction: a follow-up message resumes the
			// agent, because pi has no hook that can veto agent_end directly.
			pi.sendMessage(
				{ customType: VERIFY_MESSAGE, content: message, display: true },
				{ deliverAs: "followUp", triggerTurn: true },
			);
		});
	}
}
