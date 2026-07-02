/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Root-owned OAuth device-authorization + refresh state machine (RFC 8628).
 *
 * This is the provider-agnostic half of credential resolution (Phase 0 #4,
 * option B). It performs the device-code request, the background polling loop,
 * and proactive token refresh with a per-provider mutex + jittered window. It
 * knows nothing about the on-disk shape or where OAuth config comes from — it
 * asks the injected {@link OAuthBackendHooks} to read/persist tokens and errors.
 *
 * No fs / vscode / @assistant/* / SDK imports — pure fetch + timers.
 */

import type { OAuthBackendHooks, OAuthProviderConfig } from "./Backend";
import type { DeviceAuthInfo, Logger, TokenData } from "./types";

/** Token endpoint response shape (RFC 8628 §3.5 / OAuth token response). */
interface TokenResponse {
	access_token: string;
	refresh_token: string;
	expires_in: number;
	token_type: string;
	scope: string;
}

/** Device authorization response shape (RFC 8628 §3.2). */
interface DeviceCodeResponse {
	user_code: string;
	verification_uri: string;
	verification_uri_complete: string;
	device_code: string;
	interval: number;
	expires_in: number;
}

function tokenResponseToTokenData(data: TokenResponse): TokenData {
	return {
		accessToken: data.access_token,
		refreshToken: data.refresh_token,
		expiresIn: data.expires_in,
		tokenType: data.token_type,
		scope: data.scope,
	};
}

/**
 * The engine drives a single backend's OAuth providers. One instance is held
 * by each {@link createCredentialProvider} result.
 */
export class OAuthEngine {
	private readonly hooks: OAuthBackendHooks;
	private readonly logger?: Logger;

	/** Per-provider refresh mutex to prevent concurrent refreshes racing writes. */
	private readonly refreshPromises = new Map<string, Promise<void>>();
	/** Per-provider polling abort controllers. */
	private readonly pollingControllers = new Map<string, AbortController>();
	/**
	 * Jittered proactive refresh window (minutes before expiry). Randomized per
	 * instance to spread refresh attempts across processes. Range: 4–6 minutes.
	 */
	private readonly refreshJitterMinutes = 4 + Math.random() * 2;

	constructor(hooks: OAuthBackendHooks, logger?: Logger) {
		this.hooks = hooks;
		this.logger = logger;
	}

	/**
	 * Current access token for a provider, refreshing if expired/expiring.
	 * Returns null if the provider has no OAuth config or is not authenticated.
	 */
	async getAccessToken(providerId: string): Promise<string | null> {
		const config = this.hooks.configForProvider(providerId);
		if (!config) {
			this.logger?.debug(`[ai-credentials] getAccessToken: no OAuth config for ${providerId}`);
			return null;
		}

		const tokens = await this.hooks.readTokens(providerId);
		if (!tokens) {
			this.logger?.debug(`[ai-credentials] getAccessToken: no stored tokens for ${providerId}`);
			return null;
		}

		const expiresAt = new Date(tokens.expiresAt);
		const now = new Date();
		const refreshThreshold = new Date(now.getTime() + this.refreshJitterMinutes * 60 * 1000);

		if (expiresAt > refreshThreshold) {
			return tokens.accessToken;
		}

		// Expired or expiring soon — refresh.
		this.logger?.info(
			`[ai-credentials] getAccessToken: ${providerId} token ${
				expiresAt <= now ? "expired" : "expiring soon"
			}, refreshing`,
		);
		try {
			await this.refreshToken(providerId, tokens.refreshToken, config);
		} catch (error) {
			this.logger?.error(
				`[ai-credentials] getAccessToken: refresh failed for ${providerId}`,
				error,
			);
			await this.hooks.persistError(providerId, "refresh_failed");
			return null;
		}

		const updated = await this.hooks.readTokens(providerId);
		return updated?.accessToken ?? null;
	}

