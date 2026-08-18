/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import { registerGeminiProvider } from "../gemini-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

/** Live `/v1beta/models` shape for the hosted Gemma 4 models (verified 2026-08-17). */
const GEMMA_MODELS_PAYLOAD = {
	models: [
		{
			name: "models/gemma-4-31b-it",
			displayName: "Gemma 4 31B IT",
			inputTokenLimit: 262144,
			outputTokenLimit: 32768,
			supportedGenerationMethods: ["generateContent", "countTokens"],
			thinking: true,
		},
		{
			name: "models/gemma-4-26b-a4b-it",
			displayName: "Gemma 4 26B A4B IT",
			inputTokenLimit: 262144,
			outputTokenLimit: 32768,
			supportedGenerationMethods: ["generateContent", "countTokens"],
			thinking: true,
		},
	],
};

describe("registerGeminiProvider model discovery", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("surfaces Gemma models from the /models payload with hosted-Gemma capabilities", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(JSON.stringify(GEMMA_MODELS_PAYLOAD), {
						status: 200,
						headers: { "content-type": "application/json" },
					}),
			),
		);

		const registry = new ProviderRegistry(logger);
		registerGeminiProvider(registry, logger);
		const models = await registry.getModelsForProvider("gemini", {
			type: "apikey",
			apiKey: "key",
		});

		expect(models.map((model) => model.id)).toEqual(["gemma-4-31b-it", "gemma-4-26b-a4b-it"]);

		const gemma = models[0];
		expect(gemma).toMatchObject({
			id: "gemma-4-31b-it",
			name: "Gemma 4 31B IT",
			providerId: "gemini",
			vendor: "google",
			family: "gemma-4",
			// Live API token limits overlay the capability table
			maxInputTokens: 262_144,
			maxOutputTokens: 32_768,
			maxContextLength: 262_144,
			// Product-level vocabulary; the client maps off→minimal at the wire
			thinkingEffortLevels: ["off", "high"],
			supportsTools: true,
			supportsImages: true,
			supportsToolResultImages: true,
			supportedInputMediaTypes: [
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
				"application/pdf",
			],
			supportsWebSearch: false,
		});
	});

	it("discovers unprofiled chat models fail-open, without advertised thinking levels", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(
				async () =>
					new Response(
						JSON.stringify({
							models: [
								// Profiled: full thinking levels
								{
									name: "models/gemini-3.6-flash",
									displayName: "Gemini 3.6 Flash",
									inputTokenLimit: 1048576,
									outputTokenLimit: 65536,
									supportedGenerationMethods: ["generateContent", "countTokens"],
								},
								// Unprofiled but chat-shaped: discoverable, no levels
								{
									name: "models/gemini-3.5-flash-lite",
									displayName: "Gemini 3.5 Flash Lite",
									inputTokenLimit: 1048576,
									outputTokenLimit: 65536,
									supportedGenerationMethods: ["generateContent", "countTokens"],
								},
								// Non-chat: excluded by suffix, name, or methods
								{
									name: "models/gemini-3-pro-image",
									displayName: "Gemini 3 Pro Image",
									supportedGenerationMethods: ["generateContent", "countTokens"],
								},
								{
									name: "models/gemini-embedding-001",
									displayName: "Gemini Embedding",
									supportedGenerationMethods: ["embedContent", "countTokens"],
								},
								{
									name: "models/gemini-2.5-flash-native-audio-latest",
									displayName: "Gemini 2.5 Flash Native Audio",
									supportedGenerationMethods: ["countTokens", "bidiGenerateContent"],
								},
								{
									name: "models/gemini-flash-latest",
									displayName: "Gemini Flash Latest",
									supportedGenerationMethods: ["generateContent", "countTokens"],
								},
							],
						}),
						{ status: 200, headers: { "content-type": "application/json" } },
					),
			),
		);

		const registry = new ProviderRegistry(logger);
		registerGeminiProvider(registry, logger);
		const models = await registry.getModelsForProvider("gemini", {
			type: "apikey",
			apiKey: "key",
		});

		expect(models.map((model) => model.id)).toEqual(["gemini-3.6-flash", "gemini-3.5-flash-lite"]);

		// Profiled model: levels from the ai-config table, live token overlay
		expect(models[0]).toMatchObject({
			family: "gemini-3",
			maxInputTokens: 1_048_576,
			maxOutputTokens: 65_536,
			thinkingEffortLevels: ["minimal", "low", "medium", "high"],
		});

		// Unprofiled model: ai-config inference applies, but thinking levels
		// are stripped — the client cannot map efforts without a profile
		expect(models[1]).toMatchObject({
			family: "gemini-3",
			maxInputTokens: 1_048_576,
			maxOutputTokens: 65_536,
			supportsTools: true,
		});
		expect(models[1].thinkingEffortLevels).toBeUndefined();
	});
});
