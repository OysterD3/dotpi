/**
 * The transcript line a diet round leaves behind: "◍ Context diet — dropped 38
 * stale results, 221k → 149k".
 *
 * A custom entry, so it never reaches the model, and it appears only on the
 * calls where a round actually ran — not on the many calls that merely re-apply
 * evictions already decided. A marker that sat there permanently would be
 * reporting a state, not an event.
 *
 * The wording lives in diet.ts; this file is only the pixels, so everything
 * worth asserting can be tested without pi's TUI runtime.
 */
import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { type DietEntry, dietLine } from "./diet.ts";

export function renderDiet(entry: DietEntry, theme: Theme): Text {
	return new Text(theme.fg("muted", `◍ ${dietLine(entry)}`), 0, 0);
}
