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
	suppressAiSdkDefaultErrorLogging: vi.fn(),
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

const CLIENT_CASES: readonly (ClientCase & { name: string })[] = [
	{
		name: "Anthropic",
		host: "https://api.anthropic.com",
		versioned: "https://api.anthropic.com/v1",
		construct: (baseUrl) => new AnthropicClient({ apiKey: "sk-test" }, baseUrl),
		model: "claude-opus-4-8",
		factory: createAnthropic,
	},
	{
		name: "OpenAI",
		host: "https://api.openai.com",
		versioned: "https://api.openai.com/v1",
		construct: (baseUrl) =>
			new OpenAIClient({
				apiKey: "sk-test",
				baseUrl,
				apiMode: "responses",
			}),
		model: "gpt-5.4",
		factory: createOpenAI,
	},
	{
		name: "Gemini",
		host: "https://generativelanguage.googleapis.com",
		versioned: "https://generativelanguage.googleapis.com/v1beta",
		construct: (baseUrl) => new GeminiClient("sk-test", baseUrl),
		model: "gemini-2.5-pro",
		factory: createGoogleGenerativeAI,
	},
];

interface BaseUrlPassThroughCase {
	/** Test name describing the source and expected URL behavior. */
	name: string;
	/** Construct the client with the source appropriate for this case. */
	construct: (client: ClientCase) => ModelClient;
	/** Per-request URL; omitted to preserve the no-request-override path. */
	requestBaseUrl?: (client: ClientCase) => string;
	/** URL expected at the SDK boundary; undefined preserves the SDK default. */
	expectedBaseUrl: (client: ClientCase) => string | undefined;
}

const BASE_URL_PASS_THROUGH_CASES: readonly BaseUrlPassThroughCase[] = [
	{
		name: "passes a per-request bare host straight through, unchanged",
		construct: (client) => client.construct(),
		requestBaseUrl: (client) => client.host,
		expectedBaseUrl: (client) => client.host,
	},
	{
		name: "passes a bare host supplied at construction time straight through, unchanged",
		construct: (client) => client.construct(client.host),
		expectedBaseUrl: (client) => client.host,
	},
	{
		name: "prefers the per-request base URL over the constructor value",
		construct: (client) => client.construct(client.versioned),
		requestBaseUrl: () => "https://my-proxy.example/gateway",
		expectedBaseUrl: () => "https://my-proxy.example/gateway",
	},
	{
		name: "leaves an already-versioned host untouched",
		construct: (client) => client.construct(),
		requestBaseUrl: (client) => client.versioned,
		expectedBaseUrl: (client) => client.versioned,
	},
	{
		name: "passes a custom URL with a trailing slash through byte-for-byte",
		construct: (client) => client.construct(),
		requestBaseUrl: () => "https://my-proxy.example/gateway/",
		expectedBaseUrl: () => "https://my-proxy.example/gateway/",
	},
	{
		name: "omits baseURL entirely when none is configured (SDK keeps its default)",
		construct: (client) => client.construct(),
		expectedBaseUrl: () => undefined,
	},
];

describe.each(CLIENT_CASES)("$name base URL pass-through", (c) => {
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

	it.each(BASE_URL_PASS_THROUGH_CASES)("$name", async (testCase) => {
		const requestBaseUrl = testCase.requestBaseUrl?.(c);
		const chatParams =
			requestBaseUrl === undefined ? params() : params({ baseUrl: requestBaseUrl });

		await testCase.construct(c).chat(chatParams);
		expect(baseUrlPassedTo(c.factory)).toBe(testCase.expectedBaseUrl(c));
	});
});
