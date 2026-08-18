/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger } from "../../types";
import {
	registerCustomOpenAICompatibleProvider,
	registerOpenAICompatibleProvider,
} from "../openai-compatible-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

afterEach(() => {
	vi.unstubAllGlobals();
	vi.clearAllMocks();
});

describe("registerCustomOpenAICompatibleProvider", () => {
	it("discovers /models and stamps the custom provider id", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: [{ id: "gateway-model", object: "model" }] }),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		const models = await registry.getModelsForProvider("acme-openai", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example/v1/",
		});

		expect(models).toHaveLength(1);
		expect(models[0]).toMatchObject({ id: "gateway-model", providerId: "acme-openai" });
		expect(fetchMock).toHaveBeenCalledWith("https://gateway.example/v1/models", {
			headers: { Authorization: "Bearer sk-test" },
		});
	});

	it("reads discovery capabilities for a custom endpoint too", async () => {
		// The two registrars share a fetcher today, but they are wired
		// independently — a capability regression could reach only one.
		const fetchMock = vi.fn(async () =>
			Response.json({
				data: [{ id: "gateway-model", input: ["text", "image"], max_model_len: 262_144 }],
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		const models = await registry.getModelsForProvider("acme-openai", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://gateway.example/v1",
		});

		expect(models[0]).toMatchObject({
			providerId: "acme-openai",
			supportsImages: true,
			maxContextLength: 262_144,
		});
		expect(models[0]?.supportedInputMediaTypes).toContain("image/png");
	});

	it("keeps independent model caches per custom endpoint", async () => {
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const url =
				typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
			const id = url.includes("gateway-a") ? "model-a" : "model-b";
			return Response.json({ data: [{ id }] });
		});
		vi.stubGlobal("fetch", fetchMock);

		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-a"), logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-b"), logger);

		const credsA = {
			type: "apikey",
			apiKey: "",
			baseUrl: "https://gateway-a/v1",
		} satisfies ApiKeyCredentials;
		const credsB = {
			type: "apikey",
			apiKey: "",
			baseUrl: "https://gateway-b/v1",
		} satisfies ApiKeyCredentials;
		for (let i = 0; i < 2; i++) {
			expect((await registry.getModelsForProvider("acme-a", credsA))[0]?.id).toBe("model-a");
			expect((await registry.getModelsForProvider("acme-b", credsB))[0]?.id).toBe("model-b");
		}

		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("registers the kind-keyed client factory without the built-in registrar", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		expect(
			registry.getClientForProviderOrKind(
				"acme-openai",
				{ type: "apikey", apiKey: "", baseUrl: "https://gateway.example/v1" },
				"openai-compatible",
			),
		).not.toBeNull();
	});

	it("does not pin the custom id when the catalog kind changes", () => {
		const registry = new ProviderRegistry(logger);
		registerCustomOpenAICompatibleProvider(registry, mintCustomProviderId("acme-openai"), logger);

		const litellmClient = { chat: vi.fn() };
		registry.registerClientFactory("litellm", () => litellmClient);

		expect(
			registry.getClientForProviderOrKind(
				"acme-openai",
				{ type: "apikey", apiKey: "", baseUrl: "https://gateway.example/v1" },
				"litellm",
			),
		).toBe(litellmClient);
	});
});

/**
 * Discover one model from a stubbed `/v1/models` payload through the built-in
 * registrar. Entering through the registry (rather than calling the parser)
 * keeps these tests on the seam that was actually broken: the registrar wires
 * the fetcher, and a capability regression could hide in either half.
 */
async function discoverModel(entry: Record<string, unknown>) {
	vi.stubGlobal(
		"fetch",
		vi.fn(async () => Response.json({ data: [entry] })),
	);
	const registry = new ProviderRegistry(logger);
	registerOpenAICompatibleProvider(registry, logger);
	const models = await registry.getModelsForProvider("openai-compatible", {
		type: "apikey",
		apiKey: "sk-test",
		baseUrl: "https://endpoint.example/v1",
	});
	return models[0];
}

/** The conservative capability set an endpoint that publishes nothing gets. */
const BASELINE = {
	supportsTools: true,
	supportsImages: false,
	supportsToolResultImages: false,
	supportsWebSearch: false,
	maxContextLength: 128_000,
	maxInputTokens: 128_000,
	maxOutputTokens: 16_384,
};

