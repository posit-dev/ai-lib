/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { isBuiltinProviderId, PROVIDER_CONNECTION_DEFAULTS } from "ai-config";
import type { ResolvedConnection, ResolvedProvider } from "ai-config";

import type { HeadlessProviderData } from "./types.js";

export function toHeadlessProviderData(provider: ResolvedProvider): HeadlessProviderData {
	const connection = provider.connection;
	const builtin = isBuiltinProviderId(provider.id);
	const customizedConnection = customizedConnectionFields(
		connection,
		builtin ? PROVIDER_CONNECTION_DEFAULTS[provider.id] : undefined,
	);
	return {
		id: provider.id,
		enabled: provider.enabled,
		...(builtin ? {} : { custom: true as const }),
		...(connection.baseUrl !== undefined && { baseUrl: connection.baseUrl }),
		...(connection.positaiLogin?.scope !== undefined && {
			positaiLoginScope: connection.positaiLogin.scope,
		}),
		...(customizedConnection && { customizedConnection }),
	};
}

/**
 * The connection fields whose resolved value differs from the provider's
 * built-in defaults, as dotted names. The resolved connection alone reads as
 * "customized" on a stock install, because ai-config layers built-in defaults
 * (positai's baseUrl, ollama's endpoint, google-vertex's location) under the
 * user/enforced config; diffing against those defaults recovers "set by the
 * user or an administrator". For a custom provider there are no defaults, so
 * every set field counts -- accurate, since its whole connection is
 * user-defined. Names only: no value this function reads reaches its result.
 * @param connection The provider's resolved connection.
 * @param defaults ai-config's built-in defaults for the provider, when it has any.
 */
export function customizedConnectionFields(
	connection: ResolvedConnection,
	defaults: ResolvedConnection | undefined,
): string[] | undefined {
	const fields: string[] = [];
	if (connection.baseUrl !== undefined && connection.baseUrl !== defaults?.baseUrl) {
		fields.push("baseUrl");
	}
	if (connection.endpoint !== undefined && connection.endpoint !== defaults?.endpoint) {
		fields.push("endpoint");
	}
	// No built-in default carries headers, so any non-empty map is the user's.
	if (connection.customHeaders && Object.keys(connection.customHeaders).length > 0) {
		fields.push("customHeaders");
	}
	const groups: Record<
		string,
		[Record<string, unknown> | undefined, Record<string, unknown> | undefined]
	> = {
		aws: [connection.aws, defaults?.aws],
		googleCloud: [connection.googleCloud, defaults?.googleCloud],
		snowflake: [connection.snowflake, defaults?.snowflake],
		databricks: [connection.databricks, defaults?.databricks],
		azure: [connection.azure, defaults?.azure],
	};
	for (const [group, [values, defaultValues]] of Object.entries(groups)) {
		for (const [name, value] of Object.entries(values ?? {})) {
			if (value !== undefined && value !== defaultValues?.[name]) {
				fields.push(`${group}.${name}`);
			}
		}
	}
	return fields.length > 0 ? fields : undefined;
}
