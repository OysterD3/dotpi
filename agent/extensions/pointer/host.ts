/**
 * The native messaging host — the process Chrome spawns when the extension
 * connects, and the only thing in this design that runs outside a pi session.
 *
 * It is a go-between with no state of its own: it reads intercom's presence
 * to answer "who is up", names the project a dev server serves so the bar can
 * preselect the session that holds it, writes a point into that session's
 * inbox, and waits for the session to say how it landed. Chrome keeps one host
 * per connection alive until the extension's port closes.
 *
 * Framing is Chrome's: a 32-bit native-endian length, then UTF-8 JSON. What the
 * host sends back stays far under the 1 MB Chrome allows in that direction —
 * the screenshot travels the other way, where the limit is 64 MB.
 *
 * Run by the wrapper `/pointer install` writes, with an absolute node path:
 * Chrome launches the host with its own environment, not the shell's PATH.
 * Nothing here imports pi — this must start under plain node.
 */

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { endianness, homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { layout as intercomLayout, listPeers } from "../intercom/store.ts";
import { CONFIG } from "./config.ts";
import { type Ack, ensure, layout, matchesRoot, type Point, type PointElement, putPoint, removePoint, takeAck } from "./store.ts";

type PeersRequest = { id: number; type: "peers"; origin: string; root?: string | null };
type PointRequest = { id: number; type: "point"; to: string; point: Omit<Point, "id" | "sentAt"> };
type Request = PeersRequest | PointRequest;

export type PeerRow = { id: string; name: string; cwd: string; idle: boolean; match: boolean };
export type Reply =
	| { id: number; type: "peers"; root: string | null; peers: PeerRow[] }
	| { id: number; type: "result"; ok: true; delivery: "turn" | "followUp" | "attached" }
	| { id: number; type: "result"; ok: false; reason: string };

const LITTLE = endianness() === "LE";

const real = (path: string) => {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function run(file: string, args: string[]): Promise<string> {
	return new Promise((resolve) => {
		execFile(file, args, { timeout: CONFIG.lsofTimeoutMs }, (error, stdout) => resolve(error ? "" : stdout));
	});
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/**
 * The directory the dev server on this origin was started from — via lsof,
 * port to pid to cwd. Only for loopback origins: a name that resolves
 * elsewhere is not a process on this machine. The launch directory is the
 * project root in the common case and the monorepo root in the other; the
 * page's own hint, when it has one, wins over this.
 */
export async function serverRoot(origin: string): Promise<string | null> {
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return null;
	}
	const host = url.hostname;
	if (!LOOPBACK.has(host) && !host.endsWith(".localhost")) return null;
	const port = url.port || (url.protocol === "https:" ? "443" : "80");
	const pid = (await run("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"])).split("\n").map((s) => s.trim()).find(Boolean);
	if (!pid || !/^\d+$/.test(pid)) return null;
	const cwd = (await run("lsof", ["-a", "-p", pid, "-d", "cwd", "-Fn"])).split("\n").find((line) => line.startsWith("n/"));
	return cwd ? cwd.slice(1) : null;
}

const isString = (value: unknown): value is string => typeof value === "string";

/**
 * One line, no control characters. Names, paths and titles are printed as
 * prose outside the HTML fence and drawn in the terminal, and every one of
 * them is page content — a newline would let the page write a header of its
 * own, an escape sequence would reach the terminal.
 */
const oneLine = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").trim();

function cleanElement(e: PointElement): PointElement {
	return {
		tag: oneLine(e.tag),
		selector: e.selector,
		html: e.html,
		owners: e.owners.map(oneLine).filter(Boolean),
		...(e.source
			? { source: { file: oneLine(e.source.file), line: e.source.line, ...(typeof e.source.column === "number" ? { column: e.source.column } : {}), via: e.source.via } }
			: {}),
	};
}

function validElement(value: unknown): value is PointElement {
	const e = value as PointElement;
	return (
		!!e &&
		isString(e.tag) &&
		isString(e.selector) &&
		isString(e.html) &&
		Array.isArray(e.owners) &&
		e.owners.every(isString) &&
		(e.source === undefined ||
			(!!e.source &&
				isString(e.source.file) &&
				typeof e.source.line === "number" &&
				(e.source.column === undefined || typeof e.source.column === "number") &&
				(e.source.via === "attr" || e.source.via === "debugSource" || e.source.via === "stack")))
	);
}

function validPoint(value: unknown): value is PointRequest["point"] {
	const p = value as PointRequest["point"];
	return (
		!!p &&
		(p.mode === "send" || p.mode === "attach") &&
		isString(p.text) &&
		!!p.page &&
		isString(p.page.url) &&
		isString(p.page.title) &&
		Array.isArray(p.elements) &&
		p.elements.length > 0 &&
		p.elements.every(validElement) &&
		(p.image === undefined || (!!p.image && isString(p.image.data) && isString(p.image.mimeType)))
	);
}

export type Host = {
	handle(request: Request): Promise<Reply>;
	/** Take back every point still waiting for an answer — the pipe is closing and nobody will hear one. */
	withdraw(): void;
	agentDir: string;
};

export function createHost(agentDir: string, now: () => number = Date.now): Host {
	const l = layout(agentDir);
	const il = intercomLayout(agentDir);
	ensure(l);

	const live = () => listPeers(il, now());
	const waiting = new Set<{ to: string; point: Point }>();

	const peers = async (request: PeersRequest): Promise<Reply> => {
		const hint = isString(request.root) && request.root ? real(request.root) : null;
		const found = hint ?? (await serverRoot(request.origin));
		const root = found ? real(found) : null;
		return {
			id: request.id,
			type: "peers",
			root,
			peers: live().map((peer) => ({
				id: peer.id,
				name: peer.name,
				cwd: peer.cwd,
				idle: peer.idle,
				match: matchesRoot({ cwd: real(peer.cwd) }, root),
			})),
		};
	};

	const point = async (request: PointRequest): Promise<Reply> => {
		const fail = (reason: string): Reply => ({ id: request.id, type: "result", ok: false, reason });
		if (!validPoint(request.point)) return fail("The browser sent a point this host does not understand.");
		// Only a session the presence files say is up gets an inbox entry, and
		// the directory name is that file's own id — never the caller's string.
		const target = live().find((peer) => peer.id === request.to);
		if (!target) return fail("That pi session is not live any more.");
		const stamped: Point = {
			...request.point,
			elements: request.point.elements.map(cleanElement),
			page: { url: oneLine(request.point.page.url), title: oneLine(request.point.page.title) },
			id: randomUUID(),
			sentAt: now(),
		};
		const entry = { to: target.id, point: stamped };
		waiting.add(entry);
		putPoint(l, target.id, stamped);
		try {
			const answer = (ack: Ack): Reply => ("error" in ack ? fail(ack.error) : { id: request.id, type: "result", ok: true, delivery: ack.delivery });
			const deadline = now() + CONFIG.ackTimeoutMs;
			while (now() < deadline) {
				const ack = takeAck(l, stamped.id);
				if (ack) return answer(ack);
				await sleep(CONFIG.ackPollMs);
			}
			// Whatever was not picked up is withdrawn: a point delivered a minute
			// after the bar said it failed would be the worse outcome.
			if (removePoint(l, target.id, stamped)) return fail("The session did not pick it up — is the pointer extension loaded there?");
			// Taken, then. The ack may have landed in the gap after the last look.
			const late = takeAck(l, stamped.id);
			return late ? answer(late) : fail("The session took the point but did not answer.");
		} finally {
			waiting.delete(entry);
		}
	};

	return {
		agentDir,
		withdraw: () => {
			for (const entry of waiting) removePoint(l, entry.to, entry.point);
			waiting.clear();
		},
		handle: (request) => {
			if (request?.type === "peers" && isString(request.origin)) return peers(request);
			if (request?.type === "point" && isString(request.to)) return point(request);
			return Promise.resolve({ id: (request as { id: number })?.id ?? 0, type: "result", ok: false, reason: "Unknown request." });
		},
	};
}

// ------------------------------------------------------------------ stdio

export function encode(message: unknown): Buffer {
	const body = Buffer.from(JSON.stringify(message), "utf8");
	const head = Buffer.alloc(4);
	if (LITTLE) head.writeUInt32LE(body.length);
	else head.writeUInt32BE(body.length);
	return Buffer.concat([head, body]);
}

/** Pull every whole frame off the front of `buffer`; what is left is a partial frame. */
export function decode(buffer: Buffer): { messages: unknown[]; rest: Buffer } {
	const messages: unknown[] = [];
	let offset = 0;
	while (buffer.length - offset >= 4) {
		const length = LITTLE ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
		if (buffer.length - offset - 4 < length) break;
		try {
			messages.push(JSON.parse(buffer.subarray(offset + 4, offset + 4 + length).toString("utf8")));
		} catch {
			/* a frame that is not JSON is dropped; the extension never sends one */
		}
		offset += 4 + length;
	}
	return { messages, rest: buffer.subarray(offset) };
}

export function serve(host: Host, input: NodeJS.ReadableStream, output: NodeJS.WritableStream): void {
	let buffer = Buffer.alloc(0);
	input.on("data", (chunk: Buffer) => {
		const decoded = decode(Buffer.concat([buffer, chunk]));
		buffer = decoded.rest;
		for (const message of decoded.messages) {
			void host.handle(message as Request).then((reply) => output.write(encode(reply)));
		}
	});
	// A point still waiting when Chrome closes the pipe would be delivered
	// after the bar reported a lost connection — so it is taken back first.
	input.on("end", () => {
		host.withdraw();
		process.exit(0);
	});
}

// Chrome passes its origin as the first argument; the test harness passes
// nothing. Either way, only a direct run serves stdio — an import does not.
if (process.argv[1] && real(process.argv[1]) === real(fileURLToPath(import.meta.url))) {
	serve(createHost(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent")), process.stdin, process.stdout);
}
