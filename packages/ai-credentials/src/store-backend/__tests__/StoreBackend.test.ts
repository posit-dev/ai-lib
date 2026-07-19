/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createStoreBackend — the store→env→null resolver + OAuth hooks.
 *
 * Uses a real SingleFileStore over a temp file so persistence + the on-disk
 * shape are exercised end-to-end.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SingleFileStore } from "../../store";
import { storageKeyFor } from "../../types";
import type { AuthMethodDescriptor } from "../StoreBackend";
import { createStoreBackend } from "../StoreBackend";
import type { StoredProviderCredentials } from "../StoredProviderCredentials";

const DESCRIPTORS: Record<string, AuthMethodDescriptor> = {
	anthropic: { authMethodId: "apikey" },
	"openai-compatible": { authMethodId: "apikey", apiKeyOptional: true },
	ollama: { authMethodId: "local" },
	bedrock: { authMethodId: "aws-credentials" },
	positai: { authMethodId: "oauth" },
	databricks: { authMethodId: "apikey" },
};

function resolveAuthMethod(id: string): AuthMethodDescriptor | undefined {
	return DESCRIPTORS[id];
}

describe("createStoreBackend", () => {
	let dir: string;
	let store: SingleFileStore;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aicred-"));
		store = new SingleFileStore({ filePath: join(dir, "data.json") });
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	describe("getCredentials — store then env then null", () => {
		it("returns stored api-key credentials", async () => {
			await store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
				apiKeyAuth: { apiKey: "sk-stored", baseUrl: "https://gw.example" },
			});
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });

			expect(await backend.getCredentials("anthropic")).toEqual({
				type: "apikey",
				apiKey: "sk-stored",
				baseUrl: "https://gw.example",
			});
		});

		it("falls back to env when the store is empty", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				env: { ANTHROPIC_API_KEY: "sk-env" },
			});
			expect(await backend.getCredentials("anthropic")).toEqual({
				type: "apikey",
				apiKey: "sk-env",
			});
		});

		it("returns null when neither store nor env has credentials", async () => {
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(await backend.getCredentials("anthropic")).toBeNull();
		});

		it("returns null for unknown providers", async () => {
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(await backend.getCredentials("mystery")).toBeNull();
		});

		it("returns null for OAuth providers (root handles those)", async () => {
			await store.set<StoredProviderCredentials>(storageKeyFor("positai", "oauth"), {
				authenticated: true,
				oauthAuth: {
					tokenData: {
						accessToken: "x",
						refreshToken: "y",
						expiresAt: "z",
						tokenType: "Bearer",
						scope: "prism",
					},
					expiresAt: "z",
					scope: "prism",
				},
			});
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(await backend.getCredentials("positai")).toBeNull();
		});

		it("returns stored local + aws credentials", async () => {
			await store.set<StoredProviderCredentials>(storageKeyFor("ollama", "local"), {
				localAuth: { endpoint: "http://localhost:11434" },
			});
			await store.set<StoredProviderCredentials>(storageKeyFor("bedrock", "aws-credentials"), {
				awsAuth: { region: "us-west-2", accessKeyId: "AK", secretAccessKey: "SK" },
			});
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });

			expect(await backend.getCredentials("ollama")).toEqual({
				type: "local",
				endpoint: "http://localhost:11434",
			});
			expect(await backend.getCredentials("bedrock")).toMatchObject({
				type: "aws-credentials",
				region: "us-west-2",
				accessKeyId: "AK",
				secretAccessKey: "SK",
			});
		});

		it("treats an empty required api key as unset and falls through to env", async () => {
			await store.set<StoredProviderCredentials>(storageKeyFor("anthropic", "apikey"), {
				apiKeyAuth: { apiKey: "" },
			});
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				env: { ANTHROPIC_API_KEY: "sk-env" },
			});
			expect(await backend.getCredentials("anthropic")).toEqual({
				type: "apikey",
				apiKey: "sk-env",
			});
		});
	});

	describe("Zod validation (Phase 0 #5 runtime guard)", () => {
		it("parses a tolerant legacy record (subset of fields) unchanged", async () => {
			// Legacy api-key record with no `configured`/`authenticated` flags.
			await store.set(storageKeyFor("anthropic", "apikey"), {
				apiKeyAuth: { apiKey: "sk-legacy" },
			});
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(await backend.getCredentials("anthropic")).toEqual({
				type: "apikey",
				apiKey: "sk-legacy",
				baseUrl: undefined,
			});
		});

		it("drops a structurally invalid record (apiKeyAuth missing required apiKey)", async () => {
			// Missing the required `apiKey` string → schema rejects the record.
			await store.set(storageKeyFor("anthropic", "apikey"), {
				apiKeyAuth: { baseUrl: "https://gw.example" },
			});
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				env: { ANTHROPIC_API_KEY: "sk-env" },
			});
			// Invalid record ignored → falls through to env fallback.
			expect(await backend.getCredentials("anthropic")).toEqual({
				type: "apikey",
				apiKey: "sk-env",
			});
		});

		it("drops an invalid record with no env fallback → null", async () => {
			await store.set(storageKeyFor("bedrock", "aws-credentials"), {
				awsAuth: { accessKeyId: "AK" }, // missing required `region`
			});
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(await backend.getCredentials("bedrock")).toBeNull();
		});
	});

	describe("oauth hooks", () => {
		const oauthConfigForProvider = () => ({
			authHost: "auth.test",
			scope: "prism",
			clientId: "databot",
		});

		it("is absent when no oauthConfigForProvider is supplied", () => {
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			expect(backend.oauth).toBeUndefined();
		});

		it("persists and reads back tokens with a computed expiry", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				oauthConfigForProvider,
				env: {},
			});
			const oauth = backend.oauth;
			expect(oauth).toBeDefined();
			if (!oauth) return;

			await oauth.persistTokens("positai", {
				accessToken: "at",
				refreshToken: "rt",
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: "prism",
			});

			const tokens = await oauth.readTokens("positai");
			expect(tokens).toMatchObject({ accessToken: "at", refreshToken: "rt", scope: "prism" });
			expect(new Date(tokens?.expiresAt ?? 0).getTime()).toBeGreaterThan(Date.now());

			// Round-trips through the on-disk StoredProviderCredentials shape.
			const stored = await store.get<StoredProviderCredentials>(storageKeyFor("positai", "oauth"));
			expect(stored?.authenticated).toBe(true);
			expect(stored?.oauthAuth?.tokenData.accessToken).toBe("at");
		});

		it("persistError clears tokens and readTokens returns null", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				oauthConfigForProvider,
				env: {},
			});
			const oauth = backend.oauth;
			if (!oauth) throw new Error("expected oauth hooks");

			await oauth.persistTokens("positai", {
				accessToken: "at",
				refreshToken: "rt",
				expiresIn: 3600,
				tokenType: "Bearer",
				scope: "prism",
			});
			await oauth.persistError("positai", "access_denied");

			expect(await oauth.readTokens("positai")).toBeNull();
			const stored = await store.get<StoredProviderCredentials>(storageKeyFor("positai", "oauth"));
			expect(stored?.error).toBe("access_denied");
			expect(await backend.getCredentialStatus("positai")).toMatchObject({
				authenticated: false,
				error: "access_denied",
			});
		});

		it("clearError resets a prior error record to a clean unauthenticated state", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				oauthConfigForProvider,
				env: {},
			});
			const oauth = backend.oauth;
			if (!oauth) throw new Error("expected oauth hooks");

			await oauth.persistError("positai", "access_denied");
			await oauth.clearError("positai");

			const stored = await store.get<StoredProviderCredentials>(storageKeyFor("positai", "oauth"));
			expect(stored?.authenticated).toBe(false);
			expect(stored?.error).toBeUndefined();
			expect(await oauth.readTokens("positai")).toBeNull();
		});

		it("readTokens ignores a record marked authenticated:false with stale tokenData", async () => {
			// Legacy refresh-failure shape: authenticated flipped to false but
			// oauthAuth.tokenData left in place. Must NOT be treated as usable.
			await store.set<StoredProviderCredentials>(storageKeyFor("positai", "oauth"), {
				authenticated: false,
				error: "refresh_failed",
				oauthAuth: {
					tokenData: {
						accessToken: "stale",
						refreshToken: "rt",
						expiresAt: new Date(Date.now() + 3600_000).toISOString(),
						tokenType: "Bearer",
						scope: "prism",
					},
					expiresAt: new Date(Date.now() + 3600_000).toISOString(),
					scope: "prism",
				},
			});
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				oauthConfigForProvider,
				env: {},
			});
			expect(await backend.oauth?.readTokens("positai")).toBeNull();
		});
	});

	describe("Databricks environment source selection", () => {
		it("does not report PAT readiness when explicitly selected M2M is incomplete", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				env: {
					DATABRICKS_AUTH_TYPE: "oauth-m2m",
					DATABRICKS_TOKEN: "must-not-be-used",
					DATABRICKS_HOST: "https://workspace.test",
					DATABRICKS_CLIENT_ID: "incomplete-client",
				},
			});

			expect(await backend.getCredentials("databricks")).toBeNull();
			expect(await backend.getCredentialStatus("databricks")).toMatchObject({
				configured: false,
				authenticated: false,
				readiness: "unauthenticated",
				source: "oauth-m2m",
				origin: "environment",
			});
		});

		it("uses the same complete M2M source for material and status", async () => {
			const backend = createStoreBackend({
				store,
				resolveAuthMethod,
				oauthConfigForProvider: (_providerId, source) =>
					source?.type === "oauth-m2m"
						? {
								grantType: "client-credentials",
								clientId: source.clientId,
								clientSecret: source.clientSecret,
								tokenEndpoint: `${source.workspaceHost}/token`,
								credentialBaseUrl: source.workspaceHost,
								cacheKey: source.clientId,
							}
						: undefined,
				env: {
					DATABRICKS_AUTH_TYPE: "oauth-m2m",
					DATABRICKS_TOKEN: "must-not-be-used",
					DATABRICKS_HOST: "https://workspace.test",
					DATABRICKS_CLIENT_ID: "client",
					DATABRICKS_CLIENT_SECRET: "secret",
				},
			});

			expect(await backend.getCredentials("databricks")).toBeNull();
			expect(await backend.getCredentialStatus("databricks")).toMatchObject({
				configured: true,
				authenticated: true,
				source: "oauth-m2m",
				origin: "environment",
			});
		});
	});

	describe("onDidChangeCredentials", () => {
		it("is a no-op when no watched providers are given", () => {
			const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });
			const disposable = backend.onDidChangeCredentials(() => {
				throw new Error("should not fire");
			});
			expect(typeof disposable.dispose).toBe("function");
			disposable.dispose();
		});
	});

	describe("custom providers (widened ResolvedProviderId, Phase 0 #2)", () => {
		// Custom catalog providers arrive as arbitrary (minted) id strings whose
		// descriptors come from the resolved catalog at runtime, not a fixed map.
		// The backend must resolve them exactly like built-ins.
		const CUSTOM_ID = "my-gateway";
		const resolveCustom = (id: string): AuthMethodDescriptor | undefined =>
			id === CUSTOM_ID ? { authMethodId: "apikey", apiKeyOptional: true } : undefined;

		it("resolves stored api-key credentials for a custom provider id", async () => {
			await store.set<StoredProviderCredentials>(storageKeyFor(CUSTOM_ID, "apikey"), {
				apiKeyAuth: { apiKey: "sk-custom", baseUrl: "https://gw.custom" },
			});
			const backend = createStoreBackend({ store, resolveAuthMethod: resolveCustom, env: {} });

			expect(await backend.getCredentials(CUSTOM_ID)).toEqual({
				type: "apikey",
				apiKey: "sk-custom",
				baseUrl: "https://gw.custom",
			});
		});

		it("resolves an api-key-optional custom provider even with no stored key", async () => {
			// openai-compatible-style gateways may need only a baseUrl (apiKeyOptional).
			await store.set<StoredProviderCredentials>(storageKeyFor(CUSTOM_ID, "apikey"), {
				apiKeyAuth: { apiKey: "", baseUrl: "https://gw.custom" },
			});
			const backend = createStoreBackend({ store, resolveAuthMethod: resolveCustom, env: {} });

			expect(await backend.getCredentials(CUSTOM_ID)).toEqual({
				type: "apikey",
				apiKey: "",
				baseUrl: "https://gw.custom",
			});
		});

		it("returns null for a custom id with no catalog descriptor", async () => {
			const backend = createStoreBackend({ store, resolveAuthMethod: resolveCustom, env: {} });
			expect(await backend.getCredentials("unregistered-custom")).toBeNull();
		});
	});
});

