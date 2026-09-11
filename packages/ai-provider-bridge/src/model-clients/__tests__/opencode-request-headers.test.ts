/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unit coverage for the OpenCode header policy: endpoint recognition
 * (matching, normalization, and non-matches) and header-merge semantics.
 * Wire-level behavior is covered by `opencode-session-wire.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
	explicitUserAgentHeader,
	isOpencodeEndpoint,
	mergeOpencodeHeaders,
} from "../opencode-request-headers";

describe("isOpencodeEndpoint", () => {
	it.each([
		// Go and Zen API roots
		["https://opencode.ai/zen/go/v1", true],
		["https://opencode.ai/zen/v1", true],
		// Trailing slashes and discovery sub-paths
		["https://opencode.ai/zen/go/v1/", true],
		["https://opencode.ai/zen/v1///", true],
		["https://opencode.ai/zen/v1/models", true],
		// Hostname normalization (URL parsing lowercases the host)
		["https://OPENCODE.AI/zen/go/v1", true],
		// Explicit default HTTPS port
		["https://opencode.ai:443/zen/v1", true],
		// Non-matches: http, subdomains, lookalikes, other ports, other paths
		["http://opencode.ai/zen/go/v1", false],
		["https://sub.opencode.ai/zen/go/v1", false],
		["https://opencode.ai.evil.example.com/zen/go/v1", false],
		["https://opencode.ai:8443/zen/go/v1", false],
		["https://opencode.ai/v1", false],
		["https://opencode.ai/zen", false],
		["https://opencode.ai/zen/v2", false],
		["https://opencode.ai/zen/v1beta", false],
		["https://api.openai.com/v1", false],
		// Absent or unparsable URLs
		[undefined, false],
		["", false],
		["not a url", false],
	])("matches %s -> %s", (url, expected) => {
		expect(isOpencodeEndpoint(url)).toBe(expected);
	});
});

describe("explicitUserAgentHeader", () => {
	it("finds a non-empty User-Agent case-insensitively", () => {
		expect(explicitUserAgentHeader({ "USER-agent": "my-agent/1.0" })).toBe("my-agent/1.0");
		expect(explicitUserAgentHeader({ "user-agent": "" })).toBeUndefined();
		expect(explicitUserAgentHeader({ "x-other": "my-agent/1.0" })).toBeUndefined();
		expect(explicitUserAgentHeader(undefined)).toBeUndefined();
	});
});

describe("mergeOpencodeHeaders", () => {
	const GO = "https://opencode.ai/zen/go/v1";

	it("returns the record unchanged on non-matching routes", () => {
		const headers = { "x-opencode-session": "static", "x-other": "kept" };
		expect(
			mergeOpencodeHeaders(headers, {
				baseUrl: "https://api.example.com/v1",
				rootConversationId: "root-1",
				userAgent: "host/1.0",
			}),
		).toBe(headers);
	});

	it("sets the generated session header, replacing case-variants", () => {
		const merged = mergeOpencodeHeaders(
			{ "X-OpenCode-Session": "static", "x-other": "kept" },
			{ baseUrl: GO, rootConversationId: "root-1" },
		);
		expect(merged).toEqual({ "x-other": "kept", "x-opencode-session": "root-1" });
	});

	it("leaves a static session header alone when no root identity is available", () => {
		const merged = mergeOpencodeHeaders(
			{ "X-OpenCode-Session": "static" },
			{ baseUrl: GO, userAgent: "host/1.0" },
		);
		expect(merged).toEqual({ "X-OpenCode-Session": "static", "User-Agent": "host/1.0" });
	});

	it("adds the host User-Agent only beneath an explicit custom one", () => {
		expect(
			mergeOpencodeHeaders({ "x-other": "kept" }, { baseUrl: GO, userAgent: "host/1.0" }),
		).toEqual({ "x-other": "kept", "User-Agent": "host/1.0" });

		expect(
			mergeOpencodeHeaders({ "USER-AGENT": "custom/2.0" }, { baseUrl: GO, userAgent: "host/1.0" }),
		).toEqual({ "USER-AGENT": "custom/2.0" });

		// An empty custom value does not count as an explicit override.
		expect(
			mergeOpencodeHeaders({ "User-Agent": "" }, { baseUrl: GO, userAgent: "host/1.0" }),
		).toEqual({ "User-Agent": "host/1.0" });
	});

	it("produces headers from nothing on a matching route", () => {
		expect(
			mergeOpencodeHeaders(undefined, {
				baseUrl: GO,
				rootConversationId: "root-1",
				userAgent: "host/1.0",
			}),
		).toEqual({ "x-opencode-session": "root-1", "User-Agent": "host/1.0" });
		// No policy input, no headers.
		expect(mergeOpencodeHeaders(undefined, { baseUrl: GO })).toBeUndefined();
	});
});
