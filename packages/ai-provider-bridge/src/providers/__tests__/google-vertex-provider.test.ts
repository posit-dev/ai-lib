/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mintCustomProviderId } from "ai-config";
import { captureProviderEnvironment } from "ai-credentials/store-backend";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const authMocks = vi.hoisted(() => ({
	googleAuth: vi.fn(),
	getClient: vi.fn(),
	getAccessToken: vi.fn(),
}));

vi.mock("google-auth-library", () => ({
	GoogleAuth: authMocks.googleAuth,
	OAuth2Client: class {},
}));

import {
	describeGoogleVertexCredentialSource,
	resolveGoogleVertexAccessToken,
} from "../../google-vertex-credentials";
import {
	getEffectiveLocation,
	isVertexAnthropicModel,
} from "../../model-clients/GoogleVertexClient";
import type { Logger } from "../../types";
import {
	claudeDisplayName,
	registerCustomGoogleVertexProvider,
	registerGoogleVertexProvider,
} from "../google-vertex-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const mockLogger: Logger = {
	info: vi.fn(),
	warn: vi.fn(),
	error: vi.fn(),
	debug: vi.fn(),
	trace: vi.fn(),
};

describe("registerGoogleVertexProvider", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.getAccessToken.mockResolvedValue({ token: "captured-adc-token" });
		authMocks.getClient.mockResolvedValue({ getAccessToken: authMocks.getAccessToken });
		authMocks.googleAuth.mockImplementation(() => ({ getClient: authMocks.getClient }));
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				return new Response("Request had invalid authentication credentials", {
					status: 401,
					statusText: "Unauthorized",
				});
			}),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("uses Positron auth guidance for brokered-token auth errors", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(registry, mockLogger, { onProviderStatusChange });

		const models = await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "brokered-token",
		});

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith({
			providerId: "google-vertex",
			authMethodId: "google-cloud",
			status: "auth_error",
			error: {
				code: "google_cloud_auth_expired",
				message:
					"Google Cloud authentication expired or is unavailable. Reconnect Google Cloud auth in Positron, then click Reload model list.",
				action: {
					label: "Reload model list",
					commandId: "refresh-models",
				},
			},
		});
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining("Reconnect Google Cloud auth in Positron"),
		);
	});

	it("uses Positron auth guidance for a brokered token even when inline variables are set", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{
				GOOGLE_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
				GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
			},
		);

		await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "brokered-token",
		});

		expect(authMocks.googleAuth).not.toHaveBeenCalled();
		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "auth_error",
				error: expect.objectContaining({ code: "google_cloud_auth_expired" }),
			}),
		);
	});

	it("points inline service-account users at their variables when Vertex rejects the minted token", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{
				GOOGLE_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
				GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
			},
		);

		await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "auth_error",
				error: expect.objectContaining({ code: "inline_service_account_rejected" }),
			}),
		);
	});

	it("reports rejected inline service-account credentials as an auth error, not a network error", async () => {
		authMocks.getAccessToken.mockRejectedValueOnce(new Error("invalid_rapt"));
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{
				GOOGLE_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
				GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
			},
		);

		const models = await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({
				providerId: "google-vertex",
				status: "auth_error",
				error: expect.objectContaining({
					code: "inline_service_account_rejected",
					message: expect.stringContaining("GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY"),
				}),
			}),
		);
	});

	it("reports a GOOGLE_APPLICATION_CREDENTIALS path that does not exist as an auth error naming the path", async () => {
		// The error google-auth-library throws when `keyFilename` points nowhere.
		authMocks.getClient.mockRejectedValueOnce(
			Object.assign(new Error("ENOENT: no such file or directory, open '/no/such/adc.json'"), {
				code: "ENOENT",
			}),
		);
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{ GOOGLE_APPLICATION_CREDENTIALS: "/no/such/adc.json" },
		);

		await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({
				status: "auth_error",
				error: expect.objectContaining({ code: "adc_expired" }),
			}),
		);
		expect(mockLogger.error).toHaveBeenCalledWith(
			expect.stringContaining(
				"Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (/no/such/adc.json, which does not exist)",
			),
		);
		expect(mockLogger.info).not.toHaveBeenCalledWith(
			expect.stringContaining("[GoogleVertex] Using"),
		);
	});

	it("reports a dropped inline token exchange as a network error, not rejected credentials", async () => {
		authMocks.getAccessToken.mockRejectedValueOnce(
			Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
		);
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{
				GOOGLE_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
				GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
			},
		);

		await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({ providerId: "google-vertex", status: "network_error" }),
		);
	});

	it("names the credential source when minting an ADC token fails transiently", async () => {
		authMocks.getClient.mockRejectedValueOnce(
			Object.assign(new Error("unavailable"), { response: { status: 503 } }),
		);
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(
			registry,
			mockLogger,
			{ onProviderStatusChange },
			{ GOOGLE_APPLICATION_CREDENTIALS: "/no/such/adc.json" },
		);

		await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({ status: "network_error" }),
		);
		expect(mockLogger.warn).toHaveBeenCalledWith(
			expect.stringContaining(
				"Credential source: Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (/no/such/adc.json",
			),
		);
	});

	it("uses a captured ADC path after the ambient environment is scrubbed", async () => {
		const parentEnvironment: Record<string, string | undefined> = {
			GOOGLE_APPLICATION_CREDENTIALS: "/secrets/service-account.json",
		};
		const captured = Object.freeze({ ...parentEnvironment });
		delete parentEnvironment.GOOGLE_APPLICATION_CREDENTIALS;
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					publisherModels: [{ name: "publishers/google/models/gemini-2.5-pro" }],
				}),
			),
		);
		const registry = new ProviderRegistry(mockLogger);
		registerGoogleVertexProvider(registry, mockLogger, undefined, captured);

		const models = await registry.getModelsForProvider("google-vertex", {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
		});

		expect(models).toHaveLength(2);
		expect(authMocks.googleAuth).toHaveBeenCalledWith({
			scopes: ["https://www.googleapis.com/auth/cloud-platform"],
			keyFilename: "/secrets/service-account.json",
		});
		expect(mockLogger.info).toHaveBeenCalledWith(
			expect.stringContaining(
				"[GoogleVertex] Using Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (/secrets/service-account.json",
			),
		);
	});

	it("discovers models under a custom Vertex provider ID", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: string | URL | Request) => {
				const url = String(input);
				const publisherModels = url.includes("/google/")
					? [{ name: "publishers/google/models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro" }]
					: [
							{
								name: "publishers/anthropic/models/claude-sonnet-4-6",
								displayName: "Claude Sonnet 4.6",
							},
						];
				return new Response(JSON.stringify({ publisherModels }), {
					status: 200,
					headers: { "content-type": "application/json" },
				});
			}),
		);
		const registry = new ProviderRegistry(mockLogger);
		const providerId = mintCustomProviderId("custom-vertex");
		registerCustomGoogleVertexProvider(registry, providerId, mockLogger);

		const models = await registry.getModelsForProvider(providerId, {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "brokered-token",
		});

		expect(models).toHaveLength(2);
		expect(models.every((model) => model.providerId === providerId)).toBe(true);
	});

	it("attributes custom Vertex authentication failures to the custom provider", async () => {
		const onProviderStatusChange = vi.fn().mockResolvedValue(undefined);
		const registry = new ProviderRegistry(mockLogger);
		const providerId = mintCustomProviderId("custom-vertex");
		registerCustomGoogleVertexProvider(registry, providerId, mockLogger, {
			onProviderStatusChange,
		});

		const models = await registry.getModelsForProvider(providerId, {
			type: "google-cloud",
			project: "my-project",
			location: "us-central1",
			accessToken: "expired-token",
		});

		expect(models).toEqual([]);
		expect(onProviderStatusChange).toHaveBeenCalledWith(
			expect.objectContaining({ providerId, status: "auth_error" }),
		);
	});
});

