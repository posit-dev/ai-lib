/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	createVertex: vi.fn(() => vi.fn(() => ({}))),
	createVertexAnthropic: vi.fn(() => vi.fn(() => ({}))),
	streamText: vi.fn(() => ({
		fullStream: (async function* () {})(),
	})),
}));

vi.mock("@ai-sdk/google-vertex", () => ({ createVertex: mocks.createVertex }));
vi.mock("@ai-sdk/google-vertex/anthropic", () => ({
	createVertexAnthropic: mocks.createVertexAnthropic,
}));
vi.mock("ai", async (importOriginal) => ({
	...(await importOriginal<typeof import("ai")>()),
	streamText: mocks.streamText,
}));

import { GoogleVertexClient } from "../GoogleVertexClient";

describe("GoogleVertexClient captured authentication", () => {
	it("passes the captured ADC filename to the lazily-created request SDK", async () => {
		const client = new GoogleVertexClient({
			project: "project-id",
			location: "us-central1",
			googleApplicationCredentials: "/secrets/service-account.json",
		});

		await client.chat({
			model: "gemini-2.5-pro",
			messages: [{ role: "user", content: [{ type: "text", text: "hello" }] }],
			cancellationToken: {
				isCancellationRequested: false,
				onCancellationRequested: () => ({ dispose() {} }),
			},
		});

		expect(mocks.createVertex).toHaveBeenCalledWith(
			expect.objectContaining({
				project: "project-id",
				googleAuthOptions: { keyFilename: "/secrets/service-account.json" },
			}),
		);
	});
});
