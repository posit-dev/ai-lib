/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createPositronBackend — the vscode.authentication credential backend.
 *
 * Mocks the `vscode` module (authentication + workspace config + EventEmitter),
 * mirroring the bridge's auth adapter tests at a smaller scale.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationSession } from "vscode";

const { mockGetSession, mockGetConfigValue, configChangeHook, sessionChangeHook } = vi.hoisted(
	() => ({
		mockGetSession: vi.fn(),
		mockGetConfigValue: vi.fn().mockReturnValue(undefined),
		configChangeHook: { callback: null as ((e: unknown) => void) | null },
		sessionChangeHook: { callback: null as ((e: unknown) => void) | null },
	}),
);

vi.mock("vscode", () => ({
	authentication: {
		getSession: (...args: unknown[]) => mockGetSession(...args),
		onDidChangeSessions: (cb: (e: unknown) => void) => {
			sessionChangeHook.callback = cb;
			return { dispose: vi.fn() };
		},
	},
	workspace: {
		getConfiguration: () => ({ get: (key: string) => mockGetConfigValue(key) }),
		onDidChangeConfiguration: (cb: (e: unknown) => void) => {
			configChangeHook.callback = cb;
			return { dispose: vi.fn() };
		},
	},
	EventEmitter: class {
		private listeners: Array<(e: unknown) => void> = [];
		event = (listener: (e: unknown) => void) => {
			this.listeners.push(listener);
			return { dispose: () => {} };
		};
		fire = (data: unknown) => {
			for (const listener of this.listeners) listener(data);
		};
		dispose = () => {
			this.listeners = [];
		};
	},
}));

const { createPositronBackend } = await import("../PositronBackend");
import type { AuthProviderMapping } from "../../types";

const PROVIDER_MAP: Record<string, AuthProviderMapping> = {
	anthropic: { authProviderId: "anthropic-api", scopes: [], credentialType: "apikey" },
	positai: { authProviderId: "posit-ai", scopes: ["positai"], credentialType: "oauth" },
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

function makeSession(accessToken: string): AuthenticationSession {
	return { id: "s", accessToken, account: { id: "a", label: "A" }, scopes: [] };
}

describe("createPositronBackend", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfigValue.mockReturnValue(undefined);
	});

	it("shapes api-key credentials from the vscode session", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-ant",
			baseUrl: undefined,
			customHeaders: undefined,
		});
	});

	it("shapes oauth credentials for positai", async () => {
		mockGetSession.mockResolvedValue(makeSession("oauth-token"));
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("positai")).toEqual({
			type: "oauth",
			accessToken: "oauth-token",
		});
	});

	it("returns null when there is no session", async () => {
		mockGetSession.mockResolvedValue(undefined);
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		expect(await backend.getCredentials("anthropic")).toBeNull();
	});

	it("returns null for unmapped providers", async () => {
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		expect(await backend.getCredentials("unmapped")).toBeNull();
	});

	it("has no oauth device-flow hooks", () => {
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		expect(backend.oauth).toBeUndefined();
	});

	it("getCredentialsWithPrompt uses createIfNone", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		await backend.getCredentialsWithPrompt("anthropic");
		expect(mockGetSession).toHaveBeenCalledWith("anthropic-api", [], { createIfNone: true });
	});

	it("fires onDidChangeCredentials on a matching session change", () => {
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		const seen: string[][] = [];
		backend.onDidChangeCredentials((ids) => seen.push(ids));

		sessionChangeHook.callback?.({ provider: { id: "anthropic-api" } });
		expect(seen).toEqual([["anthropic"]]);
	});

	it("fires positai on base URL config change", () => {
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		const seen: string[][] = [];
		backend.onDidChangeCredentials((ids) => seen.push(ids));

		configChangeHook.callback?.({
			affectsConfiguration: (k: string) => k === "authentication.positai.baseUrl",
		});
		expect(seen).toEqual([["positai"]]);
	});
});
