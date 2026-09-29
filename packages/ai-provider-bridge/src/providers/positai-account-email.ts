/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Looks up the email of the account a Posit AI Pass access token belongs to,
 * so the host can send it to posit.ai `/setup?email=` for the wrong-account
 * check.
 *
 * The lookup sends the bearer token to a login host's `/api/users/me`. That is
 * a new destination for the token, and stored tokens outlive auth-host edits,
 * so the token is only sent to a candidate host that publishes the key that
 * signed it: the token's RS256 signature must verify against that host's
 * public JWKS. This guards against misrouting, such as sending a staging token
 * to production after the host is switched. It does not prove the host is the
 * issuer: public keys can be republished by anyone. Candidates must therefore
 * come from trusted configuration, which already controls where PA signs in
 * and refreshes tokens. The token's `iss` claim names no host, so it can't be
 * used instead. Every failure (no candidates, bad host, bad signature, JWKS or
 * lookup failure, timeout) resolves to `undefined`; the lookup never rejects.
 *
 * Never log the token, the email, the `/api/users/me` body, or the text of an
 * error raised while fetching or parsing it (JSON parse errors quote the input).
 */

import type { Logger } from "../types";

const LOG_PREFIX = "[positai]";

/** Bound on one whole lookup (JWKS fetches plus `/api/users/me`). */
const LOOKUP_TIMEOUT_MS = 5_000;

export interface PositAiAccountEmailLookup {
	/** The token's account email, or `undefined` when it can't be established. Never rejects. */
	lookup(accessToken: string): Promise<string | undefined>;
	/** Drop the memoized lookup (for example on sign-out). */
	forget(): void;
}

interface MemoEntry {
	/** The (token, candidate hosts) the lookup ran for. */
	readonly key: string;
	readonly promise: Promise<string | undefined>;
}

interface ParsedJwt {
	readonly kid: string;
	readonly subject: string;
	readonly signingInput: Uint8Array<ArrayBuffer>;
	readonly signature: Uint8Array<ArrayBuffer>;
}

interface RsaSigningKey {
	readonly kid: string;
	readonly n: string;
	readonly e: string;
	readonly alg?: string;
	readonly use?: string;
}

/**
 * @param getAuthHostCandidates Login hosts that may have issued the token, in
 *   preference order (bare hosts or `https://` URLs). Absent or empty disables
 *   the lookup.
 */
