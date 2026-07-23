/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type {
	AcquisitionBackendHooks,
	CredentialSourceContext,
	MutableBackend,
	OAuthBackendHooks,
	OAuthGrantConfig,
	OAuthProviderConfig,
	StoredOAuthTokens,
} from "../Backend.js";
import type {
	CredentialMutation,
	CredentialSourceInput,
	CredentialStatus,
	Disposable,
} from "../CredentialProvider.js";
import type { SingleFileStore } from "../store/index.js";
import type { Logger, ProviderCredentials, TokenData } from "../types/index.js";
import { normalizeDatabricksHost, storageKeyFor } from "../types/index.js";
import { resolveCredentialsFromEnv } from "./envCredentialResolver.js";
import {
	storedProviderCredentialsSchema,
	type StoredProviderCredentials,
} from "./StoredProviderCredentials.js";

export interface AuthMethodDescriptor {
	authMethodId: string;
	apiKeyOptional?: boolean;
}

export interface CreateStoreBackendOptions {
	store: SingleFileStore;
	resolveAuthMethod(providerId: string): AuthMethodDescriptor | undefined;
	oauthConfigForProvider?: (
		providerId: string,
		source?: CredentialSourceContext,
	) =>
		| OAuthGrantConfig
		| OAuthProviderConfig
		| undefined
		| Promise<OAuthGrantConfig | OAuthProviderConfig | undefined>;
	shapeToken?: (
		providerId: string,
		accessToken: string,
		config: OAuthGrantConfig,
		source: CredentialSourceContext,
	) => ProviderCredentials;
	notifyReady?: (providerId: string) => void;
	watchedProviderIds?: string[];
	env?: Record<string, string | undefined>;
	logger?: Logger;
	generationFactory?: () => string;
}

interface NormalizedStored {
	readiness: "pending" | "ready" | "unauthenticated";
	generation?: string;
	source?: CredentialSourceInput;
	tokens?: StoredOAuthTokens;
	error?: string;
}

const NOOP_DISPOSABLE: Disposable = { dispose() {} };

