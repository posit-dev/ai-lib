/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	AuthorizationCodeCallback,
	AuthorizationCodeReceiver,
	CredentialSourceContext,
	OAuthGrantConfig,
	PreparedAuthorizationCodeReceiver,
} from "../Backend";
import { createCredentialProvider } from "../createCredentialProvider";
import { SingleFileStore } from "../store";
import { createStoreBackend } from "../store-backend/StoreBackend";
import type { StoredProviderCredentials } from "../store-backend/StoredProviderCredentials";

class TestReceiver implements AuthorizationCodeReceiver {
	private resolveCallback?: (callback: AuthorizationCodeCallback) => void;

	prepare(): Promise<PreparedAuthorizationCodeReceiver> {
		return Promise.resolve({
			redirectUri: "http://127.0.0.1:8020/",
			waitForCallback: () =>
				new Promise((resolve) => {
					this.resolveCallback = resolve;
				}),
			dispose() {},
		});
	}

	complete(callback: AuthorizationCodeCallback): void {
		this.resolveCallback?.(callback);
	}
}

const ok = (body: unknown): Response =>
	new Response(JSON.stringify(body), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});

describe("generalized store-backed acquisition", () => {
	let directory: string;
	let store: SingleFileStore;
	let receiver: TestReceiver;
	let generations: number;

	beforeEach(() => {
		directory = mkdtempSync(join(tmpdir(), "acquisition-"));
		store = new SingleFileStore({ filePath: join(directory, "data.json") });
		receiver = new TestReceiver();
		generations = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		rmSync(directory, { recursive: true, force: true });
	});

	function createProvider(
		env: Record<string, string | undefined> = {},
		authorizationReceiver: AuthorizationCodeReceiver = receiver,
	) {
		const backend = createStoreBackend({
			store,
			env,
			generationFactory: () => `generation-${++generations}`,
			resolveAuthMethod: (providerId) =>
				providerId === "databricks" ? { authMethodId: "apikey" } : undefined,
			oauthConfigForProvider: (
				_providerId: string,
				source?: CredentialSourceContext,
			): OAuthGrantConfig | undefined => {
				if (source?.type === "oauth-u2m") {
					return {
						grantType: "authorization-code",
						clientId: "client",
						scope: "all-apis offline_access",
						authorizationEndpoint: `${source.workspaceHost}/authorize`,
						tokenEndpoint: `${source.workspaceHost}/token`,
						credentialBaseUrl: source.workspaceHost,
						receiver: authorizationReceiver,
					};
				}
				if (source?.type === "oauth-m2m") {
					return {
						grantType: "client-credentials",
						clientId: source.clientId,
						clientSecret: source.clientSecret,
						tokenEndpoint: `${source.workspaceHost}/token`,
						credentialBaseUrl: source.workspaceHost,
						cacheKey: `${source.workspaceHost}:${source.clientId}`,
					};
				}
				return undefined;
			},
		});
		return createCredentialProvider({ backend });
	}

	it("completes authorization-code PKCE and rejects a second local start", async () => {
		const provider = createProvider();
		await provider.mutateCredentials("databricks", {
			kind: "replace",
			source: { type: "oauth-u2m", workspaceHost: "https://workspace.test" },
		});
		vi.stubGlobal(
			"fetch",
			vi.fn().mockResolvedValue(
				ok({
					access_token: "access",
					refresh_token: "refresh",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "all-apis offline_access",
				}),
			),
		);

		const started = await provider.startAuthentication("databricks");
		expect(started.status).toBe("started");
		expect(await provider.startAuthentication("databricks")).toEqual({
			status: "already-in-progress",
		});
		const pending = await store.get<StoredProviderCredentials>("auth:databricks:apikey");
		expect(pending).toMatchObject({ readiness: "pending", authenticated: false });
		expect(pending?.oauthAuth?.tokenData).toBeUndefined();

		receiver.complete({ code: "code" });
		await vi.waitFor(async () => {
			expect(await provider.getCredentials("databricks")).toEqual({
				type: "apikey",
				apiKey: "access",
				baseUrl: "https://workspace.test",
			});
		});
	});

	it("does not let a stale callback resurrect credentials after clear", async () => {
		const provider = createProvider();
		await provider.mutateCredentials("databricks", {
			kind: "replace",
			source: { type: "oauth-u2m", workspaceHost: "https://workspace.test" },
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					ok({ access_token: "stale", refresh_token: "stale-refresh", expires_in: 3600 }),
				),
		);
		await provider.startAuthentication("databricks");
		await provider.mutateCredentials("databricks", { kind: "clear" });
		receiver.complete({ code: "late" });
		await new Promise((resolve) => setTimeout(resolve, 0));

		expect(await provider.getCredentials("databricks")).toBeNull();
		expect(await store.get<StoredProviderCredentials>("auth:databricks:apikey")).toMatchObject({
			readiness: "unauthenticated",
			configured: false,
		});
	});

	it("cancels by opaque attempt ID and replaces pending state with a fresh terminal generation", async () => {
		const provider = createProvider();
		await provider.mutateCredentials("databricks", {
			kind: "replace",
			source: { type: "oauth-u2m", workspaceHost: "https://workspace.test" },
		});
		const started = await provider.startAuthentication("databricks");
		if (started.status !== "started") throw new Error("Expected authentication to start");
		const pending = await store.get<StoredProviderCredentials>("auth:databricks:apikey");
		provider.cancelAuthentication(started.challenge.attemptId);

		await vi.waitFor(async () => {
			const terminal = await store.get<StoredProviderCredentials>("auth:databricks:apikey");
			expect(terminal).toMatchObject({
				readiness: "unauthenticated",
				authenticated: false,
				error: "cancelled",
			});
			expect(terminal?.generation).not.toBe(pending?.generation);
		});
		receiver.complete({ code: "late" });
		expect(await provider.getCredentials("databricks")).toBeNull();
	});

	it("renews environment M2M in memory without persisting secrets or tokens", async () => {
		const provider = createProvider({
			DATABRICKS_CLIENT_ID: "client",
			DATABRICKS_CLIENT_SECRET: "secret",
			DATABRICKS_HOST: "https://workspace.test",
		});
		vi.stubGlobal(
			"fetch",
			vi
				.fn()
				.mockResolvedValue(
					ok({ access_token: "m2m-access", expires_in: 3600, token_type: "Bearer" }),
				),
		);

		expect(await provider.getCredentials("databricks")).toEqual({
			type: "apikey",
			apiKey: "m2m-access",
			baseUrl: "https://workspace.test",
		});
		expect(await store.keys()).toEqual([]);
		expect(await provider.getCredentialStatus("databricks")).toMatchObject({
			source: "oauth-m2m",
			origin: "environment",
		});
	});

	it("treats a legacy generationless PAT as an explicit stored source", async () => {
		await store.set("auth:databricks:apikey", {
			apiKeyAuth: { apiKey: "legacy", baseUrl: "https://legacy.test" },
		});
		const provider = createProvider({
			DATABRICKS_CLIENT_ID: "client",
			DATABRICKS_CLIENT_SECRET: "secret",
			DATABRICKS_HOST: "https://environment.test",
		});
		expect(await provider.getCredentials("databricks")).toEqual({
			type: "apikey",
			apiKey: "legacy",
			baseUrl: "https://legacy.test",
		});
	});

	it("rejects a stale process across clear, a generationless legacy write, and a later attempt", async () => {
		const firstReceiver = new TestReceiver();
		const secondReceiver = new TestReceiver();
		const firstProcess = createProvider({}, firstReceiver);
		const secondProcess = createProvider({}, secondReceiver);
		await firstProcess.mutateCredentials("databricks", {
			kind: "replace",
			source: { type: "oauth-u2m", workspaceHost: "https://workspace.test" },
		});
		await firstProcess.startAuthentication("databricks");
		await secondProcess.mutateCredentials("databricks", { kind: "clear" });
		await store.set("auth:databricks:apikey", {
			apiKeyAuth: { apiKey: "legacy", baseUrl: "https://workspace.test" },
		});
		await secondProcess.mutateCredentials("databricks", {
			kind: "replace",
			source: { type: "oauth-u2m", workspaceHost: "https://workspace.test" },
		});
		await secondProcess.startAuthentication("databricks");
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
				const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
				const code = body.get("code");
				return ok({
					access_token: code === "first" ? "stale" : "current",
					refresh_token: `${code}-refresh`,
					expires_in: 3600,
				});
			}),
		);

		firstReceiver.complete({ code: "first" });
		secondReceiver.complete({ code: "second" });
		await vi.waitFor(async () => {
			expect(await secondProcess.getCredentials("databricks")).toMatchObject({
				apiKey: "current",
			});
		});
		expect(await firstProcess.getCredentials("databricks")).toMatchObject({ apiKey: "current" });
	});
});
