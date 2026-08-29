/**
 * The service worker: the only part of the extension with chrome.* APIs.
 *
 * The action click (or Alt+Shift+P) is the gesture that grants activeTab —
 * enough to inject into the page and to photograph it, with no host
 * permission on any site. Two scripts go in: resolve.js into the page's own
 * world, where React's fibers are visible, and bar.js into the isolated world,
 * where the UI lives and the page cannot reach it.
 *
 * Everything to pi goes through one native messaging port. Chrome spawns the
 * host on connect and keeps it until this worker goes idle; the next request
 * reconnects. Requests carry an id so replies can be matched.
 */

const HOST = "com.pi.pointer";

let port = null;
let seq = 0;
const waiting = new Map();

function connect() {
	if (port) return port;
	port = chrome.runtime.connectNative(HOST);
	port.onMessage.addListener((message) => {
		const pending = waiting.get(message?.id);
		if (!pending) return;
		waiting.delete(message.id);
		pending.resolve(message);
	});
	port.onDisconnect.addListener(() => {
		const reason = chrome.runtime.lastError?.message || "the pi host closed the connection";
		port = null;
		for (const pending of waiting.values()) pending.reject(new Error(reason));
		waiting.clear();
	});
	return port;
}

function ask(message) {
	return new Promise((resolve, reject) => {
		const id = ++seq;
		waiting.set(id, { resolve, reject });
		try {
			connect().postMessage({ id, ...message });
		} catch (error) {
			waiting.delete(id);
			port = null;
			reject(error);
		}
	});
}

function friendly(error) {
	const text = String(error?.message || error);
	if (/host not found/i.test(text)) return "pi host not installed — run /pointer install in pi, then restart the browser.";
	if (/forbidden/i.test(text)) return "this extension id is not allowed by the host manifest — run /pointer install again.";
	return text;
}

chrome.action.onClicked.addListener(async (tab) => {
	if (!tab.id) return;
	try {
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["resolve.js"], world: "MAIN" });
		await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ["bar.js"] });
	} catch (error) {
		console.warn("pi pointer cannot run on this page:", error);
	}
});

/**
 * One viewport shot at device pixels, every selection outlined on it. The
 * rects arrive in CSS pixels, so they scale by the page's ratio.
 */
async function shoot(windowId, rects, ratio) {
	const url = await chrome.tabs.captureVisibleTab(windowId, { format: "png" });
	const bitmap = await createImageBitmap(await (await fetch(url)).blob());
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
	const g = canvas.getContext("2d");
	g.drawImage(bitmap, 0, 0);
	g.lineWidth = 3 * ratio;
	g.strokeStyle = "#ff3b30";
	for (const r of rects) g.strokeRect(r.x * ratio, r.y * ratio, r.width * ratio, r.height * ratio);
	const bytes = new Uint8Array(await (await canvas.convertToBlob({ type: "image/png" })).arrayBuffer());
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
	return { data: btoa(binary), mimeType: "image/png" };
}

async function point(sender, message) {
	const body = { ...message.point };
	if (sender.tab && message.rects?.length) body.image = await shoot(sender.tab.windowId, message.rects, message.ratio || 1);
	return ask({ type: "point", to: message.to, point: body });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
	if (message?.type === "peers") {
		ask({ type: "peers", origin: message.origin, root: message.root ?? null }).then(reply, (error) => reply({ type: "peers", error: friendly(error) }));
		return true;
	}
	if (message?.type === "point") {
		point(sender, message).then(reply, (error) => reply({ type: "result", ok: false, reason: friendly(error) }));
		return true;
	}
	return false;
});
