/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the options passed to each SDK factory so we can assert on baseURL.
// `vi.hoisted` lets these mock fns exist before the hoisted `vi.mock` factories run.
const { createAnthropic, createOpenAI, createGoogleGenerativeAI } = vi.hoisted(() => ({
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createOpenAI: vi.fn(() => ({ responses: vi.fn(() => ({})), chat: vi.fn(() => ({})) })),
	createGoogleGenerativeAI: vi.fn(() => ({ interactions: vi.fn(() => ({})) })),
}));

vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI }));
vi.mock("@ai-sdk/google", () => ({ createGoogleGenerativeAI }));
vi.mock("ai", () => ({ streamText: vi.fn(() => ({ fullStream: {} })) }));
// Bypass the stream-conversion + abort plumbing; we only care about baseURL.
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import type { CancellationToken } from "../../types";
import { AnthropicClient } from "../AnthropicClient";
import { GeminiClient } from "../GeminiClient";
import type { ModelClient, ModelClientChatParams } from "../ModelClient";
import { OpenAIClient } from "../OpenAIClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

/** Read the `baseURL` option the client handed to its SDK factory. */
function baseUrlPassedTo(factory: ReturnType<typeof vi.fn>): string | undefined {
	const opts = factory.mock.calls[0]?.[0] as { baseURL?: string } | undefined;
	return opts?.baseURL;
}

interface ClientCase {
	/** Public host whose bare form should gain the version segment. */
	host: string;
	/** Fully versioned default the SDK expects (host + "/" + version). */
	versioned: string;
	/** Build a client with an optional constructor-time base URL. */
	construct: (baseUrl?: string) => ModelClient;
	/** Model ID accepted by the client's capability lookups. */
	model: string;
	/** The mocked SDK factory that receives the resolved `baseURL`. */
	factory: ReturnType<typeof vi.fn>;
}

const CASES: Record<string, ClientCase> = {
	Anthropic: {
		host: "https://api.anthropic.com",
		versioned: "https://api.anthropic.com/v1",
		construct: (baseUrl) => new AnthropicClient("sk-test", baseUrl),
		model: "claude-opus-4-8",
		factory: createAnthropic,
	},
	OpenAI: {
		host: "https://api.openai.com",
		versioned: "https://api.openai.com/v1",
		construct: (baseUrl) => new OpenAIClient("sk-test", baseUrl, "responses"),
		model: "gpt-5.4",
		factory: createOpenAI,
	},
	Gemini: {
		host: "https://generativelanguage.googleapis.com",
		versioned: "https://generativelanguage.googleapis.com/v1beta",
		construct: (baseUrl) => new GeminiClient("sk-test", baseUrl),
		model: "gemini-2.5-pro",
		factory: createGoogleGenerativeAI,
	},
};

describe.each(Object.entries(CASES))("%s base URL normalization", (_name, c) => {
	const params = (overrides?: Partial<ModelClientChatParams>): ModelClientChatParams => ({
		model: c.model,
		messages: [],
		maxOutputTokens: 1024,
		cancellationToken,
		...overrides,
	});

	beforeEach(() => {
		c.factory.mockClear();
	});

	it("appends the version segment to a per-request bare host (Positron direct-routing regression)", async () => {
		await c.construct().chat(params({ baseUrl: c.host }));
		expect(baseUrlPassedTo(c.factory)).toBe(c.versioned);
	});

	it("appends the version segment to a bare host supplied at construction time", async () => {
		await c.construct(c.host).chat(params());
		expect(baseUrlPassedTo(c.factory)).toBe(c.versioned);
	});

	it("prefers the per-request base URL over the constructor value", async () => {
		await c.construct(c.versioned).chat(params({ baseUrl: "https://my-proxy.example/gateway" }));
		expect(baseUrlPassedTo(c.factory)).toBe("https://my-proxy.example/gateway");
	});

	it("leaves an already-versioned host untouched", async () => {
		await c.construct().chat(params({ baseUrl: c.versioned }));
		expect(baseUrlPassedTo(c.factory)).toBe(c.versioned);
	});

	it("omits baseURL entirely when none is configured (SDK keeps its default)", async () => {
		await c.construct().chat(params());
		expect(baseUrlPassedTo(c.factory)).toBeUndefined();
	});
});