export function createPositAiAccountEmailLookup(
	getAuthHostCandidates: (() => readonly string[]) | undefined,
	logger: Logger,
): PositAiAccountEmailLookup {
	// One slot: only the current token's lookup is worth keeping. A token's
	// email never changes, so a success is reused until the token or hosts
	// change; failures are dropped so the next read retries.
	let memo: MemoEntry | undefined;
	// Public keys per origin. Survives everything; an unknown `kid` refetches.
	const jwksCache = new Map<string, readonly RsaSigningKey[]>();

	const currentOrigins = (): string[] => {
		const origins: string[] = [];
		for (const candidate of getAuthHostCandidates?.() ?? []) {
			const origin = normalizeAuthOrigin(candidate);
			if (origin === undefined) {
				logger.debug(
					`${LOG_PREFIX} Ignoring auth host candidate that isn't a bare host or https origin`,
				);
			} else if (!origins.includes(origin)) {
				origins.push(origin);
			}
		}
		return origins;
	};

	const verifiesAgainst = async (
		jwt: ParsedJwt,
		origin: string,
		signal: AbortSignal,
	): Promise<boolean> => {
		let key = findSigningKey(jwksCache.get(origin), jwt.kid);
		if (!key) {
			// No cached set, or an unknown `kid` (key rotation): fetch once.
			const keys = await fetchJwks(origin, signal, logger);
			if (!keys) return false;
			jwksCache.set(origin, keys);
			key = findSigningKey(keys, jwt.kid);
			if (!key) return false;
		}
		return verifyRs256(key, jwt);
	};

	const resolveEmail = async (
		token: string,
		origins: readonly string[],
		signal: AbortSignal,
	): Promise<string | undefined> => {
		const jwt = parseRs256Jwt(token);
		if (!jwt) {
			logger.debug(`${LOG_PREFIX} Account email lookup skipped: token isn't an RS256 JWT`);
			return undefined;
		}
		let issuer: string | undefined;
		for (const origin of origins) {
			if (await verifiesAgainst(jwt, origin, signal)) {
				issuer = origin;
				break;
			}
		}
		if (!issuer) {
			logger.debug(
				`${LOG_PREFIX} Account email lookup skipped: no auth host's keys verify the token`,
			);
			return undefined;
		}
		const response = await fetch(`${issuer}/api/users/me`, {
			headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
			// A redirect (to /login) means "not authenticated"; following it
			// could carry the token elsewhere.
			redirect: "error",
			signal,
		});
		if (response.status !== 200) {
			logger.debug(`${LOG_PREFIX} Account email lookup returned ${response.status}`);
			return undefined;
		}
		const body: unknown = await response.json();
		const email = pickEmail(body, jwt.subject);
		if (email === undefined) {
			logger.debug(`${LOG_PREFIX} Account email lookup response had no usable email`);
		}
		return email;
	};

	const runLookup = async (
		token: string,
		origins: readonly string[],
	): Promise<string | undefined> => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Race as well as abort, so even a fetch that ignores the signal is bounded.
		const timeout = new Promise<undefined>((resolve) => {
			timer = setTimeout(() => {
				logger.debug(`${LOG_PREFIX} Account email lookup timed out`);
				controller.abort();
				resolve(undefined);
			}, LOOKUP_TIMEOUT_MS);
		});
		try {
			return await Promise.race([resolveEmail(token, origins, controller.signal), timeout]);
		} catch (error) {
			logger.debug(`${LOG_PREFIX} Account email lookup failed: ${lookupFailureCategory(error)}`);
			return undefined;
		} finally {
			clearTimeout(timer);
		}
	};

	return {
		async lookup(accessToken: string): Promise<string | undefined> {
			const origins = currentOrigins();
			if (origins.length === 0) return undefined;
			const key = memoKey(accessToken, origins);
			let entry = memo;
			if (entry?.key !== key) {
				const created: MemoEntry = {
					key,
					promise: runLookup(accessToken, origins).then((email) => {
						if (email === undefined && memo === created) memo = undefined;
						return email;
					}),
				};
				memo = created;
				entry = created;
			}
			const email = await entry.promise;
			// Discard a result whose (token, hosts) stopped being current while
			// it ran: forgotten, replaced by another token, or hosts changed.
			if (memo !== entry || memoKey(accessToken, currentOrigins()) !== entry.key) {
				return undefined;
			}
			return email;
		},
		forget(): void {
			memo = undefined;
		},
	};
}

function memoKey(token: string, origins: readonly string[]): string {
	return JSON.stringify([token, origins]);
}

/**
 * `login.posit.cloud` or `https://login.posit.cloud[/]` -> `https://login.posit.cloud`.
 * Anything else (another scheme, userinfo, a path, query, or fragment,
 * unparsable input) -> `undefined`. HTTPS only, with no loopback exception.
 */
function normalizeAuthOrigin(raw: string): string | undefined {
	const value = raw.trim();
	if (value === "" || /[?#\\\s]/.test(value)) return undefined;
	const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value);
	let url: URL;
	try {
		url = new URL(hasScheme ? value : `https://${value}`);
	} catch {
		return undefined;
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== "" ||
		url.hostname === ""
	) {
		return undefined;
	}
	return url.origin;
}

function parseRs256Jwt(token: string): ParsedJwt | undefined {
	const parts = token.split(".");
	if (parts.length !== 3) return undefined;
	const [headerSegment, payloadSegment, signatureSegment] = parts;
	const header = decodeJsonSegment(headerSegment);
	const payload = decodeJsonSegment(payloadSegment);
	const signature = decodeBase64Url(signatureSegment);
	if (!isRecord(header) || header.alg !== "RS256" || typeof header.kid !== "string") {
		return undefined;
	}
	if (!isRecord(payload) || typeof payload.sub !== "string" || payload.sub === "") {
		return undefined;
	}
	if (!signature || signature.length === 0) return undefined;
	return {
		kid: header.kid,
		subject: payload.sub,
		signingInput: new TextEncoder().encode(`${headerSegment}.${payloadSegment}`),
		signature,
	};
}

function decodeJsonSegment(segment: string): unknown {
	const bytes = decodeBase64Url(segment);
	if (!bytes) return undefined;
	try {
		return JSON.parse(new TextDecoder().decode(bytes));
	} catch {
		return undefined;
	}
}

function decodeBase64Url(segment: string): Uint8Array<ArrayBuffer> | undefined {
	if (!/^[A-Za-z0-9_-]*$/.test(segment)) return undefined;
	const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
	try {
		const binary = atob(base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), "="));
		const bytes = new Uint8Array(binary.length);
		for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
		return bytes;
	} catch {
		return undefined;
	}
}

