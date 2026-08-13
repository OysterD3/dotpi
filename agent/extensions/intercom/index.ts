/**
 * intercom — live pi sessions talk to each other.
 *
 * session-ref brings a session's RECORD in: you name it, it is read off disk,
 * and it never knows. This is the other half — two sessions that are both up
 * right now, one asking the other something it can answer today.
 *
 *   intercom_peers                 who else is running
 *   intercom_send(to, message)     say it and carry on
 *   intercom_ask(to, question)     say it and wait for the answer
 *
 * Delivery follows background-shell's rule exactly, because it is the same
 * problem: something arrived from outside the turn. An idle session is woken
 * (`triggerTurn`); a busy one gets it as a follow-up on the run it is already
 * doing. One tick's whole drain becomes one message, so three peers do not
 * start three turns.
 *
 * Two facts shape everything else. A session id changes under a live process —
 * `/new`, `/resume` and fork all rebind it — so presence is torn down and
 * rewritten on every session_start, and the poller reads the id fresh each
 * tick; without that, a session keeps draining the inbox of a conversation it
 * has already left. And a process that is SIGKILLed never runs its shutdown, so
 * presence is a heartbeat plus a pid check rather than a file that exists,
 * and every session sweeps the corpses when it starts.
 *
 * The intercom needs an interactive session to be worth anything: a headless
 * `-p` run has no next turn to deliver into and is gone before a peer could
 * answer. There, presence is never written and the tools say so.
 *
 *   store.ts    the files, presence, liveness, and target resolution
 *   tools.ts    the three tools
 *   prompts.ts  tool descriptions and the delivered block
 *   config.ts   heartbeats, timeouts, limits
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG, MESSAGE_TYPE } from "./config.ts";
import { intercomBlock } from "./prompts.ts";
import { type AliveCheck, drain, ensure, forget, type Layout, layout, processAlive, type Self, sweep, writePresence } from "./store.ts";
import { registerIntercomTools } from "./tools.ts";

export type IntercomDetails = {
	/** Display names of the senders, in delivery order. */
	from: string[];
	count: number;
	/** How many of them are blocked waiting for an answer. */
	asking: number;
};

export type Deps = {
	agentDir: string;
	now?: () => number;
	alive?: AliveCheck;
};

function renderIntercom(details: IntercomDetails, theme: Theme): Text {
	const lines = [
		theme.fg("accent", theme.bold(`⇄ Intercom: ${details.count} message${details.count === 1 ? "" : "s"}`)),
		theme.fg("muted", `from ${details.from.join(", ")}`),
	];
	if (details.asking > 0) lines.push(theme.fg("dim", `${details.asking} waiting for an answer`));
	return new Text(lines.join("\n"), 0, 0);
}

export function registerIntercom(pi: ExtensionAPI, deps: Deps): void {
	const l: Layout = layout(deps.agentDir);
	const now = deps.now ?? (() => Date.now());
	const alive = deps.alive ?? processAlive;

	let self: Self | undefined;
	/**
	 * The context delivery goes through. Held across turns and rebound on every
	 * session_start, the way background-shell holds its own — a timer has no
	 * event of its own to be handed one.
	 */
	let uiCtx: ExtensionContext | undefined;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;

	const unref = (timer: unknown) => (timer as { unref?: () => void }).unref?.();

	const beat = () => {
		if (self) writePresence(l, self, now());
	};

	/**
	 * Drain this session's inbox and hand it over.
	 *
	 * `drain` removes what it reads, so a throw between here and sendMessage
	 * loses those messages — the same trade background-shell makes with a
	 * finished shell's exit. The alternative, leaving them on disk until
	 * delivery is confirmed, redelivers everything after any partial failure.
	 */
	const tick = () => {
		const me = self;
		const ctx = uiCtx;
		if (!me || !ctx) return;
		const envelopes = drain(l, me.id, CONFIG.maxDrainPerTick);
		if (envelopes.length === 0) return;
		try {
			const idle = ctx.isIdle();
			pi.sendMessage<IntercomDetails>(
				{
					customType: MESSAGE_TYPE,
					content: intercomBlock(envelopes),
					display: true,
					details: {
						from: envelopes.map((envelope) => envelope.from.name),
						count: envelopes.length,
						asking: envelopes.filter((envelope) => envelope.askId).length,
					},
				},
				idle ? { triggerTurn: true } : { deliverAs: "followUp" },
			);
		} catch {
			/* a session on its way out cannot receive anything */
		}
	};

	const start = () => {
		heartbeat = setInterval(beat, CONFIG.heartbeatMs);
		poller = setInterval(tick, CONFIG.pollMs);
		unref(heartbeat);
		unref(poller);
	};

	const stop = () => {
		if (heartbeat) clearInterval(heartbeat);
		if (poller) clearInterval(poller);
		heartbeat = undefined;
		poller = undefined;
	};

	/** Leave the peer list, and take the undrainable inbox with it. */
	const leave = () => {
		if (self) forget(l, self.id);
		self = undefined;
		uiCtx = undefined;
	};

	registerIntercomTools(pi, { layout: l, self: () => self, now, alive });

	pi.registerMessageRenderer<IntercomDetails>(MESSAGE_TYPE, (message, _options, theme) =>
		message.details ? renderIntercom(message.details, theme) : undefined,
	);

	pi.on("session_start", (_event, ctx) => {
		stop();
		// A rebind (/new, /resume, fork) reaches here with the OLD id still held
		// when no shutdown ran first. Retiring it is what stops this process
		// answering for a conversation it has left.
		leave();
		if (!ctx.hasUI) return;
		const id = ctx.sessionManager.getSessionId();
		if (!id) return;
		ensure(l);
		sweep(l, now(), alive);
		self = { id, name: ctx.sessionManager.getSessionName()?.trim() || id.slice(0, CONFIG.idChars), cwd: ctx.cwd };
		uiCtx = ctx;
		beat();
		start();
	});

	// A name set mid-session is how a peer will look for this one, so it must
	// reach the peer list before the next heartbeat rather than after it.
	pi.on("session_info_changed", (event) => {
		if (!self) return;
		self = { ...self, name: event.name?.trim() || self.id.slice(0, CONFIG.idChars) };
		beat();
	});

	pi.on("session_shutdown", () => {
		stop();
		leave();
	});
}

export default function (pi: ExtensionAPI) {
	registerIntercom(pi, { agentDir: getAgentDir() });
}
