/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// SDK factories are mocked so we can grab the fetch each client installs and
// drive it the way the SDK would. `vi.hoisted` lets these mocks exist before
// the hoisted `vi.mock` factories run.
const {
	createDeepSeek,
	createAnthropic,
	createOpenAI,
	createOpenAICompatible,
	createGoogleGenerativeAI,
} = vi.hoisted(() => ({
	createDeepSeek: vi.fn(() => ({ chat: vi.fn(() => ({})) })),
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createOpenAI: vi.fn(() => ({ chat: vi.fn(() => ({})) })),
	createOpenAICompatible: vi.fn(() => ({ chatModel: vi.fn(() => ({})) })),
	createGoogleGenerativeAI: vi.fn(() => vi.fn(() => ({}))),
}));

vi.mock("@ai-sdk/deepseek", () => ({ createDeepSeek }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/openai-compatible", () => ({ createOpenAICompatible }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI }));
// The variant profile gate needs a known model; stub the lookup.
vi.mock("ai-config", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	getGeminiGenerateContentProfile: vi.fn(() => ({
		variant: "2.5-pro",
		thinking: {
			control: "budget",
			canDisable: false,
			budgets: { low: 2048, medium: 8192, high: 32_768 },
		},
		thinkingEffortLevels: ["low", "medium", "high"],
	})),
}));
vi.mock("ai", () => ({ streamText: vi.fn(() => ({ fullStream: {} })) }));
// Bypass the stream-conversion + abort plumbing; we only care about the fetch
// wrapper each client installs.
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));
vi.mock("../tool-call-ids", () => ({
	streamTextAnthropicWire: vi.fn(() => ({ fullStream: {} })),
}));

import type { CancellationToken, Logger } from "../../types";
import { DeepSeekClient } from "../DeepSeekClient";
import { GeminiGenerateContentClient } from "../GeminiGenerateContentClient";
import type { ModelClientChatParams } from "../ModelClient";
import { PositAiClient } from "../PositAiClient";
import { resetRawHttpLoggingForTests } from "../raw-http-logging";
import { SnowflakeClient, type SnowflakeSessionRefresh } from "../SnowflakeClient";

/**
 * Composition tests: raw HTTP logging must sit innermost in each client's
 * fetch stack (SDK → transform/auth/retry middleware → logger → global fetch)
 * so the log records the physical wire call — final request mutations, raw
 * pre-rewrite responses, and one pair per physical call including retries.
 */

const ENV_VAR = "PA_RAW_HTTP_LOG_DIR";

let workDir: string;

beforeEach(() => {
	workDir = mkdtempSync(join(tmpdir(), "raw-http-composition-test-"));
	process.env[ENV_VAR] = workDir;
	createDeepSeek.mockClear();
	createAnthropic.mockClear();
	createOpenAI.mockClear();
	createOpenAICompatible.mockClear();
	createGoogleGenerativeAI.mockClear();
});

afterEach(() => {
	resetRawHttpLoggingForTests();
	delete process.env[ENV_VAR];
	rmSync(workDir, { recursive: true, force: true });
	vi.restoreAllMocks();
});

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const params = (model: string, extra?: Partial<ModelClientChatParams>): ModelClientChatParams => ({
	model,
	messages: [],
	maxOutputTokens: 1024,
	cancellationToken,
	...extra,
});

type SdkFetch = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

interface SdkOptions {
	fetch?: SdkFetch;
}

/** Base names of logged pairs, in call order (trailing sequence increases). */
function listBaseNames(): string[] {
	return readdirSync(workDir)
		.filter((f) => f.endsWith("-request.http"))
		.map((f) => f.replace("-request.http", ""))
		.sort();
}

function readLog(baseName: string, suffix: "request" | "response"): Buffer {
	return readFileSync(join(workDir, `${baseName}-${suffix}.http`));
}

/** Split a raw .http log file into header section text and body text. */
function splitMessage(contents: Buffer): { head: string; body: string } {
	const separator = contents.indexOf("\n\n");
	expect(separator).toBeGreaterThan(-1);
	return {
		head: contents.subarray(0, separator).toString("utf8"),
		body: contents.subarray(separator + 2).toString("utf8"),
	};
}

/** True when `count` pairs exist and every file has content (writes are async). */
function pairsComplete(count: number): boolean {
	const bases = listBaseNames();
	if (bases.length !== count) {
		return false;
	}
	return bases.every((base) => {
		try {
			return (
				readFileSync(join(workDir, `${base}-request.http`)).length > 0 &&
				readFileSync(join(workDir, `${base}-response.http`)).length > 0
			);
		} catch {
			return false;
		}
	});
}

