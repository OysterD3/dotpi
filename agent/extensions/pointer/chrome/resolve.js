/**
 * Runs in the page's own world, where a DOM node's React fiber is visible.
 * Answers one question for the bar: where in the source does this element
 * come from, and which components rendered it.
 *
 * Three routes, in order of trust:
 *   1. React 18's fiber._debugSource — file, line, column, done.
 *   2. React 19's fiber._debugStack — an Error captured where the JSX was
 *      created. Its first frame outside React and the bundler is the JSX
 *      site in the TRANSFORMED module, so it is symbolicated through the
 *      module's source map: inline on Vite, a sibling .map on Next, or the
 *      dev server's map endpoint for webpack-internal frames.
 *   3. When every frame is a library's (a UI-kit Button rendering the div),
 *      the owner's own stack — where <Button> was written in the app.
 *
 * This world has no chrome.* APIs and the page can see it, so it speaks to
 * the bar only through window.postMessage and only ever returns plain data.
 * The pure parts sit on `PiPointerSymbols` so they can be run under node.
 */

(() => {
	const symbols = {};

	// ---------------------------------------------------------------- stacks

	const FRAME = /(?:\(|\s|^)((?:https?:|webpack-internal:|file:)\S+?):(\d+):(\d+)\)?$/;
	const NOT_USER = /node_modules|\/@vite\/|\/@react-refresh|\/@id\/|react-stack-bottom-frame|\/\.vite\//;

	/** The first frame that is the app's own, in transformed coordinates. */
	symbols.userFrame = (stack) => {
		if (typeof stack !== "string") return null;
		for (const line of stack.split("\n")) {
			const match = FRAME.exec(line.trim());
			if (!match || NOT_USER.test(match[1])) continue;
			return { url: match[1], line: Number(match[2]), column: Number(match[3]) };
		}
		return null;
	};

	// ---------------------------------------------------------------- source maps

	const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

	/** Decode `mappings` into, per generated line, sorted [genCol, src, origLine, origCol] segments. */
	symbols.decodeMappings = (mappings) => {
		const lines = [];
		let segments = [];
		let src = 0;
		let origLine = 0;
		let origCol = 0;
		let genCol = 0;
		let fields = [];
		let value = 0;
		let shift = 0;
		for (let i = 0; i <= mappings.length; i++) {
			const ch = mappings[i];
			if (ch === undefined || ch === ";" || ch === ",") {
				if (fields.length >= 4) {
					genCol += fields[0];
					src += fields[1];
					origLine += fields[2];
					origCol += fields[3];
					segments.push([genCol, src, origLine, origCol]);
				} else if (fields.length === 1) {
					genCol += fields[0];
				}
				fields = [];
				if (ch === ";" || ch === undefined) {
					lines.push(segments);
					segments = [];
					genCol = 0;
				}
				continue;
			}
			const digit = BASE64.indexOf(ch);
			if (digit < 0) continue;
			value += (digit & 31) << shift;
			if (digit & 32) {
				shift += 5;
				continue;
			}
			fields.push(value & 1 ? -(value >> 1) : value >> 1);
			value = 0;
			shift = 0;
		}
		return lines;
	};

	const decoded = new WeakMap();
	const linesOf = (map) => {
		let lines = decoded.get(map);
		if (!lines) {
			lines = symbols.decodeMappings(map.mappings || "");
			decoded.set(map, lines);
		}
		return lines;
	};

	/**
	 * Original position for a 0-based generated line and column. The segment
	 * is the last one at or before the column; a line with nothing before the
	 * column takes its first, which is the nearest thing to right.
	 */
	symbols.lookup = (map, line, column) => {
		if (Array.isArray(map.sections)) {
			let section = null;
			for (const candidate of map.sections) {
				const at = candidate.offset;
				if (at.line < line || (at.line === line && at.column <= column)) section = candidate;
			}
			if (!section) return null;
			const at = section.offset;
			return symbols.lookup(section.map, line - at.line, line === at.line ? column - at.column : column);
		}
		const segments = linesOf(map)[line];
		if (!segments || segments.length === 0) return null;
		let hit = segments[0];
		for (const segment of segments) {
			if (segment[0] > column) break;
			hit = segment;
		}
		const source = (map.sources || [])[hit[1]];
		if (typeof source !== "string") return null;
		return { source, sourceRoot: map.sourceRoot || "", line: hit[2], column: hit[3] };
	};

	/**
	 * A path pi can open. Absolute stays absolute (Next's maps are); a
	 * relative source is resolved against the map's own URL and given back
	 * root-relative (Vite's are), or absolute again when it left the root
	 * through /@fs/.
	 */
	symbols.fileOf = (source, sourceRoot, mapUrl) => {
		let s = sourceRoot ? `${sourceRoot.replace(/\/?$/, "/")}${source}` : source;
		if (s.startsWith("file://")) return decodeURIComponent(new URL(s).pathname);
		if (s.startsWith("webpack://")) return s.slice("webpack://".length).replace(/^\/?(\.\/)?/, "");
		if (s.startsWith("/")) return s;
		let pathname;
		try {
			pathname = decodeURIComponent(new URL(s, mapUrl).pathname);
		} catch {
			return s;
		}
		if (pathname.startsWith("/@fs/")) return pathname.slice("/@fs".length);
		return pathname.replace(/^\//, "");
	};

	const MAP_COMMENT = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/;

	/** The source map behind a served module, and the URL it should be read relative to. */
	symbols.mapFor = async (url, fetcher) => {
		if (url.startsWith("webpack-internal:")) {
			const endpoint = `${location.origin}/__nextjs_source-map?filename=${encodeURIComponent(url)}`;
			const response = await fetcher(endpoint);
			if (!response.ok || response.status === 204) return null;
			return { map: await response.json(), mapUrl: endpoint };
		}
		const response = await fetcher(url);
		if (!response.ok) return null;
		const text = await response.text();
		const tail = text.slice(-1_000_000);
		let comment = null;
		for (const line of tail.split("\n")) {
			const match = MAP_COMMENT.exec(line.trim());
			if (match) comment = match[1];
		}
		if (!comment) return null;
		if (comment.startsWith("data:")) {
			const payload = comment.slice(comment.indexOf(",") + 1);
			const json = /;base64,/.test(comment) ? atob(payload) : decodeURIComponent(payload);
			return { map: JSON.parse(json), mapUrl: url };
		}
		const mapUrl = new URL(comment, url).href;
		const mapResponse = await fetcher(mapUrl);
		if (!mapResponse.ok) return null;
		return { map: await mapResponse.json(), mapUrl };
	};

	/**
	 * Maps by module URL. Cleared each time the bar opens: a module's URL is
	 * stable across recompiles on Next, so a map held for the page's life
	 * would answer from before the edit pi just made. A miss is never kept —
	 * Next answers 204 until a module is compiled, and that is not forever.
	 */
	const maps = new Map();
	symbols.reset = () => maps.clear();

	/** Original file:line:column for a frame, or null when the map cannot say. */
	symbols.symbolicate = async (frame, fetcher = (u) => fetch(u)) => {
		let loading = maps.get(frame.url);
		if (!loading) {
			loading = symbols.mapFor(frame.url, fetcher).catch(() => null);
			maps.set(frame.url, loading);
		}
		const found = await loading;
		if (!found) {
			maps.delete(frame.url);
			return null;
		}
		const hit = symbols.lookup(found.map, frame.line - 1, frame.column - 1);
		if (!hit) return null;
		return { file: symbols.fileOf(hit.source, hit.sourceRoot, found.mapUrl), line: hit.line + 1, column: hit.column + 1 };
	};

	// ---------------------------------------------------------------- fibers

	const fiberOf = (el) => {
		const key = Object.keys(el).find((k) => k.startsWith("__reactFiber$"));
		return key ? el[key] : null;
	};

	const nameOf = (type) => {
		if (typeof type === "function") return type.displayName || type.name || null;
		if (type && typeof type === "object") return type.displayName || nameOf(type.render) || nameOf(type.type) || null;
		return null;
	};

	/** Component names up the owner chain, innermost first. Server components arrive as plain info objects. */
	const ownerNames = (fiber) => {
		const names = [];
		let owner = fiber._debugOwner;
		while (owner && names.length < 8) {
			const isFiber = typeof owner.tag === "number";
			const name = isFiber ? nameOf(owner.type) : owner.name;
			if (name) names.push(name);
			owner = isFiber ? owner._debugOwner : owner.owner;
		}
		return names;
	};

	const sourceOf = async (fiber, depth) => {
		if (!fiber || typeof fiber.tag !== "number") return null;
		const known = fiber._debugSource;
		if (known && typeof known.fileName === "string") {
			return { file: known.fileName, line: known.lineNumber, column: known.columnNumber, via: "debugSource" };
		}
		const frame = symbols.userFrame(fiber._debugStack?.stack);
		if (frame) {
			const mapped = await symbols.symbolicate(frame);
			if (mapped) return { ...mapped, via: "stack" };
		}
		return depth < 4 ? sourceOf(fiber._debugOwner, depth + 1) : null;
	};

	symbols.resolveElement = async (el) => {
		const fiber = fiberOf(el);
		if (!fiber) return { source: null, owners: [] };
		return { source: await sourceOf(fiber, 0), owners: ownerNames(fiber) };
	};

	// ---------------------------------------------------------------- wiring

	if (typeof window === "undefined") {
		globalThis.PiPointerSymbols = symbols;
		return;
	}
	if (window.__piPointerResolve) return;
	window.__piPointerResolve = true;

	window.addEventListener("message", async (event) => {
		if (event.source !== window || !event.data || typeof event.data !== "object") return;
		const data = event.data;
		if (data.__piPointer === "reset") {
			symbols.reset();
			return;
		}
		if (data.__piPointer === "root") {
			const root = window.__astro_dev_toolbar__?.root;
			window.postMessage({ __piPointer: "root:reply", root: typeof root === "string" ? root : null }, "*");
			return;
		}
		if (data.__piPointer === "resolve" && typeof data.n === "number") {
			const el = document.querySelector(`[data-pi-pointer="${data.n}"]`);
			let result = { source: null, owners: [] };
			try {
				if (el) result = await symbols.resolveElement(el);
			} catch {
				/* a page that breaks the walk still gets a DOM-only answer */
			}
			window.postMessage({ __piPointer: "resolve:reply", n: data.n, source: result.source, owners: result.owners }, "*");
		}
	});
})();
