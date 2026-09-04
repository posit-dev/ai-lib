/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type {
	AcquisitionBackendHooks,
	OAuthGrantConfig,
	PreparedAuthorizationCodeReceiver,
	StoredOAuthTokens,
} from "./Backend.js";
import type { AuthenticationStartResult } from "./CredentialProvider.js";
import type { DeviceAuthInfo, Logger, ProviderCredentials, TokenData } from "./types/index.js";

interface TokenResponse {
	access_token?: unknown;
	refresh_token?: unknown;
	expires_in?: unknown;
	token_type?: unknown;
	scope?: unknown;
}

interface ActiveAttempt {
	attemptId: string;
	providerId: string;
	generation: string;
	controller: AbortController;
	receiver?: PreparedAuthorizationCodeReceiver;
	terminalPromise?: Promise<void>;
}

interface DeviceAuthenticationStart {
	result: AuthenticationStartResult;
	info: DeviceAuthInfo;
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_REFRESH_TIMEOUT_MS = 30_000;
const DEFAULT_REFRESH_COOLDOWN_MS = 60_000;

/**
 * Refresh-failure policy: only a definitive server rejection — one of these
 * RFC 6749 codes on a 400/401 — may delete the stored tokens. Every other
 * failure (network, timeout, 429, 5xx, unknown 4xx, malformed body, local
 * lock/IO) keeps them and retries later.
 */
const TERMINAL_REFRESH_CODES = new Set(["invalid_grant", "invalid_client"]);

/** Non-2xx response from an OAuth endpoint, with the parsed RFC 6749 code. */
class OAuthHttpError extends Error {
	constructor(
		readonly status: number,
		readonly code: string | undefined,
		message: string,
	) {
		super(message);
		this.name = "OAuthHttpError";
	}
}

export interface AcquisitionRefreshPolicy {
	/** Bound on a single refresh exchange so a hung fetch cannot hold the store lock. */
	refreshTimeoutMs?: number;
	/** In-memory per-provider backoff after a transient refresh failure. */
	refreshCooldownMs?: number;
}

/** Provider-neutral device/code/client-credentials acquisition state machine. */
export class AcquisitionEngine {
	private readonly activeByProvider = new Map<string, ActiveAttempt>();
	private readonly activeById = new Map<string, ActiveAttempt>();
	private readonly startingProviders = new Set<string>();
	private readonly refreshPromises = new Map<string, Promise<ProviderCredentials | null>>();
	private readonly refreshCooldowns = new Map<string, number>();
	private readonly clientCredentialTokens = new Map<string, StoredOAuthTokens>();
	private readonly refreshJitterMinutes = 4 + Math.random() * 2;
	private readonly startPromises = new Set<Promise<unknown>>();
	private readonly terminalPromises = new Set<Promise<void>>();
	private readonly refreshTimeoutMs: number;
	private readonly refreshCooldownMs: number;
	private disposed = false;
	private disposalPromise: Promise<void> | undefined;

	constructor(
		private readonly hooks: AcquisitionBackendHooks,
		private readonly logger?: Logger,
		refreshPolicy: AcquisitionRefreshPolicy = {},
	) {
		this.refreshTimeoutMs = refreshPolicy.refreshTimeoutMs ?? DEFAULT_REFRESH_TIMEOUT_MS;
		this.refreshCooldownMs = refreshPolicy.refreshCooldownMs ?? DEFAULT_REFRESH_COOLDOWN_MS;
	}

	async getCredentials(
		providerId: string,
	): Promise<{ handled: boolean; credentials: ProviderCredentials | null }> {
		const config = await this.hooks.configForProvider(providerId);
		if (!config) return { handled: false, credentials: null };

		if (config.grantType === "client-credentials") {
			return { handled: true, credentials: await this.getClientCredentials(providerId, config) };
		}

		const tokens = await this.hooks.readTokens(providerId);
		if (!tokens) return { handled: true, credentials: null };
		if (!this.isExpiring(tokens)) {
			return {
				handled: true,
				credentials: this.hooks.shapeToken(providerId, tokens.accessToken, config),
			};
		}

		return { handled: true, credentials: await this.refreshStored(providerId, config) };
	}

	startAuthentication(providerId: string): Promise<AuthenticationStartResult> {
		if (this.disposed) return Promise.reject(new Error("Credential provider is disposed"));
		if (this.activeByProvider.has(providerId) || this.startingProviders.has(providerId)) {
			return Promise.resolve({ status: "already-in-progress" });
		}
		this.startingProviders.add(providerId);
		const start = this.startReserved(providerId, false).then((value) => value.result);
		return this.trackStart(providerId, start);
	}

