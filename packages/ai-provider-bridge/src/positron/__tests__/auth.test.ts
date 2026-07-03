/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for PositronCredentialProvider — the provider-bridge's VS Code auth adapter.
 *
 * Covers: API key credential mapping, OAuth credential mapping, AWS credential JSON
 * parsing, config-key overrides, Snowflake URL construction, base URL resolution,
 * and session-driven credential change invalidation (connection-config changes now
 * flow through the catalog, not this emitter — see the onDidChangeCredentials block).
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
		getConfiguration: () => ({
			get: (key: string) => mockGetConfigValue(key),
		}),
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
	},
}));

const { PositronCredentialProvider } = await import("../auth");

const mockLogger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

function makeSession(accessToken: string): AuthenticationSession {
	return {
		id: "test-session",
		accessToken,
		account: { id: "test", label: "Test" },
		scopes: [],
	};
}

describe("PositronCredentialProvider.getCredentials", () => {
	let provider: InstanceType<typeof PositronCredentialProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfigValue.mockReturnValue(undefined);
		provider = new PositronCredentialProvider(mockLogger);
	});

	// --- API key providers ---

	it("returns apikey credentials for anthropic", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant-test-key"));

		const result = await provider.getCredentials("anthropic");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-ant-test-key",
			baseUrl: undefined,
		});
		expect(mockGetSession).toHaveBeenCalledWith("anthropic-api", [], { silent: true });
	});

	it("returns apikey credentials for gemini", async () => {
		mockGetSession.mockResolvedValue(makeSession("gemini-api-key"));

		const result = await provider.getCredentials("gemini");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "gemini-api-key",
			baseUrl: undefined,
		});
		expect(mockGetSession).toHaveBeenCalledWith("google", [], { silent: true });
	});

	it("returns apiKey as empty string for openai-compatible with empty accessToken", async () => {
		mockGetSession.mockResolvedValue(makeSession(""));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "openai-compatible.baseUrl" ? "http://localhost:8080" : undefined,
		);

		const result = await provider.getCredentials("openai-compatible");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "",
			baseUrl: "http://localhost:8080",
		});
	});

	// --- OAuth providers ---

	it("returns oauth credentials for positai", async () => {
		mockGetSession.mockResolvedValue(makeSession("bearer-token-123"));

		const result = await provider.getCredentials("positai");

		expect(result).toEqual({
			type: "oauth",
			accessToken: "bearer-token-123",
		});
		expect(mockGetSession).toHaveBeenCalledWith("posit-ai", ["positai"], { silent: true });
	});

	// --- Config-key overrides ---

	it("uses legacy config key override for anthropic (anthropic-api -> anthropic)", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant-key"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "anthropic.baseUrl" ? "https://custom.anthropic.example.com" : undefined,
		);

		const result = await provider.getCredentials("anthropic");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-ant-key",
			baseUrl: "https://custom.anthropic.example.com",
		});
	});

	it("reads Foundry base URL using config key override (ms-foundry -> foundry)", async () => {
		mockGetSession.mockResolvedValue(makeSession("foundry-token"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "foundry.baseUrl" ? "https://my-foundry.example.com" : undefined,
		);

		const result = await provider.getCredentials("ms-foundry");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "foundry-token",
			baseUrl: "https://my-foundry.example.com",
		});
	});

	// --- Base URL resolution ---

	it("returns baseUrl from VS Code settings for openai provider", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-openai-key"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "openai-api.baseUrl" ? "https://custom.openai.example.com/v1" : undefined,
		);

		const result = await provider.getCredentials("openai");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-openai-key",
			baseUrl: "https://custom.openai.example.com/v1",
		});
	});

	it("returns undefined baseUrl when no base URL is set", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-openai-key"));

		const result = await provider.getCredentials("openai");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-openai-key",
			baseUrl: undefined,
		});
	});

	// --- AWS credentials (Bedrock) ---

	it("returns aws-credentials for bedrock, parsing JSON accessToken", async () => {
		const awsCreds = JSON.stringify({
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			sessionToken: "FwoGZXIvYXdzEBAaDH...",
		});
		mockGetSession.mockResolvedValue(makeSession(awsCreds));
		mockGetConfigValue.mockImplementation((key: string) => {
			if (key === "credentials") return { AWS_REGION: "us-west-2" };
			return undefined;
		});

		const result = await provider.getCredentials("bedrock");

		expect(result).toEqual({
			type: "aws-credentials",
			region: "us-west-2",
			accessKeyId: "AKIAIOSFODNN7EXAMPLE",
			secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
			sessionToken: "FwoGZXIvYXdzEBAaDH...",
		});
		expect(mockGetSession).toHaveBeenCalledWith("amazon-bedrock", [], { silent: true });
	});

	it("bedrock region falls back to process.env.AWS_REGION", async () => {
		const awsCreds = JSON.stringify({
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
		});
		mockGetSession.mockResolvedValue(makeSession(awsCreds));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalRegion = process.env.AWS_REGION;
		process.env.AWS_REGION = "eu-central-1";
		try {
			const result = await provider.getCredentials("bedrock");
			expect(result).toEqual(
				expect.objectContaining({
					type: "aws-credentials",
					region: "eu-central-1",
				}),
			);
		} finally {
			if (originalRegion === undefined) {
				delete process.env.AWS_REGION;
			} else {
				process.env.AWS_REGION = originalRegion;
			}
		}
	});

	it("bedrock region falls back to us-east-1 when no config or env", async () => {
		const awsCreds = JSON.stringify({
			accessKeyId: "AKIA",
			secretAccessKey: "secret",
		});
		mockGetSession.mockResolvedValue(makeSession(awsCreds));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalRegion = process.env.AWS_REGION;
		delete process.env.AWS_REGION;
		try {
			const result = await provider.getCredentials("bedrock");
			expect(result).toEqual(
				expect.objectContaining({
					type: "aws-credentials",
					region: "us-east-1",
				}),
			);
		} finally {
			if (originalRegion !== undefined) {
				process.env.AWS_REGION = originalRegion;
			}
		}
	});

	it("returns null for bedrock when accessToken is not valid JSON", async () => {
		mockGetSession.mockResolvedValue(makeSession("not-json"));

		const result = await provider.getCredentials("bedrock");

		expect(result).toBeNull();
	});

	it("returns null for bedrock when accessToken JSON lacks required fields", async () => {
		mockGetSession.mockResolvedValue(makeSession(JSON.stringify({ accessKeyId: "AKIA" })));

		const result = await provider.getCredentials("bedrock");

		expect(result).toBeNull();
	});

	// --- Google Cloud credentials (Vertex) ---

	it("returns google-cloud credentials for google-vertex, parsing JSON accessToken with brokered token", async () => {
		const gcpCreds = JSON.stringify({
			token: "test-token",
			project: "my-gcp-project",
			location: "us-central1",
		});
		mockGetSession.mockResolvedValue(makeSession(gcpCreds));

		const result = await provider.getCredentials("google-vertex");

		expect(result).toEqual({
			type: "google-cloud",
			project: "my-gcp-project",
			location: "us-central1",
			accessToken: "test-token",
		});
		expect(mockGetSession).toHaveBeenCalledWith("google-cloud", [], { silent: true });
	});

	it("returns google-cloud credentials for google-vertex without token for ADC fallback", async () => {
		const gcpCreds = JSON.stringify({
			project: "my-gcp-project",
			location: "us-central1",
		});
		mockGetSession.mockResolvedValue(makeSession(gcpCreds));

		const result = await provider.getCredentials("google-vertex");

		expect(result).toEqual({
			type: "google-cloud",
			project: "my-gcp-project",
			location: "us-central1",
		});
		expect(mockGetSession).toHaveBeenCalledWith("google-cloud", [], { silent: true });
	});

	it("returns null for google-vertex when accessToken is not valid JSON", async () => {
		mockGetSession.mockResolvedValue(makeSession("not-json"));

		const result = await provider.getCredentials("google-vertex");

		expect(result).toBeNull();
	});

	it("returns null for google-vertex when accessToken JSON lacks project", async () => {
		mockGetSession.mockResolvedValue(
			makeSession(JSON.stringify({ token: "test-token", location: "us-central1" })),
		);

		const result = await provider.getCredentials("google-vertex");

		expect(result).toBeNull();
	});

	it("returns null for google-vertex when accessToken JSON lacks location", async () => {
		mockGetSession.mockResolvedValue(
			makeSession(JSON.stringify({ token: "test-token", project: "my-gcp-project" })),
		);

		const result = await provider.getCredentials("google-vertex");

		expect(result).toBeNull();
	});

	// --- Snowflake URL construction ---

	it("constructs Snowflake base URL from authentication.snowflake.credentials.SNOWFLAKE_ACCOUNT", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockImplementation((key: string) => {
			if (key === "credentials") return { SNOWFLAKE_ACCOUNT: "myorg-myaccount" };
			return undefined;
		});

		const result = await provider.getCredentials("snowflake-cortex");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "snowflake-token",
			baseUrl: "https://myorg-myaccount.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("Snowflake base URL falls back to SNOWFLAKE_ACCOUNT env var", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalAccount = process.env.SNOWFLAKE_ACCOUNT;
		process.env.SNOWFLAKE_ACCOUNT = "env-org-account";
		try {
			const result = await provider.getCredentials("snowflake-cortex");
			expect(result).toEqual(
				expect.objectContaining({
					type: "apikey",
					baseUrl: "https://env-org-account.snowflakecomputing.com/api/v2/cortex/v1",
				}),
			);
		} finally {
			if (originalAccount === undefined) {
				delete process.env.SNOWFLAKE_ACCOUNT;
			} else {
				process.env.SNOWFLAKE_ACCOUNT = originalAccount;
			}
		}
	});

	it("Snowflake base URL is undefined when no account is configured", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalAccount = process.env.SNOWFLAKE_ACCOUNT;
		delete process.env.SNOWFLAKE_ACCOUNT;
		try {
			const result = await provider.getCredentials("snowflake-cortex");
			expect(result).toEqual(
				expect.objectContaining({
					type: "apikey",
					baseUrl: undefined,
				}),
			);
		} finally {
			if (originalAccount !== undefined) {
				process.env.SNOWFLAKE_ACCOUNT = originalAccount;
			}
		}
	});

	it("SNOWFLAKE_HOST in credentials config takes precedence over SNOWFLAKE_ACCOUNT", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockImplementation((key: string) => {
			if (key === "credentials") {
				return {
					SNOWFLAKE_HOST: "mhb16489.va3.us-east-1.aws.snowflakecomputing.com",
					SNOWFLAKE_ACCOUNT: "myorg-myaccount",
				};
			}
			return undefined;
		});

		const result = await provider.getCredentials("snowflake-cortex");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "snowflake-token",
			baseUrl: "https://mhb16489.va3.us-east-1.aws.snowflakecomputing.com/api/v2/cortex/v1",
		});
	});

	it("SNOWFLAKE_HOST env var is used when credentials config has no host", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalHost = process.env.SNOWFLAKE_HOST;
		const originalAccount = process.env.SNOWFLAKE_ACCOUNT;
		process.env.SNOWFLAKE_HOST = "mhb16489.va3.us-east-1.aws.snowflakecomputing.com";
		delete process.env.SNOWFLAKE_ACCOUNT;
		try {
			const result = await provider.getCredentials("snowflake-cortex");
			expect(result).toEqual(
				expect.objectContaining({
					type: "apikey",
					baseUrl: "https://mhb16489.va3.us-east-1.aws.snowflakecomputing.com/api/v2/cortex/v1",
				}),
			);
		} finally {
			if (originalHost === undefined) {
				delete process.env.SNOWFLAKE_HOST;
			} else {
				process.env.SNOWFLAKE_HOST = originalHost;
			}
			if (originalAccount !== undefined) {
				process.env.SNOWFLAKE_ACCOUNT = originalAccount;
			}
		}
	});

	it("SNOWFLAKE_HOST env var takes precedence over SNOWFLAKE_ACCOUNT env var", async () => {
		mockGetSession.mockResolvedValue(makeSession("snowflake-token"));
		mockGetConfigValue.mockReturnValue(undefined);

		const originalHost = process.env.SNOWFLAKE_HOST;
		const originalAccount = process.env.SNOWFLAKE_ACCOUNT;
		process.env.SNOWFLAKE_HOST = "mhb16489.va3.us-east-1.aws.snowflakecomputing.com";
		process.env.SNOWFLAKE_ACCOUNT = "myorg-myaccount";
		try {
			const result = await provider.getCredentials("snowflake-cortex");
			expect(result).toEqual(
				expect.objectContaining({
					type: "apikey",
					baseUrl: "https://mhb16489.va3.us-east-1.aws.snowflakecomputing.com/api/v2/cortex/v1",
				}),
			);
		} finally {
			if (originalHost === undefined) {
				delete process.env.SNOWFLAKE_HOST;
			} else {
				process.env.SNOWFLAKE_HOST = originalHost;
			}
			if (originalAccount === undefined) {
				delete process.env.SNOWFLAKE_ACCOUNT;
			} else {
				process.env.SNOWFLAKE_ACCOUNT = originalAccount;
			}
		}
	});

	// --- Copilot fallback scopes ---

	it("uses the primary read:user scope for copilot when a session exists there", async () => {
		mockGetSession.mockImplementation(
			async (_authProviderId: string, scopes: string[], _options: object) => {
				if (scopes.length === 1 && scopes[0] === "read:user") {
					return makeSession("primary-gh-token");
				}
				return undefined;
			},
		);

		const result = await provider.getCredentials("copilot");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "primary-gh-token",
			baseUrl: undefined,
		});
		// Primary match short-circuits — no fallback lookups should fire.
		expect(mockGetSession).toHaveBeenCalledTimes(1);
		expect(mockGetSession).toHaveBeenCalledWith("github", ["read:user"], { silent: true });
	});

	it("falls back to the aligned scope set for copilot when the primary is missing", async () => {
		const aligned = ["read:user", "user:email", "repo", "workflow"];
		mockGetSession.mockImplementation(
			async (_authProviderId: string, scopes: string[], _options: object) => {
				// No primary session.
				if (scopes.length === 1 && scopes[0] === "read:user") return undefined;
				// Aligned session exists (granted by VS Code Copilot Chat).
				if (scopes.length === aligned.length && scopes.every((s, i) => s === aligned[i])) {
					return makeSession("aligned-gh-token");
				}
				return undefined;
			},
		);

		const result = await provider.getCredentials("copilot");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "aligned-gh-token",
			baseUrl: undefined,
		});
		// Aligned wins before user:email is consulted.
		expect(mockGetSession).toHaveBeenCalledTimes(2);
		expect(mockGetSession).toHaveBeenNthCalledWith(1, "github", ["read:user"], { silent: true });
		expect(mockGetSession).toHaveBeenNthCalledWith(2, "github", aligned, { silent: true });
	});

	it("falls back to user:email for copilot when neither primary nor aligned exist", async () => {
		mockGetSession.mockImplementation(
			async (_authProviderId: string, scopes: string[], _options: object) => {
				if (scopes.length === 1 && scopes[0] === "user:email") {
					return makeSession("email-gh-token");
				}
				return undefined;
			},
		);

		const result = await provider.getCredentials("copilot");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "email-gh-token",
			baseUrl: undefined,
		});
		// Walked all three scope sets: primary → aligned → user:email.
		expect(mockGetSession).toHaveBeenCalledTimes(3);
		expect(mockGetSession).toHaveBeenNthCalledWith(3, "github", ["user:email"], { silent: true });
	});

	it("returns null for copilot when no GitHub session exists for any scope set", async () => {
		mockGetSession.mockResolvedValue(undefined);

		const result = await provider.getCredentials("copilot");

		expect(result).toBeNull();
		// Exhausted every scope bucket before giving up.
		expect(mockGetSession).toHaveBeenCalledTimes(3);
	});

	// --- Null/error cases ---

	it("returns null when getSession returns undefined (no session)", async () => {
		mockGetSession.mockResolvedValue(undefined);

		const result = await provider.getCredentials("anthropic");

		expect(result).toBeNull();
	});

	it("returns null when getSession throws (provider not registered)", async () => {
		mockGetSession.mockRejectedValue(
			new Error("Timed out waiting for authentication provider 'anthropic-api' to register."),
		);

		const result = await provider.getCredentials("anthropic");

		expect(result).toBeNull();
	});

	it("returns null for an unmapped provider", async () => {
		const result = await provider.getCredentials("openrouter");

		expect(result).toBeNull();
		expect(mockGetSession).not.toHaveBeenCalled();
	});
});

