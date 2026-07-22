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
	} satisfies Record<string, ColorSpec>,
};
