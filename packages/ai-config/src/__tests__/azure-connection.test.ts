/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { readEnvConnectionConfig } from "../connection-env.js";
import { MS_FOUNDRY_DEFAULT_SCOPE } from "../defaults.js";
import type { ProviderConfigSource } from "../resolve-catalog.js";
import { resolveProviderCatalog } from "../resolve-catalog.js";
import { providersConfigSchema } from "../schema.js";
import type { ResolvedProvider } from "../types.js";

function source(
	kind: ProviderConfigSource["kind"],
	config: ProviderConfigSource["config"],
): ProviderConfigSource {
	return { kind, config };
}

function findFoundry(catalog: readonly ResolvedProvider[]): ResolvedProvider {
	const foundry = catalog.find((p) => (p.id as string) === "ms-foundry");
	if (!foundry) throw new Error("ms-foundry missing from catalog");
	return foundry;
}

describe("azure connection section — schema", () => {
	it("accepts azure on the built-in ms-foundry provider", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				"ms-foundry": {
					baseUrl: "https://my-resource.openai.azure.com/openai/v1",
					azure: {
						authMode: "entra",
						scope: "https://ai.azure.com/.default",
						tenantId: "my-tenant",
					},
				},
			},
		});
		expect(result.success).toBe(true);
	});

	it("rejects azure on a custom ms-foundry provider", () => {
		const result = providersConfigSchema.safeParse({
			providers: {
				custom: {
					"my-foundry": {
						type: "ms-foundry",
						baseUrl: "https://my-resource.openai.azure.com/openai/v1",
						azure: { authMode: "entra" },
					},
				},
			},
		});
		expect(result.success).toBe(false);
	});

	it("rejects azure on built-in providers that do not carry the section", () => {
		const result = providersConfigSchema.safeParse({
			providers: { openai: { azure: { authMode: "entra" } } },
		});
		expect(result.success).toBe(false);
	});

	it("rejects unknown keys inside azure (strict)", () => {
		const result = providersConfigSchema.safeParse({
			providers: { "ms-foundry": { azure: { authMode: "entra", region: "eastus" } } },
		});
		expect(result.success).toBe(false);
	});

	it("rejects an invalid authMode value", () => {
		const result = providersConfigSchema.safeParse({
			providers: { "ms-foundry": { azure: { authMode: "oauth" } } },
		});
		expect(result.success).toBe(false);
	});
});

describe("azure connection section — resolution", () => {
	it("defaults authMode to apikey and scope to the cognitiveservices default", () => {
		const catalog = resolveProviderCatalog({ sources: [], envVars: {} });
		expect(findFoundry(catalog).connection.azure).toEqual({
			authMode: "apikey",
			scope: MS_FOUNDRY_DEFAULT_SCOPE,
		});
	});

	it("preserves an explicit entra mode and tenant, defaulting only scope", () => {
		const catalog = resolveProviderCatalog({
			sources: [
				source("user", {
					providers: { "ms-foundry": { azure: { authMode: "entra", tenantId: "my-tenant" } } },
				}),
			],
			envVars: {},
		});
		expect(findFoundry(catalog).connection.azure).toEqual({
			authMode: "entra",
			scope: MS_FOUNDRY_DEFAULT_SCOPE,
			tenantId: "my-tenant",
		});
	});

	it("maps MS_FOUNDRY_* env vars into the azure section", () => {
		const fragment = readEnvConnectionConfig({
			MS_FOUNDRY_AUTH_MODE: "entra",
			MS_FOUNDRY_ENTRA_SCOPE: "https://ai.azure.com/.default",
			MS_FOUNDRY_TENANT_ID: "env-tenant",
		});
		expect(fragment.providers?.["ms-foundry"]?.azure).toEqual({
			authMode: "entra",
			scope: "https://ai.azure.com/.default",
			tenantId: "env-tenant",
		});
	});

	it("lets env authMode outrank user config, and enforced outrank env", () => {
		const envVars = { MS_FOUNDRY_AUTH_MODE: "apikey" };

		const envOverUser = resolveProviderCatalog({
			sources: [source("user", { providers: { "ms-foundry": { azure: { authMode: "entra" } } } })],
			envVars,
		});
		expect(findFoundry(envOverUser).connection.azure?.authMode).toBe("apikey");

		const enforcedOverEnv = resolveProviderCatalog({
			sources: [
				source("enforced", { providers: { "ms-foundry": { azure: { authMode: "entra" } } } }),
				source("user", { providers: { "ms-foundry": { azure: { authMode: "apikey" } } } }),
			],
			envVars,
		});
		expect(findFoundry(enforcedOverEnv).connection.azure?.authMode).toBe("entra");
	});
});
