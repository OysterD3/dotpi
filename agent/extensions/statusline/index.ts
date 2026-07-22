/**
 * Rich statusline (custom footer) for pi.
 *
 * Line 1:  <model>  |  <cwd>  |  <branch>  |  (+added,-removed)  |  v<pi-version>
 * Line 2:  Context: [====------] <tokens>/<window> (<pct>%)  Cached: <c>  In: <i>  Out: <o>  Total: <t>
 * Line 3:  Session: [====------] <pct>% (resets <time>)   Weekly: [==--------] <pct>% (resets <time>)
 *
 * Data sources:
 *   - model / cwd / usage tokens : ctx.model, ctx.cwd, ctx.sessionManager.getEntries()
 *   - context window / percent   : ctx.getContextUsage()
 *   - git branch                 : footerData.getGitBranch()
 *   - git diff (+/-)             : `git diff --numstat HEAD` (shelled out, cached briefly)
 *   - session / weekly limits    : ./usage.ts (ChatGPT subscription endpoint; Codex provider only)
 *
 * Line 3 appears only when pi is authenticated with the `openai-codex` provider and the
 * usage endpoint answers. On any other provider, or any failure, it is omitted entirely.
 *
 * This lives in `extensions/statusline/index.ts` rather than `extensions/statusline.ts`
 * because pi auto-loads every top-level `extensions/*.ts` as its own extension. In a
 * subdirectory only `index.ts` is loaded, so `usage.ts` stays a plain helper module.
 */

import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { createUsageReader, type LimitWindow } from "./usage.ts";

/**
 * A color is either one of pi's semantic theme roles (follows the active theme) or a
 * `#rrggbb` literal (pinned exactly, ignores the theme). `ThemeColor` is pi's own
 * exported union, so an invalid role name is a compile error rather than a silent
 * mis-render.
 */
type ColorSpec = ThemeColor | `#${string}`;

/**
 * Display knobs. Everything tunable lives here so the render code below stays boring.
 *
 * Roles are the default so the footer tracks whatever theme is active; switch an entry
 * to a hex literal when you want an exact match to some other tool's palette.
 */
const CONFIG = {
	/** Width of each meter in cells. */
	barCells: 12,
	/** Show the session/weekly limit meters at all. */
	showLimits: true,
	/** "clock" -> "resets 17:04"; "relative" -> "3h 12m left". */
	resetStyle: "clock" as "clock" | "relative",
	/** Context percentage above which the meter turns warning/error colored. */
	warnAbovePercent: 70,
	errorAbovePercent: 90,
	colors: {
		model: "accent",
		cwd: "dim",
		branch: "mdListBullet",
		added: "success",
		removed: "error",
		version: "dim",
		separator: "dim",
		label: "muted",
		barFill: "accent",
		barTrack: "dim",
		barWarn: "warning",
		barError: "error",
		cached: "mdCode",
		out: "warning",
		reset: "dim",
	} satisfies Record<string, ColorSpec>,
};

/** Bar glyphs. The track is a mid dot so an empty meter reads as empty, not solid. */
const BAR_FILL = "█";
const BAR_TRACK = "·";

/** Paint `text` with a CONFIG.colors entry, honoring either a theme role or a hex value. */
function paint(theme: Theme, color: ColorSpec, text: string): string {
	if (!color.startsWith("#")) return theme.fg(color as ThemeColor, text);
	const r = Number.parseInt(color.slice(1, 3), 16);
	const g = Number.parseInt(color.slice(3, 5), 16);
	const b = Number.parseInt(color.slice(5, 7), 16);
	if (Number.isNaN(r) || Number.isNaN(g) || Number.isNaN(b)) return text;
	return `\x1b[38;2;${r};${g};${b}m${text}\x1b[39m`;
}

function formatTokens(count: number): string {
	if (count < 1000) return `${count}`;
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const rel = relative(resolve(home), resolve(cwd));
	const inside = rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
	if (!inside) return cwd;
	return rel === "" ? "~" : `~${sep}${rel}`;
}