export function createStoreBackend(options: CreateStoreBackendOptions): MutableBackend {
	const {
		store,
		resolveAuthMethod,
		oauthConfigForProvider,
		shapeToken,
		notifyReady,
		watchedProviderIds = [],
		logger,
		generationFactory = defaultGeneration,
	} = options;
	const currentEnvironment = () => options.env ?? process.env;

	function keyFor(providerId: string): string | undefined {
		const descriptor = resolveAuthMethod(providerId);
		return descriptor ? storageKeyFor(providerId, descriptor.authMethodId) : undefined;
	}

	async function readRecord(providerId: string): Promise<StoredProviderCredentials | undefined> {
		const key = keyFor(providerId);
		if (!key) return undefined;
		const raw = await store.get<unknown>(key);
		if (raw === undefined) return undefined;
		const parsed = storedProviderCredentialsSchema.safeParse(raw);
		if (!parsed.success) {
			logger?.warn(`[ai-credentials] Ignoring invalid credential record for ${providerId}`);
			return undefined;
		}
		return parsed.data;
	}

	function normalize(record: StoredProviderCredentials | undefined): NormalizedStored | null {
		if (!record) return null;
		const readiness =
			record.readiness ??
			(record.authenticated === true
				? "ready"
				: record.authenticated === false
					? "unauthenticated"
					: undefined);

		if (record.source === "oauth-m2m" && record.clientCredentialsAuth) {
			return {
				readiness: readiness === "pending" ? "pending" : "ready",
				generation: record.generation,
				source: { type: "oauth-m2m", ...record.clientCredentialsAuth },
			};
		}

		if (record.source === "oauth-u2m") {
			const workspaceHost = record.oauthAuth?.workspaceHost;
			if (!workspaceHost)
				return { readiness: "unauthenticated", generation: record.generation, error: record.error };
			return {
				readiness: readiness ?? "unauthenticated",
				generation: record.generation,
				source: { type: "oauth-u2m", workspaceHost },
				tokens: readiness === "ready" ? storedTokens(record) : undefined,
				error: record.error,
			};
		}

		if (record.apiKeyAuth && (record.source === undefined || record.source === "api-key")) {
			return {
				readiness: "ready",
				generation: record.generation,
				source: {
					type: "api-key",
					apiKey: record.apiKeyAuth.apiKey,
					...(record.apiKeyAuth.baseUrl ? { baseUrl: record.apiKeyAuth.baseUrl } : {}),
				},
			};
		}

		if (record.source === "oauth-device" || (record.source === undefined && record.oauthAuth)) {
			const tokenData = record.oauthAuth?.tokenData;
			return {
				readiness: readiness ?? (tokenData ? "ready" : "unauthenticated"),
				generation: record.generation,
				source: { type: "oauth-device" },
				tokens:
					readiness === "ready" || (readiness === undefined && tokenData)
						? storedTokens(record)
						: undefined,
				error: record.error,
			};
		}

		if (record.localAuth) {
			return {
				readiness: "ready",
				generation: record.generation,
				source: { type: "local", endpoint: record.localAuth.endpoint },
			};
		}
		if (record.awsAuth) {
			return {
				readiness: "ready",
				generation: record.generation,
				source: { type: "aws-credentials", ...record.awsAuth },
			};
		}
		if (record.googleCloudAuth) {
			return {
				readiness: "ready",
				generation: record.generation,
				source: { type: "google-cloud", ...record.googleCloudAuth },
			};
		}
		return { readiness: "unauthenticated", generation: record.generation, error: record.error };
	}

	async function storedSource(providerId: string): Promise<NormalizedStored | null> {
		return normalize(await readRecord(providerId));
	}

	type EnvironmentResolution =
		| {
				kind: "credentials";
				credentials: ProviderCredentials;
		  }
		| {
				kind: "oauth-m2m";
				source: Extract<CredentialSourceContext, { type: "oauth-m2m" }>;
		  }
		| {
				kind: "incomplete-oauth-m2m";
				workspaceHost?: string;
				error: string;
		  }
		| { kind: "none" };

	function environmentResolution(providerId: string): EnvironmentResolution {
		const env = currentEnvironment();
		if (providerId !== "databricks") {
			const credentials = resolveCredentialsFromEnv(providerId, env);
			return credentials ? { kind: "credentials", credentials } : { kind: "none" };
		}

		const token = env.DATABRICKS_TOKEN;
		const explicitlyM2m = env.DATABRICKS_AUTH_TYPE === "oauth-m2m";
		if (token && !explicitlyM2m) {
			const credentials = resolveCredentialsFromEnv(providerId, env);
			return credentials ? { kind: "credentials", credentials } : { kind: "none" };
		}
		if (env.DATABRICKS_CLIENT_ID && env.DATABRICKS_CLIENT_SECRET && env.DATABRICKS_HOST) {
			let workspaceHost: string;
			try {
				workspaceHost = normalizeDatabricksHost(env.DATABRICKS_HOST);
			} catch (error) {
				return {
					kind: "incomplete-oauth-m2m",
					workspaceHost: env.DATABRICKS_HOST,
					error: error instanceof Error ? error.message : "Invalid Databricks workspace URL",
				};
			}
			return {
				kind: "oauth-m2m",
				source: {
					type: "oauth-m2m",
					origin: "environment",
					clientId: env.DATABRICKS_CLIENT_ID,
					clientSecret: env.DATABRICKS_CLIENT_SECRET,
					workspaceHost,
				},
			};
		}
		if (explicitlyM2m) {
			return {
				kind: "incomplete-oauth-m2m",
				workspaceHost: env.DATABRICKS_HOST,
				error:
					"Databricks OAuth M2M requires DATABRICKS_HOST, DATABRICKS_CLIENT_ID, and DATABRICKS_CLIENT_SECRET",
			};
		}
		return { kind: "none" };
	}

	async function sourceContext(providerId: string): Promise<CredentialSourceContext | undefined> {
		const normalized = await storedSource(providerId);
		if (normalized?.source) {
			if (normalized.source.type === "oauth-device") {
				return { type: "oauth-device", origin: "stored" };
			}
			if (normalized.source.type === "oauth-u2m") {
				return { ...normalized.source, origin: "stored" };
			}
			if (normalized.source.type === "oauth-m2m") {
				return { ...normalized.source, origin: "stored" };
			}
			return undefined;
		}
		if (providerId === "databricks") {
			const environment = environmentResolution(providerId);
			return environment.kind === "oauth-m2m" ? environment.source : undefined;
		}
		if (resolveAuthMethod(providerId)?.authMethodId === "oauth") {
			return { type: "oauth-device", origin: "implicit" };
		}
		return undefined;
	}

	async function resolveGrant(providerId: string): Promise<OAuthGrantConfig | undefined> {
		if (!oauthConfigForProvider) return undefined;
		const source = await sourceContext(providerId);
		if (!source) return undefined;
		const config = await oauthConfigForProvider(providerId, source);
		if (!config) return undefined;
		if ("grantType" in config) return config;
		return {
			grantType: "device-code",
			clientId: config.clientId,
			scope: config.scope,
			deviceAuthorizationEndpoint: `https://${config.authHost}/oauth/device/authorize`,
			tokenEndpoint: `https://${config.authHost}/oauth/token`,
		};
	}

	async function getCredentials(providerId: string): Promise<ProviderCredentials | null> {
		const descriptor = resolveAuthMethod(providerId);
		if (!descriptor) return null;
		const normalized = await storedSource(providerId);
		if (normalized?.source) {
			const source = normalized.source;
			switch (source.type) {
				case "api-key":
					if (!source.apiKey && !descriptor.apiKeyOptional) break;
					return { type: "apikey", apiKey: source.apiKey, baseUrl: source.baseUrl };
				case "local":
					return { type: "local", endpoint: source.endpoint };
				case "aws-credentials":
					return { ...source };
				case "google-cloud":
					return { ...source };
				case "oauth-device":
				case "oauth-u2m":
				case "oauth-m2m":
					return null;
			}
		}
		const environment = environmentResolution(providerId);
		return environment.kind === "credentials" ? environment.credentials : null;
	}

	async function mutateCredentials(
		providerId: string,
		mutation: CredentialMutation,
	): Promise<void> {
		const key = keyFor(providerId);
		if (!key) throw new Error(`Unknown provider: ${providerId}`);
		await store.withLock(async () => {
			await store.get<unknown>(key);
			const generation = generationFactory();
			if (mutation.kind === "clear") {
				await store.set(key, {
					generation,
					readiness: "unauthenticated",
					configured: false,
					authenticated: false,
				} satisfies StoredProviderCredentials);
				return;
			}
			await store.set(key, recordForSource(mutation.source, generation));
		});
	}

	async function getCredentialSource(providerId: string): Promise<CredentialSourceInput | null> {
		const normalized = await storedSource(providerId);
		return normalized?.source ?? null;
	}

	async function getCredentialStatus(providerId: string): Promise<CredentialStatus> {
		const normalized = await storedSource(providerId);
		if (normalized?.source) {
			const metadata = sourceMetadata(normalized.source);
			return {
				configured: true,
				authenticated: normalized.readiness === "ready",
				readiness: normalized.readiness,
				source: normalized.source.type,
				origin: "stored",
				expiresAt: normalized.tokens?.expiresAt,
				scope: normalized.tokens?.scope,
				error: "error" in normalized ? normalized.error : undefined,
				metadata,
			};
		}
		const environment = environmentResolution(providerId);
		if (environment.kind === "oauth-m2m") {
			return {
				configured: true,
				authenticated: true,
				readiness: "ready",
				source: "oauth-m2m",
				origin: "environment",
				metadata: { workspaceHost: environment.source.workspaceHost },
			};
		}
		if (environment.kind === "credentials") {
			return {
				configured: true,
				authenticated: true,
				readiness: "ready",
				source: "api-key",
				origin: "environment",
			};
		}
		if (environment.kind === "incomplete-oauth-m2m") {
			return {
				configured: false,
				authenticated: false,
				readiness: "unauthenticated",
				source: "oauth-m2m",
				origin: "environment",
				error: environment.error,
				metadata: environment.workspaceHost
					? { workspaceHost: environment.workspaceHost }
					: undefined,
			};
		}
		return {
			configured: false,
			authenticated: false,
			readiness: "unauthenticated",
			error: normalized?.error,
		};
	}

	async function beginAuthentication(providerId: string): Promise<string> {
		const key = keyFor(providerId);
		if (!key) throw new Error(`Unknown provider: ${providerId}`);
		return store.withLock(async () => {
			const normalized = normalize(await readRecord(providerId));
			const generation = generationFactory();
			let source: CredentialSourceInput = { type: "oauth-device" };
			if (normalized?.source) source = normalized.source;
			if (source.type !== "oauth-device" && source.type !== "oauth-u2m") {
				throw new Error(`Stored source ${source.type} is not interactive`);
			}
			await store.set(key, pendingRecord(source, generation));
			return generation;
		});
	}

	async function commitAuthentication(
		providerId: string,
		generation: string,
		tokens: TokenData,
	): Promise<"committed" | "superseded"> {
		return compareAndWrite(providerId, generation, (current) => {
			if (!current.source) return null;
			if (current.source.type !== "oauth-device" && current.source.type !== "oauth-u2m")
				return null;
			return authenticatedOAuthRecord(current.source, tokens, generationFactory());
		});
	}

	async function finishAuthentication(
		providerId: string,
		generation: string,
		error: string,
	): Promise<"committed" | "superseded"> {
		return compareAndWrite(providerId, generation, (current) => {
			if (!current.source) return null;
			return terminalOAuthRecord(current.source, generationFactory(), error);
		});
	}

	async function compareAndWrite(
		providerId: string,
		generation: string,
		build: (current: NormalizedStored) => StoredProviderCredentials | null,
	): Promise<"committed" | "superseded"> {
		const key = keyFor(providerId);
		if (!key) return "superseded";
		return store.withLock(async () => {
			const current = normalize(await readRecord(providerId));
			if (!current || current.generation !== generation) return "superseded";
			const next = build(current);
			if (!next) return "superseded";
			await store.set(key, next);
			return "committed";
		});
	}

	async function readTokens(providerId: string): Promise<StoredOAuthTokens | null> {
		const normalized = await storedSource(providerId);
		if (!normalized || normalized.readiness !== "ready" || !normalized.source) return null;
		if (normalized.source.type !== "oauth-device" && normalized.source.type !== "oauth-u2m")
			return null;
		return normalized.tokens ?? null;
	}

	async function persistRefreshedTokens(providerId: string, tokens: TokenData): Promise<void> {
		const key = keyFor(providerId);
		if (!key) return;
		const current = normalize(await readRecord(providerId));
		if (!current?.source) return;
		if (current.source.type !== "oauth-device" && current.source.type !== "oauth-u2m") return;
		await store.set(key, authenticatedOAuthRecord(current.source, tokens, generationFactory()));
	}

	async function persistRefreshError(providerId: string, error: string): Promise<void> {
		const key = keyFor(providerId);
		if (!key) return;
		const current = normalize(await readRecord(providerId));
		if (!current?.source) return;
		await store.set(key, terminalOAuthRecord(current.source, generationFactory(), error));
	}

	const acquisition: AcquisitionBackendHooks | undefined = oauthConfigForProvider
		? {
				configForProvider: resolveGrant,
				readTokens,
				beginAuthentication,
				commitAuthentication,
				finishAuthentication,
				persistRefreshedTokens,
				persistRefreshError,
				withRefreshTransaction: (_providerId, operation) => store.withLock(operation),
				shapeToken: asyncShapeToken,
				notifyReady(providerId) {
					notifyReady?.(providerId);
				},
			}
		: undefined;

	function asyncShapeToken(
		providerId: string,
		accessToken: string,
		config: OAuthGrantConfig,
	): ProviderCredentials {
		const descriptor = resolveAuthMethod(providerId);
		// shapeToken is intentionally synchronous. The source was already resolved
		// by configForProvider, so provider-specific shaping can be derived from the
		// descriptor/config. Databricks baseUrl is attached by Node's catalog merge.
		if (shapeToken) {
			// Custom shapers that need the source should encode its non-secret identity
			// in the resolved grant configuration. Keep secrets out of errors/logs.
			const fallback: CredentialSourceContext = { type: "oauth-device", origin: "implicit" };
			return shapeToken(providerId, accessToken, config, fallback);
		}
		return descriptor?.authMethodId === "apikey"
			? { type: "apikey", apiKey: accessToken, baseUrl: config.credentialBaseUrl }
			: { type: "oauth", accessToken };
	}

	const oauth: OAuthBackendHooks | undefined = oauthConfigForProvider
		? {
				configForProvider(providerId): OAuthProviderConfig | undefined {
					// Compatibility is limited to the original synchronous Posit AI callback.
					const value = oauthConfigForProvider(providerId, {
						type: "oauth-device",
						origin: "implicit",
					});
					if (value instanceof Promise || !value || "grantType" in value) return undefined;
					return value;
				},
				readTokens,
				async persistTokens(providerId, tokens) {
					const key = keyFor(providerId);
					if (!key) return;
					await store.withLock(async () => {
						await store.set(
							key,
							authenticatedOAuthRecord({ type: "oauth-device" }, tokens, generationFactory()),
						);
					});
				},
				persistError: persistRefreshError,
				async clearError(providerId) {
					const key = keyFor(providerId);
					if (!key) return;
					await store.withLock(async () => {
						await store.set(
							key,
							terminalOAuthRecord({ type: "oauth-device" }, generationFactory()),
						);
					});
				},
				notifyReady(providerId) {
					notifyReady?.(providerId);
				},
			}
		: undefined;

	function onDidChangeCredentials(callback: (providerIds: string[]) => void): Disposable {
		if (watchedProviderIds.length === 0) return NOOP_DISPOSABLE;
		return store.watch(() => callback([...watchedProviderIds]));
	}

	return {
		getCredentials,
		onDidChangeCredentials,
		...(oauth ? { oauth } : {}),
		...(acquisition ? { acquisition } : {}),
		mutateCredentials,
		getCredentialStatus,
		getCredentialSource,
	};
}