	/**
	 * Start the OAuth device-authorization flow. Returns device-code info for
	 * display and begins polling for the token in the background.
	 * Throws if the provider has no device-flow config.
	 */
	async startDeviceAuth(providerId: string): Promise<DeviceAuthInfo> {
		const config = this.hooks.configForProvider(providerId);
		if (!config) {
			throw new Error(`OAuth device auth not supported for provider: ${providerId}`);
		}

		// Note: any stale error is cleared by persistTokens on success (it writes
		// error: undefined); on failure the polling loop overwrites it.
		const authUrl = `https://${config.authHost}/oauth/device/authorize`;
		const params = new URLSearchParams({ scope: config.scope, client_id: config.clientId });

		this.logger?.debug(`[ai-credentials] startDeviceAuth: requesting device code from ${authUrl}`);
		const response = await fetch(authUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		if (!response.ok) {
			const errorText = await response.text();
			throw new Error(`Device authorization failed: ${response.status} ${errorText}`);
		}

		const data = (await response.json()) as DeviceCodeResponse;
		const deviceAuthInfo: DeviceAuthInfo = {
			userCode: data.user_code,
			verificationUri: data.verification_uri,
			verificationUriComplete: data.verification_uri_complete,
			deviceCode: data.device_code,
			interval: data.interval,
			expiresIn: data.expires_in,
		};

		// Poll in the background; swallow errors (status is persisted via hooks).
		void this.pollForToken(
			providerId,
			config,
			deviceAuthInfo.deviceCode,
			deviceAuthInfo.interval,
		).catch((error: unknown) => {
			this.logger?.error(`[ai-credentials] device auth polling failed for ${providerId}`, error);
		});

		return deviceAuthInfo;
	}

	/** Cancel any in-flight polling for a provider (e.g. on logout). */
	cancelPolling(providerId: string): void {
		const controller = this.pollingControllers.get(providerId);
		if (controller) {
			controller.abort();
			this.pollingControllers.delete(providerId);
		}
	}

	/** Cancel all in-flight polling. */
	dispose(): void {
		for (const controller of this.pollingControllers.values()) {
			controller.abort();
		}
		this.pollingControllers.clear();
	}

	// ------------------------------------------------------------------------
	// Internal
	// ------------------------------------------------------------------------

	private async pollForToken(
		providerId: string,
		config: OAuthProviderConfig,
		deviceCode: string,
		interval: number,
	): Promise<void> {
		const tokenUrl = `https://${config.authHost}/oauth/token`;

		// Cancel any prior polling for this provider.
		this.cancelPolling(providerId);
		const controller = new AbortController();
		this.pollingControllers.set(providerId, controller);

		let currentInterval = interval * 1000;

		try {
			while (!controller.signal.aborted) {
				await this.sleep(currentInterval);
				if (controller.signal.aborted) break;

				let response: Response;
				try {
					const params = new URLSearchParams({
						scope: config.scope,
						client_id: config.clientId,
						grant_type: "urn:ietf:params:oauth:grant-type:device_code",
						device_code: deviceCode,
					});
					response = await fetch(tokenUrl, {
						method: "POST",
						headers: { "Content-Type": "application/x-www-form-urlencoded" },
						body: params.toString(),
						signal: controller.signal,
					});
				} catch (error) {
					if (error instanceof Error && error.name === "AbortError") break;
					await this.hooks.persistError(providerId, "polling_error");
					break;
				}

				if (response.ok) {
					const tokenData = (await response.json()) as TokenResponse;
					await this.hooks.persistTokens(providerId, tokenResponseToTokenData(tokenData));
					this.hooks.notifyReady(providerId);
					break;
				}

				if (response.status === 400) {
					const errorData = (await response.json()) as { error: string };
					const errorCode = errorData.error;
					if (errorCode === "authorization_pending") {
						continue;
					} else if (errorCode === "slow_down") {
						currentInterval += 5000;
						continue;
					} else if (errorCode === "expired_token" || errorCode === "access_denied") {
						await this.hooks.persistError(providerId, errorCode);
						break;
					} else {
						await this.hooks.persistError(providerId, `auth_error_${errorCode}`);
						break;
					}
				} else {
					await this.hooks.persistError(providerId, `network_error_${response.status}`);
					break;
				}
			}
		} finally {
			if (this.pollingControllers.get(providerId) === controller) {
				this.pollingControllers.delete(providerId);
			}
		}
	}

	/**
	 * Refresh with a per-provider mutex so concurrent callers await one refresh.
	 */
	private refreshToken(
		providerId: string,
		refreshToken: string,
		config: OAuthProviderConfig,
	): Promise<void> {
		const existing = this.refreshPromises.get(providerId);
		if (existing) return existing;

		const promise = this.doRefreshToken(providerId, refreshToken, config);
		this.refreshPromises.set(providerId, promise);
		return promise.finally(() => {
			this.refreshPromises.delete(providerId);
		});
	}

	private async doRefreshToken(
		providerId: string,
		refreshToken: string,
		config: OAuthProviderConfig,
	): Promise<void> {
		// Another process may have refreshed already — skip if still valid > 2 min.
		const current = await this.hooks.readTokens(providerId);
		if (current) {
			const twoMinutesFromNow = new Date(Date.now() + 2 * 60 * 1000);
			if (new Date(current.expiresAt) > twoMinutesFromNow) {
				this.logger?.debug(
					`[ai-credentials] refresh: ${providerId} already refreshed by another process, skipping`,
				);
				return;
			}
		}

		const tokenUrl = `https://${config.authHost}/oauth/token`;
		const params = new URLSearchParams({
			scope: config.scope,
			client_id: config.clientId,
			grant_type: "refresh_token",
			refresh_token: refreshToken,
		});

		const response = await fetch(tokenUrl, {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: params.toString(),
		});

		if (!response.ok) {
			let errorBody = "";
			try {
				errorBody = await response.text();
			} catch {
				// ignore body read failures
			}
			throw new Error(`Token refresh failed: ${response.status} - ${errorBody}`);
		}

		const tokenData = (await response.json()) as TokenResponse;
		await this.hooks.persistTokens(providerId, tokenResponseToTokenData(tokenData));
		this.hooks.notifyReady(providerId);
	}

	private sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}
}
