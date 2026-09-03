/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * External-variant contract test.
 *
 * External builds redirect `providerEnvMappings.ts` to
 * `providerEnvMappings-external.ts` via bundler file-level aliasing, so the
 * entire public `/store-backend` surface must keep working against the empty
 * registry. This test reproduces that aliasing with a module mock and
 * exercises the surface ordinary internal tests (which see the full
 * registry) cannot cover.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock(
	"../providerEnvMappings.js",
	async () => await import("../providerEnvMappings-external.js"),
);

import {
	captureProviderEnvironment,
	createStoreBackend,
	hasEnvCredentials,
	PROVIDER_ENV_MAPPINGS,
	readSdkCredentialEnvironment,
	resolveCredentialsFromEnv,
} from "../index.js";
import type { StoreBackendStorage } from "../StoreBackend.js";

function emptyStore(): StoreBackendStorage {
	return {
		get: async () => undefined,
		set: async () => {},
		withLock: async (fn) => fn(),
		watch: () => ({ dispose() {} }),
	};
}

describe("external provider-env-mappings variant", () => {
	it("exports an empty registry", () => {
		expect(PROVIDER_ENV_MAPPINGS).toEqual({});
	});

	it("captures and reads nothing, regardless of the environment", () => {
		const env = { ANTHROPIC_API_KEY: "secret", AZURE_CLIENT_SECRET: "azure-secret" };

		expect(captureProviderEnvironment(["anthropic", "ms-foundry"], env)).toEqual({
			declaredNames: [],
			scrubbedNames: [],
			environment: {},
		});
		expect(readSdkCredentialEnvironment(env)).toEqual({
			googleApplicationCredentials: undefined,
			azureTenantId: undefined,
			azureClientId: undefined,
			azureClientSecret: undefined,
			azureClientCertificatePath: undefined,
			azureClientCertificatePassword: undefined,
		});
	});

	it("resolves no credentials from the environment", () => {
		expect(resolveCredentialsFromEnv("anthropic", { ANTHROPIC_API_KEY: "secret" })).toBeNull();
		expect(hasEnvCredentials("anthropic", { ANTHROPIC_API_KEY: "secret" })).toBe(false);
	});

	it("resolves Databricks environment credentials to none without throwing", async () => {
		const backend = createStoreBackend({
			store: emptyStore(),
			resolveAuthMethod: (providerId) =>
				providerId === "databricks" ? { authMethodId: "oauth" } : undefined,
			env: {
				DATABRICKS_AUTH_TYPE: "oauth-m2m",
				DATABRICKS_HOST: "https://workspace.example.com",
				DATABRICKS_CLIENT_ID: "client-id",
				DATABRICKS_CLIENT_SECRET: "client-secret",
			},
		});

		await expect(backend.getCredentials("databricks")).resolves.toBeNull();
	});
});
