/**
 * The three tools: see who is up, say something, ask something.
 *
 * `intercom_send` returns as soon as the message is on the peer's disk;
 * `intercom_ask` blocks on the answer. Everything either can reach is a LIVE
 * session — a target that is not running is refused here rather than queued,
 * because a queued message would be delivered on a resume that may be days
 * away, to a session whose user has long since moved on.
 *
 * The blocked ask is the one place this can wedge: two sessions asking each
 * other at the same moment are both inside a tool call, so neither can reach
 * the turn where it would answer. The timeout is the whole of the answer to
 * that, which is why it is bounded and why the description says so.
 */

import { randomUUID } from "node:crypto";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { CONFIG, TOOL_ASK, TOOL_PEERS, TOOL_SEND } from "./config.ts";
import {
	ASK_DESCRIPTION,
	ASK_SNIPPET,
	INTERCOM_GUIDELINES,
	OFF_TEXT,
	PEERS_DESCRIPTION,
	PEERS_SNIPPET,
	SEND_DESCRIPTION,
	SEND_SNIPPET,
} from "./prompts.ts";
import {
	type AliveCheck,
	closeAsk,
	type Layout,
	listPeers,
	openAsk,
	putAnswer,
	putMessage,
	resolvePeer,
	type Self,
	takeAnswer,
} from "./store.ts";

export type ToolDeps = {
	layout: Layout;
	/** Who this session is, or undefined when the intercom is off here. */
	self: () => Self | undefined;
	now: () => number;
	alive?: AliveCheck;
};

const said = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function registerIntercomTools(pi: ExtensionAPI, deps: ToolDeps): void {
	const peers = () => listPeers(deps.layout, deps.now(), deps.alive);
	/** Live peers minus this session: talking to yourself is a deadlock with extra steps. */
	const others = (me: Self) => peers().filter((peer) => peer.id !== me.id);

	pi.registerTool({
		name: TOOL_PEERS,
		label: "Intercom Peers",
		description: PEERS_DESCRIPTION,
		promptSnippet: PEERS_SNIPPET,
		parameters: Type.Object({}),
		async execute() {
			const me = deps.self();
			if (!me) return said(OFF_TEXT);
			const rows = others(me);
			if (rows.length === 0) return said("No other pi session is running right now.");
			return said(
				[
					`${rows.length} other live session${rows.length === 1 ? "" : "s"}:`,
					...rows.map((peer) => `${peer.id.slice(0, CONFIG.idChars)}  ${peer.name}  ·  ${peer.cwd}`),
				].join("\n"),
			);
		},
	});

	pi.registerTool({
		name: TOOL_SEND,
		label: "Intercom Send",
		description: SEND_DESCRIPTION,
		promptSnippet: SEND_SNIPPET,
		promptGuidelines: INTERCOM_GUIDELINES,
		parameters: Type.Object({
			to: Type.Optional(
				Type.String({
					description: `The target session's id (or its name, when that is unambiguous), from ${TOOL_PEERS}. Omit only when answering with reply_to.`,
				}),
			),
			message: Type.String({ description: "What to say. Say who you are and what you need — the peer has none of your context." }),
			reply_to: Type.Optional(
				Type.String({ description: `The ask id stated in a question a peer sent you with ${TOOL_ASK}. Answers that question and needs no 'to'.` }),
			),
		}),
		async execute(_toolCallId, params) {
			const me = deps.self();
			if (!me) return said(OFF_TEXT);

			const message = String(params.message ?? "").trim();
			if (!message) return said("Nothing to send: message was empty.");
			if (message.length > CONFIG.maxMessageChars) {
				return said(`That message is ${message.length} characters; the limit is ${CONFIG.maxMessageChars}. Send the short version.`);
			}

			const replyTo = typeof params.reply_to === "string" ? params.reply_to.trim() : "";
			if (replyTo) {
				const delivered = putAnswer(deps.layout, replyTo, message, deps.now());
				return said(
					delivered
						? "Answer delivered. That session is unblocked."
						: `Nobody is waiting on "${replyTo}" any more — that ask timed out or its session quit. The answer was not delivered.`,
				);
			}

			const target = resolvePeer(others(me), String(params.to ?? ""));
			if (!target.ok) return said(target.reason);

			putMessage(deps.layout, target.peer.id, { from: me, text: message, sentAt: deps.now() });
			return said(`Sent to "${target.peer.name}" (${target.peer.id.slice(0, CONFIG.idChars)}). It arrives on that session's next turn. There is no reply unless it sends one.`);
		},
	});

	pi.registerTool({
		name: TOOL_ASK,
		label: "Intercom Ask",
		description: ASK_DESCRIPTION,
		promptSnippet: ASK_SNIPPET,
		parameters: Type.Object({
			to: Type.String({ description: `The target session's id (or its name, when that is unambiguous), from ${TOOL_PEERS}.` }),
			question: Type.String({ description: "What to ask. Include the context the peer needs — it cannot see your session." }),
			timeout_seconds: Type.Optional(
				Type.Number({ description: `How long to wait. Default ${CONFIG.defaultAskTimeoutMs / 1000}, maximum ${CONFIG.maxAskTimeoutMs / 1000}.` }),
			),
		}),
		async execute(_toolCallId, params, signal) {
			const me = deps.self();
			if (!me) return said(OFF_TEXT);

			const question = String(params.question ?? "").trim();
			if (!question) return said("Nothing to ask: question was empty.");
			if (question.length > CONFIG.maxMessageChars) {
				return said(`That question is ${question.length} characters; the limit is ${CONFIG.maxMessageChars}. Ask the short version.`);
			}

			const target = resolvePeer(others(me), String(params.to ?? ""));
			if (!target.ok) return said(target.reason);
			const peer = target.peer;

			const seconds = typeof params.timeout_seconds === "number" && params.timeout_seconds > 0 ? params.timeout_seconds : CONFIG.defaultAskTimeoutMs / 1000;
			const timeoutMs = Math.min(seconds * 1000, CONFIG.maxAskTimeoutMs);
			const askId = `ask_${randomUUID().slice(0, 8)}`;
			const deadline = deps.now() + timeoutMs;

			// The wait marker goes down BEFORE the question goes out: a peer fast
			// enough to answer within the poll interval would otherwise be told
			// nobody was listening.
			openAsk(deps.layout, askId, deps.now());
			try {
				putMessage(deps.layout, peer.id, { from: me, text: question, askId, sentAt: deps.now() });

				while (deps.now() < deadline) {
					const answer = takeAnswer(deps.layout, askId);
					if (answer !== undefined) return said(`"${peer.name}" answered:\n\n${answer}`);
					if (signal?.aborted) return said(`Stopped waiting for "${peer.name}".`);
					// A peer that quits mid-question will never answer, and waiting
					// out the full timeout for a session that is gone is just a hang
					// with a schedule.
					if (!peers().some((row) => row.id === peer.id)) return said(`"${peer.name}" quit before answering.`);
					await sleep(CONFIG.askPollMs);
				}

				return said(
					`No answer from "${peer.name}" within ${Math.round(timeoutMs / 1000)}s. It may be mid-task, or blocked waiting on somebody itself. Carry on without it, or send what you know with ${TOOL_SEND}.`,
				);
			} finally {
				closeAsk(deps.layout, askId);
			}
		},
	});
}
