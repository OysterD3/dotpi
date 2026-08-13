/**
 * The files two sessions talk through, and the rules for who is listening.
 *
 * pi's own event bus is in-process, and every session is a separate process, so
 * the transport is the filesystem under `<agentDir>/intercom/`:
 *
 *   peers/<id>.json          who is live, rewritten on a heartbeat
 *   inbox/<id>/<ts>-<n>.json messages waiting for that session to drain
 *   answers/<askId>.wait     an asker is blocked on this question right now
 *   answers/<askId>.json     the reply it is waiting for
 *
 * An inbox only means anything while its owner runs: a message to a session
 * that is not up is refused at send time rather than stored for a resume that
 * may never come. That is what makes this an intercom and not a mailbox, and it
 * is why presence is the first thing every operation consults.
 *
 * Every write lands via a temp file and a rename, so a reader mid-write sees
 * either the old file or the whole new one. Readers ignore anything that is not
 * a `.json`, which is what the temp names are shaped to avoid.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFIG, TOOL_PEERS } from "./config.ts";

export type Peer = {
	id: string;
	/** Session name, or the first characters of the id when it has none. */
	name: string;
	cwd: string;
	pid: number;
	/** Last heartbeat, ms since epoch. */
	updatedAt: number;
	/** When this session joined the peer list, ms since epoch. */
	startedAt: number;
	/** Whether it was between turns as of that heartbeat. */
	idle: boolean;
};

/** Who a session is, as its peers see it. */
export type Self = Pick<Peer, "id" | "name" | "cwd">;

/** What a heartbeat records beyond the identity that does not change. */
export type Presence = { now: number; startedAt: number; idle: boolean };

export type Envelope = {
	from: Self;
	text: string;
	/** One line for the receiver's chat row. Derived from the text when unstated. */
	summary: string;
	/** Set when the sender is blocked waiting for an answer to this. */
	askId?: string;
	sentAt: number;
};

export type Layout = { root: string; peers: string; inbox: string; answers: string };

export function layout(agentDir: string): Layout {
	const root = join(agentDir, "intercom");
	return { root, peers: join(root, "peers"), inbox: join(root, "inbox"), answers: join(root, "answers") };
}

