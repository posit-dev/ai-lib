/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Keyless (anonymous) Anthropic discovery.
 *
 * Auth-less custom providers — endpoints that need no API key, such as a
 * localhost SSO-authenticating enterprise proxy — synthesize
 * `{ type: "apikey", apiKey: "" }` credentials. The empty string is the
 * canonical anonymous signal: discovery must proceed and emit only
 * `anthropic-version`, with no credential header. A MISSING key still falls
 * back to the static model list without a fetch.
 */

import { mintCustomProviderId } from "ai-config";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createRawFetchCapture } from "../../../tests/helpers/raw-fetch-capture";
import type { ApiKeyCredentials, Logger } from "../../types";
import { registerCustomAnthropicProvider } from "../anthropic-provider";
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
	vi.unstubAllEnvs();
});

function modelsResponse(): Response {
	return new Response(
		JSON.stringify({
			data: [{ id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" }],
		}),
		{ status: 200, headers: { "content-type": "application/json" } },
	);
}

describe("custom Anthropic keyless discovery", () => {
	it("discovers models with an empty key, sending only anthropic-version", async () => {
		// ANTHROPIC_API_KEY is set to prove the ambient env var is never
		// inherited into the request.
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-env-must-not-leak");
		const capture = createRawFetchCapture(async () => modelsResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("corp-proxy");
		registerCustomAnthropicProvider(registry, id, logger);

		const models = await registry.getModelsForProvider(id, {
			type: "apikey",
			apiKey: "",
			baseUrl: "http://localhost:8443/v1",
		});

		expect(models.map((model) => model.id)).toEqual(["claude-sonnet-4-6"]);
		const [url, init] = capture.single();
		expect(url).toBe("http://localhost:8443/v1/models");
		const headers = new Headers(init?.headers);
		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
	});

	it("still falls back without a fetch when the key is missing entirely", async () => {
		const capture = createRawFetchCapture(async () => modelsResponse());
		vi.stubGlobal("fetch", capture.mock);

		const registry = new ProviderRegistry(logger);
		const id = mintCustomProviderId("corp-proxy");
		registerCustomAnthropicProvider(registry, id, logger);

		// A loosely-typed runtime caller with no resolved key at all (the
		// pre-synthesis shape) must not be mistaken for the anonymous signal.
		const noKey = { type: "apikey", baseUrl: "http://localhost:8443" } as ApiKeyCredentials;
		const models = await registry.getModelsForProvider(id, noKey);

		expect(models).toEqual([]);
		expect(capture.calls).toHaveLength(0);
	});
});