async function fetchJwks(
	origin: string,
	signal: AbortSignal,
	logger: Logger,
): Promise<RsaSigningKey[] | undefined> {
	try {
		// Public keys: no token is sent. Redirects are refused all the same, so
		// the keys come from exactly this origin.
		const response = await fetch(`${origin}/.well-known/jwks.json`, {
			headers: { Accept: "application/json" },
			redirect: "error",
			signal,
		});
		if (!response.ok) {
			logger.debug(`${LOG_PREFIX} JWKS fetch from ${origin} returned ${response.status}`);
			return undefined;
		}
		const body: unknown = await response.json();
		if (!isRecord(body) || !Array.isArray(body.keys)) {
			logger.debug(`${LOG_PREFIX} JWKS from ${origin} has no keys array`);
			return undefined;
		}
		return body.keys.flatMap((key: unknown): RsaSigningKey[] => {
			if (
				!isRecord(key) ||
				key.kty !== "RSA" ||
				typeof key.kid !== "string" ||
				typeof key.n !== "string" ||
				typeof key.e !== "string"
			) {
				return [];
			}
			return [
				{
					kid: key.kid,
					n: key.n,
					e: key.e,
					alg: typeof key.alg === "string" ? key.alg : undefined,
					use: typeof key.use === "string" ? key.use : undefined,
				},
			];
		});
	} catch (error) {
		logger.debug(`${LOG_PREFIX} JWKS fetch from ${origin} failed: ${describeError(error)}`);
		return undefined;
	}
}

function findSigningKey(
	keys: readonly RsaSigningKey[] | undefined,
	kid: string,
): RsaSigningKey | undefined {
	return keys?.find(
		(key) =>
			key.kid === kid &&
			(key.alg === undefined || key.alg === "RS256") &&
			(key.use === undefined || key.use === "sig"),
	);
}

async function verifyRs256(key: RsaSigningKey, jwt: ParsedJwt): Promise<boolean> {
	const algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
	try {
		const publicKey = await crypto.subtle.importKey(
			"jwk",
			{ kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true },
			algorithm,
			false,
			["verify"],
		);
		return await crypto.subtle.verify(algorithm, publicKey, jwt.signature, jwt.signingInput);
	} catch {
		return false;
	}
}

/**
 * Only `id` and `email` are read. `id` must match the verified token's `sub`
 * (`lucid:users:<id>`), so the email is known to belong to this token's user.
 */
function pickEmail(body: unknown, subject: string): string | undefined {
	if (!isRecord(body)) return undefined;
	const { id, email } = body;
	if (typeof email !== "string" || email === "") return undefined;
	if (typeof id !== "number" && typeof id !== "string") return undefined;
	const subjectId = subject.slice(subject.lastIndexOf(":") + 1);
	if (subjectId === "" || String(id) !== subjectId) return undefined;
	return email;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * A fixed description of a failed identity lookup. The error's own text can
 * quote the profile body or request details, so it is never logged.
 */
function lookupFailureCategory(error: unknown): string {
	if (error instanceof SyntaxError) return "response wasn't JSON";
	if (error instanceof Error && error.name === "AbortError") return "aborted";
	return "request failed";
}
