/**
 * The files the browser and a session talk through.
 *
 * The Chrome extension cannot see the filesystem and a pi session has no
 * listening socket, so the native host Chrome spawns is the go-between: it
 * reads intercom's presence to learn who is up, and hands a point over under
 * `<agentDir>/pointer/`:
 *
 *   inbox/<sessionId>/<ts>-<n>.json   points waiting for that session
 *   acks/<pointId>.json               how the session delivered one
 *
 * Presence itself is intercom's, not duplicated here: a session that runs
 * intercom is a session the browser can reach, and the host reads the same
 * peer files intercom writes. Every write lands via a temp file and a rename,
 * and readers ignore anything that is not a `.json`, for the same reason as
 * there.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type AliveCheck, layout as intercomLayout, type Peer, processAlive } from "../intercom/store.ts";

/** Where in the source a picked element comes from, and how that was learned. */
export type Source = {
	file: string;
	line: number;
	column?: number;
	/** A build-plugin attribute, React 18's fiber field, or a React 19 stack symbolicated through a source map. */
	via: "attr" | "debugSource" | "stack";
};

export type PointElement = {
	tag: string;
	/** A CSS path that finds this element on the page. */
	selector: string;
	/** The whole outerHTML, by decision uncapped. */
	html: string;
	source?: Source;
	/** Component names that rendered it, innermost first. */
	owners: string[];
};

export type Image = { data: string; mimeType: string };

export type Point = {
	id: string;
	/** `send` carries an instruction and starts a turn; `attach` is held for the next typed prompt. */
	mode: "send" | "attach";
	text: string;
	page: { url: string; title: string };
	elements: PointElement[];
	/** One viewport screenshot with the selections outlined. */
	image?: Image;
	sentAt: number;
};

export type Ack = { delivery: "turn" | "followUp" | "attached" } | { error: string };

export type Layout = { root: string; inbox: string; acks: string; peers: string };

export function layout(agentDir: string): Layout {
	const root = join(agentDir, "pointer");
	return { root, inbox: join(root, "inbox"), acks: join(root, "acks"), peers: intercomLayout(agentDir).peers };
}

export function ensure(l: Layout): void {
	for (const dir of [l.inbox, l.acks]) mkdirSync(dir, { recursive: true });
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

// ------------------------------------------------------------------ points

export function putPoint(l: Layout, toId: string, point: Point): void {
	const dir = join(l.inbox, toId);
	mkdirSync(dir, { recursive: true });
	writeJson(join(dir, `${String(point.sentAt).padStart(16, "0")}-${point.id.slice(0, 8)}.json`), point);
}

/** Take up to `max` points, oldest first, removing each as it is read. Synchronous, like intercom's drain, for the same reason. */
export function drainPoints(l: Layout, id: string, max: number): Point[] {
	const dir = join(l.inbox, id);
	const taken: Point[] = [];
	for (const file of jsonFiles(dir).sort().slice(0, max)) {
		const path = join(dir, file);
		const point = readJson<Point>(path);
		rmSync(path, { force: true });
		// The id becomes the ack's file name, so only the shape the host writes is taken.
		if (typeof point?.id === "string" && /^[\w-]+$/.test(point.id) && Array.isArray(point.elements) && (point.mode === "send" || point.mode === "attach"))
			taken.push(point);
	}
	return taken;
}

/** Withdraw a point nobody has taken yet. True when it was still there. */
export function removePoint(l: Layout, toId: string, point: Point): boolean {
	const path = join(l.inbox, toId, `${String(point.sentAt).padStart(16, "0")}-${point.id.slice(0, 8)}.json`);
	try {
		rmSync(path);
		return true;
	} catch {
		return false;
	}
}

// ------------------------------------------------------------------ acks

export function putAck(l: Layout, pointId: string, ack: Ack): void {
	mkdirSync(l.acks, { recursive: true });
	writeJson(join(l.acks, `${pointId}.json`), ack);
}

/** Read and remove an ack. */
export function takeAck(l: Layout, pointId: string): Ack | undefined {
	const path = join(l.acks, `${pointId}.json`);
	const ack = readJson<Ack>(path);
	if (ack) rmSync(path, { force: true });
	return ack;
}

// ------------------------------------------------------------------ sweep

/**
 * Bury the inboxes of sessions whose PROCESS is gone. Staleness is not the
 * test — a stopped or slept session is stale in seconds and comes back for
 * its mail — so this reads the peer files directly rather than asking for
 * the live list. Stray acks go too; nobody waits more than a few seconds for
 * one.
 */
export function sweep(l: Layout, alive: AliveCheck = processAlive): void {
	const running = new Set<string>();
	for (const file of jsonFiles(l.peers)) {
		const peer = readJson<Peer>(join(l.peers, file));
		if (peer && typeof peer.id === "string" && typeof peer.pid === "number" && alive(peer.pid)) running.add(peer.id);
	}
	try {
		for (const id of readdirSync(l.inbox)) if (!running.has(id)) rmSync(join(l.inbox, id), { recursive: true, force: true });
	} catch {
		/* no inbox directory yet */
	}
	for (const file of jsonFiles(l.acks)) rmSync(join(l.acks, file), { force: true });
}

// ------------------------------------------------------------------ which session

/** `inner` is `outer` or lies below it. Both are already real paths. */
const within = (inner: string, outer: string) => inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);

/**
 * Does this session's directory hold the project the dev server serves — or
 * the other way round, for a session opened in a package of a monorepo whose
 * server was started at the root. The bar preselects a lone match and shows
 * the list otherwise; matching twice is a question for the developer, not a
 * guess.
 */
export function matchesRoot(peer: Pick<Peer, "cwd">, root: string | null): boolean {
	if (!root) return false;
	return within(root, peer.cwd) || within(peer.cwd, root);
}
