/**
 * Rendering the subagents table — Subagent | Model | Reasoning | Purpose — the
 * panel shown by /subagents. Pure: it takes already-resolved display rows and
 * returns aligned monospace lines, so it is testable without a session or a
 * model registry.
 */

export interface PanelRow {
	name: string;
	/** Effective model display: a resolved id, "(session default)", or "⚠ <ref>". */
	model: string;
	/** Reasoning display, already formatted (e.g. "High"), or "—". */
	reasoning: string;
	purpose: string;
}

/** Title-case a thinking level for the Reasoning column ("high" -> "High"). */
export function formatReasoning(level: string | undefined): string {
	if (!level) return "—";
	return level.charAt(0).toUpperCase() + level.slice(1);
}

function pad(text: string, width: number): string {
	return text.length >= width ? text : text + " ".repeat(width - text.length);
}

function widthOf(rows: PanelRow[], key: keyof PanelRow, header: string): number {
	return rows.reduce((max, row) => Math.max(max, row[key].length), header.length);
}

/**
 * The aligned table. `purposeCap` clips the last column so a long purpose does
 * not blow out the width; it is the only column allowed to be clipped because
 * it is the only free-text one.
 */
export function tableLines(rows: PanelRow[], purposeCap = 60): string[] {
	if (rows.length === 0) {
		return ["No subagents configured. Add them under \"subagents\" in agent/settings.json."];
	}

	const clipped = rows.map((row) => ({
		...row,
		purpose: row.purpose.length > purposeCap ? `${row.purpose.slice(0, purposeCap - 1)}…` : row.purpose,
	}));

	const nameW = widthOf(clipped, "name", "Subagent");
	const modelW = widthOf(clipped, "model", "Model");
	const reasonW = widthOf(clipped, "reasoning", "Reasoning");

	const header = `${pad("Subagent", nameW)}  ${pad("Model", modelW)}  ${pad("Reasoning", reasonW)}  Purpose`;
	const rule = "─".repeat(header.length);
	const body = clipped.map(
		(row) => `${pad(row.name, nameW)}  ${pad(row.model, modelW)}  ${pad(row.reasoning, reasonW)}  ${row.purpose}`,
	);
	return [header, rule, ...body];
}
