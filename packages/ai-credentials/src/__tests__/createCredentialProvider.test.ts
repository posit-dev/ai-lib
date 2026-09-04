/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Tests for createCredentialProvider — the root resolver seam.
 *
 * Uses fake in-memory backends so routing is exercised in isolation (no fs, no
 * vscode). Acquisition-engine behavior itself is covered in acquisition.test.ts.
 */

import { describe, expect, it } from "vitest";

import type { Backend } from "../Backend.js";
import { createCredentialProvider } from "../createCredentialProvider.js";
import type { ProviderCredentials } from "../types/index.js";

function makeBackend(getCredentials: (id: string) => Promise<ProviderCredentials | null>): Backend {
	return {
		getCredentials,
		onDidChangeCredentials: () => ({ dispose() {} }),
	};
}

describe("createCredentialProvider — getCredentials routing", () => {
	it("defers to backend.getCredentials for providers without acquisition hooks", async () => {
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
});

describe("createCredentialProvider — backend without acquisition hooks", () => {
	const provider = () => createCredentialProvider({ backend: makeBackend(async () => null) });

	it("getAccessToken returns null", async () => {
		expect(await provider().getAccessToken("positai")).toBeNull();
	});

	it("startDeviceAuth rejects as unsupported", async () => {
		await expect(provider().startDeviceAuth("positai")).rejects.toThrow(/not supported/);
	});

	it("startAuthentication rejects as unsupported", async () => {
		await expect(provider().startAuthentication("positai")).rejects.toThrow(/not supported/);
	});

	it("cancelDeviceAuth and cancelAuthentication are no-ops", () => {
		const p = provider();
		expect(() => p.cancelDeviceAuth("positai")).not.toThrow();
		expect(() => p.cancelAuthentication("positai")).not.toThrow();
	});

	it("dispose resolves", async () => {
		await expect(provider().dispose()).resolves.toBeUndefined();
	});
});