/** pi's own version, resolved once (best-effort). */
function piVersion(): string {
	try {
		const req = createRequire(import.meta.url);
		return req("@earendil-works/pi-coding-agent/package.json").version ?? "";
	} catch {
		return "";
	}
}

/** Sum of added/removed lines vs HEAD, cached for a short window to avoid spawning git on every render. */
function makeGitDiffCounter(cwd: string) {
	let cache: { added: number; removed: number } | null = null;
	let stamp = 0;
	return (): { added: number; removed: number } | null => {
		const now = Date.now();
		if (cache && now - stamp < 2000) return cache;
		stamp = now;
		try {
			const out = execFileSync("git", ["diff", "--numstat", "HEAD"], {
				cwd,
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
				timeout: 1500,
			});
			let added = 0;
			let removed = 0;
			for (const line of out.split("\n")) {
				const [a, r] = line.split("\t");
				if (a && a !== "-") added += Number(a) || 0;
				if (r && r !== "-") removed += Number(r) || 0;
			}
			cache = { added, removed };
		} catch {
			cache = null;
		}
		return cache;
	};
}

function bar(percent: number, cells = CONFIG.barCells): { filled: string; track: string } {
	const clamped = Math.max(0, Math.min(100, percent));
	const filled = Math.round((clamped / 100) * cells);
	return { filled: BAR_FILL.repeat(filled), track: BAR_TRACK.repeat(cells - filled) };
}

/** Color role for a meter, escalating as it fills. */
function meterColor(percent: number | null): ColorSpec {
	if (percent === null) return CONFIG.colors.barFill;
	if (percent > CONFIG.errorAbovePercent) return CONFIG.colors.barError;
	if (percent > CONFIG.warnAbovePercent) return CONFIG.colors.barWarn;
	return CONFIG.colors.barFill;
}

/** `[███·····]` with the fill colored by severity and the track always dim. */
function meter(theme: Theme, percent: number | null): string {
	const { filled, track } = bar(percent ?? 0);
	return (
		paint(theme, CONFIG.colors.barTrack, "[") +
		paint(theme, meterColor(percent), filled) +
		paint(theme, CONFIG.colors.barTrack, track) +
		paint(theme, CONFIG.colors.barTrack, "]")
	);
}

