/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { createRawFetchCapture } from "./raw-fetch-capture";

const respond = async () => new Response("ok");

describe("createRawFetchCapture", () => {
	it("retains the raw input, init, headers, and body identities", async () => {
		const capture = createRawFetchCapture(respond);
		const input = new URL("https://example.test/messages");
		const headers = new Headers({ authorization: "Bearer token" });
		const body = new Blob(["raw body"]);
		const init: RequestInit = { method: "POST", headers, body };

		await capture.mock(input, init);

		const call = capture.single();
		expect(call).toBe(capture.mock.mock.calls[0]);
		expect(call[0]).toBe(input);
		expect(call[1]).toBe(init);
		expect(call[1]?.headers).toBe(headers);
		expect(call[1]?.body).toBe(body);
		expect(capture.calls).toBe(capture.mock.mock.calls);
	});

	it("retains string, URL, and Request inputs without adding an init", async () => {
		const capture = createRawFetchCapture(respond);
		const inputs = [
			"https://example.test/string",
			new URL("https://example.test/url"),
			new Request("https://example.test/request"),
		] as const;

		for (const input of inputs) await capture.mock(input);

		expect(capture.calls).toHaveLength(3);
		expect(capture.calls.map(([input]) => input)).toEqual(inputs);
		for (const call of capture.calls) {
			expect(call).toHaveLength(1);
			expect(call[1]).toBeUndefined();
		}
	});

	it("keeps repeated calls in order and exposes indexed access", async () => {
		const capture = createRawFetchCapture(respond);
		const first = new Request("https://example.test/repeated");
		const second = new Request("https://example.test/repeated");
		const third = new Request("https://example.test/repeated");

		await capture.mock(first);
		await capture.mock(second);
		await capture.mock(third);

		expect(capture.call(0)[0]).toBe(first);
		expect(capture.call(1)[0]).toBe(second);
		expect(capture.call(2)[0]).toBe(third);
	});

	it("single() rejects zero and multiple calls", async () => {
		const capture = createRawFetchCapture(respond);

		expect(() => capture.single()).toThrow(
			"Expected exactly one fetch call, but captured 0 call(s)",
		);

		await capture.mock("https://example.test/first");
		await capture.mock("https://example.test/second");

		expect(() => capture.single()).toThrow(
			"Expected exactly one fetch call, but captured 2 call(s)",
		);
	});
});
