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
 * problem: something arrived from outside the turn. An idle session is woken by
 * it, a busy one gets it as a follow-up on the run it is already doing, and one
 * tick's whole drain becomes one message, so three peers do not become three
 * turns.
 *
 * Waking is the choice, not the default. The quieter option — hold everything
 * for the next thing the user types — protects the receiver's tokens, and costs
 * the thing an intercom is for: a peer that only hears you when its user
 * happens to come back is a mailbox. The price is stated in the tool
 * description instead, where the sender reads it before spending it.
 *
 * Two facts shape everything else. A session id changes under a live process —
 * `/new`, `/resume` and fork all rebind it — so presence is torn down and
 * rewritten on every session_start, and the poller reads the id fresh each
 * tick; without that, a session keeps draining the inbox of a conversation it
 * has already left. And a process that is SIGKILLed never runs its shutdown, so
 * presence is a heartbeat plus a pid check rather than a file that exists,
 * and every session sweeps the corpses when it starts.
 *
 * A headless run takes part too, and used to be excluded outright — presence
 * was never written and all three tools refused. The reasoning was that a
 * `-p` run has no next turn to deliver into and is gone before a peer could
 * answer, which is half true and was applied to the whole extension. SENDING
 * needs no turn and no UI at all, and a headless run is exactly the thing that
 * wants to tell somebody what it found. Being reached works too, as long as its
 * one turn is still going: a follow-up rides a run in progress, which is the
 * same delivery an interactive session gets when it is busy.
 *
 * What genuinely does not work is waking it, so that is the only thing withheld.
 * `wakeable: false` goes in its presence record, it is never sent a turn of its
 * own, its inbox is left unread while it is idle rather than drained into
 * nowhere, and the peer list marks it so a sender knows an `ask` will likely
 * outlive it. A session with no id at all — `--no-session` — is still off,
 * because there is nothing to address.
 *
 *   store.ts    the files, presence, liveness, and target resolution
 *   tools.ts    the three tools
 *   prompts.ts  tool descriptions and the delivered block
 *   config.ts   heartbeats, timeouts, limits
 */

import { getAgentDir, type ExtensionAPI, type ExtensionContext, type Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { CONFIG, INCOMING_CHANNEL, type IncomingDelivery, MESSAGE_TYPE } from "./config.ts";
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
	/** How it landed: a turn of its own, or the run that was already going. */
	delivery: "turn" | "followUp" | "steer";
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
	if (details.delivery === "followUp") lines.push(theme.fg("dim", "picked up by the turn already running"));
	if (details.delivery === "steer") lines.push(theme.fg("dim", "received while a user question is open"));
	return new Text(lines.join("\n"), 0, 0);
}

/**
 * How a drained message is handed over.
 *
 * A turn of its own only for a session that can be woken. For a headless run
 * that would keep a process alive its caller is waiting to finish, and collide
 * with the single prompt it was invoked for — so it always rides the run
 * already going, and the tick that got here checked there is one.
 *
 * Not folded into that check, and not redundant with it: the two read the clock
 * at different moments, and a turn that ends in between would otherwise turn
 * "deliver into the run in progress" into "start a new one" for exactly the
 * session that must never get one. Pure, so the rule can be read as a table.
 */
export function deliveryFor(wakeable: boolean, idle: boolean): "turn" | "followUp" {
	return wakeable && idle ? "turn" : "followUp";
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
	 * Idle: wake it, the way a shell exit does. Mid-turn: ride the run already
	 * going as a follow-up. That second case is the one with a loss mode worth
	 * knowing — the follow-up queue is the exact queue an abort clears whole, so
	 * a peer's message delivered mid-turn dies with an Escape. Nothing here
	 * re-sends it: the sender was told it was delivered, and it was.
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
		// A headless run between turns has nowhere to put this. Waking it is not
		// available — that is what `wakeable: false` means — and `drain` DELETES
		// what it reads, so reading the inbox here would lose the mail rather
		// than hold it. Left on disk instead: the turn that is about to start (or
		// is still going) picks it up on a later tick, and if the process exits
		// first the sweep buries the inbox with the session.
		if (!me.wakeable && isIdle()) return;
		const envelopes = drain(l, me.id, CONFIG.maxDrainPerTick);
		if (envelopes.length === 0) return;
		try {
			// Release ask_user's tool wait, but keep its question and draft on screen.
			// A follow-up would wait for all tools to finish and could deadlock again.
			const incoming: IncomingDelivery = { steer: false };
			pi.events.emit(INCOMING_CHANNEL, incoming);
			const delivery = incoming.steer && !ctx.isIdle() ? "steer" : deliveryFor(me.wakeable !== false, ctx.isIdle());
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
		const id = ctx.sessionManager.getSessionId();
		if (!id) return;
		ensure(l);
		// `hasUI` is read as "wakeable" and stored under that name, because that
		// is the only thing the intercom does differently with it: a session with
		// dialog-capable UI (TUI, RPC) has a next turn a message can start, and a
		// headless `pi -p` run does not. Everything else — sending, and being
		// reached while a turn is running — works identically either way.
		self = {
			id,
			name: ctx.sessionManager.getSessionName()?.trim() || id.slice(0, CONFIG.idChars),
			cwd: ctx.cwd,
			wakeable: ctx.hasUI,
		};
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
