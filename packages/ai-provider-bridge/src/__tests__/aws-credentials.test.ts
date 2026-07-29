/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

const { chainProvider, fromNodeProviderChain } = vi.hoisted(() => ({
	chainProvider: vi.fn(async () => ({
		accessKeyId: "chain-key",
		secretAccessKey: "chain-secret",
		sessionToken: "chain-token",
	})),
	fromNodeProviderChain: vi.fn(),
}));

vi.mock("@aws-sdk/credential-providers", () => ({
	fromNodeProviderChain,
}));

import { createAwsCredentialProvider, hasManualAwsKeys } from "../aws-credentials";

beforeEach(() => {
	vi.clearAllMocks();
	fromNodeProviderChain.mockReturnValue(chainProvider);
});

describe("createAwsCredentialProvider", () => {
	it("wraps manual keys in the same provider-function shape", async () => {
		const source = {
			region: "us-east-2",
			profile: "ignored",
			accessKeyId: "manual-key",
			secretAccessKey: "manual-secret",
			sessionToken: "manual-token",
		};
		expect(hasManualAwsKeys(source)).toBe(true);

		await expect(createAwsCredentialProvider(source)()).resolves.toEqual({
			accessKeyId: "manual-key",
			secretAccessKey: "manual-secret",
			sessionToken: "manual-token",
		});
		expect(fromNodeProviderChain).not.toHaveBeenCalled();
	});

	it("returns the standard Node chain directly when manual keys are absent", async () => {
		const provider = createAwsCredentialProvider({
			region: "us-east-2",
			profile: "analytics",
		});

		expect(fromNodeProviderChain).toHaveBeenCalledWith({ profile: "analytics" });
		expect(provider).toBe(chainProvider);
		await expect(provider()).resolves.toEqual({
			accessKeyId: "chain-key",
			secretAccessKey: "chain-secret",
			sessionToken: "chain-token",
		});
	});
});