	startDeviceAuthentication(providerId: string): Promise<DeviceAuthInfo> {
		if (this.disposed) return Promise.reject(new Error("Credential provider is disposed"));
		if (this.activeByProvider.has(providerId) || this.startingProviders.has(providerId)) {
			return Promise.reject(new Error(`Authentication is already in progress for ${providerId}`));
		}
		this.startingProviders.add(providerId);
		const start = this.startReserved(providerId, true).then((value) => {
			if (!value.device) {
				throw new Error(`OAuth device auth not supported for provider: ${providerId}`);
			}
			return value.device.info;
		});
		return this.trackStart(providerId, start);
	}

	private async startReserved(
		providerId: string,
		deviceOnly: boolean,
	): Promise<{ result: AuthenticationStartResult; device?: DeviceAuthenticationStart }> {
		let attempt: ActiveAttempt | undefined;
		try {
			const config = await this.hooks.configForProvider(providerId);
			if (this.disposed) throw new Error("Credential provider is disposed");
			if (!config || config.grantType === "client-credentials") {
				throw new Error(`Interactive authentication is not supported for provider: ${providerId}`);
			}
			if (deviceOnly && config.grantType !== "device-code") {
				throw new Error(`OAuth device auth not supported for provider: ${providerId}`);
			}

			const attemptId = randomOpaque(16);
			const generation = await this.hooks.beginAuthentication(providerId);
			if (this.disposed) {
				await this.hooks.finishAuthentication(providerId, generation, "cancelled");
				throw new Error("Credential provider is disposed");
			}
			attempt = {
				attemptId,
				providerId,
				generation,
				controller: new AbortController(),
			};
			this.activeByProvider.set(providerId, attempt);
			this.activeById.set(attemptId, attempt);

			if (config.grantType === "device-code") {
				const device = await this.startDeviceCode(attempt, config);
				return { result: device.result, device };
			}
			return { result: await this.startAuthorizationCode(attempt, config) };
		} catch (error) {
			if (attempt) {
				await this.terminateAttempt(attempt, errorCode(error));
			}
			throw error;
		}
	}

	cancelAuthentication(attemptId: string): void {
		const attempt = this.activeById.get(attemptId);
		if (!attempt) return;
		void this.terminateAttempt(attempt, "cancelled");
	}

	cancelProvider(providerId: string, persistTerminal = true): void {
		const attempt = this.activeByProvider.get(providerId);
		if (!attempt) return;
		if (persistTerminal) {
			void this.terminateAttempt(attempt, "cancelled");
		} else {
			attempt.controller.abort();
			attempt.receiver?.dispose();
			this.removeAttempt(attempt);
		}
	}

	dispose(): Promise<void> {
		if (this.disposalPromise) return this.disposalPromise;
		this.disposed = true;
		const terminalWrites = [...this.activeById.values()].map((attempt) =>
			this.terminateAttempt(attempt, "cancelled"),
		);
		this.disposalPromise = Promise.allSettled([
			...this.startPromises,
			...this.terminalPromises,
			...terminalWrites,
		]).then(() => undefined);
		return this.disposalPromise;
	}

	private async startDeviceCode(
		attempt: ActiveAttempt,
		config: Extract<OAuthGrantConfig, { grantType: "device-code" }>,
	): Promise<DeviceAuthenticationStart> {
		const response = await postForm(
			config.deviceAuthorizationEndpoint,
			{
				scope: config.scope,
				client_id: config.clientId,
			},
			attempt.controller.signal,
		);
		const data = await readObject(response, "Device authorization");
		const userCode = requiredString(data, "user_code");
		const verificationUri = requiredString(data, "verification_uri");
		const verificationUriComplete = requiredString(data, "verification_uri_complete");
		const deviceCode = requiredString(data, "device_code");
		const interval = requiredPositiveNumber(data, "interval");
		const expiresIn = requiredPositiveNumber(data, "expires_in");

		void this.pollDeviceCode(attempt, config, deviceCode, interval).catch((error: unknown) => {
			this.logger?.error(
				`[ai-credentials] device authentication failed for ${attempt.providerId}`,
				error,
			);
		});

		return {
			result: {
				status: "started",
				challenge: {
					kind: "device-code",
					attemptId: attempt.attemptId,
					verificationUri,
					verificationUriComplete,
					userCode,
					expiresIn,
				},
			},
			info: {
				verificationUri,
				verificationUriComplete,
				userCode,
				deviceCode,
				interval,
				expiresIn,
			},
		};
	}

