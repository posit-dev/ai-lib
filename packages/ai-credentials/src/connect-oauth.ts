/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Posit Connect OAuth discovery and dynamic client registration.
 *
 * Before the Assistant can start a device flow against a Connect server it
 * needs that server's endpoint URLs and a `client_id`. Both come from Connect
 * without any admin configuration: RFC 8414 discovery at
 * `/.well-known/oauth-authorization-server` returns the endpoints, and
 * RFC 7591 registration at the advertised `registration_endpoint` is
 * unauthenticated and idempotent for a given (name, redirect URIs) pair.
 *
 * Hosts pair the grant with `AuthMethodDescriptor.deviceSignIn` so the store
 * backend binds the resulting token to the server that issued it.
 */

import type { OAuthGrantConfig } from "./Backend.js";

interface ConnectOAuthEndpoints {
	deviceAuthorizationEndpoint: string;
	tokenEndpoint: string;
	registrationEndpoint?: string;
}

/** The device-code grant a Connect server issues its API keys through. */
export type ConnectDeviceCodeGrant = Extract<OAuthGrantConfig, { grantType: "device-code" }>;

const CLIENT_NAME = "Posit Assistant";
const REDIRECT_URI = "http://127.0.0.1/oauth/callback";
const OAUTH_SETUP_TIMEOUT_MS = 30_000;

/**
 * Canonicalize the server root used for discovery, grant caching, credential
 * shaping, and gateway requests.
 */
export function normalizeConnectBaseUrl(raw: string): string {
	let url: URL;
	try {
		url = new URL(raw.trim());
	} catch {
		throw new Error(`Not a valid Posit Connect server URL: ${raw}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Posit Connect server URL must be http or https, got ${url.protocol}`);
	}
	assertAllowedOrigin(url);
	if (url.username || url.password) {
		throw new Error("Posit Connect server URL must not contain a username or password");
	}
	url.search = "";
	url.hash = "";
	return url.toString().replace(/\/+$/, "");
}

/** RFC 8414 discovery against a Connect server's base URL. */
async function discoverConnectOAuth(
	baseUrl: string,
	signal?: AbortSignal,
): Promise<ConnectOAuthEndpoints> {
	const base = new URL(normalizeConnectBaseUrl(baseUrl));

	const discoveryUrl = discoveryUrlFor(base);
	const response = await fetch(discoveryUrl, { signal });
	if (!response.ok) {
		throw new Error(
			`Connect OAuth discovery at ${discoveryUrl.href} failed with status ${response.status}`,
		);
	}
	const document: unknown = await response.json();

	if (!hasStringProperty(document, "issuer") || !sameUrl(document.issuer, base)) {
		throw new Error(
			`Connect OAuth discovery document issuer does not match the requested server (${baseUrl})`,
		);
	}
	if (!hasStringProperty(document, "device_authorization_endpoint")) {
		throw new Error("Connect OAuth discovery document is missing device_authorization_endpoint");
	}
	if (!hasStringProperty(document, "token_endpoint")) {
		throw new Error("Connect OAuth discovery document is missing token_endpoint");
	}

	const deviceAuthorizationEndpoint = validateEndpointOrigin(
		base,
		document.device_authorization_endpoint,
	);
	const tokenEndpoint = validateEndpointOrigin(base, document.token_endpoint);
	const registrationEndpoint = hasStringProperty(document, "registration_endpoint")
		? validateEndpointOrigin(base, document.registration_endpoint)
		: undefined;

	return {
		deviceAuthorizationEndpoint,
		tokenEndpoint,
		...(registrationEndpoint ? { registrationEndpoint } : {}),
	};
}

/**
 * RFC 7591 registration. Registration is idempotent for a given
 * (client_name, redirect_uris) pair, so this is safe to call on every sign-in
 * and needs no persisted client id.
 */
async function registerConnectClient(
	endpoints: ConnectOAuthEndpoints,
	clientName: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!endpoints.registrationEndpoint) {
		throw new Error("Connect OAuth discovery did not advertise a registration_endpoint");
	}
	const response = await fetch(endpoints.registrationEndpoint, {
		method: "POST",
		signal,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify({
			client_name: clientName,
			redirect_uris: [REDIRECT_URI],
		}),
	});
	if (!response.ok) {
		throw new Error(
			`Connect OAuth client registration at ${endpoints.registrationEndpoint} failed with status ${response.status}`,
		);
	}
	const document: unknown = await response.json();
	if (!hasStringProperty(document, "client_id")) {
		throw new Error("Connect OAuth registration response is missing client_id");
	}
	return document.client_id;
}

