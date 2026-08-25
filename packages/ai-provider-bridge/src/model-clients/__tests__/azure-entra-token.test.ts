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

	it("normalizes token-acquisition failures into an actionable error", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => {
			throw new Error("CredentialUnavailableError: no credential in the chain succeeded");
		});

		const provider = createAzureEntraTokenProvider("scope-a");
		await expect(provider()).rejects.toThrow(/az login/);
		await expect(provider()).rejects.toThrow(/no credential in the chain succeeded/);
	});

	it("passes tokens through unchanged on success", async () => {
		mocks.getBearerTokenProvider.mockReturnValue(async () => "entra-token");

		const provider = createAzureEntraTokenProvider("scope-a");
		await expect(provider()).resolves.toBe("entra-token");
	});
});
