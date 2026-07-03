/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Cross-product smoke test (Phase 9): a minimal Notebooks-like consumer.
 *
 * Notebooks (and other standalone consumers) resolve BOTH config and credentials
 * using only the shared `ai-lib` packages — `ai-config` (layered catalog),
 * `ai-credentials` (credential resolver + backends), and `ai-provider-bridge`
 * (client construction) — WITHOUT importing anything from `@assistant/*`.
 *
 * This exercises the whole stack end-to-end:
 *   1. resolve a provider catalog from layered sources (ai-config),
 *   2. derive auth descriptors from the bridge's PROVIDER_MAP (client layer),
 *   3. resolve credentials through the credential provider over EACH backend —
 *      the store+env backend (outside Positron) and an injected host backend
 *      (the vscode.authentication path, represented in-memory here).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { PlatformBaseline, ProviderConfigSource, ResolvedProvider } from "ai-config";
import { resolveProviderCatalog } from "ai-config";
import type { Backend } from "ai-credentials";
import { createCredentialProvider } from "ai-credentials";
import { SingleFileStore } from "ai-credentials/store";
import type { AuthMethodDescriptor, StoredProviderCredentials } from "ai-credentials/store-backend";
import { createStoreBackend } from "ai-credentials/store-backend";
import { storageKeyFor } from "ai-credentials/types";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { PROVIDER_MAP } from "../provider-map";

const BASELINE: PlatformBaseline = { defaultEnabled: false };

function find(catalog: readonly ResolvedProvider[], id: string): ResolvedProvider | undefined {
	return catalog.find((p) => (p.id as string) === id);
}

/**
 * A notebooks consumer derives the credential auth method from the bridge's
 * client-construction map (PROVIDER_MAP) for built-ins, and from the resolved
 * catalog's clientKind for custom providers — no assistant code involved.
 */
function resolveAuthMethod(providerId: string): AuthMethodDescriptor | undefined {
	const mapping = PROVIDER_MAP[providerId as keyof typeof PROVIDER_MAP];
	if (mapping) return { authMethodId: mapping.credentialType };
	// Custom openai-compatible gateway (from the resolved catalog).
	return { authMethodId: "apikey", apiKeyOptional: true };
}

describe("Notebooks-like consumer — config + credentials across the ai-lib stack", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "nb-consumer-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a layered catalog with a built-in and a custom provider", () => {
		const sources: ProviderConfigSource[] = [
			{
				kind: "user",
				config: {
					providers: {
						anthropic: { enabled: true },
						custom: {
							"my-gateway": {
								type: "openai-compatible",
								baseUrl: "https://gw.example.com",
								enabled: true,
							},
						},
					},
				},
			},
		];
		const catalog = resolveProviderCatalog({ sources, baseline: BASELINE, envVars: {} });

		expect(find(catalog, "anthropic")?.enabled).toBe(true);
		const gw = find(catalog, "my-gateway");
		expect(gw?.enabled).toBe(true);
		expect(gw?.clientKind).toBe("openai-compatible");
		expect(gw?.connection.baseUrl).toBe("https://gw.example.com");
	});

	it("resolves credentials via the store+env backend (outside Positron)", async () => {
		const store = new SingleFileStore({ filePath: join(dir, "data.json") });
		// Seed a built-in api-key credential; leave the custom gateway to env.
		await store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
			apiKeyAuth: { apiKey: "sk-stored" },
		});

		const backend = createStoreBackend({
			store,
			resolveAuthMethod,
			env: { OPENAI_API_KEY: "sk-openai-env" },
		});
		const credentials = createCredentialProvider({ backend });

		// store hit
		expect(await credentials.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-stored",
			baseUrl: undefined,
		});
		// env fallback
		expect(await credentials.getCredentials("openai")).toEqual({
			type: "apikey",
			apiKey: "sk-openai-env",
		});
		// custom provider (widened ResolvedProviderId) — nothing stored/env → null
		expect(await credentials.getCredentials("my-gateway")).toBeNull();
	});

	it("resolves credentials via an injected host backend (the vscode.authentication path)", async () => {
		// The Positron backend is vscode-bound and can't load in a node test, so we
		// inject an equivalent in-memory Backend to prove the resolver is
		// backend-agnostic: the SAME resolver surface works over EACH backend.
		const hostBackend: Backend = {
			getCredentials: async (id) =>
				id === "anthropic" ? { type: "apikey", apiKey: "sk-from-host" } : null,
			onDidChangeCredentials: () => ({ dispose() {} }),
		};
		const credentials = createCredentialProvider({ backend: hostBackend });

		expect(await credentials.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-from-host",
		});
		expect(await credentials.getCredentials("openai")).toBeNull();
	});

	it("wires resolved providers to the bridge's client-construction map", () => {
		// The bridge is the third leg: a resolved built-in provider must be known
		// to PROVIDER_MAP so the consumer can construct a client for it.
		const sources: ProviderConfigSource[] = [
			{ kind: "user", config: { providers: { anthropic: { enabled: true } } } },
		];
		const catalog = resolveProviderCatalog({ sources, baseline: BASELINE, envVars: {} });
		const anthropic = find(catalog, "anthropic");

		expect(anthropic).toBeDefined();
		expect(PROVIDER_MAP[anthropic?.id as keyof typeof PROVIDER_MAP]?.credentialType).toBe("apikey");
	});
});