/** Resolves the device-code grant for a Connect server URL. */
export type ConnectDeviceCodeGrantResolver = (serverUrl: string) => Promise<ConnectDeviceCodeGrant>;

/**
 * Create a resolver for Connect device-code grants: discovery plus client
 * registration, memoized per normalized server URL for the resolver's
 * lifetime. A failed setup is evicted so a later sign-in retries it.
 *
 * The grant's `credentialBaseUrl` is the normalized server URL; hosts declare
 * the same value as `deviceSignIn.serverUrl` so stored tokens stay bound to it.
 */
export function createConnectDeviceCodeGrantResolver(): ConnectDeviceCodeGrantResolver {
	const grants = new Map<string, Promise<ConnectDeviceCodeGrant>>();
	return async (serverUrl) => {
		const baseUrl = normalizeConnectBaseUrl(serverUrl);
		const existing = grants.get(baseUrl);
		if (existing) return existing;
		const pending = withSetupDeadline(baseUrl, async (signal) => {
			const endpoints = await discoverConnectOAuth(baseUrl, signal);
			const clientId = await registerConnectClient(endpoints, CLIENT_NAME, signal);
			return {
				grantType: "device-code",
				clientId,
				scope: "",
				deviceAuthorizationEndpoint: endpoints.deviceAuthorizationEndpoint,
				tokenEndpoint: endpoints.tokenEndpoint,
				credentialBaseUrl: baseUrl,
			} satisfies ConnectDeviceCodeGrant;
		});
		grants.set(baseUrl, pending);
		void pending.catch(() => grants.delete(baseUrl));
		return pending;
	};
}

/** Bound pre-attempt network work so failed setup cannot wedge the resolver. */
async function withSetupDeadline<T>(
	baseUrl: string,
	operation: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(new Error(`Connect OAuth setup at ${baseUrl} timed out`));
		}, OAUTH_SETUP_TIMEOUT_MS);
	});
	try {
		return await Promise.race([operation(controller.signal), timeout]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

/**
 * Reject a non-https base URL unless the host is loopback, matching
 * Connect's own redirect-URI policy: a developer can point at
 * `http://localhost:3939` without opening plaintext OAuth over a network.
 */
function assertAllowedOrigin(url: URL): void {
	if (url.protocol === "https:" || isLoopbackHost(url.hostname)) return;
	throw new Error(
		`Connect OAuth requires https (or a loopback host), got ${url.protocol}//${url.hostname}`,
	);
}

function isLoopbackHost(hostname: string): boolean {
	// URL.hostname keeps the brackets on a bracketed IPv6 literal (e.g. the
	// hostname of `http://[::1]:3939` is `"[::1]"`), so strip them before
	// comparing.
	const normalized =
		hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
	return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

/** RFC 8414 §3: insert the well-known segment before an issuer path. */
function discoveryUrlFor(base: URL): URL {
	const path = stripTrailingSlash(base.pathname);
	const discovery = new URL(base.origin);
	discovery.pathname = `/.well-known/oauth-authorization-server${path === "/" ? "" : path}`;
	return discovery;
}

/** RFC 8414 §3.3: the discovery document's issuer must equal the URL that was asked. */
function sameUrl(candidate: string, expected: URL): boolean {
	let candidateUrl: URL;
	try {
		candidateUrl = new URL(candidate);
	} catch {
		return false;
	}
	return (
		candidateUrl.origin === expected.origin &&
		stripTrailingSlash(candidateUrl.pathname) === stripTrailingSlash(expected.pathname)
	);
}

function stripTrailingSlash(pathname: string): string {
	return pathname.replace(/\/+$/, "");
}

/**
 * A hostile or misconfigured Connect server could otherwise redirect the
 * device flow, and the resulting token, to a different origin.
 */
function validateEndpointOrigin(base: URL, raw: string): string {
	let endpoint: URL;
	try {
		endpoint = new URL(raw, base);
	} catch {
		throw new Error(`Connect OAuth discovery returned an invalid endpoint URL: ${raw}`);
	}
	if (endpoint.origin !== base.origin) {
		throw new Error(`Connect OAuth discovery returned a cross-origin endpoint: ${raw}`);
	}
	return endpoint.toString();
}

function hasStringProperty<Key extends string>(
	value: unknown,
	key: Key,
): value is Record<Key, string> {
	return (
		typeof value === "object" &&
		value !== null &&
		key in value &&
		typeof Reflect.get(value, key) === "string"
	);
}
