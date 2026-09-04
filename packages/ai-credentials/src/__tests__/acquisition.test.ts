/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

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
			expect(successful.status).toBe("started");
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await provider.getCredentials("positai")).toEqual({
					type: "oauth",
					accessToken: "posit-access",
				});
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

			fetchMock.mockResolvedValueOnce(deviceCodeResponse()).mockResolvedValueOnce(
				new Response(JSON.stringify({ error: "access_denied" }), {
					status: 400,
					headers: { "Content-Type": "application/json" },
				}),
			);
			await provider.startAuthentication("positai");
			await vi.advanceTimersByTimeAsync(1000);
			await vi.waitFor(async () => {
				expect(await store.get<StoredProviderCredentials>("auth:positai:oauth")).toMatchObject({
					readiness: "unauthenticated",
					error: "access_denied",
				});
			});
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
			const provider = createProvider();

			expect(await provider.getCredentials("positai")).toBeNull();
			expect(await storedPositai()).toMatchObject({
				readiness: "unauthenticated",
				error: "refresh_failed",
			});
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
	});

	describe("AcquisitionEngine refresh policy", () => {
		interface EngineState {
			tokens: StoredOAuthTokens | null;
			tombstone: string | undefined;
			failTransaction: boolean;
			failPersist: boolean;
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
				commitAuthentication: () => Promise.resolve("committed"),
				finishAuthentication: () => Promise.resolve("committed"),
				persistRefreshedTokens: (_providerId, tokens) => {
					if (state.failPersist) {
						return Promise.reject(new Error("EACCES: permission denied"));
					}
					state.tokens = {
						accessToken: tokens.accessToken,
						refreshToken: tokens.refreshToken,
						expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
						tokenType: tokens.tokenType,
						scope: tokens.scope,
					};
					return Promise.resolve();
				},
				persistRefreshError: (_providerId, error) => {
					state.tombstone = error;
					state.tokens = null;
					return Promise.resolve();
				},
				withRefreshTransaction: (_providerId, operation) =>
					state.failTransaction
						? Promise.reject(new Error("ELOCKED: file is locked"))
						: operation(),
				shapeToken: (_providerId, accessToken) => ({ type: "oauth", accessToken }),
				notifyReady: () => {},
			};
		}

		it("keeps the tokens when the refresh transaction itself fails", async () => {
			const state = makeEngineState();
			state.failTransaction = true;
			vi.stubGlobal("fetch", vi.fn());
			const engine = new AcquisitionEngine(makeEngineHooks(state));

			await expect(engine.getCredentials("positai")).resolves.toEqual({
				handled: true,
				credentials: null,
			});
			expect(state.tokens).not.toBeNull();
			expect(state.tombstone).toBeUndefined();
		});

		it("treats a persistence failure after a successful exchange as transient", async () => {
			const state = makeEngineState();
			state.failPersist = true;
			vi.stubGlobal(
				"fetch",
				vi
					.fn()
					.mockResolvedValue(
						ok({ access_token: "fresh", refresh_token: "rotated", expires_in: 3600 }),
					),
			);
			const engine = new AcquisitionEngine(makeEngineHooks(state));

			const result = await engine.getCredentials("positai");
			expect(result.credentials).toBeNull();
			expect(state.tokens?.accessToken).toBe("old-access");
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