describe("PositronCredentialProvider.getCredentialsWithPrompt", () => {
	let provider: InstanceType<typeof PositronCredentialProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfigValue.mockReturnValue(undefined);
		provider = new PositronCredentialProvider(mockLogger);
	});

	it("uses createIfNone when prompting", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant-prompted"));

		const result = await provider.getCredentialsWithPrompt("anthropic");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-ant-prompted",
			baseUrl: undefined,
		});
		expect(mockGetSession).toHaveBeenCalledWith("anthropic-api", [], { createIfNone: true });
	});

	it("only prompts for the primary copilot scope and never walks fallbacks", async () => {
		// Even if the primary prompt returns no session, we must NOT fall through
		// to the silent fallback scopes — the prompt path is for the deliberate
		// sign-in UX (posit-assistant.signInToCopilot), which explicitly wants the
		// primary grant.
		mockGetSession.mockResolvedValue(undefined);

		const result = await provider.getCredentialsWithPrompt("copilot");

		expect(result).toBeNull();
		expect(mockGetSession).toHaveBeenCalledTimes(1);
		expect(mockGetSession).toHaveBeenCalledWith("github", ["read:user"], { createIfNone: true });
	});
});

describe("PositronCredentialProvider.onDidChangeCredentials", () => {
	it("fires when VS Code auth sessions change for a mapped provider", () => {
		const provider = new PositronCredentialProvider(mockLogger);
		const callback = vi.fn();
		provider.onDidChangeCredentials(callback);

		expect(sessionChangeHook.callback).not.toBeNull();
		sessionChangeHook.callback!({ provider: { id: "anthropic-api" } });

		expect(callback).toHaveBeenCalledWith(["anthropic"]);
	});

	it("does not fire for unmapped auth provider changes", () => {
		const provider = new PositronCredentialProvider(mockLogger);
		const callback = vi.fn();
		provider.onDidChangeCredentials(callback);

		sessionChangeHook.callback!({ provider: { id: "unknown-provider" } });

		expect(callback).not.toHaveBeenCalled();
	});

	it("does NOT fire on connection-config changes (the catalog owns those now)", () => {
		// Phase 6 / A6: the bridge emitter fires only on auth session changes.
		// Connection-config (`authentication.*` baseUrl/customHeaders/AWS/Snowflake)
		// is folded into the resolved catalog as a `host` source, so the catalog's
		// debounced change event is the single source of truth. The bridge no
		// longer registers an onDidChangeConfiguration listener at all.
		const provider = new PositronCredentialProvider(mockLogger);
		const callback = vi.fn();
		provider.onDidChangeCredentials(callback);

		// No config listener was wired, so a settings change cannot fire the emitter.
		expect(configChangeHook.callback).toBeNull();

		// A session change still fires — login/logout notification is unchanged.
		sessionChangeHook.callback!({ provider: { id: "anthropic-api" } });
		expect(callback).toHaveBeenCalledWith(["anthropic"]);
	});
});

