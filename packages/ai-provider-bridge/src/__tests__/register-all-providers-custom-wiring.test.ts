/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mintCustomProviderId } from "ai-config";
import { describe, expect, it, vi } from "vitest";

import { registerCustomBedrockProvider } from "../providers/bedrock-provider";
import { registerCustomFoundryProvider } from "../providers/foundry-provider";
import { registerCustomGoogleVertexProvider } from "../providers/google-vertex-provider";
import { ProviderRegistry } from "../providers/ProviderRegistry";
import { registerCustomSnowflakeProvider } from "../providers/snowflake-cortex-provider";
import { registerAllProviders } from "../register-all-providers";
import type { Logger } from "../types";

vi.mock("../providers/bedrock-provider", async (importActual) => {
	const actual = await importActual<typeof import("../providers/bedrock-provider")>();
	return { ...actual, registerCustomBedrockProvider: vi.fn(actual.registerCustomBedrockProvider) };
});
vi.mock("../providers/foundry-provider", async (importActual) => {
	const actual = await importActual<typeof import("../providers/foundry-provider")>();
	return { ...actual, registerCustomFoundryProvider: vi.fn(actual.registerCustomFoundryProvider) };
});
vi.mock("../providers/google-vertex-provider", async (importActual) => {
	const actual = await importActual<typeof import("../providers/google-vertex-provider")>();
	return {
		...actual,
		registerCustomGoogleVertexProvider: vi.fn(actual.registerCustomGoogleVertexProvider),
	};
});
vi.mock("../providers/snowflake-cortex-provider", async (importActual) => {
	const actual = await importActual<typeof import("../providers/snowflake-cortex-provider")>();
	return {
		...actual,
		registerCustomSnowflakeProvider: vi.fn(actual.registerCustomSnowflakeProvider),
	};
});

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

describe("registerAllProviders custom-entry wiring", () => {
	// Every trailing registrar argument is optional, so a dropped one still compiles and
	// only fails later as an auth error at request time.
	it("passes each custom kind the callbacks and credential environment it needs", () => {
		const log = logger();
		const registry = new ProviderRegistry(log);
		const bedrockCallbacks = { onProviderStatusChange: vi.fn() };
		const googleVertexCallbacks = { onProviderStatusChange: vi.fn() };
		const snowflakeCallbacks = { reauthenticateSession: vi.fn() };
		const credentialEnvironment = { GOOGLE_CLOUD_PROJECT: "sentinel-project" };
		const awsId = mintCustomProviderId("team-bedrock");
		const vertexId = mintCustomProviderId("team-vertex");
		const snowflakeId = mintCustomProviderId("team-snowflake");
		const foundryId = mintCustomProviderId("team-foundry");

		registerAllProviders(registry, log, {
			positAiBaseUrl: "https://api.posit.cloud",
			allowedProviders: [],
			bedrockCallbacks,
			googleVertexCallbacks,
			snowflakeCallbacks,
			credentialEnvironment,
			customProviders: [
				{ id: awsId, clientKind: "aws" },
				{ id: vertexId, clientKind: "google-vertex" },
				{ id: snowflakeId, clientKind: "snowflake" },
				{ id: foundryId, clientKind: "ms-foundry" },
			],
		});

		expect(registerCustomBedrockProvider).toHaveBeenCalledWith(
			registry,
			awsId,
			log,
			bedrockCallbacks,
		);
		expect(registerCustomGoogleVertexProvider).toHaveBeenCalledWith(
			registry,
			vertexId,
			log,
			googleVertexCallbacks,
			credentialEnvironment,
		);
		expect(registerCustomSnowflakeProvider).toHaveBeenCalledWith(
			registry,
			snowflakeId,
			log,
			snowflakeCallbacks,
		);
		expect(registerCustomFoundryProvider).toHaveBeenCalledWith(
			registry,
			foundryId,
			log,
			credentialEnvironment,
		);
	});
});