describe("resolveGoogleVertexAccessToken", () => {
	const inlineEnv = {
		GOOGLE_CLIENT_EMAIL: "svc@example.iam.gserviceaccount.com",
		GOOGLE_PRIVATE_KEY: "-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----",
	};

	beforeEach(() => {
		vi.clearAllMocks();
		authMocks.getClient.mockResolvedValue({ getAccessToken: authMocks.getAccessToken });
		authMocks.googleAuth.mockImplementation(() => ({ getClient: authMocks.getClient }));
	});

	it("mints from inline service-account env vars before ADC", async () => {
		authMocks.getAccessToken.mockResolvedValueOnce({ token: "inline-token" });
		await expect(resolveGoogleVertexAccessToken(inlineEnv)).resolves.toBe("inline-token");
		expect(authMocks.googleAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				credentials: expect.objectContaining({
					client_email: inlineEnv.GOOGLE_CLIENT_EMAIL,
					private_key: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----",
				}),
			}),
		);
	});

	it("mints from the captured provider environment a scrubbing host hands over", async () => {
		authMocks.getAccessToken.mockResolvedValueOnce({ token: "inline-token" });
		const captured = captureProviderEnvironment(["google-vertex"], {
			...inlineEnv,
			GOOGLE_PRIVATE_KEY_ID: "kid-1",
			UNRELATED: "x",
		});
		expect(captured.scrubbedNames).toContain("GOOGLE_PRIVATE_KEY");
		await expect(resolveGoogleVertexAccessToken(captured.environment)).resolves.toBe(
			"inline-token",
		);
		expect(authMocks.googleAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				credentials: expect.objectContaining({
					client_email: inlineEnv.GOOGLE_CLIENT_EMAIL,
					private_key_id: "kid-1",
				}),
			}),
		);
	});

	it("includes GOOGLE_PRIVATE_KEY_ID when set", async () => {
		authMocks.getAccessToken.mockResolvedValueOnce({ token: "inline-token" });
		await resolveGoogleVertexAccessToken({ ...inlineEnv, GOOGLE_PRIVATE_KEY_ID: "kid-1" });
		expect(authMocks.googleAuth).toHaveBeenCalledWith(
			expect.objectContaining({
				credentials: expect.objectContaining({ private_key_id: "kid-1" }),
			}),
		);
	});

	it("surfaces an inline failure instead of falling through to ADC", async () => {
		authMocks.getAccessToken.mockRejectedValueOnce(new Error("bad key"));
		await expect(resolveGoogleVertexAccessToken(inlineEnv)).rejects.toMatchObject({
			name: "InlineServiceAccountError",
			message: "Inline service-account credentials failed: bad key",
		});
		expect(authMocks.googleAuth).toHaveBeenCalledTimes(1);
	});

	it.each([
		["a connection reset", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" })],
		[
			"a token-service outage",
			Object.assign(new Error("unavailable"), { response: { status: 503 } }),
		],
		["throttling", Object.assign(new Error("rate limited"), { response: { status: 429 } })],
		["a request timeout", Object.assign(new Error("request timed out"), { name: "TimeoutError" })],
		["an aborted request", Object.assign(new Error("aborted"), { name: "AbortError" })],
	])("passes %s through unchanged instead of blaming the credentials", async (_label, error) => {
		authMocks.getAccessToken.mockRejectedValueOnce(error);
		await expect(resolveGoogleVertexAccessToken(inlineEnv)).rejects.toBe(error);
	});

	it("treats a token-endpoint rejection as rejected credentials", async () => {
		authMocks.getAccessToken.mockRejectedValueOnce(
			Object.assign(new Error("invalid_grant"), { response: { status: 400 } }),
		);
		await expect(resolveGoogleVertexAccessToken(inlineEnv)).rejects.toMatchObject({
			name: "InlineServiceAccountError",
		});
	});

	it("falls back to ADC when the inline vars are absent", async () => {
		authMocks.getAccessToken.mockResolvedValueOnce({ token: "adc-token" });
		await expect(resolveGoogleVertexAccessToken({})).resolves.toBe("adc-token");
		expect(authMocks.googleAuth).toHaveBeenCalledWith(
			expect.not.objectContaining({ credentials: expect.anything() }),
		);
	});

	it("treats ADC yielding no token as a credential error", async () => {
		authMocks.getAccessToken.mockResolvedValueOnce({ token: null });
		await expect(resolveGoogleVertexAccessToken({})).rejects.toMatchObject({
			name: "ApplicationDefaultCredentialsError",
			message: "Application Default Credentials failed: no access token was returned",
		});
	});
});

