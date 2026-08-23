/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { requireBareAuthHost } from "../utils.js";

describe("requireBareAuthHost", () => {
	it("returns a bare host unchanged", () => {
		expect(requireBareAuthHost("login.posit.cloud")).toBe("login.posit.cloud");
	});

	it("returns a host with a port unchanged", () => {
		expect(requireBareAuthHost("localhost:8787")).toBe("localhost:8787");
	});

	it("trims surrounding whitespace", () => {
		expect(requireBareAuthHost("  login.posit.cloud  ")).toBe("login.posit.cloud");
	});

	it("throws a descriptive error for a scheme-carrying host", () => {
		// Regression: a scheme-carrying host interpolated into
		// `https://${host}/...` produced `https://https://...`, which failed
		// with the cryptic `getaddrinfo ENOTFOUND https`.
		expect(() => requireBareAuthHost("https://login.staging.posit.cloud")).toThrow(
			/Invalid auth host "https:\/\/login\.staging\.posit\.cloud": expected a bare hostname/,
		);
	});

	it("throws for a host with a path or trailing slash", () => {
		expect(() => requireBareAuthHost("login.posit.cloud/")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("login.posit.cloud/oauth")).toThrow(/Invalid auth host/);
	});

	it("throws for a host with a query or fragment", () => {
		expect(() => requireBareAuthHost("login.posit.cloud?x=1")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("login.posit.cloud#y")).toThrow(/Invalid auth host/);
	});

	it("throws for an empty host", () => {
		expect(() => requireBareAuthHost("")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("   ")).toThrow(/Invalid auth host/);
	});

	it("throws for userinfo, which would silently target a different hostname", () => {
		expect(() => requireBareAuthHost("user@login.posit.cloud")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("user:pass@login.posit.cloud")).toThrow(/Invalid auth host/);
	});

	it("throws for invalid ports, backslashes, and internal whitespace", () => {
		expect(() => requireBareAuthHost("login.posit.cloud:abc")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("login.posit.cloud:99999")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("login.posit.cloud\\oauth")).toThrow(/Invalid auth host/);
		expect(() => requireBareAuthHost("login. posit.cloud")).toThrow(/Invalid auth host/);
	});
});