	private async startAuthorizationCode(
		attempt: ActiveAttempt,
		config: Extract<OAuthGrantConfig, { grantType: "authorization-code" }>,
	): Promise<AuthenticationStartResult> {
		const state = randomOpaque(32);
		const verifier = randomOpaque(64);
		const challenge = await sha256Base64Url(verifier);
		const timeoutMs = config.timeoutMs ?? DEFAULT_AUTHORIZATION_TIMEOUT_MS;
		const receiver = await config.receiver.prepare({
			attemptId: attempt.attemptId,
			state,
			timeoutMs,
		});
		attempt.receiver = receiver;

		const url = new URL(config.authorizationEndpoint);
		url.search = new URLSearchParams({
			client_id: config.clientId,
			redirect_uri: receiver.redirectUri,
			response_type: "code",
			scope: config.scope,
			state,
			code_challenge: challenge,
			code_challenge_method: "S256",
		}).toString();

		void this.completeAuthorizationCode(attempt, config, verifier).catch((error: unknown) => {
			this.logger?.error(
				`[ai-credentials] authorization-code authentication failed for ${attempt.providerId}`,
				error,
			);
		});

		return {
			status: "started",
			challenge: {
				kind: "authorization-code",
				attemptId: attempt.attemptId,
				authorizationUrl: url.toString(),
				expiresIn: Math.floor(config.challengeExpiresIn ?? timeoutMs / 1000),
			},
		};
	}

	private async completeAuthorizationCode(
		attempt: ActiveAttempt,
		config: Extract<OAuthGrantConfig, { grantType: "authorization-code" }>,
		verifier: string,
	): Promise<void> {
		try {
			const receiver = attempt.receiver;
			if (!receiver) throw new Error("authorization_callback_missing");
			const callback = await receiver.waitForCallback();
			if (callback.error) {
				throw new Error(callback.errorDescription || callback.error);
			}
			if (!callback.code) throw new Error("authorization_code_missing");
			if (!this.isCurrent(attempt)) return;

			const response = await postForm(
				config.tokenEndpoint,
				{
					grant_type: "authorization_code",
					client_id: config.clientId,
					code: callback.code,
					code_verifier: verifier,
					redirect_uri: receiver.redirectUri,
				},
				attempt.controller.signal,
			);
			const tokens = await tokenData(response, true);
			const committed = await this.hooks.commitAuthentication(
				attempt.providerId,
				attempt.generation,
				tokens,
			);
			if (committed === "committed") this.hooks.notifyReady(attempt.providerId);
		} catch (error) {
			if (this.isCurrent(attempt)) {
				await this.hooks.finishAuthentication(
					attempt.providerId,
					attempt.generation,
					errorCode(error),
				);
			}
		} finally {
			attempt.receiver?.dispose();
			this.removeAttempt(attempt);
		}
	}

	private async pollDeviceCode(
		attempt: ActiveAttempt,
		config: Extract<OAuthGrantConfig, { grantType: "device-code" }>,
		deviceCode: string,
		intervalSeconds: number,
	): Promise<void> {
		let intervalMs = intervalSeconds * 1000;
		try {
			while (this.isCurrent(attempt) && !attempt.controller.signal.aborted) {
				await sleep(intervalMs, attempt.controller.signal);
				const response = await postForm(
					config.tokenEndpoint,
					{
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						client_id: config.clientId,
						scope: config.scope,
						device_code: deviceCode,
					},
					attempt.controller.signal,
					true,
				);
				if (response.ok) {
					const tokens = await tokenData(response, true);
					const committed = await this.hooks.commitAuthentication(
						attempt.providerId,
						attempt.generation,
						tokens,
					);
					if (committed === "committed") this.hooks.notifyReady(attempt.providerId);
					return;
				}
				const body = await safeObject(response);
				const code = typeof body.error === "string" ? body.error : `http_${response.status}`;
				if (code === "authorization_pending") continue;
				if (code === "slow_down") {
					intervalMs += 5000;
					continue;
				}
				throw new Error(code);
			}
		} catch (error) {
			if (this.isCurrent(attempt) && !attempt.controller.signal.aborted) {
				await this.hooks.finishAuthentication(
					attempt.providerId,
					attempt.generation,
					errorCode(error),
				);
			}
		} finally {
			this.removeAttempt(attempt);
		}
	}