/**
 * Disk-format compatibility (Phase 0 #5 — v1 is byte-compatible).
 *
 * A legacy `data.json` (records with the current 9-key shape, no stored version)
 * must round-trip byte-identically through the store backend: resolving
 * credentials only reads, never rewrites the file.
 */
describe("createStoreBackend — legacy data.json byte-compatibility", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aicred-compat-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	// A representative pre-existing store: one record per auth method, no version
	// marker, exactly as written by the shipping credential store today.
	const LEGACY_JSON = JSON.stringify(
		{
			"auth:anthropic:apikey": {
				configured: true,
				authenticated: true,
				apiKeyAuth: { apiKey: "sk-legacy-anthropic" },
			},
			"auth:ollama:local": {
				configured: true,
				localAuth: { endpoint: "http://localhost:11434" },
			},
			"auth:bedrock:aws-credentials": {
				configured: true,
				awsAuth: { region: "us-west-2", accessKeyId: "AK", secretAccessKey: "SK" },
			},
			"auth:positai:oauth": {
				authenticated: true,
				oauthAuth: {
					tokenData: {
						accessToken: "at",
						refreshToken: "rt",
						expiresAt: "2999-01-01T00:00:00.000Z",
						tokenType: "Bearer",
						scope: "prism",
					},
					expiresAt: "2999-01-01T00:00:00.000Z",
					scope: "prism",
				},
			},
		},
		null,
		2,
	);

	it("reads legacy records via the tolerant Zod schema without rewriting the file", async () => {
		const filePath = join(dir, "data.json");
		writeFileSync(filePath, LEGACY_JSON);
		const before = readFileSync(filePath);

		const store = new SingleFileStore({ filePath });
		const backend = createStoreBackend({ store, resolveAuthMethod, env: {} });

		// Existing records parse and resolve to runtime credentials.
		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-legacy-anthropic",
			baseUrl: undefined,
		});
		expect(await backend.getCredentials("ollama")).toEqual({
			type: "local",
			endpoint: "http://localhost:11434",
		});
		expect(await backend.getCredentials("bedrock")).toMatchObject({
			type: "aws-credentials",
			region: "us-west-2",
		});
		// OAuth is resolved by the root state machine, so the backend returns null
		// here — but the stored oauth record must remain untouched on disk.
		expect(await backend.getCredentials("positai")).toBeNull();

		// The file is byte-identical after all reads (no migration, no re-serialize).
		const after = readFileSync(filePath);
		expect(after.equals(before)).toBe(true);
	});
});
