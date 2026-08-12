/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	streamText,
	createAmazonBedrock,
	createBedrockAnthropic,
	createBedrockMantle,
	resolveBedrockTransport,
} = vi.hoisted(() => ({
	streamText: vi.fn(() => ({ fullStream: {} })),
	createAmazonBedrock: vi.fn(() => vi.fn(() => ({ route: "converse" }))),
	createBedrockAnthropic: vi.fn(() => vi.fn(() => ({ route: "anthropic" }))),
	createBedrockMantle: vi.fn(() => ({
		chat: vi.fn(() => ({ route: "mantle-chat" })),
		responses: vi.fn(() => ({ route: "mantle-responses" })),
	})),
	resolveBedrockTransport: vi.fn(),
}));

vi.mock("ai", () => ({ streamText }));
vi.mock("@ai-sdk/amazon-bedrock", () => ({ createAmazonBedrock }));
vi.mock("@ai-sdk/amazon-bedrock/anthropic", () => ({ createBedrockAnthropic }));
vi.mock("@ai-sdk/amazon-bedrock/mantle", () => ({ createBedrockMantle }));
vi.mock("../../providers/bedrock-transport", () => ({ resolveBedrockTransport }));
vi.mock("@aws-sdk/credential-providers", () => ({
	fromNodeProviderChain: vi.fn(() => vi.fn()),
}));
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

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

function params(overrides: Partial<ModelClientChatParams>): ModelClientChatParams {
	return {
		model: "openai.gpt-5.5",
		messages: [],
		cancellationToken,
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	resolveBedrockTransport.mockResolvedValue({
		useFipsEndpoint: false,
		runtimeBaseUrl: "https://bedrock-runtime.us-east-2.amazonaws.com",
		mantleEnabled: true,
	});
});

describe("Bedrock Mantle protocol routing", () => {
	const client = new BedrockClient({
		region: "us-east-2",
		accessKeyId: "key",
		secretAccessKey: "secret",
	});

	it("routes Responses with stateless forced reasoning and no invented token fallback", async () => {
		await client.chat(
			params({
				protocol: "openai-responses",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				thinkingEffort: "off",
				supportsToolResultImages: true,
			}),
		);

		expect(createBedrockMantle).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://bedrock-mantle.us-east-2.api.aws/openai/v1",
				apiKey: "",
				credentialProvider: expect.any(Function),
			}),
		);
		expect(streamText).toHaveBeenCalledWith(
			expect.objectContaining({
				model: { route: "mantle-responses" },
				maxOutputTokens: undefined,
				providerOptions: {
					openai: {
						store: false,
						forceReasoning: true,
						reasoningEffort: "none",
						reasoningSummary: "detailed",
					},
				},
			}),
		);
		expect(createAmazonBedrock).not.toHaveBeenCalled();
	});

	it("routes gpt-oss through Chat without forceReasoning", async () => {
		await client.chat(
			params({
				model: "openai.gpt-oss-120b",
				protocol: "openai-chat",
				baseUrl: "https://bedrock-mantle.us-east-2.api.aws/v1",
				maxOutputTokens: 16_384,
				thinkingEffort: "high",
			}),
		);

		const options = streamText.mock.calls.at(-1)?.[0];
		expect(options).toEqual(
			expect.objectContaining({
				model: { route: "mantle-chat" },
				maxOutputTokens: 16_384,
				providerOptions: { openai: { reasoningEffort: "high" } },
			}),
		);
		expect(options?.providerOptions?.openai).not.toHaveProperty("forceReasoning");
	});

	it("keeps existing Converse and Anthropic routes off Mantle", async () => {
		await client.chat(params({ model: "amazon.nova-pro", protocol: "bedrock-converse" }));
		expect(createAmazonBedrock).toHaveBeenCalled();
		expect(createBedrockMantle).not.toHaveBeenCalled();

		vi.clearAllMocks();
		await client.chat(
			params({ model: "anthropic.claude-sonnet-4-6", protocol: "anthropic-messages" }),
		);
		expect(createBedrockAnthropic).toHaveBeenCalled();
		expect(createBedrockMantle).not.toHaveBeenCalled();
	});

	it("routes both runtime factories through the resolved FIPS host", async () => {
		resolveBedrockTransport.mockResolvedValue({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
			mantleEnabled: false,
		});
		const fipsClient = new BedrockClient({
			region: "us-gov-west-1",
			accessKeyId: "key",
			secretAccessKey: "secret",
		});

		await fipsClient.chat(params({ model: "amazon.nova-pro", protocol: "bedrock-converse" }));
		await fipsClient.chat(
			params({ model: "anthropic.claude-sonnet-4-6", protocol: "anthropic-messages" }),
		);

		expect(createAmazonBedrock).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
			}),
		);
		expect(createBedrockAnthropic).toHaveBeenCalledWith(
			expect.objectContaining({
				baseURL: "https://bedrock-runtime-fips.us-gov-west-1.amazonaws.com",
			}),
		);
	});

	it("rejects Mantle protocols when FIPS endpoints are enabled", async () => {
		resolveBedrockTransport.mockResolvedValue({
			useFipsEndpoint: true,
			runtimeBaseUrl: "https://bedrock-runtime-fips.us-east-2.amazonaws.com",
			mantleEnabled: false,
		});

		await expect(
			client.chat(params({ model: "openai.gpt-5.5", protocol: "openai-responses" })),
		).rejects.toThrow(/openai-responses.*FIPS/);
		expect(createBedrockMantle).not.toHaveBeenCalled();
	});
});
