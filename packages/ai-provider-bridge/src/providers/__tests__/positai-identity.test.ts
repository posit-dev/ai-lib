/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { Logger, PositAiAuthMetadata, ProviderCredentials } from "../../types";
import { registerPositAiProvider } from "../positai-provider";
import { ProviderRegistry } from "../ProviderRegistry";

const API = "https://api.posit.cloud";
const STAGING = "https://login.staging.posit.cloud";
const PRODUCTION = "https://login.posit.cloud";

const PENDING_BODY = JSON.stringify({ error: { error_type: "prism_account_not_found" } });

interface SigningKey {
	readonly kid: string;
	readonly privateKey: CryptoKey;
	readonly publicJwk: JsonWebKey & { kid: string };
}

type Handler = (init: RequestInit | undefined) => Response | Promise<Response>;

interface Deferred<T> {
	readonly promise: Promise<T>;
	resolve(value: T): void;
}

function deferred<T>(): Deferred<T> {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((r) => {
		resolve = r;
	});
	return { promise, resolve };
}

function createMockLogger(): Logger {
	return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() };
}

async function createSigningKey(kid: string): Promise<SigningKey> {
	const pair = await crypto.subtle.generateKey(
		{
			name: "RSASSA-PKCS1-v1_5",
			modulusLength: 2048,
			publicExponent: new Uint8Array([1, 0, 1]),
			hash: "SHA-256",
		},
		true,
		["sign", "verify"],
	);
	const jwk = await crypto.subtle.exportKey("jwk", pair.publicKey);
	return { kid, privateKey: pair.privateKey, publicJwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
}

function base64Url(value: string | ArrayBuffer): string {
	const buffer = typeof value === "string" ? Buffer.from(value) : Buffer.from(value);
	return buffer.toString("base64url");
}

/** A Lucid-shaped access token for user `userId`, signed by `key`. */
async function signToken(key: SigningKey, userId: number, jti = "1"): Promise<string> {
	const header = base64Url(JSON.stringify({ alg: "RS256", kid: key.kid, typ: "at+JWT" }));
	const payload = base64Url(
		JSON.stringify({ iss: "lucid:services:lucid-auth", sub: `lucid:users:${userId}`, jti }),
	);
	const signature = await crypto.subtle.sign(
		"RSASSA-PKCS1-v1_5",
		key.privateKey,
		new TextEncoder().encode(`${header}.${payload}`),
	);
	return `${header}.${payload}.${base64Url(signature)}`;
}

function json(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), { status });
}

function modelsOk(ids: string[]): Response {
	return json({
		chat: ids.map((id) => ({
			id,
			display_name: id,
			endpoints: [{ path: "/anthropic/v1", protocol: "anthropic-messages" }],
		})),
	});
}

/**
 * Routes fetches by URL. Unrouted URLs fail the test. Default /models answers
 * pending; override per test.
 */
function mockFetch(routes: Record<string, Handler>) {
	const table: Record<string, Handler> = {
		[`${API}/models`]: () => new Response(PENDING_BODY, { status: 403 }),
		...routes,
	};
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			const handler = table[url];
			if (!handler) throw new Error(`unexpected fetch: ${url}`);
			return handler(init);
		});
}

function jwksRoute(...keys: SigningKey[]): Handler {
	return () => json({ keys: keys.map((key) => key.publicJwk) });
}

function meRoute(id: number, email: string): Handler {
	return () => json({ id, email, display_name: "Someone", picture: "https://example.com/p.png" });
}

function setup(getAuthHostCandidates?: () => readonly string[]) {
	const logger = createMockLogger();
	const registry = new ProviderRegistry(logger);
	registerPositAiProvider(registry, API, "test/1.0", logger, getAuthHostCandidates);
	return {
		registry,
		list: (accessToken: string | undefined) =>
			registry.getModelsForProvider("positai", {
				type: "oauth",
				accessToken,
			} as ProviderCredentials),
		state: () => registry.getModelFetchState<PositAiAuthMetadata>("positai"),
	};
}

