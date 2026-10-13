/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Portkey connection vocabulary and validation — the one owner of the rules
 * that combine the base URL, the key type, and key presence.
 *
 * The key type says what the stored API key *is*:
 *
 * - `"portkey"` — a Portkey API key (hosted Portkey, a proxy in front of
 *   hosted Portkey, or a Portkey hybrid gateway).
 * - `"upstream"` — the upstream provider's key, for a self-hosted open-source
 *   gateway that forwards it.
 *
 * When the key type is absent it is inferred from the URL, exactly as before
 * the field existed: the canonical hosted origin means a Portkey key, any
 * other URL an upstream key.
 *
 * These rules are deliberately NOT in the strict schema: a bad combination
 * must never make providers.json invalid (which would block every save).
 * The bridge resolver runs {@link checkPortkeyConnection} on the effective
 * merged values; forms and mutators run it before writing so users see the
 * problem at save time.
 */

import { PORTKEY_HOST, PORTKEY_HOSTED_BASE_URL } from "./base-url.js";

/** What the stored Portkey API key is. */
export const PORTKEY_KEY_TYPES = ["portkey", "upstream"] as const;
export type PortkeyKeyType = (typeof PORTKEY_KEY_TYPES)[number];

const CANONICAL_PORTKEY_HOSTNAME = new URL(PORTKEY_HOST).hostname;

/** Narrow an arbitrary string to a {@link PortkeyKeyType}. */
export function isPortkeyKeyType(value: string): value is PortkeyKeyType {
	return (PORTKEY_KEY_TYPES as readonly string[]).includes(value);
}

/**
 * The key type a base URL implies when none is configured: `"portkey"` for
 * the exact canonical hosted origin (`https://api.portkey.ai`, default port),
 * `"upstream"` for anything else — including an unparseable URL, which
 * {@link checkPortkeyConnection} reports separately.
 *
 * Writers use this to omit a configured key type that matches what the URL
 * already implies, so older readers keep the block.
 */
export function inferredPortkeyKeyType(baseUrl: string): PortkeyKeyType {
	return isCanonicalPortkeyOrigin(baseUrl) ? "portkey" : "upstream";
}

/** The values {@link checkPortkeyConnection} validates. Never the secret itself. */
export interface PortkeyConnectionInput {
	/** The effective base URL, or `undefined` when no layer sets one. */
	readonly baseUrl: string | undefined;
	/** The effective configured key type, or `undefined` to infer it from the URL. */
	readonly keyType: PortkeyKeyType | undefined;
	/** Whether a non-empty API key is (or will be) available. */
	readonly apiKeyPresent: boolean;
}

/** Which input a failed check is about, so a form can attach the message. */
export type PortkeyConnectionField = "baseUrl" | "keyType" | "apiKey";

export type PortkeyConnectionCheck =
	| {
			readonly ok: true;
			/** The trimmed base URL. */
			readonly baseUrl: string;
			/** The configured key type, or the one the URL implies. */
			readonly keyType: PortkeyKeyType;
			/** Whether the URL is exactly the canonical hosted origin. */
			readonly canonical: boolean;
	  }
	| {
			readonly ok: false;
			readonly field: PortkeyConnectionField;
			readonly message: string;
	  };

/**
 * Validate an effective Portkey connection. Rules:
 *
 * - A base URL is required: it is where the key goes.
 * - The URL must parse and have a host.
 * - The canonical hostname is valid only as exactly the hosted HTTPS origin
 *   (`http://api.portkey.ai` or a non-default port has no safe meaning).
 * - `"upstream"` with the hosted origin is an error: hosted Portkey never
 *   takes an upstream key.
 * - A Portkey key (configured or inferred) must be present. An upstream key
 *   may be absent, for gateways or proxies that inject credentials.
 *
 * There is no HTTPS requirement for non-canonical URLs: self-hosted and
 * in-cluster gateways on `http://` are legitimate.
 */
export function checkPortkeyConnection(input: PortkeyConnectionInput): PortkeyConnectionCheck {
	const baseUrl = input.baseUrl?.trim();
	if (!baseUrl) {
		return {
			ok: false,
			field: "baseUrl",
			message:
				"The Portkey provider requires a base URL: it is where requests and the API key are " +
				`sent. Set the PORTKEY_BASE_URL environment variable (hosted: ${PORTKEY_HOSTED_BASE_URL}) ` +
				"or enter a base URL in the Portkey configure form.",
		};
	}
	const url = parseUrl(baseUrl);
	if (!url) {
		return {
			ok: false,
			field: "baseUrl",
			message: `Invalid Portkey base URL "${baseUrl}": not a valid URL`,
		};
	}
	if (url.origin === "null") {
		return {
			ok: false,
			field: "baseUrl",
			message: `Invalid Portkey base URL "${baseUrl}": no host`,
		};
	}
	const canonical = url.origin === PORTKEY_HOST;
	if (!canonical && url.hostname === CANONICAL_PORTKEY_HOSTNAME) {
		return {
			ok: false,
			field: "baseUrl",
			message:
				`Invalid Portkey base URL "${baseUrl}": the hosted Portkey host is only valid as ` +
				`exactly ${PORTKEY_HOSTED_BASE_URL} (HTTPS, default port). For a self-hosted gateway ` +
				"or a proxy, use its own URL.",
		};
	}

	const keyType = input.keyType ?? (canonical ? "portkey" : "upstream");
	if (canonical && keyType === "upstream") {
		return {
			ok: false,
			field: "keyType",
			message:
				"Hosted Portkey only accepts Portkey API keys. Choose the Portkey key type, or enter " +
				"the URL of the self-hosted gateway that takes your provider's key.",
		};
	}
	if (keyType === "portkey" && !input.apiKeyPresent) {
		return {
			ok: false,
			field: "apiKey",
			message: canonical
				? "Hosted Portkey requires a non-empty API key. Keyless connections are supported only " +
					"for self-hosted gateways or credential-injecting proxies."
				: "A Portkey API key is required when the key type is Portkey.",
		};
	}
	return { ok: true, baseUrl, keyType, canonical };
}

function isCanonicalPortkeyOrigin(baseUrl: string): boolean {
	return parseUrl(baseUrl.trim())?.origin === PORTKEY_HOST;
}

function parseUrl(value: string): URL | undefined {
	try {
		return new URL(value);
	} catch {
		return undefined;
	}
}