async function waitFor(condition: () => boolean): Promise<void> {
	const deadline = Date.now() + 5000;
	while (!condition()) {
		if (Date.now() > deadline) {
			throw new Error("Timed out waiting for log files");
		}
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function sseResponse(chunks: string[]): Response {
	const encoder = new TextEncoder();
	return new Response(
		new ReadableStream<Uint8Array>({
			start(controller) {
				for (const chunk of chunks) {
					controller.enqueue(encoder.encode(chunk));
				}
				controller.close();
			},
		}),
		{ status: 200, headers: { "content-type": "text/event-stream" } },
	);
}

describe("raw HTTP logging composition", () => {
	it("deepseek: logged request body includes the middleware-injected reasoning_effort", async () => {
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

		await new DeepSeekClient("sk-test").chat(params("deepseek-chat", { thinkingEffort: "high" }));
		const sdkFetch = (createDeepSeek.mock.calls[0]?.[0] as SdkOptions | undefined)?.fetch;
		expect(sdkFetch).toBeDefined();

		const response = await sdkFetch!("https://api.deepseek.com/v1/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ model: "deepseek-chat", messages: [] }),
		});
		await response.text();

		await waitFor(() => pairsComplete(1));
		const request = splitMessage(readLog(listBaseNames()[0]!, "request"));
		expect(request.body).toContain('"reasoning_effort":"high"');

		// Sanity: the wire received the same mutation.
		const wireBody = JSON.parse(fetchSpy.mock.calls[0]?.[1]?.body as string) as {
			reasoning_effort?: string;
		};
		expect(wireBody.reasoning_effort).toBe("high");
	});

	it("positai: logged request shows final auth headers (authorization redacted, x-api-key stripped)", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

		await new PositAiClient(
			"oauth-token",
			"https://positai.example/api",
			"test-agent",
			mockLogger,
		).chat(params("claude-opus-4-7", { protocol: "anthropic-messages" }));
		const sdkFetch = (createAnthropic.mock.calls[0]?.[0] as SdkOptions | undefined)?.fetch;
		expect(sdkFetch).toBeDefined();

		// Drive the installed fetch as the SDK would (SDK sets x-api-key).
		const response = await sdkFetch!("https://positai.example/api/anthropic/v1/messages", {
			method: "POST",
			headers: { "x-api-key": "oauth-token", "content-type": "application/json" },
			body: "{}",
		});
		await response.text();

		await waitFor(() => pairsComplete(1));
		const { head } = splitMessage(readLog(listBaseNames()[0]!, "request"));
		expect(head).toContain("authorization: [REDACTED]");
		expect(head).not.toContain("x-api-key");
	});

	it("snowflake: logs post-transform requests, raw pre-transform SSE, and one pair per physical call", async () => {
		const expiredBody = JSON.stringify({ code: "390112", message: "session token has expired" });
		const rawChunk =
			'data: {"id":"x","object":"chat.completion.chunk","created":0,"model":"m",' +
			'"choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_1",' +
			'"function":{"name":"noop","arguments":""}}]}}]}\n\n';
		const fetchSpy = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(
				new Response(expiredBody, {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			)
			.mockResolvedValueOnce(sseResponse([rawChunk, "data: [DONE]\n\n"]));

		const refresh: SnowflakeSessionRefresh = {
			connectionIdentity: "conn",
			reauthenticate: vi.fn(async () => "fresh-token"),
		};
		await new SnowflakeClient(
			"sess-tok",
			"https://acct.snowflakecomputing.com/api/v2/cortex",
			"session",
			undefined,
			refresh,
		).chat(params("openai-gpt-5.2"));
		const sdkFetch = (createOpenAI.mock.calls[0]?.[0] as SdkOptions | undefined)?.fetch;
		expect(sdkFetch).toBeDefined();

		const response = await sdkFetch!("https://x/chat/completions", {
			method: "POST",
			headers: { "content-type": "application/json", "x-api-key": "session-auth" },
			body: JSON.stringify({
				model: "openai-gpt-5.2",
				max_tokens: 128,
				tools: [{ type: "function", function: { name: "noop", parameters: { type: "object" } } }],
			}),
		});
		const seenByConsumer = await response.text();

		// The expired first call plus the retry: two physical calls, two pairs.
		await waitFor(() => pairsComplete(2));
		expect(fetchSpy).toHaveBeenCalledTimes(2);
		const [first, second] = listBaseNames();

		// The logged request carries the compat transform's final mutation
		// (max_tokens renamed) and the session-auth header (value redacted).
		const request = splitMessage(readLog(second!, "request"));
		expect(request.body).toContain('"max_completion_tokens":128');
		expect(request.body).not.toContain('"max_tokens"');
		expect(request.head).toContain("authorization: [REDACTED]");
		expect(request.head).not.toContain("x-api-key");

		// The first pair recorded the physical 390112 response that the retry
		// middleware hid from the SDK.
		expect(splitMessage(readLog(first!, "response")).body).toContain("390112");

		// The logged SSE is the raw wire bytes; the consumer saw the compat
		// fix-up (arguments "" → "{}" for the no-arg tool).
		expect(splitMessage(readLog(second!, "response")).body).toContain('"arguments":""');
		expect(seenByConsumer).toContain('"arguments":"{}"');
	});

	it("gemini generateContent: bearer mode logs beneath the bearer rewrite", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

		await new GeminiGenerateContentClient({ authToken: "tok-123" }).chat(params("gemini-2.5-pro"));
		const sdkFetch = (createGoogleGenerativeAI.mock.calls[0]?.[0] as SdkOptions | undefined)?.fetch;
		expect(sdkFetch).toBeDefined();

		// Drive the installed fetch as the SDK would (SDK sets x-goog-api-key).
		const response = await sdkFetch!(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
			{
				method: "POST",
				headers: { "x-goog-api-key": "placeholder", "content-type": "application/json" },
				body: "{}",
			},
		);
		await response.text();

		await waitFor(() => pairsComplete(1));
		const { head } = splitMessage(readLog(listBaseNames()[0]!, "request"));
		expect(head).toContain("authorization: [REDACTED]");
		expect(head).not.toContain("x-goog-api-key");
	});

	it("gemini generateContent: api-key mode installs raw logging", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(sseResponse(["data: [DONE]\n\n"]));

		await new GeminiGenerateContentClient({ apiKey: "real-key" }).chat(params("gemini-2.5-pro"));
		const sdkFetch = (createGoogleGenerativeAI.mock.calls[0]?.[0] as SdkOptions | undefined)?.fetch;
		expect(sdkFetch).toBeDefined();

		const response = await sdkFetch!(
			"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent",
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		await response.text();

		await waitFor(() => pairsComplete(1));
		expect(listBaseNames().length).toBe(1);
	});
});
