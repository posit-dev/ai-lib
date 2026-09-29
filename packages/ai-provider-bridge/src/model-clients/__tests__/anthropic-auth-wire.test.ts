/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * `AnthropicClient`'s auth config picks the wire header scheme: `{ apiKey }`
 * sends `x-api-key`, `{ authToken }` sends `Authorization: Bearer` (the scheme
 * gateways fronting the Messages API use). The two are mutually exclusive on
 * the wire, and the SDK rejects being handed both — these tests pin that only
 * the selected header ever leaves.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createRawFetchCapture,
	type RawFetchCapture,
} from "../../../tests/helpers/raw-fetch-capture";
import type { CancellationToken } from "../../types";
import { AnthropicClient } from "../AnthropicClient";

const cancellationToken: CancellationToken = {
	isCancellationRequested: false,
	onCancellationRequested: () => ({ dispose() {} }),
};

let fetchCapture: RawFetchCapture;

beforeEach(() => {
	fetchCapture = createRawFetchCapture(
		async () =>
			new Response("", {
				status: 200,
				headers: { "content-type": "text/event-stream" },
			}),
	);
	vi.stubGlobal("fetch", fetchCapture.mock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

/** Drive one chat request through a stubbed fetch and return its headers. */
async function requestHeaders(client: AnthropicClient): Promise<Headers> {
	try {
		const stream = await client.chat({
			model: "claude-haiku-4-5",
			messages: [{ role: "user", content: "hello" }],
			cancellationToken,
		});
		for await (const _part of stream) {
			// Drain the (empty) mocked event stream.
		}
	} catch {
		// The mocked stream is minimal; stream errors are fine — we only care
		// about the request headers.
	}

	const [, init] = fetchCapture.single();
	return new Headers(init?.headers);
}

describe("AnthropicClient auth config", () => {
	it("sends x-api-key and no Authorization for { apiKey }", async () => {
		const headers = await requestHeaders(new AnthropicClient({ apiKey: "sk-test" }));

		expect(headers.get("x-api-key")).toBe("sk-test");
		expect(headers.get("authorization")).toBeNull();
	});

	it("sends Authorization: Bearer and no x-api-key for { authToken }", async () => {
		const headers = await requestHeaders(new AnthropicClient({ authToken: "dapi-token" }));

		expect(headers.get("authorization")).toBe("Bearer dapi-token");
		expect(headers.get("x-api-key")).toBeNull();
	});

	it("sends no auth headers for an anonymous (empty-key) client, even with ANTHROPIC_API_KEY set", async () => {
		// Auth-less custom providers signal anonymous access with apiKey === "".
		// The ambient env var must NOT be inherited: the client passes the SDK
		// a non-empty sentinel (otherwise the SDK falls back to the env var)
		// and strips the resulting auth headers before the wire.
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-env-must-not-leak");

		const headers = await requestHeaders(new AnthropicClient({ apiKey: "" }));

		expect(headers.get("x-api-key")).toBeNull();
		expect(headers.get("authorization")).toBeNull();
		expect(headers.get("anthropic-version")).toBe("2023-06-01");
	});
});
