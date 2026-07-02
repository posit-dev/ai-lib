/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createStoreBackend — the store→env→null resolver + OAuth hooks.
 *
 * Uses a real SingleFileStore over a temp file so persistence + the on-disk
 * shape are exercised end-to-end.
 */

import { mkdtempSync, rmSync } from "node:fs";
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
});