describe("describeGoogleVertexCredentialSource", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "vertex-adc-"));
		// Point both platforms' gcloud config dirs at the temp dir.
		vi.stubEnv("HOME", dir);
		vi.stubEnv("APPDATA", join(dir, ".config"));
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", undefined);
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(dir, { recursive: true, force: true });
	});

	it("names an existing GOOGLE_APPLICATION_CREDENTIALS file", () => {
		const file = join(dir, "key.json");
		writeFileSync(file, "{}");
		expect(describeGoogleVertexCredentialSource({ kind: "adc", keyFilename: file })).toBe(
			`Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (${file})`,
		);
	});

	it("reads GOOGLE_APPLICATION_CREDENTIALS from the ambient environment when none was captured", () => {
		const file = join(dir, "missing.json");
		vi.stubEnv("GOOGLE_APPLICATION_CREDENTIALS", file);
		expect(describeGoogleVertexCredentialSource({ kind: "adc", keyFilename: undefined })).toBe(
			`Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (${file}, which does not exist)`,
		);
	});

	it("names gcloud's file when GOOGLE_APPLICATION_CREDENTIALS is unset", () => {
		const gcloudDir = join(dir, ".config", "gcloud");
		mkdirSync(gcloudDir, { recursive: true });
		const file = join(gcloudDir, "application_default_credentials.json");
		writeFileSync(file, "{}");
		expect(describeGoogleVertexCredentialSource({ kind: "adc", keyFilename: undefined })).toBe(
			`Application Default Credentials from gcloud's file (${file})`,
		);
	});

	it("lists the missing files when only the metadata server is left", () => {
		const gcloudFile = join(dir, ".config", "gcloud", "application_default_credentials.json");
		expect(describeGoogleVertexCredentialSource({ kind: "adc", keyFilename: undefined })).toBe(
			`Application Default Credentials with no file (GOOGLE_APPLICATION_CREDENTIALS is unset and there is no gcloud file at ${gcloudFile}), so only the metadata server can supply them`,
		);
	});
});