	private refreshStored(
		providerId: string,
		config: Exclude<OAuthGrantConfig, { grantType: "client-credentials" }>,
	): Promise<ProviderCredentials | null> {
		const existing = this.refreshPromises.get(providerId);
		if (existing) return existing;
		const cooldownUntil = this.refreshCooldowns.get(providerId);
		if (cooldownUntil !== undefined) {
			if (cooldownUntil > Date.now()) {
				this.logger?.debug(
					`[ai-credentials] refresh for ${providerId} skipped: cooling down after a recent transient failure`,
				);
				return Promise.resolve(null);
			}
			// An expired cooldown is removed before the retry; a successful
			// refresh therefore never has an entry to clear.
			this.refreshCooldowns.delete(providerId);
		}
		const promise = this.refreshStoredTransaction(providerId, config);
		this.refreshPromises.set(providerId, promise);
		return promise.finally(() => this.refreshPromises.delete(providerId));
	}

	/**
	 * Refresh under the cross-process store lock. Only a definitive server
	 * rejection (see {@link TERMINAL_REFRESH_CODES}) tombstones the stored
	 * tokens; every other failure keeps them so a later attempt can retry.
	 * The transaction yields the access token to shape; shaping happens
	 * outside the transaction error boundary so a programming bug in the
	 * shaper rejects instead of being misclassified as a transient failure.
	 */
	private async refreshStoredTransaction(
		providerId: string,
		config: Exclude<OAuthGrantConfig, { grantType: "client-credentials" }>,
	): Promise<ProviderCredentials | null> {
		let accessToken: string | null;
		try {
			accessToken = await this.hooks.withRefreshTransaction(providerId, async () => {
				const current = await this.hooks.readTokens(providerId);
				if (!current) return null;
				if (!this.isExpiring(current, 2)) {
					return current.accessToken;
				}
				let refreshed: TokenData;
				try {
					const response = await postForm(
						config.tokenEndpoint,
						{
							grant_type: "refresh_token",
							client_id: config.clientId,
							refresh_token: current.refreshToken,
							...(config.scope ? { scope: config.scope } : {}),
						},
						AbortSignal.timeout(this.refreshTimeoutMs),
					);
					refreshed = await tokenData(response, false, current.refreshToken);
				} catch (error) {
					if (isTerminalRefreshError(error)) {
						// Re-auth is genuinely required. Classification and the
						// tombstone stay inside the transaction so a concurrent
						// refresher cannot overwrite the terminal record.
						await this.hooks.persistRefreshError(providerId, "refresh_failed");
						this.logger?.error(
							`[ai-credentials] refresh rejected for ${providerId} (terminal: ${describeRefreshError(error)}); stored tokens removed`,
						);
					} else {
						this.startRefreshCooldown(providerId);
						this.logger?.warn(
							`[ai-credentials] refresh failed for ${providerId} (transient: ${describeRefreshError(error)}); stored tokens kept`,
						);
					}
					return null;
				}
				try {
					await this.hooks.persistRefreshedTokens(providerId, refreshed);
				} catch (error) {
					// The exchange succeeded but the rotated tokens could not be
					// saved. Keep the old record and retry later; if the server
					// rotated underneath us, the next retry gets a real
					// invalid_grant and tombstones correctly.
					this.startRefreshCooldown(providerId);
					this.logger?.warn(
						`[ai-credentials] refreshed tokens for ${providerId} could not be persisted (transient); stored tokens kept`,
						error,
					);
					return null;
				}
				this.hooks.notifyReady(providerId);
				return refreshed.accessToken;
			});
		} catch (error) {
			// The transaction itself failed (lock/IO) — same policy: keep tokens.
			this.startRefreshCooldown(providerId);
			this.logger?.warn(
				`[ai-credentials] refresh transaction failed for ${providerId} (transient); stored tokens kept`,
				error,
			);
			return null;
		}
		if (accessToken === null) return null;
		return this.hooks.shapeToken(providerId, accessToken, config);
	}

	private startRefreshCooldown(providerId: string): void {
		this.refreshCooldowns.set(providerId, Date.now() + this.refreshCooldownMs);
	}