describe("registerOpenAICompatibleProvider discovery capabilities", () => {
	it("leaves the baseline untouched for a bare response", async () => {
		const model = await discoverModel({ id: "plain-model", object: "model" });

		expect(model).toMatchObject({ id: "plain-model", name: "plain-model", ...BASELINE });
		expect(model?.supportedInputMediaTypes).toBeUndefined();
	});

	it("stamps the identity fields ModelInfo requires", async () => {
		const model = await discoverModel({ id: "plain-model" });

		expect(model).toMatchObject({
			providerId: "openai-compatible",
			vendor: "openai-compatible",
		});
	});

	it("skips entries without a usable id", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => Response.json({ data: [{}, { id: "" }, { id: 7 }, { id: "real" }] })),
		);
		const registry = new ProviderRegistry(logger);
		registerOpenAICompatibleProvider(registry, logger);

		const models = await registry.getModelsForProvider("openai-compatible", {
			type: "apikey",
			apiKey: "sk-test",
			baseUrl: "https://endpoint.example/v1",
		});

		expect(models.map((m) => m.id)).toEqual(["real"]);
	});

	describe("vision signals", () => {
		it("reads `input` modalities (GWDG SAIA shape)", async () => {
			const model = await discoverModel({
				id: "qwen3.5-397b-a17b",
				input: ["text", "image"],
				output: ["text", "thought"],
			});

			expect(model?.supportsImages).toBe(true);
			expect(model?.supportedInputMediaTypes).toEqual([
				"image/png",
				"image/jpeg",
				"image/gif",
				"image/webp",
			]);
		});

		it("reads `architecture.input_modalities`", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				architecture: { input_modalities: ["text", "image"], output_modalities: ["text"] },
			});

			expect(model?.supportsImages).toBe(true);
		});

		it("reads the input side of an `architecture.modality` string", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				architecture: { modality: "text+image->text" },
			});

			expect(model?.supportsImages).toBe(true);
		});

		it("reads a `capabilities` list", async () => {
			const model = await discoverModel({ id: "gateway-model", capabilities: ["vision", "tools"] });

			expect(model?.supportsImages).toBe(true);
		});

		it("ignores image support on the output side of a modality string", async () => {
			// "text->image" is an image *generation* model: offering uploads to it
			// would send images to a model that cannot read them.
			const model = await discoverModel({
				id: "sd-model",
				architecture: { modality: "text->image" },
			});

			expect(model?.supportsImages).toBe(false);
			expect(model?.supportedInputMediaTypes).toBeUndefined();
		});

		it("keeps tool-result images off for a vision model", async () => {
			// Images inside tool results are a stronger claim than images in user
			// messages; the host relocates them instead, which works anywhere.
			const model = await discoverModel({ id: "vision-model", input: ["text", "image"] });

			expect(model?.supportsToolResultImages).toBe(false);
		});

		it("does not infer thinking support from a `thought` output modality", async () => {
			// Knowing a model can think does not tell us how to ask it to: these
			// endpoints disagree (`reasoning_effort` vs `chat_template_kwargs`).
			const model = await discoverModel({
				id: "qwen3.5-397b-a17b",
				input: ["text"],
				output: ["text", "thought"],
			});

			expect(model?.thinkingEffortLevels).toBeUndefined();
		});

		it("falls back to the baseline for wrongly-typed vision fields", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				input: "image",
				capabilities: 3,
				architecture: "multimodal",
			});

			expect(model?.supportsImages).toBe(false);
			expect(model?.supportedInputMediaTypes).toBeUndefined();
		});
	});

	describe("token limits", () => {
		it("reads `max_model_len` (vLLM shape)", async () => {
			const model = await discoverModel({ id: "qwen", max_model_len: 262_144 });

			expect(model).toMatchObject({ maxContextLength: 262_144, maxInputTokens: 262_144 });
		});

		it("reads `max_context_length` (LM Studio shape)", async () => {
			const model = await discoverModel({ id: "local-model", max_context_length: 32_768 });

			expect(model?.maxContextLength).toBe(32_768);
		});

		it("reads `context_length` and `top_provider` (OpenRouter shape)", async () => {
			const model = await discoverModel({
				id: "vendor/model",
				context_length: 200_000,
				architecture: { modality: "text+image->text" },
				top_provider: { max_completion_tokens: 8_192 },
			});

			expect(model).toMatchObject({
				maxContextLength: 200_000,
				maxInputTokens: 200_000,
				maxOutputTokens: 8_192,
				supportsImages: true,
			});
		});

		it("prefers an explicit input limit over the context window", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				context_length: 200_000,
				max_input_tokens: 180_000,
			});

			expect(model).toMatchObject({ maxContextLength: 200_000, maxInputTokens: 180_000 });
		});

		it("prefers `max_output_tokens` over `top_provider.max_completion_tokens`", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				max_output_tokens: 4_096,
				top_provider: { max_completion_tokens: 9_999 },
			});

			expect(model?.maxOutputTokens).toBe(4_096);
		});

		it("uses an input limit as the window when no window is published", async () => {
			const model = await discoverModel({ id: "gateway-model", max_input_tokens: 64_000 });

			expect(model).toMatchObject({ maxContextLength: 64_000, maxInputTokens: 64_000 });
		});

		it("falls back to the baseline for unusable numbers", async () => {
			const model = await discoverModel({
				id: "gateway-model",
				context_length: 0,
				max_model_len: -1,
				max_context_length: 1e21,
				max_input_tokens: "200000",
				max_output_tokens: 1.5,
			});

			expect(model).toMatchObject(BASELINE);
		});
	});
});