function callsTo(spy: ReturnType<typeof mockFetch>, url: string) {
	return spy.mock.calls.filter(([input]) => String(input) === url);
}

function bearerOf(init: RequestInit | undefined): string | undefined {
	const headers = init?.headers;
	if (!headers || Array.isArray(headers) || headers instanceof Headers) return undefined;
	return headers.Authorization;
}

let stagingKey: SigningKey;
let productionKey: SigningKey;
let rotatedStagingKey: SigningKey;

beforeAll(async () => {
	// Staging and production really do share a `kid` with different keys.
	stagingKey = await createSigningKey("prism-key-1");
	productionKey = await createSigningKey("prism-key-1");
	rotatedStagingKey = await createSigningKey("prism-key-2");
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe("Posit AI Pass listing identity", () => {
	it("never serves one token's cached models to another token (account switch or refresh)", async () => {
		const fetchSpy = mockFetch({ [`${API}/models`]: () => modelsOk(["claude-sonnet-4-6"]) });
		const { list } = setup();

		await list("token-a");
		await list("token-a");
		await list("token-b");

		const models = callsTo(fetchSpy, `${API}/models`);
		expect(models.map(([, init]) => bearerOf(init))).toEqual(["Bearer token-a", "Bearer token-b"]);
	});

	it("a missing token clears the cached models, not just the fetch state", async () => {
		const fetchSpy = mockFetch({ [`${API}/models`]: () => modelsOk(["claude-sonnet-4-6"]) });
		const { list, state } = setup();

		await list("token-a");
		expect(await list(undefined)).toEqual([]);
		expect(state()).toBeUndefined();
		await list("token-a");

		expect(callsTo(fetchSpy, `${API}/models`)).toHaveLength(2);
	});

	it("drops a models response that settles after a newer token's", async () => {
		const responseA = deferred<Response>();
		const responseB = deferred<Response>();
		mockFetch({
			[`${API}/models`]: (init) =>
				bearerOf(init) === "Bearer token-a" ? responseA.promise : responseB.promise,
		});
		const { list, state } = setup();

		const listingA = list("token-a");
		const listingB = list("token-b");
		responseB.resolve(modelsOk(["model-b"]));
		expect((await listingB).map((m) => m.id)).toEqual(["model-b"]);
		responseA.resolve(modelsOk(["model-a"]));
		expect(await listingA).toEqual([]);

		expect(state()).toEqual({ modelFetchState: "ok" });
		expect((await list("token-b")).map((m) => m.id)).toEqual(["model-b"]);
	});
});

describe("Posit AI Pass account email", () => {
	it.each(["login.staging.posit.cloud", STAGING, `${STAGING}/`])(
		"publishes the email with pending state when the token verifies (candidate %s)",
		async (candidate) => {
			const token = await signToken(stagingKey, 42);
			const fetchSpy = mockFetch({
				[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
				[`${STAGING}/api/users/me`]: meRoute(42, "b@example.com"),
			});
			const { list, state } = setup(() => [candidate]);

			expect(await list(token)).toEqual([]);

			expect(state()).toEqual({
				modelFetchState: "agreement_pending",
				modelFetchStatusCode: 403,
				accountEmail: "b@example.com",
			});
			const [[, init]] = callsTo(fetchSpy, `${STAGING}/api/users/me`);
			expect(bearerOf(init)).toBe(`Bearer ${token}`);
			expect(init?.redirect).toBe("error");
			expect(callsTo(fetchSpy, `${STAGING}/.well-known/jwks.json`)[0][1]?.redirect).toBe("error");
		},
	);

	it.each([
		["no getter", undefined],
		["no candidates", () => []],
		["an http host", () => ["http://login.staging.posit.cloud"]],
		["userinfo", () => ["https://user@login.staging.posit.cloud"]],
		["a path", () => [`${STAGING}/oauth`]],
		["an unparsable host", () => ["not a host"]],
	])("makes no identity request with %s", async (_name, getter) => {
		const token = await signToken(stagingKey, 42);
		const fetchSpy = mockFetch({});
		const { list, state } = setup(getter);

		await list(token);

		expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });
		expect(fetchSpy.mock.calls.map(([input]) => String(input))).toEqual([`${API}/models`]);
	});

	it("looks up only at the first candidate whose keys verify the token", async () => {
		const token = await signToken(productionKey, 42);
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${PRODUCTION}/.well-known/jwks.json`]: jwksRoute(productionKey),
			[`${PRODUCTION}/api/users/me`]: meRoute(42, "b@example.com"),
		});
		const { list, state } = setup(() => [STAGING, PRODUCTION]);

		await list(token);

		expect(state()?.accountEmail).toBe("b@example.com");
		expect(callsTo(fetchSpy, `${STAGING}/api/users/me`)).toHaveLength(0);
	});

	it("sends the token to no new host after a host switch", async () => {
		const token = await signToken(stagingKey, 42);
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${STAGING}/api/users/me`]: meRoute(42, "b@example.com"),
			[`${PRODUCTION}/.well-known/jwks.json`]: jwksRoute(productionKey),
		});
		let candidates = [STAGING];
		const { registry, list, state } = setup(() => candidates);
		await list(token);
		expect(state()?.accountEmail).toBe("b@example.com");

		candidates = [PRODUCTION];
		registry.clearModelCache("positai");
		await list(token);

		expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });
		expect(callsTo(fetchSpy, `${PRODUCTION}/.well-known/jwks.json`)).toHaveLength(1);
		const identityCalls = fetchSpy.mock.calls.filter(([input]) =>
			String(input).endsWith("/api/users/me"),
		);
		expect(identityCalls.map(([input]) => String(input))).toEqual([`${STAGING}/api/users/me`]);
	});

	it("refetches the JWKS once for an unknown kid, then fails closed", async () => {
		let published = [stagingKey];
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: () => json({ keys: published.map((k) => k.publicJwk) }),
			[`${STAGING}/api/users/me`]: meRoute(42, "b@example.com"),
		});
		const { list, state } = setup(() => [STAGING]);
		const jwksCalls = () => callsTo(fetchSpy, `${STAGING}/.well-known/jwks.json`).length;

		await list(await signToken(stagingKey, 42));
		expect(state()?.accountEmail).toBe("b@example.com");
		expect(jwksCalls()).toBe(1);

		published = [stagingKey, rotatedStagingKey];
		await list(await signToken(rotatedStagingKey, 42));
		expect(state()?.accountEmail).toBe("b@example.com");
		expect(jwksCalls()).toBe(2);

		const unknownKey = await createSigningKey("prism-key-9");
		await list(await signToken(unknownKey, 42));
		expect(state()?.accountEmail).toBeUndefined();
		expect(jwksCalls()).toBe(3);
		expect(callsTo(fetchSpy, `${STAGING}/api/users/me`)).toHaveLength(2);
	});

	it.each([
		["another host's key", async () => signToken(productionKey, 42)],
		["a non-JWT token", async () => "opaque-token"],
		[
			"a non-RS256 JWT",
			async () => {
				const signed = await signToken(stagingKey, 42);
				const [, payload, signature] = signed.split(".");
				return `${base64Url(JSON.stringify({ alg: "HS256", kid: "prism-key-1" }))}.${payload}.${signature}`;
			},
		],
	])("sends no identity request for a token signed by %s", async (_name, makeToken) => {
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
		});
		const { list, state } = setup(() => [STAGING]);

		await list(await makeToken());

		expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });
		expect(callsTo(fetchSpy, `${STAGING}/api/users/me`)).toHaveLength(0);
	});

	it("fails closed when the JWKS fetch fails", async () => {
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: () => new Response("oops", { status: 500 }),
		});
		const { list, state } = setup(() => [STAGING]);

		await list(await signToken(stagingKey, 42));

		expect(state()?.accountEmail).toBeUndefined();
		expect(callsTo(fetchSpy, `${STAGING}/api/users/me`)).toHaveLength(0);
	});

	it.each<[string, Handler]>([
		["a non-200", () => new Response("nope", { status: 500 })],
		["a rejected fetch", () => Promise.reject(new TypeError("fetch failed"))],
		[
			"a redirect to /login",
			(init) => {
				// What fetch does with `redirect: "error"`; following would be a 302.
				if (init?.redirect === "error") throw new TypeError("fetch failed: unexpected redirect");
				return new Response(null, { status: 302, headers: { Location: "/login" } });
			},
		],
	])(
		"publishes pending without email after %s, and retries on the next read",
		async (_name, fail) => {
			let me: Handler = fail;
			mockFetch({
				[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
				[`${STAGING}/api/users/me`]: (init) => me(init),
			});
			const { registry, list, state } = setup(() => [STAGING]);
			const token = await signToken(stagingKey, 42);

			await list(token);
			expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });

			me = meRoute(42, "b@example.com");
			registry.clearModelCache("positai");
			await list(token);
			expect(state()?.accountEmail).toBe("b@example.com");
		},
	);

	it("times out a lookup that never settles and publishes pending without email", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const reached = deferred<AbortSignal | undefined>();
		mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${STAGING}/api/users/me`]: (init) => {
				reached.resolve(init?.signal ?? undefined);
				return new Promise<Response>(() => {});
			},
		});
		const { list, state } = setup(() => [STAGING]);

		const listing = list(await signToken(stagingKey, 42));
		const signal = await reached.promise;
		await vi.advanceTimersByTimeAsync(5_000);
		await listing;

		expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });
		expect(signal?.aborted).toBe(true);
	});

	it("reuses an in-flight lookup across clearCache() and still publishes the email", async () => {
		const reached = deferred<void>();
		const meResponse = deferred<Response>();
		const fetchSpy = mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${STAGING}/api/users/me`]: () => {
				reached.resolve();
				return meResponse.promise;
			},
		});
		const { registry, list, state } = setup(() => [STAGING]);
		const token = await signToken(stagingKey, 42);

		const first = list(token);
		await reached.promise;
		registry.clearModelCache("positai");
		const second = list(token);
		meResponse.resolve(json({ id: 42, email: "b@example.com" }));

		expect(await first).toEqual([]);
		await second;
		expect(state()?.accountEmail).toBe("b@example.com");
		expect(callsTo(fetchSpy, `${STAGING}/api/users/me`)).toHaveLength(1);
	});

	it("looks up each token's own email", async () => {
		mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${STAGING}/api/users/me`]: (init) =>
				bearerOf(init)?.endsWith(tokenA)
					? json({ id: 1, email: "a@example.com" })
					: json({ id: 2, email: "b@example.com" }),
		});
		const { list, state } = setup(() => [STAGING]);
		const tokenA = await signToken(stagingKey, 1);
		const tokenB = await signToken(stagingKey, 2);

		await list(tokenA);
		expect(state()?.accountEmail).toBe("a@example.com");
		await list(tokenB);
		expect(state()?.accountEmail).toBe("b@example.com");
	});

	it.each([
		["an id that doesn't match sub", { id: 7, email: "b@example.com" }],
		["no email", { id: 42 }],
		["a non-string email", { id: 42, email: 5 }],
	])("publishes no email for a body with %s", async (_name, body) => {
		mockFetch({
			[`${STAGING}/.well-known/jwks.json`]: jwksRoute(stagingKey),
			[`${STAGING}/api/users/me`]: () => json(body),
		});
		const { list, state } = setup(() => [STAGING]);

		await list(await signToken(stagingKey, 42));

		expect(state()).toEqual({ modelFetchState: "agreement_pending", modelFetchStatusCode: 403 });
	});
});
