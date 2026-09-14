import { randomUUID } from "node:crypto";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, extname, resolve } from "node:path";
import { StringEnum } from "@earendil-works/pi-ai";
import { VERSION, withFileMutationQueue, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";

const PROVIDER = "openai-codex";
const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses";
const DEFAULT_MODEL = "gpt-image-2.5-flare";
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

const parameters = Type.Object({
	prompt: Type.String({ minLength: 1, description: "Describe the image to generate." }),
	path: Type.String({ minLength: 1, description: "New PNG file path, relative to the working directory or absolute. Existing files are never overwritten." }),
	model: Type.Optional(StringEnum([DEFAULT_MODEL, "gpt-image-2.5-sunburst"] as const, {
		description: "Requested image model (default: gpt-image-2.5-flare). Codex may select another model; the result reports this.",
	})),
});
export type GenerateImageInput = Static<typeof parameters>;

type ImageItem = {
	type?: string;
	status?: string;
	result?: string;
	model?: string;
	output_format?: string;
};
type ImageEvent = {
	type?: string;
	item?: ImageItem;
	response?: {
		status?: string;
		tools?: { type?: string; model?: string }[];
		output?: ImageItem[];
	};
};

/** Parse SSE frames, including split UTF-8, CRLF, and multi-line data fields. */
async function* events(response: Response): AsyncGenerator<ImageEvent> {
	if (!response.body) throw new Error("Codex returned an empty image response.");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let pending = "";
	let data: string[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			pending += done ? decoder.decode() + "\n\n" : decoder.decode(value, { stream: true });
			let end: number;
			while ((end = pending.indexOf("\n")) !== -1) {
				const line = pending.slice(0, end).replace(/\r$/, "");
				pending = pending.slice(end + 1);
				if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
				else if (line === "" && data.length) {
					const text = data.join("\n");
					data = [];
					if (text !== "[DONE]") {
						let event: ImageEvent;
						try { event = JSON.parse(text) as ImageEvent; }
						catch { throw new Error("Codex returned malformed image stream data."); }
						if (!event || typeof event !== "object") throw new Error("Codex returned malformed image stream data.");
						yield event;
					}
				}
			}
			if (done) break;
		}
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}

async function receiveImage(response: Response) {
	let image: ImageItem | undefined;
	let reportedModel: string | undefined;
	for await (const event of events(response)) {
		const model = event.response?.tools?.find((tool) => tool.type === "image_generation")?.model;
		if (typeof model === "string" && model.trim()) reportedModel = model;
		if (["error", "response.failed", "response.incomplete"].includes(event.type ?? "")) {
			throw new Error(`Codex image generation failed (${event.type}). No image was saved.`);
		}
		if (event.type === "response.output_item.done" && event.item?.type === "image_generation_call") {
			image = event.item;
		}
		if (event.type !== "response.completed") continue;
		if (event.response?.status !== "completed") throw new Error("Codex did not complete image generation.");
		image = event.response.output?.find((item) => item.type === "image_generation_call") ?? image;
		if (image?.status !== "completed" || typeof image.result !== "string" || !image.result) {
			throw new Error("Codex completed without an image. No image was saved.");
		}
		if (typeof image.model === "string" && image.model.trim()) reportedModel = image.model;
		const bytes = Buffer.from(image.result, "base64");
		if (!bytes.subarray(0, 8).equals(PNG_SIGNATURE) || bytes.length < 24 ||
			bytes.toString("ascii", 12, 16) !== "IHDR" || !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20)) {
			throw new Error("Codex did not return a valid PNG image. No image was saved.");
		}
		return { bytes, reportedModel };
	}
	throw new Error("Codex image stream ended before completion. No image was saved.");
}

function accountId(token: string): string {
	try {
		const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
		const id = payload["https://api.openai.com/auth"]?.chatgpt_account_id;
		if (typeof id === "string" && id) return id;
	} catch {
		// Never expose a token, even when decoding fails.
	}
	throw new Error("Codex sign-in is not valid. Run /login openai-codex, then try again.");
}

async function requireNewFile(path: string) {
	try {
		await lstat(path);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
		throw error;
	}
	throw new Error(`File already exists: ${path}. Choose a new PNG path.`);
}

