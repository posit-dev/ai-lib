/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { AuthorizationCodeReceiver, OAuthGrantConfig } from "./Backend";

export const DATABRICKS_OAUTH_CLIENT_ID = "databricks-cli";
export const DATABRICKS_OAUTH_SCOPES = "all-apis offline_access";

export interface DatabricksOidcEndpoints {
	authorizationEndpoint: string;
	tokenEndpoint: string;
}

const endpointDiscovery = new Map<string, Promise<DatabricksOidcEndpoints>>();

/** Normalize and validate a workspace URL without retaining path/query fragments. */
export function normalizeDatabricksWorkspaceHost(raw: string): string {
	let value = raw.trim();
	if (!value) throw new Error("Databricks workspace URL is required");
	if (!/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(value)) value = `https://${value}`;
	const url = new URL(value);
	if (url.protocol !== "https:") {
		throw new Error("Databricks workspace URL must use HTTPS");
	}
	if (url.username || url.password)
		throw new Error("Databricks workspace URL cannot contain credentials");
	return `${url.protocol}//${url.host}`;
}

/** Discover workspace OAuth endpoints, falling back to the documented workspace paths. */
export async function discoverDatabricksOidcEndpoints(
	workspaceHost: string,
): Promise<DatabricksOidcEndpoints> {
	const host = normalizeDatabricksWorkspaceHost(workspaceHost);
	const existing = endpointDiscovery.get(host);
	if (existing) return existing;

	const discovery = discoverEndpoints(host);
	endpointDiscovery.set(host, discovery);
	try {
		return await discovery;
	} catch (error) {
		endpointDiscovery.delete(host);
		throw error;
	}
}

async function discoverEndpoints(host: string): Promise<DatabricksOidcEndpoints> {
	const response = await fetch(`${host}/.well-known/openid-configuration`);
	if (response.ok) {
		const document: unknown = await response.json();
		if (
			hasStringProperty(document, "authorization_endpoint") &&
			hasStringProperty(document, "token_endpoint")
		) {
			return {
				authorizationEndpoint: validateEndpoint(host, document.authorization_endpoint),
				tokenEndpoint: validateEndpoint(host, document.token_endpoint),
			};
		}
	}
	return {
		authorizationEndpoint: `${host}/oidc/v1/authorize`,
		tokenEndpoint: `${host}/oidc/v1/token`,
	};
}

export async function createDatabricksAuthorizationCodeGrant(input: {
	workspaceHost: string;
	receiver: AuthorizationCodeReceiver;
	clientId?: string;
	scope?: string;
	timeoutMs?: number;
}): Promise<OAuthGrantConfig> {
	const endpoints = await discoverDatabricksOidcEndpoints(input.workspaceHost);
	return {
		grantType: "authorization-code",
		credentialBaseUrl: normalizeDatabricksWorkspaceHost(input.workspaceHost),
		clientId: input.clientId ?? DATABRICKS_OAUTH_CLIENT_ID,
		scope: input.scope ?? DATABRICKS_OAUTH_SCOPES,
		authorizationEndpoint: endpoints.authorizationEndpoint,
		tokenEndpoint: endpoints.tokenEndpoint,
		receiver: input.receiver,
		...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
	};
}

export async function createDatabricksClientCredentialsGrant(input: {
	workspaceHost: string;
	clientId: string;
	clientSecret: string;
	scope?: string;
}): Promise<OAuthGrantConfig> {
	const host = normalizeDatabricksWorkspaceHost(input.workspaceHost);
	const endpoints = await discoverDatabricksOidcEndpoints(host);
	const secretFingerprint = await sha256(input.clientSecret);
	return {
		grantType: "client-credentials",
		credentialBaseUrl: host,
		clientId: input.clientId,
		clientSecret: input.clientSecret,
		scope: input.scope ?? "all-apis",
		tokenEndpoint: endpoints.tokenEndpoint,
		cacheKey: `${host}\n${input.clientId}\n${secretFingerprint}`,
	};
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

async function sha256(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateEndpoint(workspaceHost: string, raw: string): string {
	const endpoint = new URL(raw, workspaceHost);
	const workspace = new URL(workspaceHost);
	if (endpoint.origin !== workspace.origin) {
		throw new Error("Databricks OIDC discovery returned a cross-origin endpoint");
	}
	return endpoint.toString();
}
