/**
 * The bar — runs in the isolated world, so the page's scripts cannot reach
 * it, and draws in a closed shadow root, so the page's styles cannot either.
 *
 * Hover outlines an element and names it; a click adds it to the set (click
 * again removes it); ArrowUp climbs to the parent when the leaf is a wrapper
 * or an icon, ArrowDown comes back. The set sits in the bar as chips. Send
 * takes the text along and starts a turn in pi; Attach holds the set there
 * for the next prompt typed in pi. Esc closes and clears.
 *
 * Source locations come from resolve.js in the page's world, asked for by
 * number through postMessage; a build plugin's data-insp-path attribute is
 * read here directly and wins when present. Every privileged step — the
 * native host, the screenshot — is a message to the service worker.
 *
 * Running this file again toggles the bar; it never installs twice. A bar
 * left by an earlier extension world — the extension was reloaded — cannot
 * be reached through window, so a DOM event tells it to leave: those cross
 * worlds, and an orphan that kept its capture listeners would swallow every
 * press on the page.
 */

(() => {
	if (window.__piPointerBar) {
		window.__piPointerBar.toggle();
		return;
	}
	document.dispatchEvent(new CustomEvent("pi-pointer:supersede"));
	for (const stale of document.querySelectorAll("pi-pointer-host")) stale.remove();

	const host = document.createElement("pi-pointer-host");
	host.style.cssText = "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
	// What happens inside the bar stays there: a keystroke in the text box
	// must not reach the page's hotkeys, a press on Send must not read as an
	// outside click to a menu or dialog, and focus moving into the box must
	// not be pulled back by a focus trap. The bar's own document listeners
	// run in the capture phase, before any of this.
	for (const type of ["focusin", "focusout", "keydown", "keyup", "keypress", "pointerdown", "pointerup", "mousedown", "mouseup", "click"]) {
		host.addEventListener(type, (event) => event.stopPropagation());
	}
	const root = host.attachShadow({ mode: "closed" });
	root.innerHTML = `
<style>
	:host { all: initial; }
	* { box-sizing: border-box; font: 12px/1.4 -apple-system, "Segoe UI", system-ui, sans-serif; color: #e6e6e6; }
	.hl { position: fixed; pointer-events: none; outline: 2px solid #ff3b30; outline-offset: -1px; background: rgba(255,59,48,.08); display: none; }
	.tag { position: fixed; pointer-events: none; background: #ff3b30; color: #fff; padding: 2px 6px; border-radius: 3px; white-space: nowrap; display: none; font-weight: 600; }
	.bar { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%); width: min(720px, calc(100vw - 32px)); pointer-events: auto;
	       background: #1e1f22; border: 1px solid #3a3b3f; border-radius: 10px; box-shadow: 0 8px 32px rgba(0,0,0,.45); padding: 10px 12px; display: grid; gap: 8px; }
	.row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
	.chips:empty::before { content: "Click an element on the page to add it."; color: #8a8d93; }
	.chip { display: inline-flex; align-items: center; gap: 6px; background: #2b2d31; border: 1px solid #3a3b3f; border-radius: 999px; padding: 3px 8px 3px 10px; cursor: pointer; }
	.chip .at { color: #8a8d93; }
	.chip .x { color: #8a8d93; cursor: pointer; padding: 0 2px; }
	.chip .x:hover { color: #fff; }
	.chip.pending .at { font-style: italic; }
	select { background: #2b2d31; color: #e6e6e6; border: 1px solid #3a3b3f; border-radius: 6px; padding: 4px 6px; max-width: 100%; }
	.status { color: #8a8d93; }
	.status.bad { color: #ff6b62; }
	.status.good { color: #5ac26a; }
	textarea { width: 100%; min-height: 40px; max-height: 160px; resize: vertical; background: #141517; color: #e6e6e6; border: 1px solid #3a3b3f; border-radius: 6px; padding: 6px 8px; }
	textarea:focus { outline: 1px solid #5b8def; }
	.actions { justify-content: flex-end; }
	.hint { color: #8a8d93; margin-right: auto; }
	button { background: #2b2d31; color: #e6e6e6; border: 1px solid #3a3b3f; border-radius: 6px; padding: 5px 12px; cursor: pointer; }
	button:hover { background: #35373c; }
	button.send { background: #5b8def; border-color: #5b8def; color: #fff; }
	button.send:hover { background: #4a7de0; }
	button:disabled { opacity: .5; cursor: default; }
</style>
<div class="hl"></div><div class="tag"></div>
<div class="bar">
	<div class="row chips"></div>
	<div class="row"><select class="session" title="Which pi session receives this"></select><span class="status"></span></div>
	<div class="row"><textarea placeholder="What should pi do with these? Enter sends · Shift+Enter for a new line"></textarea></div>
	<div class="row actions"><span class="hint">click adds · ↑ ↓ climb · Esc closes</span><button class="attach" title="Hold these in pi for your next prompt">Attach</button><button class="send" title="Send the instruction to pi now">Send ↵</button></div>
</div>`;

	const $ = (selector) => root.querySelector(selector);
	const hl = $(".hl");
	const tag = $(".tag");
	const chips = $(".chips");
	const select = $(".session");
	const status = $(".status");
	const textarea = $("textarea");
	const buttons = { attach: $(".attach"), send: $(".send") };

	const say = (text, tone = "") => {
		status.textContent = text;
		status.className = `status ${tone}`;
	};

	// ---------------------------------------------------------------- resolving

	let seq = 0;
	const answers = new Map();
	/** Answers per element, for one opening of the bar: an edit moves lines, and Fast Refresh keeps the nodes. */
	let resolved = new WeakMap();

	window.addEventListener("message", (event) => {
		if (event.source !== window || !event.data || typeof event.data !== "object") return;
		const data = event.data;
		if (data.__piPointer === "resolve:reply" && answers.has(data.n)) {
			const settle = answers.get(data.n);
			answers.delete(data.n);
			settle({
				source: data.source && typeof data.source.file === "string" && typeof data.source.line === "number" ? data.source : null,
				owners: Array.isArray(data.owners) ? data.owners.filter((name) => typeof name === "string").slice(0, 8) : [],
			});
		}
		if (data.__piPointer === "root:reply" && answers.has("root")) {
			const settle = answers.get("root");
			answers.delete("root");
			settle(typeof data.root === "string" ? data.root : null);
		}
	});

	const askPage = (message, key, timeoutMs) =>
		new Promise((resolve) => {
			const timer = setTimeout(() => {
				answers.delete(key);
				resolve(null);
			}, timeoutMs);
			answers.set(key, (value) => {
				clearTimeout(timer);
				resolve(value);
			});
			window.postMessage(message, "*");
		});

	/**
	 * A build plugin's own answer, exact per element. code-inspector-plugin
	 * writes `path:line:column:node`; TanStack's devtools write
	 * `path:line:column`. The path may hold colons of its own, so it is
	 * whatever is left once the numbers are taken off the end.
	 */
	const attrSource = (el) => {
		const insp = el.getAttribute("data-insp-path");
		const parts = insp ? insp.split(":").slice(0, -1) : (el.getAttribute("data-tsd-source") || "").split(":");
		if (parts.length < 3) return null;
		const column = Number(parts[parts.length - 1]);
		const line = Number(parts[parts.length - 2]);
		const file = parts.slice(0, -2).join(":").replace(/^\/(?=src\/)/, "");
		return file && Number.isFinite(line) ? { file, line, column: Number.isFinite(column) ? column : undefined, via: "attr" } : null;
	};

	const resolve = (el) => {
		let promise = resolved.get(el);
		if (promise) return promise;
		const n = ++seq;
		el.setAttribute("data-pi-pointer", String(n));
		promise = askPage({ __piPointer: "resolve", n }, n, 3000)
			.then((answer) => {
				// No answer in time is not an answer: the next ask may get one.
				if (!answer) resolved.delete(el);
				const fromPage = answer || { source: null, owners: [] };
				return { source: attrSource(el) || fromPage.source, owners: fromPage.owners };
			})
			.finally(() => el.removeAttribute("data-pi-pointer"));
		resolved.set(el, promise);
		return promise;
	};

	const shortFile = (file) => file.slice(file.lastIndexOf("/") + 1);
	const nameOf = (el, info) => (info && info.owners[0]) || `<${el.tagName.toLowerCase()}>`;
	const placeOf = (info) => (info && info.source ? `${shortFile(info.source.file)}:${info.source.line}` : "");

	/** A CSS path that finds this element again: ids anchor it, classes and position do the rest. */
	const cssPath = (el) => {
		const steps = [];
		for (let node = el; node && node.nodeType === 1 && steps.length < 8; node = node.parentElement) {
			const tagName = node.tagName.toLowerCase();
			if (node.id && !/\s/.test(node.id)) {
				steps.unshift(`${tagName}#${CSS.escape(node.id)}`);
				break;
			}
			let step = tagName;
			const classes = [...node.classList].filter((c) => !/[:[\]()]/.test(c)).slice(0, 2);
			if (classes.length) step += `.${classes.map((c) => CSS.escape(c)).join(".")}`;
			const parent = node.parentElement;
			if (parent) {
				const siblings = [...parent.children].filter((child) => child.tagName === node.tagName);
				if (siblings.length > 1) step += `:nth-of-type(${siblings.indexOf(node) + 1})`;
			}
			steps.unshift(step);
			if (tagName === "body") break;
		}
		return steps.join(" > ");
	};

	// ---------------------------------------------------------------- picking

	let visible = false;
	let hover = null;
	/** Set by an arrow climb; the mouse has to travel before hover follows it again. */
	let pinned = null;
	const climbed = [];
	const selected = [];

	const outline = (el) => {
		if (!el) {
			hl.style.display = "none";
			tag.style.display = "none";
			return;
		}
		const r = el.getBoundingClientRect();
		Object.assign(hl.style, { display: "block", left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
		const top = r.top > 24 ? r.top - 22 : r.bottom + 2;
		Object.assign(tag.style, { display: "block", left: `${Math.max(0, r.left)}px`, top: `${top}px` });
	};

	const describe = (el, info) => {
		const place = placeOf(info);
		tag.textContent = place ? `${nameOf(el, info)} · ${place}` : nameOf(el, info);
	};

	const setHover = (el) => {
		hover = el;
		climbed.length = 0;
		outline(el);
		if (!el) return;
		describe(el, null);
		resolve(el).then((info) => {
			if (hover === el) describe(el, info);
		});
	};

	const isOurs = (event) => event.composedPath().includes(host);

	const underPointer = (event) => {
		const el = document.elementFromPoint(event.clientX, event.clientY);
		return !el || el === host ? null : el;
	};

	const onMove = (event) => {
		if (!visible) return;
		if (pinned) {
			if (Math.hypot(event.clientX - pinned.x, event.clientY - pinned.y) < 8) return;
			pinned = null;
		}
		const el = underPointer(event);
		if (el !== hover) setHover(el);
	};

	const renderChips = () => {
		chips.textContent = "";
		for (const entry of selected) {
			const chip = document.createElement("span");
			chip.className = entry.info ? "chip" : "chip pending";
			const name = document.createElement("span");
			name.textContent = nameOf(entry.el, entry.info);
			const at = document.createElement("span");
			at.className = "at";
			at.textContent = entry.info ? placeOf(entry.info) || "no source" : "…";
			const x = document.createElement("span");
			x.className = "x";
			x.textContent = "×";
			x.title = "Remove";
			x.addEventListener("click", (event) => {
				event.stopPropagation();
				selected.splice(selected.indexOf(entry), 1);
				renderChips();
			});
			chip.title = entry.info && entry.info.source ? `${entry.info.source.file}:${entry.info.source.line}` : entry.el.tagName.toLowerCase();
			chip.addEventListener("click", () => {
				entry.el.scrollIntoView({ block: "center", behavior: "smooth" });
				pinned = { x: -1e9, y: -1e9 };
				hover = entry.el;
				outline(entry.el);
				describe(entry.el, entry.info);
			});
			chip.append(name, at, x);
			chips.append(chip);
		}
	};

	const toggleSelect = (el) => {
		const index = selected.findIndex((entry) => entry.el === el);
		if (index >= 0) {
			selected.splice(index, 1);
			renderChips();
			return;
		}
		const entry = { el, info: null };
		selected.push(entry);
		renderChips();
		resolve(el).then((info) => {
			entry.info = info;
			renderChips();
		});
	};

	/**
	 * Selection happens on pointerdown, not click: Chrome fires no mousedown
	 * or click on a disabled control, and a disabled button is a common thing
	 * to point at — pointer events still arrive there. Cancelling pointerdown
	 * also stops the compat mouse events; the rest are swallowed too, so the
	 * page sees none of the press.
	 */
	const onPress = (event) => {
		if (!visible || isOurs(event)) return;
		event.preventDefault();
		event.stopImmediatePropagation();
		if (event.type !== "pointerdown") return;
		// What is under the pointer NOW, not the last hover: a press can arrive
		// before the move that preceded it was seen. Only an arrow climb makes
		// the hover the truth, and that is what pinned records.
		const el = (pinned ? hover : underPointer(event)) || hover;
		if (el) toggleSelect(el);
	};

	const climb = (up) => {
		if (!hover) return;
		let next;
		if (up) {
			next = hover.parentElement;
			if (!next || next === document.documentElement) return;
			climbed.push(hover);
		} else {
			next = climbed.pop();
			if (!next) return;
		}
		hover = next;
		outline(next);
		describe(next, null);
		resolve(next).then((info) => {
			if (hover === next) describe(next, info);
		});
	};

	const onKey = (event) => {
		if (!visible) return;
		if (event.key === "Escape") {
			event.preventDefault();
			hide();
			return;
		}
		if (isOurs(event)) return;
		if (event.key === "ArrowUp" || event.key === "ArrowDown") {
			event.preventDefault();
			if (!pinned) pinned = { x: lastPointer.x, y: lastPointer.y };
			climb(event.key === "ArrowUp");
		}
	};

	const lastPointer = { x: 0, y: 0 };
	const track = (event) => {
		lastPointer.x = event.clientX;
		lastPointer.y = event.clientY;
	};

	// ---------------------------------------------------------------- sessions

	const wellKnownRoot = async () => {
		try {
			const response = await fetch(`${location.origin}/.well-known/appspecific/com.chrome.devtools.json`, { headers: { Accept: "application/json" } });
			if (!response.ok || !/json/i.test(response.headers.get("content-type") || "")) return null;
			const body = await response.json();
			return body && body.workspace && typeof body.workspace.root === "string" ? body.workspace.root : null;
		} catch {
			return null;
		}
	};

	const shortDir = (dir) => {
		const parts = dir.split("/").filter(Boolean);
		return parts.length > 2 ? `…/${parts.slice(-2).join("/")}` : dir;
	};

	const refreshPeers = async () => {
		say("looking for pi sessions…");
		const root = (await wellKnownRoot()) || (await askPage({ __piPointer: "root" }, "root", 1000));
		let reply;
		try {
			reply = await chrome.runtime.sendMessage({ type: "peers", origin: location.origin, root });
		} catch (error) {
			reply = { error: String(error && error.message ? error.message : error) };
		}
		select.textContent = "";
		if (!reply || reply.error) {
			say(reply && reply.error ? reply.error : "no answer from the extension", "bad");
			return;
		}
		const peers = Array.isArray(reply.peers) ? reply.peers : [];
		const matches = peers.filter((peer) => peer.match);
		for (const peer of [...matches, ...peers.filter((peer) => !peer.match)]) {
			const option = document.createElement("option");
			option.value = peer.id;
			option.textContent = `pi: ${peer.name} · ${shortDir(peer.cwd)}${peer.idle ? "" : " · working"}${peer.match ? "" : " · other project"}`;
			option.title = peer.cwd;
			select.append(option);
		}
		if (peers.length === 0) say("no live pi session — start pi with intercom and pointer loaded", "bad");
		else if (matches.length === 1) say(`${peers.length === 1 ? "one session" : "matched"} · ${shortDir(reply.root || "")}`.trim());
		else if (matches.length > 1) say(`${matches.length} sessions hold this project — pick one`);
		else say(reply.root ? `no session in ${shortDir(reply.root)} — pick one` : "project not detected — pick a session");
	};

	// ---------------------------------------------------------------- sending

	let busy = false;

	const submit = async (mode) => {
		if (busy) return;
		if (selected.length === 0) return say("select an element first", "bad");
		const text = textarea.value.trim();
		if (mode === "send" && !text) return say("type what pi should do", "bad");
		const to = select.value;
		if (!to) return say("no pi session to send to", "bad");
		busy = true;
		buttons.attach.disabled = buttons.send.disabled = true;
		say(mode === "send" ? "sending…" : "attaching…");
		const infos = await Promise.all(selected.map((entry) => resolve(entry.el)));
		const elements = selected.map((entry, i) => ({
			tag: entry.el.tagName.toLowerCase(),
			selector: cssPath(entry.el),
			html: entry.el.outerHTML,
			source: infos[i].source || undefined,
			owners: infos[i].owners,
		}));
		const rects = selected.map((entry) => {
			const r = entry.el.getBoundingClientRect();
			return { x: r.left, y: r.top, width: r.width, height: r.height };
		});
		// The shot must not show the bar or the outline: hide, give the page
		// time to paint, shoot, show. A timer rather than an animation frame —
		// a tab that is not visible never gets a frame, and would hang here.
		outline(null);
		host.style.display = "none";
		await new Promise((done) => setTimeout(done, 80));
		let reply;
		try {
			reply = await chrome.runtime.sendMessage({
				type: "point",
				to,
				point: { mode, text, page: { url: location.href, title: document.title }, elements },
				rects,
				ratio: window.devicePixelRatio || 1,
			});
		} catch (error) {
			reply = { ok: false, reason: String(error && error.message ? error.message : error) };
		}
		host.style.display = "";
		busy = false;
		buttons.attach.disabled = buttons.send.disabled = false;
		if (!reply || !reply.ok) return say(reply && reply.reason ? reply.reason : "no answer from the extension", "bad");
		selected.length = 0;
		renderChips();
		// pi is about to edit; what was learned about this page is now history.
		forget();
		if (mode === "send") textarea.value = "";
		say(
			reply.delivery === "turn" ? "sent — pi is on it" : reply.delivery === "followUp" ? "queued — pi is busy, it follows the current run" : "attached — type your ask in pi",
			"good",
		);
	};

	buttons.send.addEventListener("click", () => submit("send"));
	buttons.attach.addEventListener("click", () => submit("attach"));
	textarea.addEventListener("keydown", (event) => {
		if (event.key === "Enter" && !event.shiftKey) {
			event.preventDefault();
			submit("send");
		}
	});

	// ---------------------------------------------------------------- show / hide

	const listeners = [
		["mousemove", onMove],
		["mousemove", track],
		["pointerdown", onPress],
		["mousedown", onPress],
		["mouseup", onPress],
		["click", onPress],
		["keydown", onKey],
	];

	const forget = () => {
		resolved = new WeakMap();
		window.postMessage({ __piPointer: "reset" }, "*");
	};

	const show = () => {
		if (visible) return;
		visible = true;
		forget();
		host.style.display = "";
		if (!host.isConnected) document.documentElement.append(host);
		for (const [type, fn] of listeners) document.addEventListener(type, fn, true);
		refreshPeers();
	};

	const hide = () => {
		if (!visible) return;
		visible = false;
		for (const [type, fn] of listeners) document.removeEventListener(type, fn, true);
		setHover(null);
		pinned = null;
		selected.length = 0;
		renderChips();
		host.remove();
	};

	document.addEventListener("pi-pointer:supersede", hide);
	window.__piPointerBar = { toggle: () => (visible ? hide() : show()) };
	show();
})();
