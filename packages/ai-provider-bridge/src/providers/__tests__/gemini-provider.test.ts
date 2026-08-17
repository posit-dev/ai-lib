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
});
