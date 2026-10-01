/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import * as http from "node:http";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createConnectDeviceCodeGrantResolver, normalizeConnectBaseUrl } from "../connect-oauth.js";

interface DiscoveryOverrides {
	issuer?: string;
	deviceAuthorizationEndpoint?: string;
}

/** Minimal Connect-shaped OAuth discovery + registration stub for tests. */
class FakeConnectOAuthServer {
	private registrationSequence = 0;

	private constructor(
		private readonly server: http.Server,
		private overrides: DiscoveryOverrides,
		private readonly host: string,
		private readonly basePath: string,
	) {}

	static async start(
		overrides: DiscoveryOverrides = {},
		host = "127.0.0.1",
		basePath = "",
	): Promise<FakeConnectOAuthServer> {
		const server = http.createServer();
		const fixture = new FakeConnectOAuthServer(server, overrides, host, basePath);
		server.on("request", (request, response) => void fixture.handle(request, response));
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(0, host, () => {
				server.off("error", reject);
				resolve();
			});
		});
		return fixture;
	}

	get baseUrl(): string {
		const address = this.server.address();
		if (!address || typeof address === "string")
			throw new Error("Fake Connect OAuth server is not listening");
		// Bracket the host if it's an IPv6 literal (contains a colon).
		const host = this.host.includes(":") ? `[${this.host}]` : this.host;
		return `http://${host}:${address.port}${this.basePath}`;
	}

	get registrationCount(): number {
		return this.registrationSequence;
	}

	async stop(): Promise<void> {
		this.server.closeAllConnections?.();
		await new Promise<void>((resolve) => this.server.close(() => resolve()));
	}

	private async handle(
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void> {
		const url = new URL(request.url ?? "/", this.baseUrl);
		if (url.pathname === `/.well-known/oauth-authorization-server${this.basePath}`) {
			this.json(response, 200, {
				issuer: this.overrides.issuer ?? this.baseUrl,
				device_authorization_endpoint:
					this.overrides.deviceAuthorizationEndpoint ?? `${this.baseUrl}/oauth/device/authorize`,
				token_endpoint: `${this.baseUrl}/oauth/token`,
				registration_endpoint: `${this.baseUrl}/oauth/v1/register`,
			});
			return;
		}
		if (url.pathname === `${this.basePath}/oauth/v1/register` && request.method === "POST") {
			await this.register(request, response);
			return;
		}
		this.json(response, 404, { error: "not_found" });
	}

	private async register(
		request: http.IncomingMessage,
		response: http.ServerResponse,
	): Promise<void> {
		const body = JSON.parse(await readBody(request)) as {
			client_name?: string;
			redirect_uris?: string[];
		};
		if (!body.client_name || !body.redirect_uris?.length) {
			this.json(response, 400, { error: "invalid_client_metadata" });
			return;
		}
		this.json(response, 200, { client_id: `mcp_${++this.registrationSequence}` });
	}

	private json(response: http.ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { "Content-Type": "application/json" });
		response.end(JSON.stringify(body));
	}
}

async function readBody(request: http.IncomingMessage): Promise<string> {
	let body = "";
	for await (const chunk of request) body += chunk.toString();
	return body;
}

