/**
 * Statusline tunables.
 *
 * A color is either one of pi's semantic theme roles (follows the active theme) or a
 * `#rrggbb` literal (pinned exactly, ignores the theme). `ThemeColor` is pi's own
 * exported union, so an invalid role name is a compile error rather than a silent
 * mis-render.
 */

import type { ThemeColor } from "@earendil-works/pi-coding-agent";

export type ColorSpec = ThemeColor | `#${string}`;

/**
 * pi.events channel the ultracode extension announces its active workflow runs
 * on. Declared here rather than imported from that extension: each extension
 * stays self-contained, the same way cmux-notify re-declares the env names
 * cmux's own bridge uses. Payload: `{ lines: string[] | undefined }`.
 */
export const WORKFLOW_CHANNEL = "ultracode:panel";

/**
 * pi.events channel the ask-user extension announces an in-flight question on.
 * Payload: `{ active: boolean }`.
 *
 * A question replaces the editor, and this footer blanks itself while one is up
 * so the question owns the whole bottom of the screen. ask-user cannot do that
 * from its side: `ui.setFooter(undefined)` restores pi's *built-in* footer, so
 * a swap-and-restore there would silently retire this statusline for the rest
 * of the session. Declared here rather than imported, as above.
 */
export const ASK_CHANNEL = "ask-user:asking";

/** Bar glyphs. The track is a mid dot so an empty meter reads as empty, not solid. */
export const BAR_FILL = "█";
export const BAR_TRACK = "·";

export const CONFIG = {
	/** Width of each meter in cells. */
	barCells: 12,
	/** Show the subscription limit meters at all. */
	showLimits: true,
	/** Render +0,-0 in a clean repo. When false, the segment only appears once something changes. */
	alwaysShowDiff: true,
	/** Minimum gap between git invocations, in ms. */
	gitPollMs: 2000,
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
		/** Statuses other extensions publish via ctx.ui.setStatus(). */
		status: "warning",
		separator: "dim",
		label: "muted",
		barFill: "accent",
		barTrack: "dim",
		barWarn: "warning",
		barError: "error",
		cached: "mdCode",
		out: "warning",
		reset: "dim",
		/** Active workflow runs, appended below everything else. */
		workflow: "accent",
	} satisfies Record<string, ColorSpec>,
};
