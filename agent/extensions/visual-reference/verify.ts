/**
 * The verify gate: turn "12 CSS/TSX edits, never rebuilt or screenshotted"
 * into a follow-up that resumes the agent, instead of a static guideline that
 * sits in every request and changes nothing.
 *
 * guideline.ts is advice the model can read and ignore; this is the
 * enforcement half, built from the same measured session: the benchmarked run
 * made its last twelve UI edits in its final five minutes and stopped without
 * ever rebuilding, rendering, or screenshotting the result. A rule that only
 * fires in front of the model loses to a rule that fires when the model is
 * ABOUT to stop having skipped it.
 *
 * State machine, driven entirely off `tool_result` — the event this actually
 * has evidence from; a tool_call fires before the edit/write/bash/read has
 * happened and cannot tell a successful render from a failed one:
 *
 *   edit/write touches a *.css/scss/less/tsx/jsx/html/vue/svelte file -> dirty++
 *   a bash command that looks like it rendered or captured something -> dirty = 0
 *   a read result that came back as an image                         -> dirty = 0
 *
 * "Looks like it rendered something" is deliberately generous — any
 * screenshot-shaped command, not specifically one of the reference — because
 * the failure this closes is an agent that stops having verified NOTHING.
 * Screenshotting only its own app is real evidence of that much; whether it
 * also compared against the reference is the guideline's job, not this gate's.
 */

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { CONFIG } from "./config.ts";
import { isRenderable } from "./detect.ts";

/**
 * File extensions a UI change actually needs a render to verify. Mirrors
 * detect.ts's RENDERABLE in spirit — narrow on purpose. A change to a .ts
 * store or hook is invisible until something re-renders it, but flagging
 * every extension that COULD affect a render would fire on nearly all of a
 * frontend session, nowhere near what the benchmark measured. Anchored on
 * extension because that is the one thing a tool_result's `input.path`
 * reliably gives us — no AST, no import graph.
 */
const DIRTY_UI_PATH = /\.(css|scss|less|tsx|jsx|html|vue|svelte)$/i;

export function isDirtyUiPath(path: string): boolean {
	return DIRTY_UI_PATH.test(path.trim());
}

/**
 * A bash command that plausibly rendered or captured something. Tested
 * against the WHOLE command string rather than parsed as argv: these are
 * shell one-liners, frequently chained with `&&`, so a substring test on the
 * tool name is more robust than trying to isolate "the" command being run.
 */
const RENDER_EVIDENCE_COMMAND = /screenshot|screencapture|agent-browser|playwright|puppeteer/i;

export function isRenderEvidenceCommand(command: string): boolean {
	return RENDER_EVIDENCE_COMMAND.test(command);
}

