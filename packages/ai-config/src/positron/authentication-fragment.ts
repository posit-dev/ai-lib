/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Pure builder for the Positron `authentication.*` host fragment.
 *
 * Positron's `authentication.<key>.*` VS Code settings are a transitional
 * **host** layer below `providers.json` (user) and above defaults. This module
 * turns those settings — read through an injected {@link PositronAuthSettingReader}
 * — into an {@link EnforcedProvidersConfig} fragment the resolver folds in at
 * `host` rank.
 *
 * It is **pure**: no `vscode`, no `process`. The vscode wiring (a reader over
 * `vscode.workspace.getConfiguration` + `process.env`) lives in the sibling
 * `index.ts`, so this builder is unit-testable with a mock reader.
 *
 * The mapping (catalog provider id ↔ VS Code `authentication.<configKey>`
 * section, and how to read each) is **injected** as descriptors rather than
 * re-derived here, so `ai-config/positron` never imports `ai-provider-bridge`
 * or `ai-credentials`. The consumer builds descriptors from the bridge's
 * `PROVIDER_MAP` + `CONFIG_KEY_OVERRIDES`, keeping those the single source of
 * truth for configKeys.
 */

import type { BuiltinProviderBlock, EnforcedProvidersConfig } from "../types.js";

/**
 * Reads the `authentication.*` settings the host fragment needs, abstracted
 * over the config source. Mirrors the bridge's `CredentialConfig` shape but is
 * defined locally so `ai-config/positron` carries no `ai-credentials` import.
 */
export interface PositronAuthSettingReader {
	/** `authentication.<configKey>.baseUrl`. */
	getBaseUrl(configKey: string): string | undefined;
	/** `authentication.<configKey>.customHeaders`. */
	getCustomHeaders(configKey: string): Record<string, string> | undefined;
	/** AWS region (`authentication.aws.credentials.AWS_REGION`, `process.env` fallback). */
	getAwsRegion(): string | undefined;
	/**
	 * Snowflake host/account/home (`authentication.snowflake.credentials.{SNOWFLAKE_HOST,
	 * SNOWFLAKE_ACCOUNT,SNOWFLAKE_HOME}`, `process.env` fallback).
	 */
	getSnowflake(): { host?: string; account?: string; home?: string } | undefined;
}

/**
 * One provider's mapping from a catalog id to its `authentication.*` section
 * and how to read it. Emitted by the Positron consumer (one per apikey /
 * aws-credentials provider in `PROVIDER_MAP`; oauth/google-cloud are skipped).
 */
export interface PositronAuthSettingDescriptor {
	/** Catalog provider id, e.g. "anthropic", "ms-foundry", "bedrock". */
	readonly providerId: string;
	/** VS Code `authentication.<configKey>.*` section, e.g. "anthropic", "foundry". */
	readonly configKey: string;
	/**
	 * How to read this provider's connection from authentication.*:
	 * - `"api-key-connection"`: reads BOTH `baseUrl` and `customHeaders` (they
	 *   share the `authentication.<configKey>` namespace).
	 * - `"aws-region"`: reads `authentication.aws.credentials.AWS_REGION`.
	 * - `"snowflake"`: reads `snowflake.credentials.{SNOWFLAKE_HOST,SNOWFLAKE_ACCOUNT,
	 *   SNOWFLAKE_HOME}` (+ `snowflake.customHeaders`), with `process.env` fallback.
	 */
	readonly read: "api-key-connection" | "aws-region" | "snowflake";
	/**
	 * Optional correction applied to the raw `baseUrl` setting value before it
	 * enters the fragment (only meaningful for `"api-key-connection"` reads).
	 * Injected by the consumer — e.g. the bridge's `normalizeBaseUrlForProvider`,
	 * which fixes bare known hosts missing their API version segment — so
	 * ai-config stays free of provider-specific URL knowledge and of any
	 * `ai-provider-bridge` import.
	 */
	readonly normalizeBaseUrl?: (url: string) => string;
}