function storedTokens(record: StoredProviderCredentials): StoredOAuthTokens | undefined {
	const tokenData = record.oauthAuth?.tokenData;
	if (!tokenData) return undefined;
	return {
		accessToken: tokenData.accessToken,
		refreshToken: tokenData.refreshToken,
		expiresAt: tokenData.expiresAt,
		tokenType: tokenData.tokenType,
		scope: tokenData.scope,
	};
}

function recordForSource(
	source: CredentialSourceInput,
	generation: string,
): StoredProviderCredentials {
	switch (source.type) {
		case "api-key":
			return {
				generation,
				readiness: "ready",
				source: "api-key",
				configured: true,
				authenticated: true,
				apiKeyAuth: {
					apiKey: source.apiKey,
					...(source.baseUrl ? { baseUrl: source.baseUrl } : {}),
				},
			};
		case "oauth-device":
			return terminalOAuthRecord(source, generation);
		case "oauth-u2m":
			return terminalOAuthRecord(source, generation);
		case "oauth-m2m":
			return {
				generation,
				readiness: "ready",
				source: "oauth-m2m",
				configured: true,
				authenticated: true,
				clientCredentialsAuth: {
					clientId: source.clientId,
					clientSecret: source.clientSecret,
					workspaceHost: source.workspaceHost,
				},
			};
		case "local":
			return {
				generation,
				readiness: "ready",
				configured: true,
				localAuth: { endpoint: source.endpoint },
			};
		case "aws-credentials": {
			const { type: _type, ...awsAuth } = source;
			return { generation, readiness: "ready", configured: true, awsAuth };
		}
		case "google-cloud":
			return {
				generation,
				readiness: "ready",
				configured: true,
				googleCloudAuth: { project: source.project, location: source.location },
			};
	}
}

