/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

import type { Logger, ModelClient, ProviderCredentials } from "../../types";
import { ProviderRegistry } from "../ProviderRegistry";

const logger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const client: ModelClient = { chat: vi.fn() };

describe("ProviderRegistry default User-Agent", () => {
	it("injects the default on model, direct-client, and kind-client paths", async () => {
		const registry = new ProviderRegistry(logger);
		const fetcher = vi.fn(async (_credentials: ProviderCredentials) => []);
		const directFactory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		const kindFactory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerModelFetcher("models", fetcher);
		registry.registerClientFactory("direct", directFactory);
		registry.registerClientFactory("openai", kindFactory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");

		await registry.getModelsForProvider("models", {
			type: "apikey",
			apiKey: "key",
			customHeaders: { "x-tenant": "acme" },
		});
		registry.getClientForProvider("direct", {
			type: "azure-entra",
			baseUrl: "https://foundry.example.com",
			scope: "scope",
		});
		registry.getClientForProviderOrKind("custom", { type: "apikey", apiKey: "key" }, "openai");

		expect(fetcher).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: {
					"User-Agent": "PositAssistant/1.0 posit_test",
					"x-tenant": "acme",
				},
			}),
			undefined,
		);
		expect(directFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
			}),
		);
		expect(kindFactory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/1.0 posit_test" },
			}),
		);
	});

	it("preserves a non-empty explicit User-Agent case-insensitively", () => {
		const registry = new ProviderRegistry(logger);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerClientFactory("direct", factory);
		registry.setDefaultUserAgent("PositAssistant/1.0 posit_test");

		registry.getClientForProvider("direct", {
			type: "apikey",
			apiKey: "key",
			customHeaders: { "uSeR-aGeNt": "AcmeGateway/2.0" },
		});

		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "uSeR-aGeNt": "AcmeGateway/2.0" },
			}),
		);
	});

	it("uses the latest default and leaves unsupported credential variants untouched", () => {
		const registry = new ProviderRegistry(logger);
		const factory = vi.fn((_credentials: ProviderCredentials): ModelClient => client);
		registry.registerClientFactory("direct", factory);
		registry.setDefaultUserAgent("PositAssistant/first");
		registry.setDefaultUserAgent("PositAssistant/second");

		registry.getClientForProvider("direct", { type: "apikey", apiKey: "key" });
		expect(factory).toHaveBeenCalledWith(
			expect.objectContaining({
				customHeaders: { "User-Agent": "PositAssistant/second" },
			}),
		);

		factory.mockClear();
		const oauth: ProviderCredentials = { type: "oauth", accessToken: "token" };
		registry.getClientForProvider("direct", oauth);
		expect(factory).toHaveBeenCalledWith(oauth);
	});
});