/**
 * Build the `host` fragment from the `authentication.*` settings.
 *
 * Emits one provider block per descriptor, keyed by the catalog **provider id**
 * (not the configKey). Unset fields are **omitted** — the builder never emits
 * `baseUrl: undefined` or an empty header map, so a host fragment can only
 * contribute values it actually has and can never clobber a lower layer with a
 * blank. Empty-string base URLs and empty header maps normalize to omitted,
 * matching the credential shaper's `|| undefined` semantics.
 */
export function buildAuthenticationFragment(
	reader: PositronAuthSettingReader,
	descriptors: readonly PositronAuthSettingDescriptor[],
): EnforcedProvidersConfig {
	// Accumulate as a plain record keyed by provider id. The strict
	// EnforcedProvidersMap type has no index signature (its keys are the fixed
	// built-in ids plus `default`/`custom`), so a dynamically-keyed accumulator
	// can't be expressed as that type directly — hence the single cast below.
	// Descriptors only ever carry built-in provider ids, so the record is a
	// valid partial built-in map.
	const providers: Record<string, BuiltinProviderBlock> = {};

	for (const descriptor of descriptors) {
		const block = buildBlock(reader, descriptor);
		if (block) {
			providers[descriptor.providerId] = block;
		}
	}

	if (Object.keys(providers).length === 0) {
		return {};
	}

	return { providers: providers as EnforcedProvidersConfig["providers"] };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildBlock(
	reader: PositronAuthSettingReader,
	descriptor: PositronAuthSettingDescriptor,
): BuiltinProviderBlock | undefined {
	switch (descriptor.read) {
		case "api-key-connection":
			return buildApiKeyBlock(reader, descriptor.configKey, descriptor.normalizeBaseUrl);
		case "aws-region":
			return buildAwsRegionBlock(reader);
		case "snowflake":
			return buildSnowflakeBlock(reader, descriptor.configKey);
	}
}

function buildApiKeyBlock(
	reader: PositronAuthSettingReader,
	configKey: string,
	normalizeBaseUrl?: (url: string) => string,
): BuiltinProviderBlock | undefined {
	const block: BuiltinProviderBlock = {};

	const baseUrl = reader.getBaseUrl(configKey) || undefined;
	if (baseUrl) {
		block.baseUrl = normalizeBaseUrl ? normalizeBaseUrl(baseUrl) : baseUrl;
	}

	const customHeaders = normalizeHeaders(reader.getCustomHeaders(configKey));
	if (customHeaders) {
		block.customHeaders = customHeaders;
	}

	return hasKeys(block) ? block : undefined;
}

function buildAwsRegionBlock(reader: PositronAuthSettingReader): BuiltinProviderBlock | undefined {
	const region = reader.getAwsRegion() || undefined;
	return region ? { aws: { region } } : undefined;
}

function buildSnowflakeBlock(
	reader: PositronAuthSettingReader,
	configKey: string,
): BuiltinProviderBlock | undefined {
	const block: BuiltinProviderBlock = {};

	const snow = reader.getSnowflake();
	const snowflake: { host?: string; account?: string; home?: string } = {};
	if (snow?.host) {
		snowflake.host = snow.host;
	}
	if (snow?.account) {
		snowflake.account = snow.account;
	}
	if (snow?.home) {
		snowflake.home = snow.home;
	}
	if (hasKeys(snowflake)) {
		block.snowflake = snowflake;
	}

	const customHeaders = normalizeHeaders(reader.getCustomHeaders(configKey));
	if (customHeaders) {
		block.customHeaders = customHeaders;
	}

	return hasKeys(block) ? block : undefined;
}

/** Empty header maps normalize to `undefined` (match the shaper's pipeline). */
function normalizeHeaders(
	headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
	return headers && Object.keys(headers).length > 0 ? headers : undefined;
}

function hasKeys(obj: object): boolean {
	return Object.keys(obj).length > 0;
}
