/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import {
	OPENCODE_DEFAULT_PRODUCT,
	OPENCODE_GO_BASE_URL,
	OPENCODE_PRODUCT_BASE_URLS,
	OPENCODE_ZEN_BASE_URL,
} from "../base-url.js";
import { inferOpencodeProtocol } from "../model-capabilities/opencode-routing.js";
import { resolveModels } from "../resolve-models.js";
import type { ModelInfoLike, ModelsBlock, ResolvedConnection } from "../types.js";

function makeModel(id: string, overrides?: Partial<ModelInfoLike>): ModelInfoLike {
	return {
		id,
		name: id,
		maxContextLength: 100000,
		supportsTools: true,
		supportsImages: false,
		supportsToolResultImages: false,
		supportsWebSearch: false,
		...overrides,
	};
}

const discovered = [makeModel("model-a"), makeModel("model-b"), makeModel("model-c")];

describe("resolveModels", () => {
	it("passes through discovered models when no models block", () => {
		const result = resolveModels(undefined, discovered);
		expect(result).toHaveLength(3);
		expect(result.map((m) => m.id)).toEqual(["model-a", "model-b", "model-c"]);
	});

	it("passes through discovered models when models block is empty", () => {
		const result = resolveModels({}, discovered);
		expect(result).toHaveLength(3);
	});

	// --- Discovery gate ---

	it("discovery: 'off' excludes discovered models", () => {
		const block: ModelsBlock = { discovery: "off" };
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(0);
	});

	it("discovery: 'off' with custom models returns only custom", () => {
		const block: ModelsBlock = {
			discovery: "off",
			custom: [
				{
					id: "custom-1",
					name: "Custom 1",
					maxContextLength: 50000,
					supportsTools: true,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
				},
			],
		};
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(1);
		expect(result[0].id).toBe("custom-1");
	});

	// --- Custom models ---

	it("adds custom models to discovered", () => {
		const block: ModelsBlock = {
			custom: [
				{
					id: "extra",
					name: "Extra",
					maxContextLength: 50000,
					supportsTools: false,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
				},
			],
		};
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(4);
		expect(result[3].id).toBe("extra");
	});

	// --- Overrides ---

	it("applies overrides to matching models", () => {
		const block: ModelsBlock = {
			overrides: {
				"model-a": { name: "Model A (patched)", maxContextLength: 200000 },
			},
		};
		const result = resolveModels(block, discovered);
		const patched = result.find((m) => m.id === "model-a");
		expect(patched?.name).toBe("Model A (patched)");
		expect(patched?.maxContextLength).toBe(200000);
	});

	it("applies capacity overrides to the effective capability facts", () => {
		const discoveredWithFacts = [
			makeModel("model-a", {
				maxContextLength: 1_050_000,
				maxInputTokens: 922_000,
				maxOutputTokens: 128_000,
				capabilityFacts: {
					maxContextLength: 1_050_000,
					maxInputTokens: 922_000,
					maxOutputTokens: 128_000,
				},
			}),
		];
		const block: ModelsBlock = {
			overrides: {
				"model-a": {
					maxContextLength: 200_000,
					maxInputTokens: 190_000,
					maxOutputTokens: 20_000,
				},
			},
		};

		const [patched] = resolveModels(block, discoveredWithFacts);

		expect(patched.capabilityFacts).toEqual({
			maxContextLength: 200_000,
			maxInputTokens: 190_000,
			maxOutputTokens: 20_000,
		});
	});

	it("ignores overrides for non-matching ids (no-op, not error)", () => {
		const block: ModelsBlock = {
			overrides: {
				"nonexistent-model": { name: "Ghost" },
			},
		};
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(3);
	});

	it("applies baseUrl from overrides", () => {
		const block: ModelsBlock = {
			overrides: {
				"model-a": { baseUrl: "https://override.example.com" },
			},
		};
		const result = resolveModels(block, discovered);
		const patched = result.find((m) => m.id === "model-a");
		expect(patched?.resolvedBaseUrl).toBe("https://override.example.com");
	});

	// --- Allow filter ---

	it("allow filters to only allowed ids", () => {
		const block: ModelsBlock = {
			allow: ["model-a", "model-c"],
		};
		const result = resolveModels(block, discovered);
		expect(result.map((m) => m.id)).toEqual(["model-a", "model-c"]);
	});

	it("empty allow passes all through", () => {
		const block: ModelsBlock = { allow: [] };
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(3);
	});

	// --- Deny filter ---

	it("deny removes specified models", () => {
		const block: ModelsBlock = {
			deny: ["model-b"],
		};
		const result = resolveModels(block, discovered);
		expect(result.map((m) => m.id)).toEqual(["model-a", "model-c"]);
	});

	it("deny wins over allow", () => {
		const block: ModelsBlock = {
			allow: ["model-a", "model-b"],
			deny: ["model-b"],
		};
		const result = resolveModels(block, discovered);
		expect(result.map((m) => m.id)).toEqual(["model-a"]);
	});

	// --- Routing resolution ---

	it("resolves protocol from provider connection", () => {
		const connection: ResolvedConnection = { protocol: "openai-chat" };
		const result = resolveModels(undefined, discovered, connection);
		expect(result[0].resolvedProtocol).toBe("openai-chat");
	});

	it("user override protocol wins over provider protocol", () => {
		const connection: ResolvedConnection = { protocol: "openai-chat" };
		const block: ModelsBlock = {
			overrides: { "model-a": { protocol: "anthropic-messages" } },
		};
		const result = resolveModels(block, discovered, connection);
		const modelA = result.find((m) => m.id === "model-a");
		const modelB = result.find((m) => m.id === "model-b");
		expect(modelA?.resolvedProtocol).toBe("anthropic-messages");
		expect(modelB?.resolvedProtocol).toBe("openai-chat");
	});

	it("provider protocol wins over discovered model protocol (built-in inference)", () => {
		// Simulate a Bedrock/PositAI model with built-in inference protocol
		const discoveredWithProtocol = [makeModel("claude-sonnet", { protocol: "anthropic" })];
		const connection: ResolvedConnection = { protocol: "openai-chat" };
		const result = resolveModels(undefined, discoveredWithProtocol, connection);
		// Provider config should win over discovered model's built-in inference
		expect(result[0].resolvedProtocol).toBe("openai-chat");
	});

	it("discovered model legacy protocol is normalized when used as fallback", () => {
		const discoveredWithProtocol = [makeModel("claude-sonnet", { protocol: "anthropic" })];
		const result = resolveModels(undefined, discoveredWithProtocol);
		// No provider config — fall back to discovered model's built-in inference,
		// but normalize legacy "anthropic" → "anthropic-messages"
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
	});

	it("discovered model legacy 'openai' protocol is normalized to 'openai-chat'", () => {
		const discoveredWithProtocol = [makeModel("gpt-4", { protocol: "openai" })];
		const result = resolveModels(undefined, discoveredWithProtocol);
		expect(result[0].resolvedProtocol).toBe("openai-chat");
	});

	it("non-legacy protocol values pass through unchanged", () => {
		const discoveredWithProtocol = [makeModel("model-a", { protocol: "bedrock-converse" })];
		const result = resolveModels(undefined, discoveredWithProtocol);
		expect(result[0].resolvedProtocol).toBe("bedrock-converse");
	});

	it("full precedence: user override > provider config > discovered inference", () => {
		const discoveredWithProtocol = [
			makeModel("model-overridden", { protocol: "anthropic" }),
			makeModel("model-provider-only", { protocol: "anthropic" }),
			makeModel("model-inference-only", { protocol: "anthropic" }),
		];
		const connection: ResolvedConnection = { protocol: "openai-chat" };
		const block: ModelsBlock = {
			overrides: { "model-overridden": { protocol: "bedrock-converse" } },
		};
		const result = resolveModels(block, discoveredWithProtocol, connection);
		// User override wins
		expect(result.find((m) => m.id === "model-overridden")?.resolvedProtocol).toBe(
			"bedrock-converse",
		);
		// Provider config wins over discovered inference
		expect(result.find((m) => m.id === "model-provider-only")?.resolvedProtocol).toBe(
			"openai-chat",
		);
		// When there's no models block, discovered inference is still the fallback
		// (already tested separately above)
	});

	it("provider endpoints resolve correctly with precedence-respecting protocol", () => {
		// Discovered model says "anthropic" (inference), but provider says "openai-chat".
		// Provider endpoints should use the provider protocol, not the discovered one.
		const discoveredWithProtocol = [makeModel("model-a", { protocol: "anthropic" })];
		const connection: ResolvedConnection = {
			protocol: "openai-chat",
			endpoints: {
				"openai-chat": "https://openai-endpoint.example.com",
				"anthropic-messages": "https://anthropic-endpoint.example.com",
			},
		};
		const result = resolveModels(undefined, discoveredWithProtocol, connection);
		// Should resolve to the openai-chat endpoint (provider protocol wins)
		expect(result[0].resolvedProtocol).toBe("openai-chat");
		expect(result[0].resolvedBaseUrl).toBe("https://openai-endpoint.example.com");
	});

	it("legacy protocol is normalized for endpoint lookup", () => {
		// Discovered model has legacy "anthropic" — after normalization it should
		// match the "anthropic-messages" endpoint key.
		const discoveredWithProtocol = [makeModel("claude-sonnet", { protocol: "anthropic" })];
		const connection: ResolvedConnection = {
			endpoints: { "anthropic-messages": "https://anthropic.example.com" },
		};
		// No provider-level protocol — falls back to discovered + normalize
		const result = resolveModels(undefined, discoveredWithProtocol, connection);
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
		expect(result[0].resolvedBaseUrl).toBe("https://anthropic.example.com");
	});

	it("an explicit canonical fallback stamp participates in endpoint lookup", () => {
		// A provider that stamps `openai-chat` as its explicit fallback (rather than
		// leaving `protocol` absent) must resolve that protocol and reach the
		// matching `endpoints` entry — that is what makes the stamp useful.
		const stamped = [makeModel("fallback-endpoint", { protocol: "openai-chat" })];
		const connection: ResolvedConnection = {
			endpoints: { "openai-chat": "https://chat.example.com" },
		};
		const result = resolveModels(undefined, stamped, connection);
		expect(result[0].resolvedProtocol).toBe("openai-chat");
		expect(result[0].resolvedBaseUrl).toBe("https://chat.example.com");
	});

	it("resolves baseUrl from provider connection when model has none", () => {
		const connection: ResolvedConnection = { baseUrl: "https://provider.example.com" };
		const result = resolveModels(undefined, discovered, connection);
		expect(result[0].resolvedBaseUrl).toBe("https://provider.example.com");
	});

	it("uses the complete endpoint precedence ladder", () => {
		const discoveredModel = makeModel("model-a", {
			protocol: "openai-responses",
			baseUrl: "https://discovered.example.com",
		});

		expect(resolveModels(undefined, [discoveredModel])[0].resolvedBaseUrl).toBe(
			"https://discovered.example.com",
		);
		expect(
			resolveModels(undefined, [discoveredModel], {
				baseUrl: "https://provider.example.com",
			})[0].resolvedBaseUrl,
		).toBe("https://discovered.example.com");
		expect(
			resolveModels(undefined, [discoveredModel], {
				endpoints: { "openai-responses": "https://protocol.example.com" },
				baseUrl: "https://provider.example.com",
			})[0].resolvedBaseUrl,
		).toBe("https://protocol.example.com");
		expect(
			resolveModels(
				{ overrides: { "model-a": { baseUrl: "https://override.example.com" } } },
				[discoveredModel],
				{
					endpoints: { "openai-responses": "https://protocol.example.com" },
					baseUrl: "https://provider.example.com",
				},
			)[0].resolvedBaseUrl,
		).toBe("https://override.example.com");
	});

	it("keeps a discovered endpoint stable across repeated routing resolution", () => {
		const once = resolveModels(undefined, [
			makeModel("model-a", {
				protocol: "openai-responses",
				baseUrl: "https://discovered.example.com",
			}),
		]);
		const twice = resolveModels(undefined, once);
		expect(twice[0].resolvedBaseUrl).toBe(once[0].resolvedBaseUrl);
	});

	it("resolves per-protocol endpoint from provider", () => {
		const connection: ResolvedConnection = {
			protocol: "anthropic-messages",
			endpoints: { "anthropic-messages": "https://anthropic.example.com" },
			baseUrl: "https://fallback.example.com",
		};
		const result = resolveModels(undefined, discovered, connection);
		expect(result[0].resolvedBaseUrl).toBe("https://anthropic.example.com");
	});

	it("custom model baseUrl is preserved in resolved output", () => {
		const block: ModelsBlock = {
			custom: [
				{
					id: "custom-routed",
					name: "Custom Routed",
					maxContextLength: 50000,
					supportsTools: true,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
					baseUrl: "https://custom.example.com",
				},
			],
		};
		const connection: ResolvedConnection = { baseUrl: "https://provider.example.com" };
		const result = resolveModels(block, [], connection);
		expect(result[0].resolvedBaseUrl).toBe("https://custom.example.com");
	});

	it("custom model without protocol resolves to undefined protocol", () => {
		// The litellm dispatching client keys its default (Anthropic-shaped)
		// route on an undefined resolved protocol — a declared custom model
		// that omits `protocol` must not have one invented for it.
		const block: ModelsBlock = {
			custom: [
				{
					id: "custom-plain",
					name: "Custom Plain",
					maxContextLength: 50000,
					supportsTools: true,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
				},
			],
		};
		const result = resolveModels(block, [], { baseUrl: "https://provider.example.com" });
		expect(result[0].resolvedProtocol).toBeUndefined();
	});

	// --- Full pipeline ---

	it("full pipeline: discovery + custom + overrides + allow + deny + routing", () => {
		const block: ModelsBlock = {
			discovery: "auto",
			custom: [
				{
					id: "custom-1",
					name: "Custom 1",
					maxContextLength: 50000,
					supportsTools: true,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
				},
			],
			overrides: {
				"model-a": { name: "Model A (patched)" },
			},
			allow: ["model-a", "model-c", "custom-1"],
			deny: ["model-c"],
		};
		const connection: ResolvedConnection = { protocol: "openai-chat" };
		const result = resolveModels(block, discovered, connection);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("model-a");
		expect(result[0].name).toBe("Model A (patched)");
		expect(result[0].resolvedProtocol).toBe("openai-chat");
		expect(result[1].id).toBe("custom-1");
	});
});

