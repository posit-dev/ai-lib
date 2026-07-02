/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createCredentialProvider — the root resolver seam + OAuth engine.
 *
 * Uses fake in-memory backends so the device-flow/refresh state machine is
 * exercised in isolation (no fs, no vscode). `fetch` is stubbed globally.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type {
	Backend,
	OAuthBackendHooks,
	OAuthProviderConfig,
	StoredOAuthTokens,
} from "../Backend";
import { createCredentialProvider } from "../createCredentialProvider";
import type { ProviderCredentials, TokenData } from "../types";

function isoIn(minutes: number): string {
	return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}

/** A fake OAuth backend that keeps tokens/errors in memory. */
function makeOAuthHooks(
	initial: StoredOAuthTokens | null,
	config: OAuthProviderConfig | undefined = {
		authHost: "auth.test",
		scope: "prism",
		clientId: "databot",
	},
): OAuthBackendHooks & { tokens: StoredOAuthTokens | null; error?: string; readyCount: number } {
	const state = {
		tokens: initial,
		error: undefined as string | undefined,
		readyCount: 0,
		configForProvider: (): OAuthProviderConfig | undefined => config,
		readTokens: async (): Promise<StoredOAuthTokens | null> => state.tokens,
		persistTokens: async (_providerId: string, t: TokenData): Promise<void> => {
			state.tokens = {
				accessToken: t.accessToken,
				refreshToken: t.refreshToken,
				expiresAt: new Date(Date.now() + t.expiresIn * 1000).toISOString(),
				scope: t.scope,
				tokenType: t.tokenType,
			};
			state.error = undefined;
		},
		persistError: async (_providerId: string, error: string): Promise<void> => {
			state.error = error;
			state.tokens = null;
		},
		notifyReady: (): void => {
			state.readyCount += 1;
		},
	};
	return state;
}

function makeBackend(
	getCredentials: (id: string) => Promise<ProviderCredentials | null>,
	oauth?: OAuthBackendHooks,
): Backend {
	return {
		getCredentials,
		onDidChangeCredentials: () => ({ dispose() {} }),
		oauth,
	};
}

const okJson = (body: unknown): Response =>
	({
		ok: true,
		status: 200,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}) as Response;
const errJson = (status: number, body: unknown): Response =>
	({
		ok: false,
		status,
		json: async () => body,
		text: async () => JSON.stringify(body),
	}) as Response;

describe("createCredentialProvider — getCredentials routing", () => {
	it("defers to backend.getCredentials for non-OAuth providers", async () => {
		const backend = makeBackend(async (id) =>
			id === "anthropic" ? { type: "apikey", apiKey: "sk-test" } : null,
		);
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-test",
		});
		expect(await provider.getCredentials("unknown")).toBeNull();
	});

	it("routes OAuth providers through the engine and wraps the token", async () => {
		const hooks = makeOAuthHooks({
			accessToken: "tok-abc",
			refreshToken: "ref",
			expiresAt: isoIn(60),
			scope: "prism",
			tokenType: "Bearer",
		});
		const backend = makeBackend(async () => null, hooks);
		const provider = createCredentialProvider({ backend });

		expect(await provider.getCredentials("positai")).toEqual({
			type: "oauth",
			accessToken: "tok-abc",
		});
	});
});

describe("createCredentialProvider — getAccessToken", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("returns null when the backend has no OAuth hooks", async () => {
		const provider = createCredentialProvider({ backend: makeBackend(async () => null) });
		expect(await provider.getAccessToken("positai")).toBeNull();
	});

	it("returns null when the provider has no OAuth config", async () => {
		const hooks = makeOAuthHooks(null, undefined);
		const provider = createCredentialProvider({ backend: makeBackend(async () => null, hooks) });
		expect(await provider.getAccessToken("positai")).toBeNull();
	});

	it("returns a valid stored token without refreshing", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const hooks = makeOAuthHooks({
			accessToken: "still-good",
			refreshToken: "ref",
			expiresAt: isoIn(60),
			scope: "prism",
			tokenType: "Bearer",
		});
		const provider = createCredentialProvider({ backend: makeBackend(async () => null, hooks) });

		expect(await provider.getAccessToken("positai")).toBe("still-good");
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("refreshes an expiring token and persists the new one", async () => {
		const fetchMock = vi.fn().mockResolvedValue(
			okJson({
				access_token: "fresh",
				refresh_token: "ref2",
				expires_in: 3600,
				token_type: "Bearer",
				scope: "prism",
			}),
		);
		vi.stubGlobal("fetch", fetchMock);

		const hooks = makeOAuthHooks({
			accessToken: "old",
			refreshToken: "ref1",
			expiresAt: isoIn(1), // within the 4–6 min jitter window → refresh
			scope: "prism",
			tokenType: "Bearer",
		});
		const provider = createCredentialProvider({ backend: makeBackend(async () => null, hooks) });

		expect(await provider.getAccessToken("positai")).toBe("fresh");
		expect(fetchMock).toHaveBeenCalledOnce();
		expect(hooks.tokens?.accessToken).toBe("fresh");
		expect(hooks.readyCount).toBe(1);
	});

	it("persists an error and returns null when refresh fails", async () => {
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(errJson(401, { error: "invalid_grant" })));
		const hooks = makeOAuthHooks({
			accessToken: "old",
			refreshToken: "bad",
			expiresAt: isoIn(0),
			scope: "prism",
			tokenType: "Bearer",
		});
		const provider = createCredentialProvider({ backend: makeBackend(async () => null, hooks) });

		expect(await provider.getAccessToken("positai")).toBeNull();
		expect(hooks.error).toBe("refresh_failed");
	});
});

describe("createCredentialProvider — startDeviceAuth", () => {
	beforeEach(() => vi.useFakeTimers());
	afterEach(() => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
	});

	it("rejects when the provider has no device-flow config", async () => {
		const provider = createCredentialProvider({ backend: makeBackend(async () => null) });
		await expect(provider.startDeviceAuth("positai")).rejects.toThrow(/not supported/);
	});

	it("returns device-code info and polls until a token is stored", async () => {
		const fetchMock = vi
			.fn()
			// 1) device-code request
			.mockResolvedValueOnce(
				okJson({
					user_code: "WXYZ",
					verification_uri: "https://auth.test/device",
					verification_uri_complete: "https://auth.test/device?code=WXYZ",
					device_code: "dev-123",
					interval: 1,
					expires_in: 900,
				}),
			)
			// 2) first poll: pending
			.mockResolvedValueOnce(errJson(400, { error: "authorization_pending" }))
			// 3) second poll: success
			.mockResolvedValueOnce(
				okJson({
					access_token: "device-tok",
					refresh_token: "device-ref",
					expires_in: 3600,
					token_type: "Bearer",
					scope: "prism",
				}),
			);
		vi.stubGlobal("fetch", fetchMock);

		const hooks = makeOAuthHooks(null);
		const provider = createCredentialProvider({ backend: makeBackend(async () => null, hooks) });

		const info = await provider.startDeviceAuth("positai");
		expect(info).toMatchObject({ userCode: "WXYZ", deviceCode: "dev-123", interval: 1 });

		// Advance through two poll intervals (1s each) and flush async work.
		await vi.advanceTimersByTimeAsync(1000);
		await vi.advanceTimersByTimeAsync(1000);

		expect(hooks.tokens?.accessToken).toBe("device-tok");
		expect(hooks.readyCount).toBe(1);
	});
});