function pendingRecord(
	source: Extract<CredentialSourceInput, { type: "oauth-device" | "oauth-u2m" }>,
	generation: string,
): StoredProviderCredentials {
	return {
		generation,
		readiness: "pending",
		source: source.type,
		configured: true,
		authenticated: false,
		oauthAuth: source.type === "oauth-u2m" ? { workspaceHost: source.workspaceHost } : undefined,
	};
}

function authenticatedOAuthRecord(
	source: Extract<CredentialSourceInput, { type: "oauth-device" | "oauth-u2m" }>,
	tokens: TokenData,
	generation: string,
): StoredProviderCredentials {
	const expiresAt = new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
	return {
		generation,
		readiness: "ready",
		source: source.type,
		configured: true,
		authenticated: true,
		oauthAuth: {
			tokenData: {
				accessToken: tokens.accessToken,
				refreshToken: tokens.refreshToken,
				expiresAt,
				tokenType: tokens.tokenType,
				scope: tokens.scope,
			},
			expiresAt,
			scope: tokens.scope,
			...(source.type === "oauth-u2m" ? { workspaceHost: source.workspaceHost } : {}),
		},
	};
}

function terminalOAuthRecord(
	source: CredentialSourceInput,
	generation: string,
	error?: string,
): StoredProviderCredentials {
	if (source.type !== "oauth-device" && source.type !== "oauth-u2m") {
		return {
			generation,
			readiness: "unauthenticated",
			configured: false,
			authenticated: false,
			error,
		};
	}
	return {
		generation,
		readiness: "unauthenticated",
		source: source.type,
		configured: true,
		authenticated: false,
		error,
		oauthAuth: source.type === "oauth-u2m" ? { workspaceHost: source.workspaceHost } : undefined,
	};
}

function sourceMetadata(source: CredentialSourceInput): Record<string, unknown> | undefined {
	if (source.type === "api-key" && source.baseUrl) return { baseUrl: source.baseUrl };
	if (source.type === "oauth-u2m" || source.type === "oauth-m2m") {
		return { workspaceHost: source.workspaceHost };
	}
	if (source.type === "local") return { endpoint: source.endpoint };
	if (source.type === "google-cloud") return { project: source.project, location: source.location };
	return undefined;
}

function defaultGeneration(): string {
	const bytes = new Uint8Array(16);
	globalThis.crypto.getRandomValues(bytes);
	return [...bytes].map((value) => value.toString(16).padStart(2, "0")).join("");
}
