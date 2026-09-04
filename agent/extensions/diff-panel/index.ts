/**
 * diff-panel — the working tree's uncommitted changes, beside the chat.
 *
 * Claude Code's diff panel, for pi: `/diff` or shift+→ opens a panel on the
 * right-hand half of the screen listing every file that differs from HEAD —
 * `2 files changed +18 -1` — and, under the list, each file's diff with line
 * numbers, drawn by pi's own diff renderer. It re-reads the tree as the model
 * edits and scrolls itself to whatever was touched last, so it can stay up
 * while you keep typing.
 *
 * Git is the source, not the session. What the panel shows is `git status`
 * against HEAD — staged and unstaged together, untracked files as additions —
 * which is what you would commit, and the one thing a shell command can never
 * slip past: an edit tool only ever knows the edits it made. The cost is that
 * outside a repository there is nothing to compare against, and the panel
 * says so.
 *
 * It is an OVERLAY, not the editor's slot. pi-tui composites it over the chat,
 * so the chat's right half is under it (as in Claude Code) while the editor and
 * footer keep their bottom rows; and it is `nonCapturing`, so the keyboard
 * stays with the editor until you ask for it (shift+→ again) and goes back on
 * esc. Two things follow from being non-modal: it hides itself while ask-user
 * or permissions have a question up, since the diff being asked about is in
 * the chat under it; and closing it is `done()`, which pops pi's topmost
 * overlay — sound today because nothing else in this config opens one.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { OverlayHandle } from "@earendil-works/pi-tui";
import { ASK_CHANNEL, CONFIG, PERMISSION_ANSWERED_CHANNEL, PERMISSION_CHANNEL } from "./config.ts";
import { ChangeReader } from "./git.ts";
import { DiffPanel } from "./panel.ts";

interface Session {
	/** Re-read the tree after `ms`; a second call inside the window replaces the first. */
	schedule(ms: number): void;
	/** Hand the panel the keyboard. */
	drive(): void;
	close(): void;
}

export default function (pi: ExtensionAPI) {
	let reader: ChangeReader | undefined;
	/** What the last edit or write named, as the model named it; the panel follows it. */
	let latest: string | undefined;
	let session: Session | undefined;

	async function show(ctx: ExtensionContext): Promise<void> {
		if (session) return;
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The diff panel needs the terminal UI", "warning");
			return;
		}
		if (!reader || reader.cwd !== ctx.cwd) reader = new ChangeReader(ctx.cwd);
		const current = reader;

		let handle: OverlayHandle | undefined;
		let panel: DiffPanel | undefined;
		let inFlight = false;
		let again = false;
		let settle: ReturnType<typeof setTimeout> | undefined;

		// One read at a time. A request that lands mid-read runs once more
		// after it, rather than racing it to the panel.
		const reread = async (): Promise<void> => {
			if (inFlight) {
				again = true;
				return;
			}
			inFlight = true;
			try {
				const reading = await current.read();
				panel?.update(reading, latest === undefined ? undefined : current.toRepoPath(latest));
			} finally {
				inFlight = false;
				if (again) {
					again = false;
					void reread();
				}
			}
		};
		const schedule = (ms: number): void => {
			if (settle) clearTimeout(settle);
			settle = setTimeout(() => void reread(), ms);
			settle.unref?.();
		};
		const poll = setInterval(() => void reread(), CONFIG.pollMs);
		poll.unref?.();

		const hide = (hidden: boolean): void => handle?.setHidden(hidden);
		const unsubscribe = [
			pi.events.on(ASK_CHANNEL, (data) => hide((data as { active?: boolean } | undefined)?.active === true)),
			pi.events.on(PERMISSION_CHANNEL, () => hide(true)),
			pi.events.on(PERMISSION_ANSWERED_CHANNEL, () => hide(false)),
		];

		try {
			await ctx.ui.custom<undefined>(
				(tui, theme, _keybindings, done) => {
					session = { schedule, drive: () => handle?.focus(), close: () => done(undefined) };
					panel = new DiffPanel(
						{
							requestRender: () => tui.requestRender(),
							rows: () => tui.terminal?.rows ?? CONFIG.assumedRows,
							unfocus: () => handle?.unfocus(),
							close: () => done(undefined),
						},
						theme,
					);
					void reread();
					return panel;
				},
				{
					overlay: true,
					overlayOptions: { width: CONFIG.width, anchor: "top-right", nonCapturing: true },
					onHandle: (overlay) => {
						handle = overlay;
					},
				},
			);
		} finally {
			session = undefined;
			clearInterval(poll);
			if (settle) clearTimeout(settle);
			for (const stop of unsubscribe) stop();
		}
	}

	// From the editor: open, or hand the open panel the keyboard. Once the
	// panel holds it the key never reaches here, and the panel closes on it.
	pi.registerShortcut(CONFIG.key, {
		description: "Open the diff panel, or take the keyboard to it",
		handler: async (ctx) => {
			if (session) session.drive();
			else await show(ctx);
		},
	});

	pi.registerCommand("diff", {
		description: "Toggle the diff panel: uncommitted changes beside the chat",
		handler: async (_args, ctx) => {
			if (session) session.close();
			else await show(ctx);
		},
	});

	pi.on("tool_execution_start", (event) => {
		if (event.toolName !== "edit" && event.toolName !== "write") return;
		const args = event.args as { path?: unknown; file_path?: unknown } | undefined;
		const path = args?.path ?? args?.file_path;
		if (typeof path === "string" && path.length > 0) latest = path;
	});

	// Any tool can change the tree — bash as much as edit — so every one is a
	// reason to look, after a short settle so a burst of calls is one read.
	pi.on("tool_execution_end", () => session?.schedule(CONFIG.settleMs));
	pi.on("turn_end", () => session?.schedule(0));

	// A new, resumed, forked or reloaded session is a NEW extension instance:
	// pi runs the factory again and hides every overlay itself, without ever
	// calling this one's done(). So the closing has to happen here, on the
	// shutdown the old instance is told about, or custom() never resolves and
	// the poll above runs git every two seconds for the rest of the process.
	pi.on("session_shutdown", () => session?.close());
}
