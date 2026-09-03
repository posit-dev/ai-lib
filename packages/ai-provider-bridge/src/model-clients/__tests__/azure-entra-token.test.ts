/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const defaultAzureCredential = vi.fn();
	const clientSecretCredential = vi.fn();
	const clientCertificateCredential = vi.fn();
	const getBearerTokenProvider = vi.fn();
	return {
		defaultAzureCredential,
		clientSecretCredential,
		clientCertificateCredential,
		getBearerTokenProvider,
	};
});

vi.mock("@azure/identity", () => ({
	DefaultAzureCredential: mocks.defaultAzureCredential,
	ClientSecretCredential: mocks.clientSecretCredential,
	ClientCertificateCredential: mocks.clientCertificateCredential,
	getBearerTokenProvider: mocks.getBearerTokenProvider,
}));

import {
	clearAzureEntraTokenProviderCache,
	createAzureEntraTokenProvider,
} from "../azure-entra-token";

afterEach(() => {
	clearAzureEntraTokenProviderCache();
	vi.clearAllMocks();
});

describe("createAzureEntraTokenProvider", () => {
	it("caches one bearer provider per scope+tenant", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");

		const a1 = createAzureEntraTokenProvider("scope-a", "tenant-1");
		const a2 = createAzureEntraTokenProvider("scope-a", "tenant-1");
		const b = createAzureEntraTokenProvider("scope-b", "tenant-1");
		const noTenant = createAzureEntraTokenProvider("scope-a");

		expect(a1).toBe(a2);
		expect(a1).not.toBe(b);
		expect(a1).not.toBe(noTenant);
		expect(mocks.defaultAzureCredential).toHaveBeenCalledTimes(3);
		expect(mocks.defaultAzureCredential).toHaveBeenCalledWith({ tenantId: "tenant-1" });
		expect(mocks.defaultAzureCredential).toHaveBeenCalledWith({});
	});

	it("does not collide distinct scope and tenant pairs", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");

		const first = createAzureEntraTokenProvider("c", "ab");
		const second = createAzureEntraTokenProvider("bc", "a");

		expect(first).not.toBe(second);
		expect(mocks.defaultAzureCredential).toHaveBeenCalledTimes(2);
	});

	it("normalizes token-acquisition failures into an actionable error", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => {
			const error = new Error("no credential in the chain succeeded");
			error.name = "CredentialUnavailableError";
			throw error;
		});

		const provider = createAzureEntraTokenProvider("scope-a");
		await expect(provider()).rejects.toThrow(/az login/);
		await expect(provider()).rejects.toThrow(/no credential in the chain succeeded/);
	});

	it("recognizes an aggregate containing only unavailable credentials", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => {
			const unavailable = new Error("Azure CLI is not installed");
			unavailable.name = "CredentialUnavailableError";
			const aggregate = Object.assign(new Error("credential chain failed"), {
				name: "AggregateAuthenticationError",
				errors: [unavailable],
			});
			throw aggregate;
		});

		const provider = createAzureEntraTokenProvider("scope-a");
		await expect(provider()).rejects.toThrow(/az login/);
	});

	it("does not diagnose other token-acquisition failures as missing credentials", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => {
			const error = new Error("invalid tenant");
			error.name = "AuthenticationError";
			throw error;
		});

		const provider = createAzureEntraTokenProvider("scope-a", "bad-tenant");
		await expect(provider()).rejects.toThrow(/token acquisition failed/);
		await expect(provider()).rejects.not.toThrow(/no usable Azure credential/);
		await expect(provider()).rejects.toThrow(/invalid tenant/);
	});

	it("passes tokens through unchanged on success", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "entra-token");

		const provider = createAzureEntraTokenProvider("scope-a");
		await expect(provider()).resolves.toBe("entra-token");
	});

	it("materializes captured service-principal credentials after ambient scrubbing", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "captured-token");
		const parentEnvironment: Record<string, string | undefined> = {
			AZURE_TENANT_ID: "tenant-from-env",
			AZURE_CLIENT_ID: "client-from-env",
			AZURE_CLIENT_SECRET: "secret-from-env",
		};
		const captured = Object.freeze({ ...parentEnvironment });
		delete parentEnvironment.AZURE_CLIENT_SECRET;

		const provider = createAzureEntraTokenProvider(
			"https://cognitiveservices.azure.com/.default",
			undefined,
			captured,
		);
		await expect(provider()).resolves.toBe("captured-token");
		expect(mocks.clientSecretCredential).toHaveBeenCalledWith(
			"tenant-from-env",
			"client-from-env",
			"secret-from-env",
		);
		expect(mocks.defaultAzureCredential).not.toHaveBeenCalled();
	});

	it("caches one bearer provider per captured record identity and scope+tenant", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");
		const captured = Object.freeze({
			AZURE_TENANT_ID: "tenant-from-env",
			AZURE_CLIENT_ID: "client-from-env",
			AZURE_CLIENT_SECRET: "secret-from-env",
		});

		const first = createAzureEntraTokenProvider("scope-a", undefined, captured);
		const second = createAzureEntraTokenProvider("scope-a", undefined, captured);
		// A structurally identical but distinct record is a different cache key:
		// identity on the raw snapshot is what keeps the Azure SDK's per-instance
		// token cache effective.
		const otherRecord = createAzureEntraTokenProvider(
			"scope-a",
			undefined,
			Object.freeze({ ...captured }),
		);

		expect(first).toBe(second);
		expect(first).not.toBe(otherRecord);
		// One credential + bearer-provider construction per distinct record.
		expect(mocks.clientSecretCredential).toHaveBeenCalledTimes(2);
		expect(mocks.getBearerTokenProvider).toHaveBeenCalledTimes(2);
	});

	it("prefers an explicit tenantId over the captured AZURE_TENANT_ID", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");
		const captured = Object.freeze({
			AZURE_TENANT_ID: "captured-tenant",
			AZURE_CLIENT_ID: "client-from-env",
			AZURE_CLIENT_SECRET: "secret-from-env",
		});

		createAzureEntraTokenProvider("scope-a", "explicit-tenant", captured);

		expect(mocks.clientSecretCredential).toHaveBeenCalledWith(
			"explicit-tenant",
			"client-from-env",
			"secret-from-env",
		);
		expect(mocks.defaultAzureCredential).not.toHaveBeenCalled();
	});

	it("constructs a certificate credential from captured values, forwarding the password", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");
		const captured = Object.freeze({
			AZURE_TENANT_ID: "tenant-from-env",
			AZURE_CLIENT_ID: "client-from-env",
			AZURE_CLIENT_CERTIFICATE_PATH: "/certs/sp.pem",
			AZURE_CLIENT_CERTIFICATE_PASSWORD: "cert-password",
		});

		createAzureEntraTokenProvider("scope-a", undefined, captured);

		expect(mocks.clientCertificateCredential).toHaveBeenCalledWith(
			"tenant-from-env",
			"client-from-env",
			{
				certificatePath: "/certs/sp.pem",
				certificatePassword: "cert-password",
			},
		);
		expect(mocks.defaultAzureCredential).not.toHaveBeenCalled();
	});

	it("falls back to DefaultAzureCredential when captured values are incomplete", () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "token");
		const captured = Object.freeze({
			AZURE_TENANT_ID: "tenant-from-env",
			AZURE_CLIENT_ID: "client-from-env",
			// No AZURE_CLIENT_SECRET / AZURE_CLIENT_CERTIFICATE_PATH.
		});

		createAzureEntraTokenProvider("scope-a", undefined, captured);

		expect(mocks.clientSecretCredential).not.toHaveBeenCalled();
		expect(mocks.clientCertificateCredential).not.toHaveBeenCalled();
		expect(mocks.defaultAzureCredential).toHaveBeenCalledWith({});
	});
});
