/**
 * pointer — point this session at elements on a page in Chrome.
 *
 * The other half lives in `chrome/` (the extension) and `host.ts` (what Chrome
 * spawns to reach the filesystem). This side is the session: it drains its
 * own inbox, hands each point to the agent, and tells the host how that went.
 *
 *   send    the developer typed the instruction in the browser — one custom
 *           message carrying the elements, the screenshot and the ask. Idle:
 *           it starts a turn; busy: it rides the run as a follow-up. The same
 *           rule as intercom and background-shell, for the same reason.
 *   attach  no instruction yet — held here, shown above the editor, and
 *           spliced into the next prompt: by before_agent_start when that
 *           prompt starts a turn, and as a queued message beside it when it
 *           is typed into a running turn, since before_agent_start does not
 *           fire on that path. Held in this process rather than queued in
 *           pi, so `/pointer clear` can drop it and an Escape cannot.
 *
 * A send while elements are attached takes them along: a turn started by a
 * custom message does not pass through before_agent_start, so folding them
 * in here is what keeps "collect, then ask" true from the browser too.
 *
 *   store.ts    inbox, acks, sweep, session matching
 *   host.ts     the native messaging host
 *   install.ts  the host manifest and wrapper `/pointer install` writes
 *   prompts.ts  what the model reads, and the chat row
 *   config.ts   timings
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type AliveCheck, processAlive } from "../intercom/store.ts";
import { CONFIG, MESSAGE_TYPE } from "./config.ts";
import { install } from "./install.ts";
import { label, pointBlock } from "./prompts.ts";
import { type Ack, drainPoints, ensure, layout, type Point, putAck, sweep } from "./store.ts";

export type PointerDetails = {
	mode: "send" | "attach";
	url: string;
	/** One chip's worth per element, e.g. `Button (Form.tsx:46)`. */
	labels: string[];
	text?: string;
	delivery?: "turn" | "followUp";
};

export type Deps = {
	agentDir: string;
	now?: () => number;
	alive?: AliveCheck;
};

type Part = { type: "text"; text: string } | { type: "image"; data: string; mimeType: string };

function parts(points: Point[]): Part[] {
	return points.flatMap((point): Part[] => [
		{ type: "text", text: pointBlock(point) },
		...(point.image ? [{ type: "image" as const, data: point.image.data, mimeType: point.image.mimeType }] : []),
	]);
}

function details(points: Point[], mode: PointerDetails["mode"], delivery?: PointerDetails["delivery"]): PointerDetails {
	const text = points.map((point) => point.text.trim()).find(Boolean);
	return {
		mode,
		url: points[0].page.url,
		labels: points.flatMap((point) => point.elements.map(label)),
		...(text ? { text } : {}),
		...(delivery ? { delivery } : {}),
	};
}

/** Terminal control sequences do not get to the terminal through a chat row. */
const plain = (text: string) => text.replace(/[\x00-\x1f\x7f]/g, "");

function renderPointer(d: PointerDetails, theme: Theme): Text {
	const count = `${d.labels.length} element${d.labels.length === 1 ? "" : "s"}`;
	const lines = [theme.fg("accent", theme.bold(d.mode === "send" ? `◎ Chrome → ${count}` : `◎ Chrome: ${count} attached`)) + theme.fg("muted", `  ${plain(d.url)}`)];
	if (d.text) lines.push(theme.fg("muted", `“${plain(d.text.split("\n")[0])}”`));
	lines.push(theme.fg("dim", plain(d.labels.join(", "))));
	if (d.delivery === "followUp") lines.push(theme.fg("dim", "picked up by the turn already running"));
	return new Text(lines.join("\n"), 0, 0);
}

