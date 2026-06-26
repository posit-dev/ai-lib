/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { resolveModels } from "../resolve-models";
import type { ModelInfoLike, ModelsBlock } from "../types";

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

	// --- Full pipeline ---

	it("full pipeline: discovery + custom + overrides + allow + deny", () => {
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
		const result = resolveModels(block, discovered);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("model-a");
		expect(result[0].name).toBe("Model A (patched)");
		expect(result[1].id).toBe("custom-1");
	});
});