describe("GoogleVertexClient location heuristic", () => {
	it("routes recognized Anthropic model IDs to global via model-ID heuristic", () => {
		// Baseline: recognized model IDs already go to global
		expect(isVertexAnthropicModel("claude-sonnet-4-6")).toBe(true);
		expect(getEffectiveLocation("claude-sonnet-4-6", "us-central1")).toBe("global");
	});

	it("routes unrecognized model IDs to configured location", () => {
		// A model ID that doesn't match the anthropic pattern
		expect(isVertexAnthropicModel("my-custom-model")).toBe(false);
		expect(getEffectiveLocation("my-custom-model", "us-central1")).toBe("us-central1");
	});

	// The actual location-with-protocol behavior is tested indirectly:
	// GoogleVertexClient.createModel is private, so we verify the exported
	// helpers produce the right inputs and trust that createModel's
	// `useAnthropicApi && protocol === "anthropic-messages"` → "global" branch
	// is covered by the type-checked implementation.
});

describe("claudeDisplayName", () => {
	it.each([
		{ id: "claude-haiku-5-5", expected: "Claude Haiku 5.5" },
		{ id: "claude-haiku-4-5-20251001", expected: "Claude Haiku 4.5" },
		{ id: "claude-3-5-sonnet-20241022", expected: "Claude 3.5 Sonnet" },
	])("names $id as $expected", ({ id, expected }) => {
		expect(claudeDisplayName(id)).toBe(expected);
	});
});
