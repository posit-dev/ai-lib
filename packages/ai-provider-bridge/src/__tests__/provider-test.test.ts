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

interface LMStudioVersionedEndpointCase {
	/** Name of the versioned-endpoint behavior being preserved. */
	name: string;
	endpoint: string;
	expectedUrl: string;
}

// Both endpoints are already versioned, so provider URL construction is identical.
const LM_STUDIO_VERSIONED_ENDPOINT_CASES: readonly LMStudioVersionedEndpointCase[] = [
	{
		name: "uses a /v1 endpoint as-is (no double /v1)",
		endpoint: "http://localhost:1234/v1",
		expectedUrl: "http://localhost:1234/v1/models",
	},
	{
		name: "leaves a custom versioned endpoint untouched",
		endpoint: "http://gpu-box:1234/v1",
		expectedUrl: "http://gpu-box:1234/v1/models",
	},
];

describe("testLMStudioProvider URL construction", () => {
	it.each(LM_STUDIO_VERSIONED_ENDPOINT_CASES)("$name", async ({ endpoint, expectedUrl }) => {
		const captured = mockFetchCapturingUrl();
		await testLMStudioProvider(endpoint);
		expect(captured.urls).toEqual([expectedUrl]);
	});

	it("normalizes the bare default host for backward compatibility", async () => {
		const captured = mockFetchCapturingUrl();
		await testLMStudioProvider("http://localhost:1234");
		expect(captured.urls).toEqual(["http://localhost:1234/v1/models"]);
	});
});

describe("testOllamaProvider URL construction", () => {
	it("appends the native API path to the bare root", async () => {
		const captured = mockFetchCapturingUrl();
		await testOllamaProvider("http://localhost:11434");
		expect(captured.urls).toEqual(["http://localhost:11434/api/tags"]);
	});
});