export default function imageGeneration(pi: ExtensionAPI) {
	pi.registerTool({
		name: "generate_image",
		label: "Generate image",
		description: "Generate one PNG through your existing OpenAI Codex (ChatGPT) sign-in, without an OpenAI API key. Uses your ChatGPT allowance. Defaults to requesting GPT Image 2.5 Flare, but Codex can replace the image model. Always reports the requested and server-reported model and warns on a mismatch or missing model. Text-to-image only; never overwrites an existing file.",
		promptSnippet: "Generate a PNG using ChatGPT/Codex sign-in, without an API key",
		promptGuidelines: ["When using generate_image, tell the user when Codex did not confirm the requested image model. Never label the returned image as GPT Image 2.5 unless the server reported that model."],
		parameters,
		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			if (!params.prompt.trim()) throw new Error("An image prompt is required.");
			const rawPath = params.path.replace(/^@/, "");
			const path = resolve(ctx.cwd, rawPath.startsWith("~/") ? resolve(homedir(), rawPath.slice(2)) : rawPath);
			if (extname(path).toLowerCase() !== ".png") throw new Error("The output path must end in .png.");
			const requestedModel = params.model ?? DEFAULT_MODEL;
			if (requestedModel !== DEFAULT_MODEL && requestedModel !== "gpt-image-2.5-sunburst") {
				throw new Error("Choose gpt-image-2.5-flare or gpt-image-2.5-sunburst.");
			}
			const driver = ctx.model?.provider === PROVIDER ? ctx.model : ctx.modelRegistry.find(PROVIDER, "gpt-5.5");
			if (!driver || !ctx.modelRegistry.isUsingOAuth(driver)) {
				throw new Error("Sign in with /login openai-codex first. No OpenAI API key is needed.");
			}

			return withFileMutationQueue(path, async () => {
				signal?.throwIfAborted();
				await requireNewFile(path);
				const auth = (await ctx.modelRegistry.getProviderAuth(PROVIDER))?.auth;
				if (!auth?.apiKey) throw new Error("Sign in with /login openai-codex first. No OpenAI API key is needed.");
				const id = accountId(auth.apiKey);
				const timeout = AbortSignal.timeout(300_000);
				const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
				requestSignal.throwIfAborted();
				onUpdate?.({ content: [{ type: "text", text: `Generating an image. Requested: ${requestedModel}. Codex may select another image model; ChatGPT usage limits apply.` }], details: { requestedModel } });
				const response = await fetch(ENDPOINT, {
					method: "POST",
					signal: requestSignal,
					redirect: "error",
					headers: {
						Authorization: `Bearer ${auth.apiKey}`,
						"chatgpt-account-id": id,
						originator: "pi",
						"User-Agent": `pi/${VERSION}`,
						"OpenAI-Beta": "responses=experimental",
						"Content-Type": "application/json",
						Accept: "text/event-stream",
						"session-id": randomUUID(),
					},
					body: JSON.stringify({
						model: driver.id,
						instructions: "Generate exactly one image with the image generation tool. Do not return prose.",
						input: [{ role: "user", content: [{ type: "input_text", text: params.prompt }] }],
						tools: [{ type: "image_generation", model: requestedModel, output_format: "png" }],
						tool_choice: "required",
						store: false,
						stream: true,
					}),
				});
				if (!response.ok) {
					await response.body?.cancel();
					const hint = response.status === 401 ? " Run /login openai-codex, then try again."
						: response.status === 403 ? " Your Codex account may not have image-generation access."
							: response.status === 429 ? " Your ChatGPT usage limit may have been reached. Try again later." : "";
					// Do not echo error bodies: a server or proxy can include credentials.
					throw new Error(`Codex image request failed (HTTP ${response.status}).${hint}`);
				}
				const { bytes, reportedModel } = await receiveImage(response);
				requestSignal.throwIfAborted();
				await mkdir(dirname(path), { recursive: true });
				await writeFile(path, bytes, { flag: "wx" });
				const modelConfirmed = reportedModel === requestedModel;
				const warning = modelConfirmed ? undefined : reportedModel
					? `Codex reported ${reportedModel}, not ${requestedModel}. The returned image was saved; the requested model was not confirmed.`
					: `Codex did not report an image model. The returned image was saved; ${requestedModel} was not confirmed.`;
				const text = [
					`Saved image: ${path}`,
					`Requested model: ${requestedModel}`,
					`Codex reported model: ${reportedModel ?? "unknown"}`,
					...(warning ? [`Warning: ${warning}`] : []),
				].join("\n");
				return {
					content: [
						{ type: "text" as const, text },
						{ type: "image" as const, data: bytes.toString("base64"), mimeType: "image/png" },
					],
					details: { path, requestedModel, reportedModel: reportedModel ?? null, modelConfirmed, warning },
				};
			});
		},
	});
}
