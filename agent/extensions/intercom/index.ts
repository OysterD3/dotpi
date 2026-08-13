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
 * Delivery is background-shell's problem — something arrived from outside the
 * turn — with one line drawn through it: only a QUESTION may start a turn. A
 * plain send waits for the next thing the user types, because a peer must not
 * be able to spend somebody else's tokens on work they did not ask for. A
 * question wakes an idle session, because it is the one message that is
 * worthless late: somebody is blocked on it. Mid-turn both ride the run
 * already going, and one tick's whole drain becomes one message, so three
 * peers do not become three turns.
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
import { intercomBlock, summarise } from "./prompts.ts";
import {
	type AliveCheck,
	drain,
	ensure,
	forget,
	type Layout,
	layout,
	processAlive,
	removePresence,
	type Self,
	sweep,
	writePresence,
} from "./store.ts";
import { registerIntercomTools } from "./tools.ts";

export type IntercomDetails = {
	/** One row per message: who sent it, what it is about, and whether it blocks them. */
	items: { from: string; summary: string; asking: boolean }[];
	count: number;
	/** How it landed: a turn of its own, the run already going, or the next prompt. */
	delivery: "turn" | "followUp" | "nextTurn";
};

export type Deps = {
	agentDir: string;
	now?: () => number;
	alive?: AliveCheck;
};

function renderIntercom(details: IntercomDetails, theme: Theme): Text {
	const lines = [theme.fg("accent", theme.bold(`⇄ Intercom: ${details.count} message${details.count === 1 ? "" : "s"}`))];
	for (const item of details.items) {
		lines.push(theme.fg("muted", `${item.from} — ${item.summary}${item.asking ? " (waiting for an answer)" : ""}`));
	}
	if (details.delivery === "nextTurn") lines.push(theme.fg("dim", "waiting for your next message"));
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
	let startedAt = 0;
	let heartbeat: ReturnType<typeof setInterval> | undefined;
	let poller: ReturnType<typeof setInterval> | undefined;

	const unref = (timer: unknown) => (timer as { unref?: () => void }).unref?.();

	/** Between turns, as far as this heartbeat can tell. A stale runtime counts as working. */
	const isIdle = () => {
		try {
			return uiCtx?.isIdle() ?? false;
		} catch {
			return false;
		}
	};

	const beat = () => {
		if (self) writePresence(l, self, { now: now(), startedAt, idle: isIdle() });
	};

	/**
	 * Drain this session's inbox and hand it over.
	 *
	 * Only a QUESTION may start a turn. A plain send waits for the next thing
	 * the user types (`nextTurn` is spliced into that prompt unconditionally, so
	 * an Escape in between cannot lose it) — a peer must not be able to spend
	 * this user's tokens on work they did not ask for. A question is the one
	 * message that is worthless late: somebody is blocked on it, and a reply
	 * that arrives after they gave up helps nobody. Mid-turn, both ride the run
	 * already going, which is background-shell's rule unchanged.
	 *
	 * A plain message that lands in the same tick as a question rides that turn
	 * free. The turn's cost was committed by the question, and a peer gains
	 * nothing by the pairing — anything it wanted acted on now, it could have
	 * written into the question itself.
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
			const delivery = !idle ? "followUp" : envelopes.some((envelope) => envelope.askId) ? "turn" : "nextTurn";
			pi.sendMessage<IntercomDetails>(
				{
					customType: MESSAGE_TYPE,
					content: intercomBlock(envelopes),
					display: true,
					details: {
						// A peer still running an older build of this extension sends no
						// preview of its own, and a row reading "undefined" is worse
						// than one derived from what it actually said.
						items: envelopes.map((envelope) => ({
							from: envelope.from.name,
							summary: envelope.summary || summarise(undefined, envelope.text),
							asking: Boolean(envelope.askId),
						})),
						count: envelopes.length,
						delivery,
					},
				},
				delivery === "turn" ? { triggerTurn: true } : { deliverAs: delivery },
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

	/**
	 * Stop answering as this session. The inbox goes too, because nobody will
	 * ever drain it — unless this same id is coming straight back, which is what
	 * `/reload` is: the mail sitting there is still addressed to somebody.
	 */
	const leave = (returning = false) => {
		if (self) (returning ? removePresence : forget)(l, self.id);
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
		self = { id, name: ctx.sessionManager.getSessionName()?.trim() || id.slice(0, CONFIG.idChars), cwd: ctx.cwd };
		uiCtx = ctx;
		startedAt = now();
		// Announce before sweeping, never after: the sweep deletes the inbox of
		// every id with no presence file, and for the moment between a reload's
		// teardown and this line, that includes this session's own.
		beat();
		sweep(l, now(), alive);
		start();
	});

	// A name set mid-session is how a peer will look for this one, so it must
	// reach the peer list before the next heartbeat rather than after it.
	pi.on("session_info_changed", (event) => {
		if (!self) return;
		self = { ...self, name: event.name?.trim() || self.id.slice(0, CONFIG.idChars) };
		beat();
	});

	pi.on("session_shutdown", (event) => {
		stop();
		// A reload tears the runtime down and builds it back under the SAME
		// session id moments later. Every other reason ends this id for good.
		leave(event.reason === "reload");
	});
}

export default function (pi: ExtensionAPI) {
	registerIntercom(pi, { agentDir: getAgentDir() });
}
