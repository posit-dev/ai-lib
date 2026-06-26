/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../providers/ProviderRegistry";
import { registerAllProviders } from "../register-all-providers-external";
import type { Logger } from "../types";

// positai is deliberately NOT mocked: we run the real register fn against a real registry and
// record which provider IDs actually get registered. That proves the external variant ever
// registers ONLY positai -- not just that positai registers. (registerPositAiProvider only
// registers lazy fetchers/factories; no network or SDK work happens during registration.)

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

const BASE_URL = "https://posit.example.com/v1";

describe("registerAllProviders (external)", () => {
	let registry: ProviderRegistry;
	let registeredIds: () => string[];

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		const fetcherSpy = vi.spyOn(registry, "registerModelFetcher");
		const factorySpy = vi.spyOn(registry, "registerClientFactory");
		registeredIds = () => [
			...new Set([
				...fetcherSpy.mock.calls.map((call) => call[0]),
				...factorySpy.mock.calls.map((call) => call[0]),
			]),
		];
	});

	it("registers exactly positai when allowedProviders is omitted", () => {
		registerAllProviders(registry, mockLogger, { positAiBaseUrl: BASE_URL });

		expect(registeredIds()).toEqual(["positai"]);
	});

	it("registers exactly positai when it is in allowedProviders", () => {
		registerAllProviders(registry, mockLogger, {
			positAiBaseUrl: BASE_URL,
			allowedProviders: ["positai", "anthropic"],
		});

		expect(registeredIds()).toEqual(["positai"]);
	});

	it("registers nothing when allowedProviders excludes positai", () => {
		registerAllProviders(registry, mockLogger, {
			positAiBaseUrl: BASE_URL,
			allowedProviders: ["anthropic"],
		});

		expect(registeredIds()).toEqual([]);
	});

	it("registers nothing when allowedProviders is empty", () => {
		registerAllProviders(registry, mockLogger, { positAiBaseUrl: BASE_URL, allowedProviders: [] });

		expect(registeredIds()).toEqual([]);
	});

	it("registers only positai even when bedrock/vertex callbacks are passed", () => {
		registerAllProviders(registry, mockLogger, {
			positAiBaseUrl: BASE_URL,
			bedrockCallbacks: { onProviderStatusChange: vi.fn().mockResolvedValue(undefined) },
			googleVertexCallbacks: { onProviderStatusChange: vi.fn().mockResolvedValue(undefined) },
		});

		expect(registeredIds()).toEqual(["positai"]);
	});
});
