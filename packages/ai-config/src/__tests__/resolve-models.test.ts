/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { resolveModels } from "../resolve-models";
import type { ModelInfoLike, ModelsBlock, ResolvedConnection } from "../types";

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

	it("resolves baseUrl from provider connection when model has none", () => {
		const connection: ResolvedConnection = { baseUrl: "https://provider.example.com" };
		const result = resolveModels(undefined, discovered, connection);
		expect(result[0].resolvedBaseUrl).toBe("https://provider.example.com");
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
