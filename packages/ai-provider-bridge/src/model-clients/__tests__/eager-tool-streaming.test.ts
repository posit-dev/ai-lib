/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

// `@ai-sdk/anthropic` adds `eager_input_streaming` to tool specs by default while
// streaming; some Anthropic models on Bedrock / Snowflake reject it with HTTP 400.
// The clients opt out by passing `providerOptions.anthropic.toolStreaming: false`.
// Capture the options handed to `streamText` so we can assert on that flag.
const {
	streamText,
	createAmazonBedrock,
	createBedrockAnthropic,
	createAnthropic,
	fromNodeProviderChain,
	resolveBedrockTransport,
} = vi.hoisted(() => ({
	streamText: vi.fn(() => ({ fullStream: {} })),
	createAmazonBedrock: vi.fn(() => vi.fn(() => ({}))),
	createBedrockAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
	fromNodeProviderChain: vi.fn(() => vi.fn()),
	resolveBedrockTransport: vi.fn(async () => ({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
		mantleEnabled: true,
	})),
}));

vi.mock("ai", () => ({ streamText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock }));
vi.mock("@ai-sdk/amazon-bedrock/anthropic", () => ({ createBedrockAnthropic }));
vi.mock("@ai-sdk/anthropic", () => ({ createAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => ({})) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain }));
vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));
// Bypass stream-conversion + abort plumbing; we only care about providerOptions.
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import type { CancellationToken } from "../../types";
import { BedrockClient } from "../BedrockClient";
import type { ModelClientChatParams } from "../ModelClient";
import { SnowflakeClient } from "../SnowflakeClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

function params(
	overrides: Partial<ModelClientChatParams> & { model: string },
): ModelClientChatParams {
	return {
		messages: [],
		maxOutputTokens: 1024,
		cancellationToken,
		...overrides,
	};
}

/** Read `providerOptions.anthropic` from the most recent `streamText` call. */
function anthropicOptions(): { toolStreaming?: boolean } | undefined {
	const opts = streamText.mock.calls.at(-1)?.[0] as
		| { providerOptions?: { anthropic?: { toolStreaming?: boolean } } }
		| undefined;
	return opts?.providerOptions?.anthropic;
}

beforeEach(() => {
	streamText.mockClear();
});

describe("Bedrock eager tool streaming opt-out", () => {
	const client = new BedrockClient({ region: "us-east-1" });

	// The bug: this failed with HTTP 400 because the opt-out was scoped to Haiku 4.5.
	it("disables eager tool streaming for Sonnet 4.5", async () => {
		await client.chat(params({ model: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" }));
		expect(anthropicOptions()?.toolStreaming).toBe(false);
	});

	it("disables eager tool streaming for Haiku 4.5 (original case)", async () => {
		await client.chat(params({ model: "us.anthropic.claude-haiku-4-5-20251001-v1:0" }));
		expect(anthropicOptions()?.toolStreaming).toBe(false);
	});

	// Only the affected models are opted out; unaffected Anthropic models keep the
	// eager streaming default (no anthropic provider options when thinking is off).
	it("leaves eager tool streaming enabled for Opus (not an affected model)", async () => {
		await client.chat(params({ model: "anthropic.claude-opus-4-8" }));
		expect(anthropicOptions()).toBeUndefined();
	});

	// Non-Anthropic Bedrock models go through the Converse API, which never sees
	// the `eager_input_streaming` field.
	it("leaves non-Anthropic models alone (no anthropic provider options)", async () => {
		await client.chat(params({ model: "amazon.nova-pro-v1:0" }));
		expect(anthropicOptions()).toBeUndefined();
	});
});

describe("Snowflake eager tool streaming opt-out", () => {
	const client = new SnowflakeClient("token", "https://acct.snowflakecomputing.com/api/v2/cortex");

	it("disables eager tool streaming for Sonnet 4.5", async () => {
		await client.chat(params({ model: "claude-sonnet-4-5" }));
		expect(anthropicOptions()?.toolStreaming).toBe(false);
	});

	it("leaves eager tool streaming enabled for Opus (not an affected model)", async () => {
		await client.chat(params({ model: "claude-opus-4-8" }));
		expect(anthropicOptions()).toBeUndefined();
	});
});
