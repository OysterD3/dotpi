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
 * pi.events channel the dynamic-workflow extension announces its active workflow runs
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

/**
 * pi.events channel the dynamic-workflow extension announces its /workflows control
 * panel on. Payload: `{ active: boolean }`.
 *
 * The panel takes the editor's place the way a question does, so this footer —
 * including the run lines it appends from WORKFLOW_CHANNEL — stands down for
 * it. Its own channel rather than ASK_CHANNEL: nothing is waiting on a human,
 * so the subscribers that act on that must not fire. Declared here rather than
 * imported, as above.
 */
export const WORKFLOW_PANEL_CHANNEL = "ultracode:panel-open";

/**
 * pi.events channels the background-shell extension announces on, mirroring
 * ultracode's pair exactly: one carries a line per running shell to append
 * below everything else (`{ lines: string[] | undefined }`), the other says
 * its shift+up panel holds the editor slot (`{ active: boolean }`) so this
 * footer stands down for it. Declared here rather than imported, as above.
 */
export const SHELL_CHANNEL = "background-shell:lines";
export const SHELL_PANEL_CHANNEL = "background-shell:panel-open";

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
