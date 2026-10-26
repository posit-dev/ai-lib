/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ModelsBlock, ResolvedConnection } from "ai-config";
import { describe, expect, it } from "vitest";

import type { ModelInfo } from "../../types";
import { applyModelPolicy } from "../model-policy";

function model(id: string, name: string, vendor = "Anthropic"): ModelInfo {
	return {
		id,
		name,
		providerId: "anthropic",
		vendor,
		maxContextLength: 200000,
		supportsTools: true,
		supportsImages: true,
		supportsToolResultImages: false,
		supportsWebSearch: false,
	};
}

function entry(models: ModelsBlock | undefined, connection: ResolvedConnection = {}) {
	return { models, connection };
}

describe("applyModelPolicy", () => {
	const discovered = [
		model("claude-opus-5", "Claude Opus 5"),
		model("claude-sonnet-5", "Claude Sonnet 5"),
		model("claude-haiku-5", "Claude Haiku 5"),
	];

	it("materializes a custom model discovery never returned, with the provider id as vendor", () => {
		const { models } = applyModelPolicy(
			entry({
				custom: [
					{
						id: "claude-custom",
						name: "Claude Custom",
						maxContextLength: 100000,
						supportsTools: true,
						supportsImages: true,
						supportsToolResultImages: false,
						supportsWebSearch: false,
					},
				],
			}),
			"anthropic",
			[],
		);

		expect(models).toEqual([
			{ id: "claude-custom", name: "Claude Custom", vendor: "anthropic", providerId: "anthropic" },
		]);
	});

	it("passes models through when there is no policy", () => {
		const { models } = applyModelPolicy(undefined, "anthropic", discovered);

		expect(models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5", "claude-haiku-5"]);
		expect(models[0]).toEqual({
			id: "claude-opus-5",
			name: "Claude Opus 5",
			vendor: "Anthropic",
			providerId: "anthropic",
		});
	});

	it("routes each model by its override, then the provider connection", () => {
		const { routes } = applyModelPolicy(
			entry(
				{ overrides: { "claude-opus-5": { baseUrl: "https://opus.example" } } },
				{ protocol: "openai-responses", baseUrl: "https://gateway.example" },
			),
			"anthropic",
			discovered.slice(0, 2),
		);

		expect(Object.fromEntries(routes)).toEqual({
			"claude-opus-5": { protocol: "openai-responses", baseUrl: "https://opus.example" },
			"claude-sonnet-5": { protocol: "openai-responses", baseUrl: "https://gateway.example" },
		});
	});

	it("routes by the provider connection when there is no policy", () => {
		const { routes } = applyModelPolicy(
			entry(undefined, { protocol: "openai-responses" }),
			"anthropic",
			discovered.slice(0, 1),
		);

		expect(Object.fromEntries(routes)).toEqual({
			"claude-opus-5": { protocol: "openai-responses", baseUrl: undefined },
		});
	});
});
