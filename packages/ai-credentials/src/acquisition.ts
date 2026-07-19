/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type {
	AcquisitionBackendHooks,
	OAuthGrantConfig,
	PreparedAuthorizationCodeReceiver,
	StoredOAuthTokens,
} from "./Backend";
import type { AuthenticationStartResult } from "./CredentialProvider";
import type { Logger, ProviderCredentials, TokenData } from "./types";

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
}

const DEFAULT_AUTHORIZATION_TIMEOUT_MS = 5 * 60 * 1000;

/** Provider-neutral device/code/client-credentials acquisition state machine. */
export class AcquisitionEngine {
	private readonly activeByProvider = new Map<string, ActiveAttempt>();
	private readonly activeById = new Map<string, ActiveAttempt>();
	private readonly refreshPromises = new Map<string, Promise<ProviderCredentials | null>>();
	private readonly clientCredentialTokens = new Map<string, StoredOAuthTokens>();
	private readonly refreshJitterMinutes = 4 + Math.random() * 2;

	constructor(
		private readonly hooks: AcquisitionBackendHooks,
		private readonly logger?: Logger,
	) {}

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

	async startAuthentication(providerId: string): Promise<AuthenticationStartResult> {
		if (this.activeByProvider.has(providerId)) return { status: "already-in-progress" };

		const config = await this.hooks.configForProvider(providerId);
		if (!config || config.grantType === "client-credentials") {
			throw new Error(`Interactive authentication is not supported for provider: ${providerId}`);
		}

		const attemptId = randomOpaque(16);
		const generation = await this.hooks.beginAuthentication(providerId);
		const attempt: ActiveAttempt = {
			attemptId,
			providerId,
			generation,
			controller: new AbortController(),
		};
		this.activeByProvider.set(providerId, attempt);
		this.activeById.set(attemptId, attempt);

		try {
			if (config.grantType === "device-code") {
				return await this.startDeviceCode(attempt, config);
			}
			return await this.startAuthorizationCode(attempt, config);
		} catch (error) {
			this.removeAttempt(attempt);
			await this.hooks.finishAuthentication(providerId, generation, errorCode(error));
			throw error;
		}
	}

	cancelAuthentication(attemptId: string): void {
		const attempt = this.activeById.get(attemptId);
		if (!attempt) return;
		attempt.controller.abort();
		attempt.receiver?.dispose();
		this.removeAttempt(attempt);
		void this.hooks.finishAuthentication(attempt.providerId, attempt.generation, "cancelled");
	}

	cancelProvider(providerId: string, persistTerminal = true): void {
		const attempt = this.activeByProvider.get(providerId);
		if (!attempt) return;
		attempt.controller.abort();
		attempt.receiver?.dispose();
		this.removeAttempt(attempt);
		if (persistTerminal) {
			void this.hooks.finishAuthentication(providerId, attempt.generation, "cancelled");
		}
	}

	dispose(): void {
		for (const attempt of [...this.activeById.values()]) {
			attempt.controller.abort();
			attempt.receiver?.dispose();
			this.removeAttempt(attempt);
		}
	}

	private async startDeviceCode(
		attempt: ActiveAttempt,
		config: Extract<OAuthGrantConfig, { grantType: "device-code" }>,
	): Promise<AuthenticationStartResult> {
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
			status: "started",
			challenge: {
				kind: "device-code",
				attemptId: attempt.attemptId,
				verificationUri,
				verificationUriComplete,
				userCode,
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
		const promise = this.hooks.withRefreshTransaction(providerId, async () => {
			const current = await this.hooks.readTokens(providerId);
			if (!current) return null;
			if (!this.isExpiring(current, 2)) {
				return this.hooks.shapeToken(providerId, current.accessToken, config);
			}
			try {
				const response = await postForm(config.tokenEndpoint, {
					grant_type: "refresh_token",
					client_id: config.clientId,
					refresh_token: current.refreshToken,
					...(config.scope ? { scope: config.scope } : {}),
				});
				const refreshed = await tokenData(response, false, current.refreshToken);
				await this.hooks.persistRefreshedTokens(providerId, refreshed);
				this.hooks.notifyReady(providerId);
				return this.hooks.shapeToken(providerId, refreshed.accessToken, config);
			} catch (error) {
				await this.hooks.persistRefreshError(providerId, "refresh_failed");
				this.logger?.error(`[ai-credentials] refresh failed for ${providerId}`, error);
				return null;
			}
		});
		this.refreshPromises.set(providerId, promise);
		return promise.finally(() => this.refreshPromises.delete(providerId));
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
		throw new Error(`oauth_http_${response.status}`);
	}
	return response;
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
