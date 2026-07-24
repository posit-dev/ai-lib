/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createPositronBackend — the vscode.authentication credential backend.
 *
 * Mocks the `vscode` module (authentication + EventEmitter), mirroring the
 * bridge's auth adapter tests at a smaller scale. The CredentialConfig is
 * injected (hosts supply a catalog-backed adapter), so tests pass a
 * plain-object factory.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthenticationSession } from "vscode";

const { mockGetSession, configChangeHook, sessionChangeHook } = vi.hoisted(() => ({
	mockGetSession: vi.fn(),
	configChangeHook: { callback: null as ((e: unknown) => void) | null },
	sessionChangeHook: { callback: null as ((e: unknown) => void) | null },
}));

vi.mock("vscode", () => ({
	authentication: {
		getSession: (...args: unknown[]) => mockGetSession(...args),
		onDidChangeSessions: (cb: (e: unknown) => void) => {
			sessionChangeHook.callback = cb;
			return { dispose: vi.fn() };
		},
	},
	workspace: {
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

const { createPositronBackend } = await import("../PositronBackend.js");
import type { AuthProviderMapping, CredentialConfig } from "../../types/index.js";

const PROVIDER_MAP: Record<string, AuthProviderMapping> = {
	anthropic: { authProviderId: "anthropic-api", scopes: [], credentialType: "apikey" },
	positai: { authProviderId: "posit-ai", scopes: ["positai"], credentialType: "oauth" },
	copilot: {
		authProviderId: "github",
		scopes: ["read:user"],
		fallbackScopes: [["read:user", "user:email", "repo", "workflow"], ["user:email"]],
		credentialType: "apikey",
	},
	databricks: { authProviderId: "databricks", scopes: [], credentialType: "apikey" },
};

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };

function makeSession(accessToken: string): AuthenticationSession {
	return { id: "s", accessToken, account: { id: "a", label: "A" }, scopes: [] };
}

/** A CredentialConfig with all readers stubbed to undefined, then overridden. */
function testConfig(overrides: Partial<CredentialConfig> = {}): CredentialConfig {
	return {
		getBaseUrl: () => undefined,
		getCustomHeaders: () => undefined,
		getAws: () => undefined,
		getSnowflake: () => undefined,
		getDatabricks: () => undefined,
		...overrides,
	};
}

function makeBackend(configOverrides: Partial<CredentialConfig> = {}) {
	return createPositronBackend({
		logger,
		providerMap: PROVIDER_MAP,
		credentialConfigFactory: () => testConfig(configOverrides),
	});
}

describe("createPositronBackend", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("shapes api-key credentials from the vscode session", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		const backend = makeBackend();

		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-ant",
			baseUrl: undefined,
			customHeaders: undefined,
		});
	});

	it("shapes oauth credentials for positai", async () => {
		mockGetSession.mockResolvedValue(makeSession("oauth-token"));
		const backend = makeBackend();

		expect(await backend.getCredentials("positai")).toEqual({
			type: "oauth",
			accessToken: "oauth-token",
		});
	});

	it("returns null when there is no session", async () => {
		mockGetSession.mockResolvedValue(undefined);
		const backend = makeBackend();
		expect(await backend.getCredentials("anthropic")).toBeNull();
	});

	it("returns null for unmapped providers", async () => {
		const backend = makeBackend();
		expect(await backend.getCredentials("unmapped")).toBeNull();
	});

	it("has no oauth device-flow hooks", () => {
		const backend = makeBackend();
		expect(backend.oauth).toBeUndefined();
	});

	it("getCredentialsWithPrompt uses createIfNone", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		const backend = makeBackend();

		await backend.getCredentialsWithPrompt("anthropic");
		expect(mockGetSession).toHaveBeenCalledWith("anthropic-api", [], { createIfNone: true });
	});

	it("fires onDidChangeCredentials on a matching session change", () => {
		const backend = makeBackend();
		const seen: string[][] = [];
		backend.onDidChangeCredentials((ids) => seen.push(ids));

		sessionChangeHook.callback?.({ provider: { id: "anthropic-api" } });
		expect(seen).toEqual([["anthropic"]]);
	});

	it("does not subscribe to connection-config changes (the catalog owns those)", () => {
		configChangeHook.callback = null;
		makeBackend();
		// Connection-config invalidation flows solely through the catalog host
		// source; wiring it here too would race the debounced catalog rebuild.
		expect(configChangeHook.callback).toBeNull();
	});

	// --- Databricks host resolution (ported from the removed bridge auth suite) ---
	// The workspace host now arrives via the injected CredentialConfig
	// (`getDatabricks`); env/setting fallbacks are folded into the catalog by the
	// host adapter, so they are exercised at the catalog layer, not here.

	it("resolves the Databricks base URL from the injected credential config", async () => {
		mockGetSession.mockResolvedValue(makeSession("databricks-bearer-token"));
		const backend = makeBackend({
			getDatabricks: () => ({ host: "https://adb-123.4.azuredatabricks.net" }),
		});

		expect(await backend.getCredentials("databricks")).toEqual({
			type: "apikey",
			apiKey: "databricks-bearer-token",
			baseUrl: "https://adb-123.4.azuredatabricks.net",
			customHeaders: undefined,
		});
		expect(mockGetSession).toHaveBeenCalledWith("databricks", [], { silent: true });
	});

	it("normalizes a scheme-less Databricks host with trailing slash", async () => {
		mockGetSession.mockResolvedValue(makeSession("databricks-bearer-token"));
		const backend = makeBackend({
			getDatabricks: () => ({ host: "my-workspace.cloud.databricks.com/" }),
		});

		expect(await backend.getCredentials("databricks")).toMatchObject({
			type: "apikey",
			baseUrl: "https://my-workspace.cloud.databricks.com",
		});
	});

	it("leaves the Databricks base URL undefined when no host is configured", async () => {
		mockGetSession.mockResolvedValue(makeSession("databricks-bearer-token"));
		const backend = makeBackend({ getDatabricks: () => undefined });

		expect(await backend.getCredentials("databricks")).toMatchObject({
			baseUrl: undefined,
		});
	});

	it("reads Databricks customHeaders alongside the host", async () => {
		mockGetSession.mockResolvedValue(makeSession("databricks-bearer-token"));
		const backend = makeBackend({
			getDatabricks: () => ({ host: "https://adb-123.4.azuredatabricks.net" }),
			getCustomHeaders: (configKey) =>
				configKey === "databricks" ? { "x-databricks-use-coding-agent-mode": "true" } : undefined,
		});

		expect(await backend.getCredentials("databricks")).toEqual({
			type: "apikey",
			apiKey: "databricks-bearer-token",
			baseUrl: "https://adb-123.4.azuredatabricks.net",
			customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
		});
	});

	// --- Copilot fallback scopes (ported from the removed bridge auth suite) ---

	it("uses the primary read:user scope for copilot when a session exists there", async () => {
		mockGetSession.mockImplementation(async (_id: string, scopes: string[]) =>
			scopes.length === 1 && scopes[0] === "read:user" ? makeSession("primary-gh") : undefined,
		);
		const backend = makeBackend();

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
		const backend = makeBackend();

		expect(await backend.getCredentials("copilot")).toMatchObject({ apiKey: "aligned-gh" });
		expect(mockGetSession).toHaveBeenNthCalledWith(1, "github", ["read:user"], { silent: true });
		expect(mockGetSession).toHaveBeenNthCalledWith(2, "github", aligned, { silent: true });
	});

	it("falls back to user:email for copilot when neither primary nor aligned exist", async () => {
		mockGetSession.mockImplementation(async (_id: string, scopes: string[]) =>
			scopes.length === 1 && scopes[0] === "user:email" ? makeSession("email-gh") : undefined,
		);
		const backend = makeBackend();

		expect(await backend.getCredentials("copilot")).toMatchObject({ apiKey: "email-gh" });
		// Walked all three scope sets: primary → aligned → user:email.
		expect(mockGetSession).toHaveBeenCalledTimes(3);
		expect(mockGetSession).toHaveBeenNthCalledWith(3, "github", ["user:email"], { silent: true });
	});

	it("returns null for copilot when no GitHub session exists for any scope set", async () => {
		mockGetSession.mockResolvedValue(undefined);
		const backend = makeBackend();

		expect(await backend.getCredentials("copilot")).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(3);
	});

	it("returns null when getSession throws (auth provider not registered)", async () => {
		mockGetSession.mockRejectedValue(new Error("provider not registered"));
		const backend = makeBackend();
		expect(await backend.getCredentials("anthropic")).toBeNull();
	});

	// --- Unregistered-provider handling (fast, correct silent lookups) ---
	// `getSession(id, …, { silent: true })` does not fail fast for an unregistered
	// provider; it blocks for seconds waiting for the provider to register. The
	// backend negative-caches that verdict so the wait is not re-paid on every
	// resolution (conversation switch, model refresh, auth-status poll).

	const NOT_REGISTERED = new Error(
		"Timed out waiting for authentication provider 'databricks' to register.",
	);

	it("negative-caches an unregistered provider and skips future silent lookups", async () => {
		mockGetSession.mockRejectedValue(NOT_REGISTERED);
		const backend = makeBackend();

		expect(await backend.getCredentials("databricks")).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(1);

		// Second resolution takes the fast path — getSession is not called again.
		expect(await backend.getCredentials("databricks")).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(1);
	});

	it("re-checks a provider after a session change clears the unregistered verdict", async () => {
		mockGetSession.mockRejectedValue(NOT_REGISTERED);
		const backend = makeBackend();

		expect(await backend.getCredentials("databricks")).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(1);

		// The auth extension registers and produces a session → change event fires.
		sessionChangeHook.callback?.({ provider: { id: "databricks" } });
		mockGetSession.mockResolvedValue(makeSession("databricks-bearer-token"));

		expect(await backend.getCredentials("databricks")).toMatchObject({
			apiKey: "databricks-bearer-token",
		});
		expect(mockGetSession).toHaveBeenCalledTimes(2);
	});

	it("logs the registration timeout at trace, not debug", async () => {
		mockGetSession.mockRejectedValue(NOT_REGISTERED);
		const backend = makeBackend();

		expect(await backend.getCredentials("databricks")).toBeNull();
		expect(logger.trace).toHaveBeenCalledWith(expect.stringContaining("is not registered"));
		expect(logger.debug).not.toHaveBeenCalled();
	});

	it("does not misclassify an unrelated error that merely contains 'to register'", async () => {
		// A transient error from a *registered* provider's session lookup. It must
		// NOT be treated as an unregistered-provider verdict: it logs at debug, is
		// not cached, and the next lookup queries the provider again.
		mockGetSession.mockRejectedValue(new Error("failed to register refresh callback"));
		const backend = makeBackend();

		expect(await backend.getCredentials("databricks")).toBeNull();
		expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("Auth session unavailable"));
		expect(logger.trace).not.toHaveBeenCalled();

		// Not negative-cached — the transient error must not suppress future lookups.
		await backend.getCredentials("databricks");
		expect(mockGetSession).toHaveBeenCalledTimes(2);
	});

	it("shapes baseUrl and customHeaders from the injected credential config", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant"));
		const backend = makeBackend({
			getBaseUrl: (configKey) => (configKey === "anthropic" ? "https://proxy.example" : undefined),
			getCustomHeaders: (configKey) =>
				configKey === "anthropic" ? { "x-tenancy": "team-42" } : undefined,
		});

		expect(await backend.getCredentials("anthropic")).toEqual({
			type: "apikey",
			apiKey: "sk-ant",
			baseUrl: "https://proxy.example",
			customHeaders: { "x-tenancy": "team-42" },
		});
	});
});
