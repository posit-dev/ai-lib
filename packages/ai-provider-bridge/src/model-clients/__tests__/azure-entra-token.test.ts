/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const defaultAzureCredential = vi.fn();
	const getBearerTokenProvider = vi.fn();
	return { defaultAzureCredential, getBearerTokenProvider };
});

vi.mock("@azure/identity", () => ({
	DefaultAzureCredential: mocks.defaultAzureCredential,
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
});
