/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Logger } from "../../types";
import { ProviderRegistry } from "../ProviderRegistry";
import { registerSnowflakeCortexProvider } from "../snowflake-cortex-provider";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("registerSnowflakeCortexProvider", () => {
	let registry: ProviderRegistry;

	beforeEach(() => {
		vi.clearAllMocks();
		registry = new ProviderRegistry(mockLogger);
		registerSnowflakeCortexProvider(registry, mockLogger);
	});

	it("returns no models when the Snowflake account URL is missing", async () => {
		const models = await registry.getModelsForProvider("snowflake-cortex", {
			type: "apikey",
			apiKey: "snowflake-token",
		});

		expect(models).toEqual([]);
	});

	it("returns no models for the wrong credential type", async () => {
		const models = await registry.getModelsForProvider("snowflake-cortex", {
			type: "oauth",
			accessToken: "snowflake-token",
		});

		expect(models).toEqual([]);
	});
});
