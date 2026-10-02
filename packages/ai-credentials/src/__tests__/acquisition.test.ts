/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createSingleFileStoreFixture,
	type SingleFileStoreFixture,
} from "../../tests/helpers/single-file-store-fixture.js";
import { AcquisitionEngine } from "../acquisition";
import type {
	AcquisitionBackendHooks,
	AuthorizationCodeCallback,
	AuthorizationCodeReceiver,
	CredentialSourceContext,
	OAuthGrantConfig,
	OAuthProviderConfig,
	PreparedAuthorizationCodeReceiver,
	StoredOAuthTokens,
} from "../Backend";
import { createCredentialProvider } from "../createCredentialProvider";
import { createStoreBackend } from "../store-backend/StoreBackend";
import type { StoredProviderCredentials } from "../store-backend/StoredProviderCredentials";
import type { Logger } from "../types/index.js";

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
	let fixture: SingleFileStoreFixture;
	let store: SingleFileStoreFixture["store"];
	let receiver: TestReceiver;
	let generations: number;

	beforeEach(() => {
		fixture = createSingleFileStoreFixture("acquisition-");
		store = fixture.store;
		receiver = new TestReceiver();
		generations = 0;
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		fixture.cleanup();
	});

	function createProvider(
		env: Record<string, string | undefined> = {},
		authorizationReceiver: AuthorizationCodeReceiver = receiver,
		logger?: Logger,
	) {
		const backend = createStoreBackend({
			store,
			env,
			generationFactory: () => `generation-${++generations}`,
			resolveAuthMethod: (providerId) => {
				if (providerId === "databricks") return { authMethodId: "apikey" };
				if (providerId === "positai") return { authMethodId: "oauth" };
				return undefined;
			},
			oauthConfigForProvider: (
				providerId: string,
				source?: CredentialSourceContext,
			): OAuthGrantConfig | OAuthProviderConfig | undefined => {
				if (providerId === "positai") {
					return { authHost: "auth.test", clientId: "posit-ai", scope: "prism" };
				}
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
		return createCredentialProvider({ backend, logger });
	}

	it("serves a valid stored Connect token after restart when grant setup is unavailable", async () => {
		const serverUrl = "https://connect.test";
		const key = "auth:connect:apikey";
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		await store.set<StoredProviderCredentials>(key, {
			source: "oauth-device",
			readiness: "ready",
			generation: "stored-token",
			oauthAuth: {
				serverUrl,
				tokenData: {
					accessToken: "valid-access",
					refreshToken: "stored-refresh",
					expiresAt,
					tokenType: "Bearer",
					scope: "",
				},
			},
		});
		const setup = vi.fn().mockRejectedValue(new Error("discovery unavailable"));
		const backend = createStoreBackend({
			store,
			env: {},
			allowOfflineServerToken: (_id, url) => url === serverUrl,
			resolveAuthMethod: (id) => (id === "connect" ? { authMethodId: "apikey" } : undefined),
			oauthConfigForProvider: (_id, source) =>
				source?.type === "oauth-device" && source.serverUrl ? setup() : undefined,
		});
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("connect")).toEqual({
			type: "apikey",
			apiKey: "valid-access",
			baseUrl: serverUrl,
		});
		expect(await backend.getCredentialStatus("connect")).toMatchObject({ authenticated: true });
		expect(setup).toHaveBeenCalledTimes(1);
		await provider.dispose();
	});

	it("rechecks host policy on every offline read, including the setup cooldown", async () => {
		const serverUrl = "https://connect.test";
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		await store.set<StoredProviderCredentials>("auth:connect:apikey", {
			source: "oauth-device",
			readiness: "ready",
			oauthAuth: {
				serverUrl,
				tokenData: {
					accessToken: "access",
					refreshToken: "refresh",
					expiresAt,
					tokenType: "Bearer",
					scope: "",
				},
			},
		});
		let allowed = true;
		const backend = createStoreBackend({
			store,
			env: {},
			allowOfflineServerToken: () => allowed,
			resolveAuthMethod: (id) => (id === "connect" ? { authMethodId: "apikey" } : undefined),
			oauthConfigForProvider: () => Promise.reject(new Error("discovery unavailable")),
		});
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("connect")).toMatchObject({ apiKey: "access" });
		allowed = false;
		expect(await provider.getCredentials("connect")).toBeNull();
		await provider.dispose();
	});

	it("does not serve a replaced server's token while offline policy is pending", async () => {
		const serverA = "https://connect-a.test";
		const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
		await store.set<StoredProviderCredentials>("auth:connect:apikey", {
			source: "oauth-device",
			readiness: "ready",
			generation: "server-a",
			oauthAuth: {
				serverUrl: serverA,
				tokenData: {
					accessToken: "access-a",
					refreshToken: "refresh-a",
					expiresAt,
					tokenType: "Bearer",
					scope: "",
				},
			},
		});
		const backend = createStoreBackend({
			store,
			env: {},
			resolveAuthMethod: (id) => (id === "connect" ? { authMethodId: "apikey" } : undefined),
			oauthConfigForProvider: () => Promise.reject(new Error("discovery unavailable")),
			allowOfflineServerToken: async () => {
				await store.set<StoredProviderCredentials>("auth:connect:apikey", {
					source: "oauth-device",
					readiness: "ready",
					generation: "server-b",
					oauthAuth: {
						serverUrl: "https://connect-b.test",
						tokenData: {
							accessToken: "access-b",
							refreshToken: "refresh-b",
							expiresAt,
							tokenType: "Bearer",
							scope: "",
						},
					},
				});
				return true;
			},
		});
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("connect")).toBeNull();
		await provider.dispose();
	});

	it("does not serve an expired stored Connect token during a grant setup outage", async () => {
		const serverUrl = "https://connect.test";
		await store.set<StoredProviderCredentials>("auth:connect:apikey", {
			source: "oauth-device",
			readiness: "ready",
			oauthAuth: {
				serverUrl,
				tokenData: {
					accessToken: "expired-access",
					refreshToken: "refresh",
					expiresAt: new Date(0).toISOString(),
					tokenType: "Bearer",
					scope: "",
				},
			},
		});
		const backend = createStoreBackend({
			store,
			env: {},
			allowOfflineServerToken: (_id, url) => url === serverUrl,
			resolveAuthMethod: (id) => (id === "connect" ? { authMethodId: "apikey" } : undefined),
			oauthConfigForProvider: () => Promise.reject(new Error("discovery unavailable")),
		});
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("connect")).toBeNull();
		await provider.dispose();
	});

	it("does not use tokens from a server switched while the OAuth grant was resolving", async () => {
		const serverA = "https://connect-a.test";
		const serverB = "https://connect-b.test";
		const key = "auth:connect:apikey";
		const record = (serverUrl: string, expiresAt: string): StoredProviderCredentials => ({
			source: "oauth-device",
			readiness: "ready",
			generation: serverUrl,
			oauthAuth: {
				serverUrl,
				expiresAt,
				tokenData: {
					accessToken: `access-${serverUrl}`,
					refreshToken: `refresh-${serverUrl}`,
					expiresAt,
					tokenType: "Bearer",
					scope: "",
				},
			},
		});
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		for (const expiresAt of [
			new Date(Date.now() + 3_600_000).toISOString(),
			new Date(0).toISOString(),
		]) {
			let grantRead!: () => void;
			let releaseGrant!: () => void;
			const read = new Promise<void>((resolve) => {
				grantRead = resolve;
			});
			const release = new Promise<void>((resolve) => {
				releaseGrant = resolve;
			});
			const backend = createStoreBackend({
				store,
				env: {},
				resolveAuthMethod: (id) => (id === "connect" ? { authMethodId: "apikey" } : undefined),
				oauthConfigForProvider: async (_id, source) => {
					if (source.type !== "oauth-device" || !source.serverUrl) return undefined;
					if (source.serverUrl === serverA) {
						grantRead();
						await release;
					}
					return {
						grantType: "device-code" as const,
						clientId: "client",
						scope: "",
						deviceAuthorizationEndpoint: `${source.serverUrl}/device`,
						tokenEndpoint: `${source.serverUrl}/token`,
						credentialBaseUrl: source.serverUrl,
					};
				},
			});
			const provider = createCredentialProvider({ backend });
			await store.set(key, record(serverA, new Date(Date.now() + 3_600_000).toISOString()));
			const pending = provider.getCredentials("connect");
			await read;
			await store.set(key, record(serverB, expiresAt));
			releaseGrant();
			expect(await pending).toBeNull();
			expect(fetchMock).not.toHaveBeenCalled();
			await provider.dispose();
		}
	});

	it("completes authorization-code PKCE and rejects a genuinely concurrent local start", async () => {
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

		const [started, concurrent] = await Promise.all([
			provider.startAuthentication("databricks"),
			provider.startAuthentication("databricks"),
		]);
		expect(started.status).toBe("started");
		expect(concurrent).toEqual({
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

	describe("Posit AI Pass device authentication through the store backend", () => {
		beforeEach(() => vi.useFakeTimers());
		afterEach(() => vi.useRealTimers());

		function deviceCodeResponse(): Response {
			return ok({
				user_code: "WXYZ",
				verification_uri: "https://auth.test/device",
				verification_uri_complete: "https://auth.test/device?code=WXYZ",
				device_code: "device-code",
				interval: 1,
				expires_in: 900,
			});
		}

		it("commits success and records cancellation and errors as terminal generations", async () => {
			const provider = createProvider();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(deviceCodeResponse())
				.mockResolvedValueOnce(
					ok({
						access_token: "posit-access",
						refresh_token: "posit-refresh",
						expires_in: 3600,
						token_type: "Bearer",
						scope: "prism",
					}),
				);
			vi.stubGlobal("fetch", fetchMock);

			const successful = await provider.startAuthentication("positai");
			if (successful.status !== "started") throw new Error("Expected authentication to start");
			expect(
				await provider.getAuthenticationAttemptOutcome(successful.challenge.attemptId),
			).toEqual({
				status: "pending",
			});
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await provider.getCredentials("positai")).toEqual({
					type: "oauth",
					accessToken: "posit-access",
				});
			});
			expect(
				await provider.getAuthenticationAttemptOutcome(successful.challenge.attemptId),
			).toEqual({
				status: "succeeded",
			});

			fetchMock.mockResolvedValueOnce(deviceCodeResponse());
			const cancelled = await provider.startAuthentication("positai");
			if (cancelled.status !== "started") throw new Error("Expected authentication to start");
			provider.cancelAuthentication(cancelled.challenge.attemptId);
			await vi.waitFor(async () => {
				expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
					readiness: "unauthenticated",
					error: "cancelled",
				});
			});
			expect(await provider.getAuthenticationAttemptOutcome(cancelled.challenge.attemptId)).toEqual(
				{
					status: "cancelled",
				},
			);

			fetchMock.mockResolvedValueOnce(deviceCodeResponse()).mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "access_denied" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			);
			const denied = await provider.startAuthentication("positai");
			if (denied.status !== "started") throw new Error("Expected authentication to start");
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
					readiness: "unauthenticated",
					error: "access_denied",
				});
			});
			expect(await provider.getAuthenticationAttemptOutcome(denied.challenge.attemptId)).toEqual({
				status: "failed",
				error: "access_denied",
			});
		});

		it("reports another process's sign-in over the same record as superseding this attempt", async () => {
			const windowA = createProvider();
			const windowB = createProvider();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(deviceCodeResponse())
				.mockResolvedValueOnce(deviceCodeResponse())
				.mockResolvedValueOnce(
					ok({
						access_token: "window-b-access",
						refresh_token: "window-b-refresh",
						expires_in: 3600,
						token_type: "Bearer",
						scope: "prism",
					}),
				);
			vi.stubGlobal("fetch", fetchMock);

			const attemptA = await windowA.startAuthentication("positai");
			if (attemptA.status !== "started") throw new Error("Expected authentication to start");
			const attemptB = await windowB.startAuthentication("positai");
			if (attemptB.status !== "started") throw new Error("Expected authentication to start");

			expect(await windowA.getAuthenticationAttemptOutcome(attemptA.challenge.attemptId)).toEqual({
				status: "superseded",
			});
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await windowB.getAuthenticationAttemptOutcome(attemptB.challenge.attemptId)).toEqual(
					{
						status: "succeeded",
					},
				);
			});
			// Window A stopped polling: the one token request was window B's.
			expect(fetchMock).toHaveBeenCalledTimes(3);
			expect(await windowA.getAuthenticationAttemptOutcome(attemptA.challenge.attemptId)).toEqual({
				status: "superseded",
			});
			await windowA.dispose();
			await windowB.dispose();
		});

		it("reports another process's disconnect as superseding this attempt without waiting for expiry", async () => {
			const windowA = createProvider();
			const windowB = createProvider();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(deviceCodeResponse()));

			const attemptA = await windowA.startAuthentication("positai");
			if (attemptA.status !== "started") throw new Error("Expected authentication to start");
			await windowB.mutateCredentials("positai", { kind: "clear" });

			expect(await windowA.getAuthenticationAttemptOutcome(attemptA.challenge.attemptId)).toEqual({
				status: "superseded",
			});
			await windowA.dispose();
			await windowB.dispose();
		});

		it("propagates the RFC 6749 error_description from a failed device-authorization start", async () => {
			const provider = createProvider();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error: "invalid_client",
							error_description: "Invalid client_id parameter value.",
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
				),
			);

			await expect(provider.startAuthentication("positai")).rejects.toThrow(
				"oauth_http_400: Invalid client_id parameter value.",
			);
			await vi.waitFor(async () => {
				expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
					readiness: "unauthenticated",
					error: "oauth_http_400: Invalid client_id parameter value.",
				});
			});
		});

		it("bounds server-supplied error detail in the persisted terminal record", async () => {
			const provider = createProvider();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValueOnce(
					new Response(
						JSON.stringify({
							error: "invalid_client",
							error_description: "x".repeat(500),
						}),
						{ status: 400, headers: { "Content-Type": "application/json" } },
					),
				),
			);

			await expect(provider.startAuthentication("positai")).rejects.toThrow("oauth_http_400: ");
			await vi.waitFor(async () => {
				const record = await store.get<StoredProviderCredentials>("auth:positai:oauth");
				expect(record).toMatchObject({ readiness: "unauthenticated" });
				const error = (record as { error?: string }).error ?? "";
				expect(error.startsWith("oauth_http_400: ")).toBe(true);
				expect(error.length).toBeLessThanOrEqual("oauth_http_400: ".length + 201);
				expect(error.endsWith("…")).toBe(true);
			});
		});

		it("shares one attempt across generic and compatibility surfaces", async () => {
			const provider = createProvider();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(deviceCodeResponse()));

			await provider.startDeviceAuth("positai");
			expect(await provider.startAuthentication("positai")).toEqual({
				status: "already-in-progress",
			});
			provider.cancelDeviceAuth("positai");
			await provider.dispose();
		});

		it("does not let compatibility polling resurrect credentials after clear", async () => {
			const provider = createProvider();
			const fetchMock = vi
				.fn()
				.mockResolvedValueOnce(deviceCodeResponse())
				.mockResolvedValueOnce(
					ok({
						access_token: "stale",
						refresh_token: "stale-refresh",
						expires_in: 3600,
						token_type: "Bearer",
						scope: "prism",
					}),
				);
			vi.stubGlobal("fetch", fetchMock);

			await provider.startDeviceAuth("positai");
			await provider.mutateCredentials("positai", { kind: "clear" });
			await vi.advanceTimersByTimeAsync(5000);
			expect(fetchMock).toHaveBeenCalledOnce();
			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
				readiness: "unauthenticated",
				configured: false,
			});
			await provider.dispose();
		});

		it("durably terminates pending authentication during graceful disposal", async () => {
			const provider = createProvider();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(deviceCodeResponse()));
			await provider.startAuthentication("positai");

			await provider.dispose();

			expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
				readiness: "unauthenticated",
				error: "cancelled",
			});
		});
	});

	describe("refresh resilience through the store backend", () => {
		const err = (status: number, body: unknown): Response =>
			new Response(typeof body === "string" ? body : JSON.stringify(body), {
				status,
				headers: { "Content-Type": "application/json" },
			});

		function mockLogger() {
			return {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				trace: vi.fn(),
			};
		}

		function loggedText(logger: ReturnType<typeof mockLogger>): string {
			return [...logger.warn.mock.calls, ...logger.error.mock.calls]
				.flat()
				.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
				.join(" | ");
		}

		function expiredPositaiRecord(): StoredProviderCredentials {
			const expiresAt = new Date(Date.now() - 60_000).toISOString();
			return {
				generation: "seed-generation",
				readiness: "ready",
				source: "oauth-device",
				configured: true,
				authenticated: true,
				oauthAuth: {
					tokenData: {
						accessToken: "old-access",
						refreshToken: "old-refresh",
						expiresAt,
						tokenType: "Bearer",
						scope: "prism",
					},
					expiresAt,
					scope: "prism",
				},
			};
		}

		async function seedExpiredPositai(): Promise<StoredProviderCredentials> {
			const record = expiredPositaiRecord();
			await store.set("auth:positai:oauth", record);
			return record;
		}

		function storedPositai(): Promise<StoredProviderCredentials | undefined> {
			return store.get<StoredProviderCredentials>("auth:positai:oauth");
		}

		it("refreshes an expired token and persists the rotated tokens", async () => {
			await seedExpiredPositai();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					ok({
						access_token: "fresh-access",
						refresh_token: "fresh-refresh",
						expires_in: 3600,
						token_type: "Bearer",
						scope: "prism",
					}),
				),
			);
			const provider = createProvider();

			expect(await provider.getCredentials("positai")).toEqual({
				type: "oauth",
				accessToken: "fresh-access",
			});
			expect(await storedPositai()).toMatchObject({
				readiness: "ready",
				authenticated: true,
				oauthAuth: {
					tokenData: { accessToken: "fresh-access", refreshToken: "fresh-refresh" },
				},
			});
		});

		it("keeps the stored tokens and ready record when refresh hits a network error", async () => {
			const seeded = await seedExpiredPositai();
			const bytesBefore = fixture.readBytes();
			const logger = mockLogger();
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
			const provider = createProvider({}, undefined, logger);

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toEqual(seeded);
			expect(fixture.readBytes().equals(bytesBefore)).toBe(true);
			expect(loggedText(logger)).toContain("transient");
		});

		it.each([
			{ status: 400, code: "invalid_grant" },
			{ status: 401, code: "invalid_client" },
		])("tombstones on a definitive server rejection ($status $code)", async ({ status, code }) => {
			const logger = mockLogger();
			await seedExpiredPositai();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(err(status, { error: code })));
			const provider = createProvider({}, undefined, logger);

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toMatchObject({
				readiness: "unauthenticated",
				authenticated: false,
				error: "refresh_failed",
			});
			const text = loggedText(logger);
			expect(text).toContain("terminal");
			expect(text).toContain(String(status));
			expect(text).toContain(code);
		});

		it("classifies by the RFC 6749 error code even when error_description is present", async () => {
			const logger = mockLogger();
			await seedExpiredPositai();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					err(400, {
						error: "invalid_grant",
						error_description: "The refresh token expired.",
					}),
				),
			);
			const provider = createProvider({}, undefined, logger);

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toMatchObject({
				readiness: "unauthenticated",
				error: "refresh_failed",
			});
			const text = loggedText(logger);
			expect(text).toContain("terminal");
			expect(text).toContain("http 400");
			expect(text).toContain("code invalid_grant");
			expect(text).toContain("The refresh token expired.");
		});

		it.each([
			["429 rate limit", err(429, { error: "slow_down" })],
			["500 server error", err(500, { error: "server_error" })],
			["503 plain text", err(503, "Service Unavailable")],
			["400 unknown code", err(400, { error: "temporarily_unavailable" })],
			["401 unknown code", err(401, { error: "unauthorized_client" })],
			["400 non-JSON body", new Response("<html>proxy error</html>", { status: 400 })],
			["200 malformed token body", ok({ refresh_token: "orphan" })],
			[
				"400 non-terminal code with description",
				err(400, {
					error: "temporarily_unavailable",
					error_description: "try again later",
				}),
			],
		])("keeps the stored record on a transient failure: %s", async (_label, response) => {
			const seeded = await seedExpiredPositai();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
			const provider = createProvider();

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toEqual(seeded);
		});

		it("bounds an overlong error code and never classifies it as terminal", async () => {
			const seeded = await seedExpiredPositai();
			const logger = mockLogger();
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue(err(400, { error: "x".repeat(500) })));
			const provider = createProvider({}, undefined, logger);

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toEqual(seeded);
			const text = loggedText(logger);
			expect(text).toContain("transient");
			expect(text).not.toContain("x".repeat(250));
		});

		describe("when another window commits during the refresh", () => {
			/** A sign-in or refresh from a window whose lock does not exclude this one. */
			function otherWindowRecord(expiresInMs = 3_600_000): StoredProviderCredentials {
				const expiresAt = new Date(Date.now() + expiresInMs).toISOString();
				return {
					...expiredPositaiRecord(),
					generation: "other-window-generation",
					oauthAuth: {
						tokenData: {
							accessToken: "other-access",
							refreshToken: "other-refresh",
							expiresAt,
							tokenType: "Bearer",
							scope: "prism",
						},
						expiresAt,
						scope: "prism",
					},
				};
			}

			/** Stub fetch so the token-endpoint response is held until `respond` is called. */
			function holdTokenEndpoint() {
				let requested!: () => void;
				const requestSeen = new Promise<void>((resolve) => {
					requested = resolve;
				});
				let respond!: (response: Response) => void;
				const response = new Promise<Response>((resolve) => {
					respond = resolve;
				});
				vi.stubGlobal(
					"fetch",
					vi.fn(() => {
						requested();
						return response;
					}),
				);
				return { requestSeen, respond };
			}

			it.each([
				[
					"rotated tokens",
					ok({ access_token: "fresh-access", refresh_token: "fresh-refresh", expires_in: 3600 }),
				],
				["an invalid_grant rejection", err(400, { error: "invalid_grant" })],
			])(
				"keeps the other window's record when the refresh returns %s",
				async (_label, response) => {
					await seedExpiredPositai();
					const tokenEndpoint = holdTokenEndpoint();
					const provider = createProvider();

					// SingleFileStore.set does not take the cross-process lock, so this
					// write lands mid-refresh the way a per-window-locked writer's would.
					const refresh = provider.getCredentials("positai");
					await tokenEndpoint.requestSeen;
					const newer = otherWindowRecord();
					await store.set("auth:positai:oauth", newer);
					tokenEndpoint.respond(response);
					await refresh;

					expect(await storedPositai()).toEqual(newer);
				},
			);

			it("refreshes with the tokens from the read it pins the generation to", async () => {
				await seedExpiredPositai();
				const sentRefreshTokens: (string | null)[] = [];
				vi.stubGlobal(
					"fetch",
					vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
						const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
						sentRefreshTokens.push(body.get("refresh_token"));
						return ok({
							access_token: "fresh-access",
							refresh_token: "fresh-refresh",
							expires_in: 3600,
						});
					}),
				);
				// The other window's record is expiring too, so a refresh that read it
				// would spend its refresh token and then drop the rotated result.
				const newer = otherWindowRecord(-60_000);
				// Land the other window's write right after the transaction's first
				// read, the gap a per-window lock leaves open.
				let inLock = false;
				let injected = false;
				const withLock = store.withLock.bind(store);
				const get = store.get.bind(store);
				vi.spyOn(store, "withLock").mockImplementation(async (fn) => {
					inLock = true;
					try {
						return await withLock(fn);
					} finally {
						inLock = false;
					}
				});
				vi.spyOn(store, "get").mockImplementation(async (key) => {
					const value = await get(key);
					if (inLock && !injected) {
						injected = true;
						await store.set("auth:positai:oauth", newer);
					}
					return value;
				});
				const provider = createProvider();

				await provider.getCredentials("positai");

				expect(injected).toBe(true);
				expect(sentRefreshTokens).toEqual(["old-refresh"]);
				expect(await storedPositai()).toEqual(newer);
			});

			it("reports the record as kept, not removed, when a rejection loses to the other window", async () => {
				await seedExpiredPositai();
				const tokenEndpoint = holdTokenEndpoint();
				const logger = mockLogger();
				const provider = createProvider({}, receiver, logger);

				const refresh = provider.getCredentials("positai");
				await tokenEndpoint.requestSeen;
				await store.set("auth:positai:oauth", otherWindowRecord());
				tokenEndpoint.respond(err(400, { error: "invalid_grant" }));
				await refresh;

				expect(logger.error).not.toHaveBeenCalled();
				expect(loggedText(logger)).toContain(
					"stored record changed during the refresh and was kept",
				);
			});
		});
	});

	describe("AcquisitionEngine refresh policy", () => {
		interface EngineState {
			tokens: StoredOAuthTokens | null;
			tombstone: string | undefined;
			failTransaction: boolean;
			failPersist: boolean;
		}

		function mockLogger() {
			return {
				info: vi.fn(),
				warn: vi.fn(),
				error: vi.fn(),
				debug: vi.fn(),
				trace: vi.fn(),
			};
		}

		function loggedText(logger: ReturnType<typeof mockLogger>): string {
			return [...logger.warn.mock.calls, ...logger.error.mock.calls]
				.flat()
				.map((arg) => (arg instanceof Error ? `${arg.name}: ${arg.message}` : String(arg)))
				.join(" | ");
		}

		function expiringTokens(): StoredOAuthTokens {
			return {
				accessToken: "old-access",
				refreshToken: "old-refresh",
				expiresAt: new Date(Date.now() - 60_000).toISOString(),
				tokenType: "Bearer",
				scope: "prism",
			};
		}

		function makeEngineState(): EngineState {
			return {
				tokens: expiringTokens(),
				tombstone: undefined,
				failTransaction: false,
				failPersist: false,
			};
		}

		function makeEngineHooks(state: EngineState): AcquisitionBackendHooks {
			const config: OAuthGrantConfig = {
				grantType: "device-code",
				clientId: "posit-ai",
				scope: "prism",
				deviceAuthorizationEndpoint: "https://auth.test/oauth/device/authorize",
				tokenEndpoint: "https://auth.test/oauth/token",
			};
			return {
				configForProvider: () => Promise.resolve(config),
				readTokens: () => Promise.resolve(state.tokens),
				beginAuthentication: () => Promise.resolve("generation"),
				holdsAuthentication: () => Promise.resolve(true),
				commitAuthentication: () => Promise.resolve("committed"),
				finishAuthentication: () => Promise.resolve("committed"),
				withRefreshTransaction: (_providerId, _config, operation) => {
					if (state.failTransaction) return Promise.reject(new Error("ELOCKED: file is locked"));
					const tokens = state.tokens;
					if (!tokens) return operation(null);
					return operation({
						tokens,
						commitTokens: (refreshed) => {
							if (state.failPersist) {
								return Promise.reject(new Error("EACCES: permission denied"));
							}
							state.tokens = {
								accessToken: refreshed.accessToken,
								refreshToken: refreshed.refreshToken,
								expiresAt: new Date(Date.now() + refreshed.expiresIn * 1000).toISOString(),
								tokenType: refreshed.tokenType,
								scope: refreshed.scope,
							};
							return Promise.resolve("committed");
						},
						commitError: (error) => {
							state.tombstone = error;
							state.tokens = null;
							return Promise.resolve("committed");
						},
					});
				},
				shapeToken: (_providerId, accessToken) => ({ type: "oauth", accessToken }),
				notifyReady: () => {},
			};
		}

		it("keeps the tokens when the refresh transaction itself fails", async () => {
			const state = makeEngineState();
			state.failTransaction = true;
			const logger = mockLogger();
			vi.stubGlobal("fetch", vi.fn());
			const engine = new AcquisitionEngine(makeEngineHooks(state), logger);

			await expect(engine.getCredentials("positai")).resolves.toEqual({
				handled: true,
				credentials: null,
			});
			expect(state.tokens).not.toBeNull();
			expect(state.tombstone).toBeUndefined();
			expect(loggedText(logger)).toContain("refresh transaction failed for positai (transient)");
		});

		it.each([
			{ code: "invalid_client", rejected: true },
			{ code: "invalid_grant", rejected: false },
		])(
			"reports the grant as rejected only when the server rejects the client ($code)",
			async ({ code, rejected }) => {
				const state = makeEngineState();
				const rejectGrant = vi.fn();
				const logger = mockLogger();
				vi.stubGlobal(
					"fetch",
					vi.fn().mockResolvedValue(
						new Response(JSON.stringify({ error: code }), {
							status: 401,
							headers: { "Content-Type": "application/json" },
						}),
					),
				);
				const engine = new AcquisitionEngine({ ...makeEngineHooks(state), rejectGrant }, logger);

				await engine.getCredentials("positai");

				expect(state.tombstone).toBe("refresh_failed");
				if (rejected) {
					expect(rejectGrant).toHaveBeenCalledWith(
						"positai",
						expect.objectContaining({ clientId: "posit-ai" }),
					);
				} else {
					expect(rejectGrant).not.toHaveBeenCalled();
				}
			},
		);

		it("reports the grant as rejected when device authorization rejects the client", async () => {
			const state = makeEngineState();
			state.tokens = null;
			const rejectGrant = vi.fn();
			vi.stubGlobal(
				"fetch",
				vi.fn().mockResolvedValue(
					new Response(JSON.stringify({ error: "invalid_client" }), {
						status: 401,
						headers: { "Content-Type": "application/json" },
					}),
				),
			);
			const engine = new AcquisitionEngine(
				{ ...makeEngineHooks(state), rejectGrant },
				mockLogger(),
			);

			await expect(engine.startAuthentication("positai")).rejects.toThrow();
			expect(rejectGrant).toHaveBeenCalledTimes(1);
		});

		it("treats a persistence failure after a successful exchange as transient", async () => {
			const state = makeEngineState();
			state.failPersist = true;
			const logger = mockLogger();
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValue(
						ok({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
					),
			);
			const engine = new AcquisitionEngine(makeEngineHooks(state), logger);

			const result = await engine.getCredentials("positai");
			expect(result.credentials).toBeNull();
			expect(state.tokens?.accessToken).toBe("old-access");
			expect(state.tombstone).toBeUndefined();
			expect(loggedText(logger)).toContain(
				"refreshed tokens for positai could not be persisted (transient)",
			);
		});

		it("lets a credential-shaping programming error reject instead of returning null", async () => {
			const state = makeEngineState();
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValue(
						ok({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
					),
			);
			const hooks = makeEngineHooks(state);
			hooks.shapeToken = () => {
				throw new Error("shaper bug");
			};
			const engine = new AcquisitionEngine(hooks);

			// The rotated tokens were committed, so the defect must surface as a
			// rejection — not be misdiagnosed as a transient refresh failure.
			await expect(engine.getCredentials("positai")).rejects.toThrow("shaper bug");
			expect(state.tokens?.accessToken).toBe("fresh");
			expect(state.tombstone).toBeUndefined();
		});

		it("aborts a hung refresh at the configured timeout and keeps the tokens", async () => {
			const state = makeEngineState();
			let observedSignal: AbortSignal | undefined;
			vi.stubGlobal(
				"fetch",
				vi.fn(
					(_url: string, init?: RequestInit) =>
						new Promise<Response>((_resolve, reject) => {
							observedSignal = init?.signal ?? undefined;
							observedSignal?.addEventListener("abort", () => reject(observedSignal.reason));
						}),
				),
			);
			const engine = new AcquisitionEngine(makeEngineHooks(state), undefined, {
				refreshTimeoutMs: 50,
			});

			const result = await engine.getCredentials("positai");
			expect(result.credentials).toBeNull();
			expect(observedSignal?.aborted).toBe(true);
			expect(state.tokens).not.toBeNull();
			expect(state.tombstone).toBeUndefined();
		});

		it("keeps the tokens when grant setup fails during a read, and still surfaces it on sign-in", async () => {
			const state = makeEngineState();
			const logger = mockLogger();
			const fetchMock = vi.fn();
			vi.stubGlobal("fetch", fetchMock);
			const setupError = new Error("Connect OAuth discovery failed with status 503");
			const configForProvider = vi.fn(() => Promise.reject(setupError));
			const engine = new AcquisitionEngine(
				{ ...makeEngineHooks(state), configForProvider },
				logger,
			);

			// A read is deferred to the backend rather than rejecting the caller
			// (e.g. an auth-status aggregate over every provider).
			await expect(engine.getCredentials("positai")).resolves.toEqual({
				handled: false,
				credentials: null,
			});
			await engine.getCredentials("positai");
			expect(configForProvider).toHaveBeenCalledTimes(1);
			expect(state.tokens?.accessToken).toBe("old-access");
			expect(state.tombstone).toBeUndefined();
			expect(fetchMock).not.toHaveBeenCalled();
			expect(loggedText(logger)).toContain("OAuth setup for positai failed (transient)");

			await expect(engine.startAuthentication("positai")).rejects.toBe(setupError);
		});

		describe("cooldown", () => {
			beforeEach(() => vi.useFakeTimers());
			afterEach(() => vi.useRealTimers());

			it("suppresses immediate retries after a transient failure and retries after the interval", async () => {
				const state = makeEngineState();
				const fetchMock = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
				vi.stubGlobal("fetch", fetchMock);
				const engine = new AcquisitionEngine(makeEngineHooks(state));

				await engine.getCredentials("positai");
				expect(state.tokens).not.toBeNull();
				await engine.getCredentials("positai");
				expect(fetchMock).toHaveBeenCalledTimes(1);

				await vi.advanceTimersByTimeAsync(61_000);
				await engine.getCredentials("positai");
				expect(fetchMock).toHaveBeenCalledTimes(2);
			});

			it("retries grant setup after the interval once it recovers", async () => {
				const state = makeEngineState();
				vi.stubGlobal(
					"fetch",
					vi
						.fn()
						.mockResolvedValue(
							ok({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
						),
				);
				const hooks = makeEngineHooks(state);
				const resolveGrant = hooks.configForProvider;
				const configForProvider = vi
					.fn<AcquisitionBackendHooks["configForProvider"]>()
					.mockRejectedValueOnce(new Error("Connect OAuth client registration failed"))
					.mockImplementation(resolveGrant);
				const engine = new AcquisitionEngine({ ...hooks, configForProvider });

				await engine.getCredentials("positai");
				await vi.advanceTimersByTimeAsync(61_000);
				expect((await engine.getCredentials("positai")).credentials).toEqual({
					type: "oauth",
					accessToken: "fresh",
				});
				expect(configForProvider).toHaveBeenCalledTimes(2);
			});

			it("does not suppress the next needed refresh after a success", async () => {
				const state = makeEngineState();
				const fetchMock = vi
					.fn()
					.mockRejectedValueOnce(new TypeError("fetch failed"))
					.mockResolvedValue(
						ok({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
					);
				vi.stubGlobal("fetch", fetchMock);
				const engine = new AcquisitionEngine(makeEngineHooks(state));

				await engine.getCredentials("positai");
				await vi.advanceTimersByTimeAsync(61_000);
				expect((await engine.getCredentials("positai")).credentials).toEqual({
					type: "oauth",
					accessToken: "fresh",
				});

				state.tokens = expiringTokens();
				await engine.getCredentials("positai");
				expect(fetchMock).toHaveBeenCalledTimes(3);
			});
		});
	});
});

describe("credential-bearing OAuth requests never follow redirects", () => {
	interface RecordedRequest {
		path: string | undefined;
		body: string;
	}

	type Reply = (status: number, body?: unknown, location?: string) => void;

	const servers: Server[] = [];

	afterEach(async () => {
		await Promise.all(
			servers
				.splice(0)
				.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
		);
	});

	function readBody(request: IncomingMessage): Promise<string> {
		return new Promise((resolve) => {
			let body = "";
			request.on("data", (chunk: Buffer) => {
				body += chunk.toString();
			});
			request.on("end", () => resolve(body));
		});
	}

	/** A loopback server recording every request; `respond` writes the reply. */
	async function startServer(
		respond: (request: RecordedRequest, reply: Reply) => void,
	): Promise<{ origin: string; requests: RecordedRequest[] }> {
		const requests: RecordedRequest[] = [];
		const server = createServer((request, response) => {
			void readBody(request).then((body) => {
				const recorded = { path: request.url, body };
				requests.push(recorded);
				respond(recorded, (status, replyBody, location) => {
					response.writeHead(status, {
						"Content-Type": "application/json",
						...(location ? { Location: location } : {}),
					});
					response.end(replyBody === undefined ? "" : JSON.stringify(replyBody));
				});
			});
		});
		servers.push(server);
		await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
		const { port } = server.address() as AddressInfo;
		return { origin: `http://127.0.0.1:${port}`, requests };
	}

	function hooksFor(
		issuer: string,
		tokens: StoredOAuthTokens | null,
		finished: string[],
	): AcquisitionBackendHooks {
		const config: OAuthGrantConfig = {
			grantType: "device-code",
			clientId: "client",
			scope: "",
			deviceAuthorizationEndpoint: `${issuer}/device`,
			tokenEndpoint: `${issuer}/token`,
			credentialBaseUrl: issuer,
		};
		return {
			configForProvider: () => Promise.resolve(config),
			readTokens: () => Promise.resolve(tokens),
			beginAuthentication: () => Promise.resolve("generation"),
			holdsAuthentication: () => Promise.resolve(true),
			commitAuthentication: () => Promise.resolve("committed"),
			finishAuthentication: (_providerId, _generation, error) => {
				finished.push(error);
				return Promise.resolve("committed");
			},
			withRefreshTransaction: (_providerId, _config, operation) =>
				operation(
					tokens
						? {
								tokens,
								commitTokens: () => Promise.resolve("committed"),
								commitError: () => Promise.resolve("committed"),
							}
						: null,
				),
			shapeToken: (_providerId, accessToken) => ({ type: "oauth", accessToken }),
			notifyReady: () => {},
		};
	}

	it.each([307, 308])("does not forward a refresh token across a %i redirect", async (status) => {
		const attacker = await startServer((_request, reply) => reply(200, { access_token: "x" }));
		const issuer = await startServer((_request, reply) =>
			reply(status, undefined, `${attacker.origin}/steal`),
		);
		const tokens: StoredOAuthTokens = {
			accessToken: "old-access",
			refreshToken: "secret-refresh",
			expiresAt: new Date(Date.now() - 60_000).toISOString(),
			tokenType: "Bearer",
			scope: "",
		};
		const engine = new AcquisitionEngine(hooksFor(issuer.origin, tokens, []));

		expect((await engine.getCredentials("connect")).credentials).toBeNull();
		expect(issuer.requests).toHaveLength(1);
		expect(issuer.requests[0]?.body).toContain("secret-refresh");
		expect(attacker.requests).toEqual([]);
	});

	it.each([307, 308])("does not forward a device code across a %i redirect", async (status) => {
		const attacker = await startServer((_request, reply) => reply(200, { access_token: "x" }));
		const issuer = await startServer((request, reply) => {
			if (request.path === "/device") {
				reply(200, {
					device_code: "secret-device-code",
					user_code: "ABCD-EFGH",
					verification_uri: "https://connect.test/device",
					verification_uri_complete: "https://connect.test/device?code=ABCD-EFGH",
					interval: 0.01,
					expires_in: 600,
				});
				return;
			}
			reply(status, undefined, `${attacker.origin}/steal`);
		});
		const finished: string[] = [];
		const engine = new AcquisitionEngine(hooksFor(issuer.origin, null, finished));

		await engine.startAuthentication("connect");
		await vi.waitFor(() => expect(finished).toEqual([`http_${status}`]));
		expect(issuer.requests.map((request) => request.path)).toEqual(["/device", "/token"]);
		expect(issuer.requests[1]?.body).toContain("secret-device-code");
		expect(attacker.requests).toEqual([]);
		await engine.dispose();
	});
});
