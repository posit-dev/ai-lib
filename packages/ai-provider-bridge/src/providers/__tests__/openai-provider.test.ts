/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import type { ApiKeyCredentials, Logger } from "../../types";
import { registerOpenAIProvider } from "../openai-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const credentials: ApiKeyCredentials = { type: "apikey", apiKey: "sk-test" };

function listingResponse(ids: string[]): Response {
	return new Response(
		JSON.stringify({
			data: ids.map((id) => ({ id, object: "model", owned_by: "openai" })),
		}),
		{ status: 200 },
	);
}

describe("OpenAI model discovery", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps GPT-6 IDs from the live /v1/models listing", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				listingResponse([
					"gpt-6-astra",
					"gpt-6-sol-2026-09-22",
					"gpt-6-luna",
					"gpt-5.4",
					"text-embedding-3-large",
				]),
			),
		);
		const registry = new ProviderRegistry(logger);
		registerOpenAIProvider(registry, logger);

		const models = await registry.getModelsForProvider("openai", credentials);

		expect(models.map((model) => model.id)).toEqual([
			"gpt-6-astra",
			"gpt-6-sol-2026-09-22",
			"gpt-6-luna",
			"gpt-5.4",
		]);
		const astra = models.find((model) => model.id === "gpt-6-astra");
		expect(astra?.name).toBe("GPT-6 Astra");
		expect(astra?.maxContextLength).toBe(1_050_000);
		expect(astra?.maxOutputTokens).toBe(128_000);
	});

	it("includes GPT-6 rows in the static fallback when the listing fails", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("network down");
			}),
		);
		const registry = new ProviderRegistry(logger);
		registerOpenAIProvider(registry, logger);

		const models = await registry.getModelsForProvider("openai", credentials);

		expect(models.map((model) => model.id)).toEqual(
			expect.arrayContaining(["gpt-6-astra", "gpt-6-sol", "gpt-6-luna"]),
		);
	});
});
