/**
 * What each depth means, and the angles a sweep can take, in one table each.
 *
 * Depth buys two different things and they are deliberately separate columns:
 * how much gets FETCHED (angles × perAngle, paid by the session agent, which is
 * the only thing here with web access) and how hard the evidence is CHECKED
 * (refute). A quick pass that still refutes would spend its budget arguing
 * about three sources; a deep pass that fetched forty and believed all of them
 * is a bibliography, not research.
 */

export const DEPTHS = ["quick", "standard", "deep"] as const;
export type Depth = (typeof DEPTHS)[number];

export type FanOut = "workflow" | "task" | "none";

export type DepthSpec = {
	/** How many of the angles below the sweep takes, cheapest coverage first. */
	angles: number;
	/** Sources fetched per angle. */
	perAngle: number;
	/**
	 * Whether the answer goes through a refutation pass before it is written.
	 *
	 * Three lenses, majority rules. This is what separates deep from standard,
	 * and it is the only stage that can throw the answer away.
	 */
	refute: boolean;
};

export const DEPTH_SPECS: Record<Depth, DepthSpec> = {
	quick: { angles: 3, perAngle: 3, refute: false },
	standard: { angles: 5, perAngle: 4, refute: false },
	deep: { angles: 8, perAngle: 5, refute: true },
};

/**
 * The sweep angles, cheapest coverage first.
 *
 * These are MODALITIES, not topics: each one searches a different way, so what
 * one is structurally blind to another finds. A single well-phrased query run
 * five times is one angle run five times — it returns the same consensus with
 * more citations, which reads as corroboration and is not.
 *
 * `provenance` is last and is the one people skip. It is also the only angle
 * that can explain why the other seven agree.
 */
export const ANGLES = [
	{ key: "definition", brief: "what the thing actually is — canonical description, in its own terms" },
	{ key: "primary", brief: "primary sources only: the spec, the RFC, the paper, the official docs, the source" },
	{ key: "counter", brief: "the strongest case AGAINST, known failure modes, retractions, criticism by name" },
	{ key: "practice", brief: "practitioners who shipped it — postmortems, issue threads, what surprised them" },
	{ key: "recent", brief: "what changed in the last 12 months; anything dated, anything superseded" },
	{ key: "numbers", brief: "measurements: benchmarks, published data, sample sizes, what was measured" },
	{ key: "alternatives", brief: "what else solves this, and on what axis it is chosen instead" },
	{ key: "provenance", brief: "who is making the claim and what they gain if it is believed" },
] as const;

export const CONFIG = {
	defaultDepth: "standard" as Depth,
	/**
	 * The scratchpad extension's announcement channel, duplicated rather than
	 * imported: every extension here installs independently, and a research run
	 * with no scratchpad must fall back rather than fail to load.
	 */
	scratchChannel: "scratchpad:dir",
	/** Where the report lands, relative to the project. */
	outDir: "docs/research",
	/** The saved workflow (agent/workflows/<name>.js) that reads the sources. */
	workflow: "deep-research",
	/**
	 * Fan-out tools, best first. `workflow` runs the whole read/cross/write
	 * fleet from one script with a real gate, so it wins wherever both are on.
	 */
	fanOutTools: ["workflow", "task"] as const satisfies readonly FanOut[],
};

/** The angles a given depth sweeps. */
export function anglesFor(depth: Depth): readonly (typeof ANGLES)[number][] {
	return ANGLES.slice(0, DEPTH_SPECS[depth].angles);
}

/** How many sources a depth expects to fetch, which is also the reader fan-out. */
export function sourceBudget(depth: Depth): number {
	const spec = DEPTH_SPECS[depth];
	return spec.angles * spec.perAngle;
}