	private async getClientCredentials(
		providerId: string,
		config: Extract<OAuthGrantConfig, { grantType: "client-credentials" }>,
	): Promise<ProviderCredentials | null> {
		const cached = this.clientCredentialTokens.get(config.cacheKey);
		if (cached && !this.isExpiring(cached)) {
			return this.hooks.shapeToken(providerId, cached.accessToken, config);
		}

		const mutexKey = `${providerId}:${config.cacheKey}`;
		const existing = this.refreshPromises.get(mutexKey);
		if (existing) return existing;
		const promise = (async () => {
			try {
				const response = await postForm(config.tokenEndpoint, {
					grant_type: "client_credentials",
					client_id: config.clientId,
					client_secret: config.clientSecret,
					...(config.scope ? { scope: config.scope } : {}),
				});
				const tokens = await tokenData(response, false, "");
				this.clientCredentialTokens.set(config.cacheKey, toStored(tokens));
				return this.hooks.shapeToken(providerId, tokens.accessToken, config);
			} catch (error) {
				this.logger?.error(
					`[ai-credentials] client-credentials renewal failed for ${providerId}`,
					error,
				);
				return null;
			}
		})();
		this.refreshPromises.set(mutexKey, promise);
		return promise.finally(() => this.refreshPromises.delete(mutexKey));
	}

	private isExpiring(tokens: StoredOAuthTokens, fixedMinutes?: number): boolean {
		const minutes = fixedMinutes ?? this.refreshJitterMinutes;
		return new Date(tokens.expiresAt).getTime() <= Date.now() + minutes * 60 * 1000;
	}

	private isCurrent(attempt: ActiveAttempt): boolean {
		return this.activeById.get(attempt.attemptId) === attempt;
	}

	private trackStart<T>(providerId: string, start: Promise<T>): Promise<T> {
		this.startPromises.add(start);
		return start.finally(() => {
			this.startPromises.delete(start);
			this.startingProviders.delete(providerId);
		});
	}

	private terminateAttempt(attempt: ActiveAttempt, error: string): Promise<void> {
		attempt.controller.abort();
		attempt.receiver?.dispose();
		this.removeAttempt(attempt);
		if (attempt.terminalPromise) {
			return attempt.terminalPromise;
		}
		const terminalPromise = this.hooks
			.finishAuthentication(attempt.providerId, attempt.generation, error)
			.then(() => undefined);
		attempt.terminalPromise = terminalPromise;
		this.terminalPromises.add(terminalPromise);
		void terminalPromise.then(
			() => this.terminalPromises.delete(terminalPromise),
			() => this.terminalPromises.delete(terminalPromise),
		);
		return terminalPromise;
	}

	private removeAttempt(attempt: ActiveAttempt): void {
		if (this.activeById.get(attempt.attemptId) === attempt) {
			this.activeById.delete(attempt.attemptId);
		}
		if (this.activeByProvider.get(attempt.providerId) === attempt) {
			this.activeByProvider.delete(attempt.providerId);
		}
	}
}

async function postForm(
	url: string,
	params: Record<string, string>,
	signal?: AbortSignal,
	allowError = false,
): Promise<Response> {
	const response = await fetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams(params).toString(),
		signal,
	});
	if (!allowError && !response.ok) {
		const { detail, code } = await oauthErrorInfo(response);
		throw new OAuthHttpError(response.status, code, `oauth_http_${response.status}${detail}`);
	}
	return response;
}

interface OAuthErrorInfo {
	/** Message detail including the leading `": "`, or "" when nothing usable. */
	detail: string;
	/** Bounded RFC 6749 `error` code, when the body carried one. */
	code: string | undefined;
}

/**
 * Best-effort detail for a failed OAuth endpoint call. RFC 6749 §5.2 error
 * bodies are JSON (`{"error": "...", "error_description": "..."}`); the
 * message prefers the description, while the structured `code` is retained
 * separately so refresh classification does not depend on message text.
 * The status alone (`oauth_http_400`) tells the user nothing — a 400 from
 * device authorization usually means a bad client ID or scope, which the
 * body names explicitly.
 */
