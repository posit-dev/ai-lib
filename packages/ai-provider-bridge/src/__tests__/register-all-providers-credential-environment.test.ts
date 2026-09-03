/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * The host-captured credential environment must reach BOTH lazy-SDK provider
 * registrars (google-vertex and ms-foundry). Direct provider tests cannot
 * catch a dropped argument at this orchestration layer — the failure would
 * appear only after startup and lazy SDK use.
 */

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	registerGoogleVertexProvider: vi.fn(),
	registerFoundryProvider: vi.fn(),
}));

vi.mock("../providers/google-vertex-provider", () => ({
	registerGoogleVertexProvider: mocks.registerGoogleVertexProvider,
}));

vi.mock("../providers/foundry-provider", () => ({
	registerFoundryProvider: mocks.registerFoundryProvider,
}));

import { ProviderRegistry } from "../providers/ProviderRegistry";
import { registerAllProviders } from "../register-all-providers";
import type { Logger } from "../types";

function logger(): Logger {
	return {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
		trace: vi.fn(),
	};
}

describe("registerAllProviders credential environment forwarding", () => {
	it("passes credentialEnvironment to the google-vertex and ms-foundry registrars", () => {
		const credentialEnvironment = Object.freeze({
			GOOGLE_APPLICATION_CREDENTIALS: "/creds/adc.json",
			AZURE_CLIENT_SECRET: "secret",
		});
		const registry = new ProviderRegistry(logger());

		registerAllProviders(registry, logger(), {
			positAiBaseUrl: "https://api.posit.cloud",
			allowedProviders: ["google-vertex", "ms-foundry"],
			credentialEnvironment,
		});

		expect(mocks.registerGoogleVertexProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			expect.anything(),
			undefined,
			credentialEnvironment,
		);
		expect(mocks.registerFoundryProvider).toHaveBeenCalledExactlyOnceWith(
			registry,
			expect.anything(),
			credentialEnvironment,
		);
	});
});
