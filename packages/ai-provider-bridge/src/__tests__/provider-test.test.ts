/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import { testLMStudioProvider, testOllamaProvider } from "../providers/provider-test";

function mockFetchCapturingUrl(): { urls: string[] } {
	const captured = { urls: [] as string[] };
	vi.stubGlobal(
		"fetch",
		vi.fn(async (url: string | URL | Request) => {
			captured.urls.push(String(url));
			return new Response(JSON.stringify({ data: [], models: [] }), { status: 200 });
		}),
	);
	return captured;
}

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("testLMStudioProvider URL construction", () => {
	it("uses a /v1 endpoint as-is (no double /v1)", async () => {
		const captured = mockFetchCapturingUrl();
		await testLMStudioProvider("http://localhost:1234/v1");
		expect(captured.urls).toEqual(["http://localhost:1234/v1/models"]);
	});

	it("normalizes the bare default host for backward compatibility", async () => {
		const captured = mockFetchCapturingUrl();
		await testLMStudioProvider("http://localhost:1234");
		expect(captured.urls).toEqual(["http://localhost:1234/v1/models"]);
	});

	it("leaves a custom versioned endpoint untouched", async () => {
		const captured = mockFetchCapturingUrl();
		await testLMStudioProvider("http://gpu-box:1234/v1");
		expect(captured.urls).toEqual(["http://gpu-box:1234/v1/models"]);
	});
});

describe("testOllamaProvider URL construction", () => {
	it("appends the native API path to the bare root", async () => {
		const captured = mockFetchCapturingUrl();
		await testOllamaProvider("http://localhost:11434");
		expect(captured.urls).toEqual(["http://localhost:11434/api/tags"]);
	});
});