describe("resolveModels — OpenCode provider context", () => {
	const GO_CONNECTION: ResolvedConnection = { baseUrl: OPENCODE_GO_BASE_URL };
	const ZEN_CONNECTION: ResolvedConnection = { baseUrl: OPENCODE_ZEN_BASE_URL };
	const OPENCODE_CONTEXT = { providerId: "opencode" };

	it("infers the product-dependent protocol from the provider URL (MiniMax)", () => {
		const minimax = [makeModel("minimax-m3")];
		expect(
			resolveModels(undefined, minimax, GO_CONNECTION, OPENCODE_CONTEXT)[0].resolvedProtocol,
		).toBe("anthropic-messages");
		expect(
			resolveModels(undefined, minimax, ZEN_CONNECTION, OPENCODE_CONTEXT)[0].resolvedProtocol,
		).toBe("openai-chat");
	});

	it("recomputes the discovery-time stamp under the full context", () => {
		// Discovery stamps with the provider URL; a stale/other-product stamp is
		// not user intent and must be recomputed, not preserved.
		const stamped = [makeModel("minimax-m3", { protocol: "openai-chat" })];
		const result = resolveModels(undefined, stamped, GO_CONNECTION, OPENCODE_CONTEXT);
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
	});

	it("recomputes from a cross-product model URL override", () => {
		// The provider connection is Zen, but the model override points at the
		// canonical Go root: inference must follow the model URL.
		const block: ModelsBlock = {
			overrides: { "minimax-m3": { baseUrl: OPENCODE_GO_BASE_URL } },
		};
		const result = resolveModels(
			block,
			[makeModel("minimax-m3")],
			ZEN_CONNECTION,
			OPENCODE_CONTEXT,
		);
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
		expect(result[0].resolvedBaseUrl).toBe(OPENCODE_GO_BASE_URL);
	});

	it("keeps an explicit protocol when the model URL crosses products", () => {
		const block: ModelsBlock = {
			overrides: {
				"minimax-m3": { protocol: "openai-chat", baseUrl: OPENCODE_GO_BASE_URL },
			},
		};
		const result = resolveModels(
			block,
			[makeModel("minimax-m3")],
			ZEN_CONNECTION,
			OPENCODE_CONTEXT,
		);
		expect(result[0].resolvedProtocol).toBe("openai-chat");
		expect(result[0].resolvedBaseUrl).toBe(OPENCODE_GO_BASE_URL);
	});

	it("ranks user and provider protocols above inference", () => {
		const block: ModelsBlock = {
			overrides: { "gpt-5.6-luna": { protocol: "openai-chat" } },
		};
		expect(
			resolveModels(block, [makeModel("gpt-5.6-luna")], ZEN_CONNECTION, OPENCODE_CONTEXT)[0]
				.resolvedProtocol,
		).toBe("openai-chat");

		const providerProtocol: ResolvedConnection = { ...ZEN_CONNECTION, protocol: "openai-chat" };
		expect(
			resolveModels(undefined, [makeModel("gpt-5.6-luna")], providerProtocol, OPENCODE_CONTEXT)[0]
				.resolvedProtocol,
		).toBe("openai-chat");
	});

	it("looks up endpoints[resolvedProtocol] AFTER inference", () => {
		const connection: ResolvedConnection = {
			...GO_CONNECTION,
			endpoints: { "anthropic-messages": "https://messages.example.com/v1" },
		};
		const result = resolveModels(
			undefined,
			[makeModel("minimax-m3")],
			connection,
			OPENCODE_CONTEXT,
		);
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
		expect(result[0].resolvedBaseUrl).toBe("https://messages.example.com/v1");
	});

	it("infers for declared custom models when discovery is off", () => {
		const block: ModelsBlock = {
			discovery: "off",
			custom: [
				{
					id: "claude-opus-5",
					name: "Claude Opus 5",
					maxContextLength: 200000,
					supportsTools: true,
					supportsImages: false,
					supportsToolResultImages: false,
					supportsWebSearch: false,
				},
			],
		};
		const result = resolveModels(block, [], ZEN_CONNECTION, OPENCODE_CONTEXT);
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
	});

	it("leaves other providers' discovered stamps untouched", () => {
		const stamped = [makeModel("claude-x", { protocol: "anthropic" })];
		const result = resolveModels(undefined, stamped, undefined, { providerId: "anthropic" });
		expect(result[0].resolvedProtocol).toBe("anthropic-messages");
	});

	it("infers the default product's routing when the opencode connection carries no URL", () => {
		// MiniMax is the product-dependent family, so it pins that the
		// absent-URL path really consults the default product.
		const defaultRoot = OPENCODE_PRODUCT_BASE_URLS[OPENCODE_DEFAULT_PRODUCT];
		const result = resolveModels(undefined, [makeModel("minimax-m3")], undefined, OPENCODE_CONTEXT);
		expect(result[0].resolvedProtocol).toBe(inferOpencodeProtocol("minimax-m3", defaultRoot));
	});
});