export function registerPointer(pi: ExtensionAPI, deps: Deps): void {
	const l = layout(deps.agentDir);
	const now = deps.now ?? (() => Date.now());
	const alive = deps.alive ?? processAlive;

	let uiCtx: ExtensionContext | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;
	/** Attached, not yet spliced into a prompt. */
	let pending: Point[] = [];

	const showPending = () => {
		const ctx = uiCtx;
		if (!ctx?.hasUI) return;
		const count = pending.reduce((sum, point) => sum + point.elements.length, 0);
		try {
			ctx.ui.setWidget(
				MESSAGE_TYPE,
				count ? [`◎ ${count} element${count === 1 ? "" : "s"} from Chrome attached — sent with your next prompt · /pointer clear drops them`] : undefined,
			);
		} catch {
			/* a session on its way out has no editor to draw above */
		}
	};

	/** Take what is attached, and show that nothing is. */
	const takePending = (): Point[] => {
		const taken = pending;
		pending = [];
		showPending();
		return taken;
	};

	const deliver = (ctx: ExtensionContext, point: Point): Ack => {
		if (point.mode === "attach") {
			pending.push(point);
			showPending();
			return { delivery: "attached" };
		}
		const idle = ctx.isIdle();
		const delivery = idle ? "turn" : "followUp";
		const points = [...takePending(), point];
		pi.sendMessage<PointerDetails>(
			{ customType: MESSAGE_TYPE, content: parts(points), display: true, details: details(points, "send", delivery) },
			idle ? { triggerTurn: true } : { deliverAs: "followUp" },
		);
		return { delivery };
	};

	const tick = () => {
		const ctx = uiCtx;
		if (!ctx) return;
		// Read fresh each tick: /new, /resume and fork all rebind the id under
		// a live process, and the inbox is keyed by it.
		const id = ctx.sessionManager.getSessionId();
		if (!id) return;
		for (const point of drainPoints(l, id, CONFIG.maxDrainPerTick)) {
			let ack: Ack;
			try {
				ack = deliver(ctx, point);
			} catch (error) {
				// The file is already gone, so the browser must hear that this
				// one was lost — a silent drop looks exactly like success.
				ack = { error: `pi could not take it: ${error instanceof Error ? error.message : String(error)}` };
			}
			putAck(l, point.id, ack);
		}
	};

	const stop = () => {
		if (poller) clearInterval(poller);
		poller = undefined;
	};

	pi.registerMessageRenderer<PointerDetails>(MESSAGE_TYPE, (message, _options, theme) =>
		message.details ? renderPointer(message.details, theme) : undefined,
	);

	pi.registerCommand("pointer", {
		description: "Chrome pointer: `install` writes the browser host manifest, `clear` drops attached elements",
		handler: async (args, ctx) => {
			const sub = args.trim().split(/\s+/)[0];
			if (sub === "install") {
				try {
					const done = install(deps.agentDir);
					ctx.ui.notify(
						`Host manifest written for ${done.manifests.length} browser${done.manifests.length === 1 ? "" : "s"}. Load ${deps.agentDir}/extensions/pointer/chrome unpacked (chrome://extensions, Developer mode) — its id must read ${done.id} — then restart the browser.`,
						done.manifests.length ? "info" : "warning",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			if (sub === "clear") {
				const dropped = takePending().reduce((sum, point) => sum + point.elements.length, 0);
				ctx.ui.notify(dropped ? `Dropped ${dropped} attached element${dropped === 1 ? "" : "s"}.` : "Nothing was attached.", "info");
				return;
			}
			ctx.ui.notify("Usage: /pointer install  ·  /pointer clear", "info");
		},
	});

	pi.on("before_agent_start", () => {
		if (pending.length === 0) return;
		const points = takePending();
		return {
			message: { customType: MESSAGE_TYPE, content: parts(points), display: true, details: details(points, "attach") },
		};
	});

	// A prompt typed while a turn runs is queued, not started, and never
	// reaches before_agent_start. The set goes into the same queue, so it is
	// read in the same batch as the words it was attached for.
	pi.on("input", (event) => {
		if (pending.length === 0 || !event.streamingBehavior) return;
		const points = takePending();
		pi.sendMessage<PointerDetails>(
			{ customType: MESSAGE_TYPE, content: parts(points), display: true, details: details(points, "attach") },
			{ deliverAs: event.streamingBehavior },
		);
	});

	pi.on("session_start", (_event, ctx) => {
		stop();
		// What was attached belonged to the conversation this process just
		// left; it does not follow into the next one.
		pending = [];
		uiCtx = ctx;
		if (!ctx.hasUI) return;
		ensure(l);
		sweep(l, alive);
		showPending();
		poller = setInterval(tick, CONFIG.pollMs);
		(poller as { unref?: () => void }).unref?.();
	});

	pi.on("session_shutdown", () => {
		stop();
		uiCtx = undefined;
	});
}

export default function (pi: ExtensionAPI) {
	registerPointer(pi, { agentDir: getAgentDir() });
}