describe("createConnectDeviceCodeGrantResolver", () => {
	let fixture: FakeConnectOAuthServer | undefined;
	let createConnectDeviceCodeGrant: ReturnType<typeof createConnectDeviceCodeGrantResolver>;

	beforeEach(() => {
		createConnectDeviceCodeGrant = createConnectDeviceCodeGrantResolver();
	});

	afterEach(async () => {
		vi.useRealTimers();
		vi.unstubAllGlobals();
		await fixture?.stop();
		fixture = undefined;
	});

	it("discovers endpoints and registers a client on the happy path", async () => {
		fixture = await FakeConnectOAuthServer.start();

		const grant = await createConnectDeviceCodeGrant(`${fixture.baseUrl}/`);
		expect(grant).toEqual({
			grantType: "device-code",
			clientId: expect.stringMatching(/^mcp_/),
			scope: "",
			deviceAuthorizationEndpoint: `${fixture.baseUrl}/oauth/device/authorize`,
			tokenEndpoint: `${fixture.baseUrl}/oauth/token`,
			credentialBaseUrl: normalizeConnectBaseUrl(fixture.baseUrl),
		});
	});

	it("inserts the well-known segment before an issuer path", async () => {
		fixture = await FakeConnectOAuthServer.start({}, "127.0.0.1", "/connect");

		await expect(createConnectDeviceCodeGrant(fixture.baseUrl)).resolves.toMatchObject({
			deviceAuthorizationEndpoint: `${fixture.baseUrl}/oauth/device/authorize`,
		});
	});

	it("memoizes a resolved grant for the same Connect server", async () => {
		fixture = await FakeConnectOAuthServer.start();

		const first = await createConnectDeviceCodeGrant(fixture.baseUrl);
		const second = await createConnectDeviceCodeGrant(`${fixture.baseUrl}/`);

		expect(second).toBe(first);
		expect(fixture.registrationCount).toBe(1);
	});

	it("registers again after a forgotten grant", async () => {
		fixture = await FakeConnectOAuthServer.start();

		const first = await createConnectDeviceCodeGrant(fixture.baseUrl);
		createConnectDeviceCodeGrant.forget(`${fixture.baseUrl}/`);
		const second = await createConnectDeviceCodeGrant(fixture.baseUrl);

		expect(second).not.toBe(first);
		expect(fixture.registrationCount).toBe(2);
	});

	it("bounds setup, aborts the request, and allows a later retry", async () => {
		vi.useFakeTimers();
		let setupSignal: AbortSignal | undefined;
		const fetchMock = vi.fn((_input: string | URL | Request, init?: RequestInit) => {
			setupSignal = init?.signal ?? undefined;
			return new Promise<Response>(() => {});
		});
		vi.stubGlobal("fetch", fetchMock);

		const first = createConnectDeviceCodeGrant("https://connect.example.com");
		const rejected = expect(first).rejects.toThrow(/timed out/i);
		await vi.advanceTimersByTimeAsync(30_000);
		await rejected;
		expect(setupSignal?.aborted).toBe(true);

		fetchMock
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify({
						issuer: "https://connect.example.com",
						device_authorization_endpoint: "https://connect.example.com/oauth/device",
						token_endpoint: "https://connect.example.com/oauth/token",
						registration_endpoint: "https://connect.example.com/oauth/register",
					}),
					{ status: 200, headers: { "content-type": "application/json" } },
				),
			)
			.mockResolvedValueOnce(
				new Response(JSON.stringify({ client_id: "client-after-retry" }), {
					status: 200,
					headers: { "content-type": "application/json" },
				}),
			);

		await expect(
			createConnectDeviceCodeGrant("https://connect.example.com"),
		).resolves.toMatchObject({ clientId: "client-after-retry" });
	});

	it("rejects a discovery document whose issuer does not match the requested server", async () => {
		fixture = await FakeConnectOAuthServer.start({ issuer: "http://127.0.0.1:1/" });

		await expect(createConnectDeviceCodeGrant(fixture.baseUrl)).rejects.toThrow(/issuer/i);
	});

	it("rejects a device_authorization_endpoint on a different origin", async () => {
		fixture = await FakeConnectOAuthServer.start({
			deviceAuthorizationEndpoint: "http://evil.example.com/oauth/device/authorize",
		});

		await expect(createConnectDeviceCodeGrant(fixture.baseUrl)).rejects.toThrow(/cross-origin/i);
	});

	it("rejects http:// on a non-loopback host", async () => {
		await expect(createConnectDeviceCodeGrant("http://example.com:1234")).rejects.toThrow(/https/i);
	});

	it("accepts the bracketed IPv6 loopback host http://[::1]", async (context) => {
		try {
			fixture = await FakeConnectOAuthServer.start({}, "::1");
		} catch (error) {
			// Some CI/sandbox environments have no IPv6 loopback available.
			context.skip(true, `IPv6 loopback unavailable: ${(error as Error).message}`);
			return;
		}

		await expect(createConnectDeviceCodeGrant(fixture.baseUrl)).resolves.toMatchObject({
			deviceAuthorizationEndpoint: `${fixture.baseUrl}/oauth/device/authorize`,
		});
	});
});