export function ensure(l: Layout): void {
	for (const dir of [l.peers, l.inbox, l.answers]) mkdirSync(dir, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
	const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
	writeFileSync(tmp, JSON.stringify(value));
	renameSync(tmp, path);
}

function readJson<T>(path: string): T | undefined {
	try {
		return JSON.parse(readFileSync(path, "utf8")) as T;
	} catch {
		return undefined;
	}
}

function jsonFiles(dir: string): string[] {
	try {
		return readdirSync(dir).filter((name) => name.endsWith(".json"));
	} catch {
		return [];
	}
}

// ------------------------------------------------------------------ presence

/**
 * Does that pid still exist? Signal 0 tests existence without delivering
 * anything. EPERM means it exists and belongs to somebody else, which is still
 * a running process — only ESRCH means gone.
 */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

export type AliveCheck = (pid: number) => boolean;

function isLive(peer: Peer | undefined, now: number, alive: AliveCheck): peer is Peer {
	if (!peer || typeof peer.id !== "string" || typeof peer.pid !== "number") return false;
	// Both halves are load-bearing: the heartbeat catches a killed process whose
	// pid the OS has since handed to something else, and the pid check catches a
	// session that died between two heartbeats.
	return now - peer.updatedAt <= CONFIG.staleAfterMs && alive(peer.pid);
}

export function writePresence(l: Layout, self: Self, state: Presence): void {
	writeJson(join(l.peers, `${self.id}.json`), {
		...self,
		pid: process.pid,
		updatedAt: state.now,
		startedAt: state.startedAt,
		idle: state.idle,
	} satisfies Peer);
}

/** Leave the peer list. Reversible: the next heartbeat puts it back. */
export function removePresence(l: Layout, id: string): void {
	rmSync(join(l.peers, `${id}.json`), { force: true });
}

/**
 * Drop a session's presence AND its inbox. An inbox with no owner is
 * undrainable — but this is not reversible, so it is only for an id that is
 * finished. A session that is coming back under the same id keeps its mail.
 */
export function forget(l: Layout, id: string): void {
	removePresence(l, id);
	rmSync(join(l.inbox, id), { recursive: true, force: true });
}

/** Sessions that are up right now, most recently heard from first. */
export function listPeers(l: Layout, now: number, alive: AliveCheck = processAlive): Peer[] {
	const peers: Peer[] = [];
	for (const file of jsonFiles(l.peers)) {
		const peer = readJson<Peer>(join(l.peers, file));
		if (isLive(peer, now, alive)) peers.push(peer);
	}
	return peers.sort((a, b) => b.updatedAt - a.updatedAt);
}

/**
 * Bury what died. A session that is SIGKILLed, or whose machine lost power,
 * never runs its shutdown handler, so its presence file and its inbox would
 * otherwise sit there forever — the presence file advertising a session nobody
 * can reach.
 *
 * The test is whether the PROCESS is gone, not whether it is listed. Those come
 * apart for a session stopped with Ctrl+Z or slept with the laptop: its
 * heartbeat goes stale in seconds, so `listPeers` stops offering it and nothing
 * new can be sent to it, but it is still there and its mail is still addressed
 * to somebody. Sweeping on staleness would take an irreversible action —
 * deleting an inbox — on a signal that reverses itself the moment the session
 * is resumed.
 */
export function sweep(l: Layout, now: number, alive: AliveCheck = processAlive): void {
	const running = new Set<string>();
	for (const file of jsonFiles(l.peers)) {
		const path = join(l.peers, file);
		const peer = readJson<Peer>(path);
		if (peer && typeof peer.id === "string" && typeof peer.pid === "number" && alive(peer.pid)) running.add(peer.id);
		else rmSync(path, { force: true });
	}
	try {
		for (const id of readdirSync(l.inbox)) if (!running.has(id)) rmSync(join(l.inbox, id), { recursive: true, force: true });
	} catch {
		/* no inbox directory yet */
	}
	// A wait marker outlives its asker only when that session died mid-ask, and
	// no ask may outlive the longest one this could have been. The stamp is read
	// out of the file rather than off its mtime: everything else here dates from
	// the caller's clock, and a file's mtime is not that clock.
	try {
		// Filtered like every other reader here: an unfiltered walk also sees a
		// temp file mid-write, and deleting one makes its owner's rename throw a
		// raw fs error out of an ask.
		for (const file of readdirSync(l.answers).filter((name) => name.endsWith(".json") || name.endsWith(".wait"))) {
			const path = join(l.answers, file);
			const at = readJson<{ at?: number }>(path)?.at;
			if (typeof at !== "number" || now - at > CONFIG.maxAskTimeoutMs) rmSync(path, { force: true });
		}
	} catch {
		/* no answers directory yet */
	}
}

// ------------------------------------------------------------------ resolving a target

export type Resolution = { ok: true; peer: Peer } | { ok: false; reason: string };

const shortIds = (peers: Peer[]) => peers.map((peer) => peer.id.slice(0, CONFIG.idChars)).join(", ");

/**
 * Which live session `to` names — an id prefix first, then a name.
 *
 * Two sessions can carry the same name, so a name that answers twice is
 * refused with the ids that would settle it rather than delivered to whichever
 * happened to sort first. Sending to the wrong session is worse than not
 * sending.
 */
export function resolvePeer(peers: Peer[], to: string): Resolution {
	const needle = to.trim().toLowerCase();
	if (!needle) return { ok: false, reason: "No session was named." };

	const byId = peers.filter((peer) => peer.id.toLowerCase().startsWith(needle));
	if (byId.length === 1) return { ok: true, peer: byId[0] };
	if (byId.length > 1) return { ok: false, reason: `"${to}" is a prefix of ${byId.length} ids (${shortIds(byId)}). Use more of the id.` };

	const exact = peers.filter((peer) => peer.name.toLowerCase() === needle);
	if (exact.length === 1) return { ok: true, peer: exact[0] };
	if (exact.length > 1) return { ok: false, reason: `${exact.length} live sessions are called "${to}". Use an id instead: ${shortIds(exact)}.` };

	const partial = peers.filter((peer) => peer.name.toLowerCase().includes(needle));
	if (partial.length === 1) return { ok: true, peer: partial[0] };
	if (partial.length > 1) return { ok: false, reason: `"${to}" matches ${partial.length} live sessions. Use an id instead: ${shortIds(partial)}.` };

	return { ok: false, reason: `No live session matches "${to}". Call ${TOOL_PEERS} to see which sessions are up.` };
}

// ------------------------------------------------------------------ messages

export function putMessage(l: Layout, toId: string, envelope: Envelope): void {
	const dir = join(l.inbox, toId);
	mkdirSync(dir, { recursive: true });
	// Time-ordered name, unique tail: two senders may write in the same
	// millisecond, and the receiver reads in filename order.
	writeJson(join(dir, `${String(envelope.sentAt).padStart(16, "0")}-${randomUUID().slice(0, 8)}.json`), envelope);
}

/**
 * Take up to `max` messages, oldest first, removing each as it is read.
 *
 * Deliberately synchronous end to end. The caller runs on a timer while the
 * session id can change under it, and a read that yielded between taking a
 * message off disk and handing it to the session would be a message lost to a
 * `/new` that happened in between.
 */
export function drain(l: Layout, id: string, max: number): Envelope[] {
	const dir = join(l.inbox, id);
	const taken: Envelope[] = [];
	for (const file of jsonFiles(dir).sort().slice(0, max)) {
		const path = join(dir, file);
		const envelope = readJson<Envelope>(path);
		rmSync(path, { force: true });
		if (envelope?.text && envelope.from?.id) taken.push(envelope);
	}
	return taken;
}

// ------------------------------------------------------------------ asks

const waitPath = (l: Layout, askId: string) => join(l.answers, `${askId}.wait`);
const answerPath = (l: Layout, askId: string) => join(l.answers, `${askId}.json`);

/** Mark an ask as blocked and waiting. Only a waiting ask can be answered. */
export function openAsk(l: Layout, askId: string, now: number): void {
	mkdirSync(l.answers, { recursive: true });
	writeJson(waitPath(l, askId), { at: now });
}

/** The asker is done — answered, timed out, or gone. Nothing may answer it now. */
export function closeAsk(l: Layout, askId: string): void {
	rmSync(waitPath(l, askId), { force: true });
	rmSync(answerPath(l, askId), { force: true });
}

/**
 * Answer a waiting ask. False when nobody is waiting any more, which the
 * responder is told plainly: an answer written into a file nobody reads is the
 * one failure that looks exactly like success.
 */
export function putAnswer(l: Layout, askId: string, text: string, now: number): boolean {
	if (!existsSync(waitPath(l, askId))) return false;
	writeJson(answerPath(l, askId), { text, at: now });
	return true;
}

export function takeAnswer(l: Layout, askId: string): string | undefined {
	const answer = readJson<{ text: string }>(answerPath(l, askId));
	return typeof answer?.text === "string" ? answer.text : undefined;
}