async function oauthErrorInfo(response: Response): Promise<OAuthErrorInfo> {
	// Bound every candidate the same way: the message is persisted in the
	// terminal credential record and echoed in status payloads and logs, and
	// the code is logged during refresh classification, so a server must not
	// be able to stuff an arbitrarily large value into any of them.
	const bound = (value: string): string => (value.length > 200 ? `${value.slice(0, 200)}…` : value);
	try {
		const text = await response.text();
		if (!text) return { detail: "", code: undefined };
		try {
			const body: unknown = JSON.parse(text);
			if (typeof body === "object" && body !== null) {
				const record = body as Record<string, unknown>;
				const rawCode = record.error;
				const code = typeof rawCode === "string" && rawCode ? bound(rawCode) : undefined;
				const description = record.error_description;
				if (typeof description === "string" && description) {
					return { detail: `: ${bound(description)}`, code };
				}
				if (code) return { detail: `: ${code}`, code };
			}
		} catch {
			// Not JSON — fall through to the raw body.
		}
		return { detail: `: ${bound(text)}`, code: undefined };
	} catch {
		return { detail: "", code: undefined };
	}
}

/** A definitive server rejection of the refresh token; anything else retries. */
function isTerminalRefreshError(error: unknown): boolean {
	return (
		error instanceof OAuthHttpError &&
		(error.status === 400 || error.status === 401) &&
		error.code !== undefined &&
		TERMINAL_REFRESH_CODES.has(error.code)
	);
}

/** Bounded one-line description of a refresh failure for logs. */
function describeRefreshError(error: unknown): string {
	if (error instanceof OAuthHttpError) {
		const code = error.code ? `, code ${error.code}` : "";
		// The message carries the bounded server detail (`oauth_http_<status>: <detail>`).
		return `http ${error.status}${code} [${error.message}]`;
	}
	if (error instanceof Error) return error.message;
	return String(error);
}

async function tokenData(
	response: Response,
	requireRefreshToken: boolean,
	refreshTokenFallback?: string,
): Promise<TokenData> {
	const body = await readObject(response, "Token exchange");
	const accessToken = requiredString(body, "access_token");
	const refreshTokenValue =
		typeof body.refresh_token === "string" ? body.refresh_token : refreshTokenFallback;
	if (requireRefreshToken && !refreshTokenValue) throw new Error("malformed_refresh_token");
	return {
		accessToken,
		refreshToken: refreshTokenValue ?? "",
		expiresIn: requiredPositiveNumber(body, "expires_in"),
		tokenType: typeof body.token_type === "string" ? body.token_type : "Bearer",
		scope: typeof body.scope === "string" ? body.scope : "",
	};
}

function toStored(tokens: TokenData): StoredOAuthTokens {
	return {
		accessToken: tokens.accessToken,
		refreshToken: tokens.refreshToken,
		expiresAt: new Date(Date.now() + tokens.expiresIn * 1000).toISOString(),
		tokenType: tokens.tokenType,
		scope: tokens.scope,
	};
}

async function readObject(response: Response, label: string): Promise<Record<string, unknown>> {
	if (!response.ok)
		throw new Error(`${label.toLowerCase().replaceAll(" ", "_")}_${response.status}`);
	const value: unknown = await response.json();
	if (typeof value !== "object" || value === null) throw new Error("malformed_oauth_response");
	return value as Record<string, unknown>;
}

async function safeObject(response: Response): Promise<Record<string, unknown>> {
	try {
		const value: unknown = await response.json();
		return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
	} catch {
		return {};
	}
}

function requiredString(value: Record<string, unknown>, key: string): string {
	const field = value[key];
	if (typeof field !== "string" || field.length === 0) throw new Error(`malformed_${key}`);
	return field;
}

function requiredPositiveNumber(value: Record<string, unknown>, key: string): number {
	const field = value[key];
	if (typeof field !== "number" || !Number.isFinite(field) || field <= 0) {
		throw new Error(`malformed_${key}`);
	}
	return field;
}

function randomOpaque(bytes: number): string {
	const values = new Uint8Array(bytes);
	globalThis.crypto.getRandomValues(values);
	return [...values].map((value) => value.toString(16).padStart(2, "0")).join("");
}

async function sha256Base64Url(value: string): Promise<string> {
	const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	const bytes = new Uint8Array(digest);
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function errorCode(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") return "cancelled";
	if (error instanceof Error && error.message) return error.message;
	return "authentication_failed";
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) {
			reject(new DOMException("Aborted", "AbortError"));
			return;
		}
		const timer = setTimeout(resolve, ms);
		signal.addEventListener(
			"abort",
			() => {
				clearTimeout(timer);
				reject(new DOMException("Aborted", "AbortError"));
			},
			{ once: true },
		);
	});
}