describe("PositronCredentialProvider.getCredentials - customHeaders", () => {
	let provider: InstanceType<typeof PositronCredentialProvider>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockGetConfigValue.mockReturnValue(undefined);
		provider = new PositronCredentialProvider(mockLogger);
	});

	it("reads customHeaders from authentication.<configKey>.customHeaders", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant-test"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "anthropic.customHeaders" ? { "x-tenancy": "team-42" } : undefined,
		);

		const result = await provider.getCredentials("anthropic");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-ant-test",
			baseUrl: undefined,
			customHeaders: { "x-tenancy": "team-42" },
		});
	});

	it("normalizes an empty customHeaders object to undefined", async () => {
		mockGetSession.mockResolvedValue(makeSession("sk-ant-test"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "anthropic.customHeaders" ? {} : undefined,
		);

		const result = await provider.getCredentials("anthropic");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-ant-test",
			baseUrl: undefined,
			// Empty object collapsed to undefined so downstream code can
			// short-circuit cleanly.
			customHeaders: undefined,
		});
	});

	it("uses the configKey alias for the customHeaders lookup (openai → openai-api)", async () => {
		// `openai` logical id maps to authProviderId `openai-api`; no override
		// is registered, so configKey is `openai-api`. The customHeaders
		// lookup must use the configKey, matching baseUrl.
		mockGetSession.mockResolvedValue(makeSession("sk-openai-test"));
		mockGetConfigValue.mockImplementation((key: string) =>
			key === "openai-api.customHeaders"
				? { "x-databricks-use-coding-agent-mode": "true" }
				: undefined,
		);

		const result = await provider.getCredentials("openai");

		expect(result).toEqual({
			type: "apikey",
			apiKey: "sk-openai-test",
			baseUrl: undefined,
			customHeaders: { "x-databricks-use-coding-agent-mode": "true" },
		});
	});
});
