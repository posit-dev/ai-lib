/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	discoverDatabricksOidcEndpoints,
	normalizeDatabricksWorkspaceHost,
} from "../databricks-oauth";
import { normalizeDatabricksHost } from "../types";

describe("Databricks OAuth workspace validation", () => {
	it("normalizes secure workspace hosts", () => {
		expect(normalizeDatabricksWorkspaceHost("workspace.example.com/path?q=1")).toBe(
			"https://workspace.example.com",
		);
	});

	it.each(["http://workspace.example.com", "http://localhost:8080", "http://127.0.0.1:8080"])(
		"rejects insecure production workspace URL %s",
		(workspaceHost) => {
			expect(() => normalizeDatabricksWorkspaceHost(workspaceHost)).toThrow(
				"Databricks workspace URL must use HTTPS",
			);
		},
	);

	it("uses the same HTTPS-only parser from the browser-safe types entrypoint", () => {
		expect(normalizeDatabricksHost("workspace.example.com/path?q=1")).toBe(
			"https://workspace.example.com",
		);
		expect(() => normalizeDatabricksHost("http://workspace.example.com")).toThrow("must use HTTPS");
	});
});

describe("Databricks OIDC endpoint discovery", () => {
	const discoveredEndpoints = (host: string) => ({
		authorization_endpoint: `${host}/oidc/discovered/authorize`,
		token_endpoint: `${host}/oidc/discovered/token`,
	});
	const fallbackEndpoints = (host: string) => ({
		authorizationEndpoint: `${host}/oidc/v1/authorize`,
		tokenEndpoint: `${host}/oidc/v1/token`,
	});

	function stubFetch(respond: (url: string, init?: RequestInit) => Promise<Response>) {
		const fetchStub = vi.fn(respond);
		vi.stubGlobal("fetch", fetchStub);
		return fetchStub;
	}

	afterEach(() => {
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it("reads the workspace authorization-server metadata and caches it", async () => {
		const host = "https://discovered.example.com";
		const fetchStub = stubFetch(async () => Response.json(discoveredEndpoints(host)));

		await expect(discoverDatabricksOidcEndpoints(`${host}/`)).resolves.toEqual({
			authorizationEndpoint: `${host}/oidc/discovered/authorize`,
			tokenEndpoint: `${host}/oidc/discovered/token`,
		});
		await discoverDatabricksOidcEndpoints(host);

		expect(fetchStub.mock.calls.map(([url]) => url)).toEqual([
			`${host}/oidc/.well-known/oauth-authorization-server`,
		]);
	});

	it("falls back after a 2 second timeout", async () => {
		const host = "https://slow.example.com";
		const timeout = new AbortController();
		const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeout.signal);
		stubFetch(
			(_url, init) =>
				new Promise((_resolve, reject) => {
					init?.signal?.addEventListener("abort", () => reject(new Error("timed out")));
				}),
		);

		const pending = discoverDatabricksOidcEndpoints(host);
		timeout.abort();

		await expect(pending).resolves.toEqual(fallbackEndpoints(host));
		expect(timeoutSpy).toHaveBeenCalledWith(2000);
	});

	it.each([
		["an HTTP error", "http-error", () => new Response("missing", { status: 404 })],
		["a document without endpoints", "no-endpoints", () => Response.json({ issuer: "x" })],
		[
			"a cross-origin endpoint",
			"cross-origin",
			() =>
				Response.json({
					authorization_endpoint: "https://attacker.example.com/authorize",
					token_endpoint: "https://attacker.example.com/token",
				}),
		],
	])(
		"falls back to the documented paths and caches them on %s",
		async (_label, subdomain, respond) => {
			const host = `https://${subdomain}.example.com`;
			const fetchStub = stubFetch(async () => respond());

			await expect(discoverDatabricksOidcEndpoints(host)).resolves.toEqual(fallbackEndpoints(host));
			await expect(discoverDatabricksOidcEndpoints(host)).resolves.toEqual(fallbackEndpoints(host));

			expect(fetchStub).toHaveBeenCalledTimes(1);
		},
	);
});
