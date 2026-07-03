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
	copilot: {
		authProviderId: "github",
		scopes: ["read:user"],
		fallbackScopes: [["read:user", "user:email", "repo", "workflow"], ["user:email"]],
		credentialType: "apikey",
	},
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

	it("does not subscribe to connection-config changes (the catalog owns those)", () => {
		configChangeHook.callback = null;
		createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		// Connection-config invalidation flows solely through the catalog host
		// source; wiring it here too would race the debounced catalog rebuild.
		expect(configChangeHook.callback).toBeNull();
	});

	// --- Copilot fallback scopes (ported from the removed bridge auth suite) ---

	it("uses the primary read:user scope for copilot when a session exists there", async () => {
		mockGetSession.mockImplementation(async (_id: string, scopes: string[]) =>
			scopes.length === 1 && scopes[0] === "read:user" ? makeSession("primary-gh") : undefined,
		);
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("copilot")).toEqual({
			type: "apikey",
			apiKey: "primary-gh",
			baseUrl: undefined,
			customHeaders: undefined,
		});
		// Primary match short-circuits — no fallback lookups fire.
		expect(mockGetSession).toHaveBeenCalledTimes(1);
		expect(mockGetSession).toHaveBeenCalledWith("github", ["read:user"], { silent: true });
	});

	it("falls back to the aligned scope set for copilot when the primary is missing", async () => {
		const aligned = ["read:user", "user:email", "repo", "workflow"];
		mockGetSession.mockImplementation(async (_id: string, scopes: string[]) =>
			scopes.length === aligned.length && scopes.every((s, i) => s === aligned[i])
				? makeSession("aligned-gh")
				: undefined,
		);
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("copilot")).toMatchObject({ apiKey: "aligned-gh" });
		expect(mockGetSession).toHaveBeenNthCalledWith(1, "github", ["read:user"], { silent: true });
		expect(mockGetSession).toHaveBeenNthCalledWith(2, "github", aligned, { silent: true });
	});

	it("falls back to user:email for copilot when neither primary nor aligned exist", async () => {
		mockGetSession.mockImplementation(async (_id: string, scopes: string[]) =>
			scopes.length === 1 && scopes[0] === "user:email" ? makeSession("email-gh") : undefined,
		);
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("copilot")).toMatchObject({ apiKey: "email-gh" });
		// Walked all three scope sets: primary → aligned → user:email.
		expect(mockGetSession).toHaveBeenCalledTimes(3);
		expect(mockGetSession).toHaveBeenNthCalledWith(3, "github", ["user:email"], { silent: true });
	});

	it("returns null for copilot when no GitHub session exists for any scope set", async () => {
		mockGetSession.mockResolvedValue(undefined);
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("copilot")).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(3);
	});

	it("returns null when getSession throws (auth provider not registered)", async () => {
		mockGetSession.mockRejectedValue(new Error("provider not registered"));
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });
		expect(await backend.getCredentials("anthropic")).toBeNull();
	});

	it("shapes baseUrl and customHeaders read from vscode settings", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		mockGetConfigValue.mockImplementation((key: string) => {
			if (key === "anthropic.baseUrl") return "https://proxy.example";
			if (key === "anthropic.customHeaders") return { "x-tenancy": "team-42" };
			return undefined;
		});
		const backend = createPositronBackend({ logger, providerMap: PROVIDER_MAP });

		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-ant",
			baseUrl: "https://proxy.example",
			customHeaders: { "x-tenancy": "team-42" },
		});
	});
});