/** file:// URLs embedded in a shell command, single-quoted or bare. */
const FILE_URL = /file:\/\/[^\s'"]+/g;

/**
 * Whether a command names a file:// URL that isRenderable() would flag as a
 * document to look at rather than read — the SAME reference-document signal
 * detect.ts's advice is built on (see its `fileUrl()`). This is what "opening
 * the reference" looks like from a bash command: e.g.
 * `agent-browser --session ref open 'file:///.../mock.html'`.
 *
 * A malformed %-escape in one candidate URL must not sink a real match sitting
 * next to it in the same command, so decoding failures fall back to testing
 * the raw (still-encoded) path rather than aborting the whole check.
 */
export function referencesRenderableFileUrl(command: string): boolean {
	const matches = command.match(FILE_URL);
	if (!matches) return false;
	return matches.some((url) => {
		const path = url.slice("file://".length).split(/[?#]/)[0] ?? "";
		try {
			return isRenderable(decodeURIComponent(path));
		} catch {
			return isRenderable(path);
		}
	});
}

/** Whether a tool_result's content includes an image block (an image read). */
export function resultReturnsImage(content: ReadonlyArray<{ type?: string }>): boolean {
	return content.some((block) => block?.type === "image");
}

/**
 * Whether an `agent_end` event's messages record the user pressing Escape,
 * rather than the model finishing on its own. `agent_end` fires on BOTH paths
 * — pi dist's agent-loop.js emits it the instant an assistant message comes
 * back with `stopReason: "aborted"`, exactly the same event this gate reads
 * for a natural stop. A follow-up queued from an `agent_end` handler is
 * delivered through `agent.continue()`, which does not itself know why the
 * run ended, so firing unconditionally here would let the gate silently
 * override the user's Escape.
 *
 * The stop reason lives on the last ASSISTANT message, not the last message
 * in the array: a normal stop that ran tool calls ends the array on a tool
 * result, so this scans from the end past those to find the message that
 * actually set the reason, rather than trusting array position.
 */
export function wasUserAborted(messages: readonly AgentMessage[]): boolean {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i] as { role?: string; stopReason?: string };
		if (message?.role !== "assistant") continue;
		return message.stopReason === "aborted";
	}
	return false;
}

/**
 * The nudge delivered on agent_end. Wording is load-bearing: it states the
 * observed count and names the files, because a generic "please verify your
 * work" is exactly the kind of advice the static guideline already carries on
 * every request and measurably failed to change behaviour with.
 */
export function followUpMessage(dirtyCount: number, files: readonly string[]): string {
	const shown = files.slice(0, CONFIG.fileListCap).join(", ");
	return `You changed ${dirtyCount} UI files since the last render (${shown}). Rebuild, screenshot your app AND the reference at the same viewport, and name the differences before stopping — unrendered UI edits are unverified edits.`;
}

/**
 * All the state the gate needs, in one small mutable class rather than
 * threaded through every handler — the same shape as goal's GoalState, for the
 * same reason: `tool_result` fires many times per turn and `agent_end` once,
 * and something has to remember what happened in between.
 *
 * NOT persisted to the session. A /goal condition has to survive `/resume`
 * because the goal is still active afterward; this gate's entire job is to
 * catch a stop that is about to happen in the CURRENT run. By the time a
 * session is resumed, that stop already happened — there is nothing live left
 * to protect, and a resumed run starts a fresh extension instance with a
 * clean slate, which is the right slate for state whose only claim is "since
 * the last render IN THIS RUN".
 */
export class VerifyGate {
	private dirtyCount = 0;
	private dirtyFiles: string[] = [];
	/** Armed by a reference file:// URL, consumed by the next image read. */
	private armedForPin = false;
	private followUpsSent = 0;

	recordDirtyEdit(path: string): void {
		this.dirtyCount++;
		if (this.dirtyFiles.length < CONFIG.fileListCap && !this.dirtyFiles.includes(path)) {
			this.dirtyFiles.push(path);
		}
	}

	/** Evidence something was rendered. Clears whatever dirt was outstanding. */
	clearDirty(): void {
		this.dirtyCount = 0;
		this.dirtyFiles = [];
	}

	/** A bash command named a renderable reference document. */
	armPin(): void {
		this.armedForPin = true;
	}

	/**
	 * Call with the toolCallId of a read result that returned an image. Returns
	 * that id when a reference URL was seen since the last pin — the
	 * presumption being this image IS the screenshot of it — and undefined for
	 * an ordinary image read nothing armed (e.g. reading the app's own
	 * screenshot, or an unrelated image file).
	 */
	consumePin(toolCallId: string): string | undefined {
		if (!this.armedForPin) return undefined;
		this.armedForPin = false;
		return toolCallId;
	}

	hasDirt(): boolean {
		return this.dirtyCount > 0;
	}

	/**
	 * Build the agent_end follow-up, or undefined when there is nothing to say
	 * (no dirt) or the session already spent its firings.
	 *
	 * Firing does NOT clear dirtyCount — only actual render evidence does — so
	 * a second nudge within the cap still reports the true outstanding total,
	 * larger if more edits happened in between, rather than resetting to
	 * "0 files" the moment the gate merely spoke.
	 */
	takeFollowUp(): string | undefined {
		if (this.dirtyCount === 0 || this.followUpsSent >= CONFIG.maxFollowUps) return undefined;
		this.followUpsSent++;
		return followUpMessage(this.dirtyCount, this.dirtyFiles);
	}
}
