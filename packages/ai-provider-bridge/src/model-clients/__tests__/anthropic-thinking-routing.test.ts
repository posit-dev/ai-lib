/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Every Claude-wire client must hand `streamText` the shared thinking options
 * (`anthropicProviderOptions`), so "off" disables thinking on each route. The
 * wire serialization itself is covered by `anthropic-thinking-wire.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	streamText,
	createAmazonBedrock,
	createBedrockAnthropic,
	createAnthropic,
	createVertex,
	createVertexAnthropic,
	fromNodeProviderChain,
	resolveBedrockTransport,
} = vi.hoisted(() => ({
	streamText: vi.fn(() => ({ fullStream: {} })),
	createAmazonBedrock: vi.fn(() => vi.fn(() => ({}))),
	createBedrockAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createAnthropic: vi.fn(() => vi.fn(() => ({}))),
	createVertex: vi.fn(() => vi.fn(() => ({}))),
	createVertexAnthropic: vi.fn(() => vi.fn(() => ({}))),
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
vi.mock("@ai-sdk/google-vertex", () => ({ createVertex }));
vi.mock("@ai-sdk/google-vertex/anthropic", () => ({ createVertexAnthropic }));
vi.mock("@ai-sdk/openai", () => ({ createOpenAI: vi.fn(() => ({})) }));
vi.mock("@aws-sdk/credential-providers", () => ({ fromNodeProviderChain }));
vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));
// Bypass stream-conversion + abort plumbing; only providerOptions matter here.
vi.mock("../ai-sdk-helpers", () => ({
	convertAiSdkStreamToPlatform: vi.fn(() => (async function* () {})()),
	createAbortControllerFromToken: vi.fn(() => ({
		abortController: new AbortController(),
		cleanup: vi.fn(),
	})),
	createStepLogger: vi.fn(() => undefined),
}));

import type { CancellationToken, Logger } from "../../types";
import { BedrockClient } from "../BedrockClient";
import { GoogleVertexClient } from "../GoogleVertexClient";
import type { ModelClient } from "../ModelClient";
import { PositAiClient } from "../PositAiClient";
import { SnowflakeClient } from "../SnowflakeClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

/** Send one request and read `providerOptions.anthropic` from the `streamText` call. */
async function anthropicOptions(
	client: ModelClient,
	model: string,
	thinkingEffort: string | undefined,
): Promise<unknown> {
	await client.chat({
		model,
		messages: [],
		maxOutputTokens: 1024,
		thinkingEffort,
		cancellationToken,
	});
	const opts = streamText.mock.calls.at(-1)?.[0] as
		| { providerOptions?: { anthropic?: unknown } }
		| undefined;
	return opts?.providerOptions?.anthropic;
}

beforeEach(() => {
	streamText.mockClear();
});

describe.each([
	{
		name: "Bedrock",
		client: new BedrockClient({ region: "us-east-1" }),
		model: "anthropic.claude-haiku-5-5",
	},
	{
		name: "Google Vertex",
		client: new GoogleVertexClient(
			{ project: "project-id", location: "us-central1", credentialSource: { kind: "adc" } },
			logger,
		),
		model: "claude-haiku-5-5",
	},
	{
		name: "Snowflake",
		client: new SnowflakeClient("token", "https://acct.snowflakecomputing.com/api/v2/cortex"),
		model: "claude-haiku-5-5",
	},
	{
		name: "Posit AI",
		client: new PositAiClient("token", "https://api.posit.example", "test-agent", logger),
		model: "claude-haiku-5-5",
	},
])("$name Claude thinking options", ({ client, model }) => {
	it('disables thinking for "off"', async () => {
		expect(await anthropicOptions(client, model, "off")).toEqual({
			thinking: { type: "disabled" },
		});
	});

	it("requests adaptive thinking at an active level", async () => {
		expect(await anthropicOptions(client, model, "medium")).toEqual({
			thinking: { type: "adaptive", display: "summarized" },
			effort: "medium",
		});
	});
});

describe("Bedrock thinking options outside the plain Claude case", () => {
	const client = new BedrockClient({ region: "us-east-1" });

	it("keeps the eager-streaming opt-out alongside disabled thinking", async () => {
		expect(
			await anthropicOptions(client, "us.anthropic.claude-sonnet-4-5-20250929-v1:0", "off"),
		).toEqual({ thinking: { type: "disabled" }, toolStreaming: false });
	});

	it("sends no anthropic options to a non-Anthropic model", async () => {
		expect(await anthropicOptions(client, "amazon.nova-pro-v1:0", "off")).toBeUndefined();
	});
});