/** "resets 17:04" / "resets 17:04 Mon", or "3h 12m left" depending on CONFIG.resetStyle. */
function formatReset(epochSeconds: number | undefined): string {
	if (epochSeconds === undefined) return "";
	const reset = new Date(epochSeconds * 1000);
	if (Number.isNaN(reset.getTime())) return "";

	if (CONFIG.resetStyle === "relative") {
		const remainingMs = reset.getTime() - Date.now();
		if (remainingMs <= 0) return "resetting";
		const minutes = Math.floor(remainingMs / 60_000);
		const hours = Math.floor(minutes / 60);
		if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h left`;
		if (hours >= 1) return `${hours}h ${minutes % 60}m left`;
		return `${minutes}m left`;
	}

	const time = `${reset.getHours().toString().padStart(2, "0")}:${reset
		.getMinutes()
		.toString()
		.padStart(2, "0")}`;
	const sameDay = reset.toDateString() === new Date().toDateString();
	const day = reset.toLocaleDateString(undefined, { weekday: "short" });
	return sameDay ? `resets ${time}` : `resets ${time} ${day}`;
}

/** "Session: [███·····] 42% (resets 17:04)" */
function limitSegment(theme: Theme, label: string, window: LimitWindow | undefined): string | null {
	if (!window) return null;
	const pct = Math.round(window.usedPercent);
	const reset = formatReset(window.resetsAt);
	return (
		paint(theme, CONFIG.colors.label, `${label}: `) +
		meter(theme, pct) +
		` ${paint(theme, meterColor(pct), `${pct}%`)}` +
		(reset ? ` ${paint(theme, CONFIG.colors.reset, `(${reset})`)}` : "")
	);
}

export default function (pi: ExtensionAPI) {
	const version = piVersion();

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const gitDiff = makeGitDiffCounter(ctx.cwd);

		ctx.ui.setFooter((tui, theme, footerData) => {
			const unsub = footerData.onBranchChange(() => tui.requestRender());
			const usage = CONFIG.showLimits ? createUsageReader(ctx, () => tui.requestRender()) : null;

			return {
				dispose() {
					unsub();
					usage?.dispose();
				},
				invalidate() {},
				render(width: number): string[] {
					// --- token totals from all assistant messages ---
					let input = 0;
					let output = 0;
					let cacheRead = 0;
					let cacheWrite = 0;
					for (const entry of ctx.sessionManager.getEntries()) {
						if (entry.type === "message" && entry.message.role === "assistant") {
							const u = (entry.message as AssistantMessage).usage;
							input += u.input;
							output += u.output;
							cacheRead += u.cacheRead;
							cacheWrite += u.cacheWrite;
						}
					}
					const cached = cacheRead + cacheWrite;
					const total = input + output + cached;

					// --- context window usage ---
					const ctxUsage = ctx.getContextUsage();
					const window = ctxUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
					const ctxTokens = ctxUsage?.tokens ?? null;
					const pct = ctxUsage?.percent ?? null;
					const pctStr = pct === null ? "?" : pct.toFixed(0);

					// --- line 1: model | cwd | branch | diff | version ---
					const parts1: string[] = [];
					parts1.push(paint(theme, CONFIG.colors.model, ctx.model?.id || "no-model"));
					parts1.push(
						paint(
							theme,
							CONFIG.colors.cwd,
							formatCwd(ctx.cwd, process.env.HOME || process.env.USERPROFILE),
						),
					);
					const branch = footerData.getGitBranch();
					if (branch) parts1.push(paint(theme, CONFIG.colors.branch, branch));
					const diff = gitDiff();
					if (diff && (diff.added > 0 || diff.removed > 0)) {
						parts1.push(
							paint(theme, CONFIG.colors.added, `+${diff.added}`) +
								paint(theme, CONFIG.colors.separator, ",") +
								paint(theme, CONFIG.colors.removed, `-${diff.removed}`),
						);
					}
					if (version) parts1.push(paint(theme, CONFIG.colors.version, `v${version}`));
					const sep1 = paint(theme, CONFIG.colors.separator, "  │  ");
					const line1 = parts1.join(sep1);

					// --- line 2: context bar + token breakdown ---
					const ctxLabel =
						ctxTokens === null
							? `?/${formatTokens(window)}`
							: `${formatTokens(ctxTokens)}/${formatTokens(window)}`;
					const line2 =
						paint(theme, CONFIG.colors.label, "Context: ") +
						meter(theme, pct) +
						` ${paint(theme, meterColor(pct), ctxLabel)} ${paint(theme, CONFIG.colors.separator, `(${pctStr}%)`)}  ` +
						paint(theme, CONFIG.colors.label, "Cached: ") +
						paint(theme, CONFIG.colors.cached, formatTokens(cached)) +
						paint(theme, CONFIG.colors.label, "  In: ") +
						formatTokens(input) +
						paint(theme, CONFIG.colors.label, "  Out: ") +
						paint(theme, CONFIG.colors.out, formatTokens(output)) +
						paint(theme, CONFIG.colors.label, "  Total: ") +
						theme.bold(formatTokens(total));

					const lines = [truncateToWidth(line1, width), truncateToWidth(line2, width)];

					// --- line 3: subscription limits (only when the provider supplies them) ---
					const limits = usage?.get();
					if (limits) {
						const segments = [
							limitSegment(theme, "Session", limits.session),
							limitSegment(theme, "Weekly", limits.weekly),
						].filter((segment): segment is string => segment !== null);
						if (segments.length > 0) {
							lines.push(truncateToWidth(segments.join("   "), width));
						}
					}

					return lines;
				},
			};
		});
	});
}
