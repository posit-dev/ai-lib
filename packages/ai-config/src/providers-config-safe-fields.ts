/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Which providers.json fields a settings report may show, declared next to
 * the schema (`schema.ts`). Masked by default: a field not declared here,
 * including any field added to the schema later, renders as `"<masked>"`
 * with its key name kept. The declarations are typed against the schema's
 * inferred types, so a misspelled or removed field fails to compile.
 *
 * - `safe`: shown as-is (a scalar or a list of scalars).
 * - `url`: shown without userinfo, query string or fragment.
 * - `configured`: shown only as `"<configured>"` (`apiKeyHelper`).
 *
 * Deliberately undeclared, so masked: `customHeaders.*`, and every field of
 * an `agentEngines.acp.*` agent (`command`, `args`, `env.*`, ...).
 */

import { isPlainObject } from "./is-plain-object.js";
import type {
	AgentEnginesConfig,
	BuiltinProviderBlock,
	CustomModel,
	ModelOverride,
	ProvidersConfigFragment,
	ProvidersMapFragment,
} from "./types.js";

/** How a masked value renders. */
export const MASKED_VALUE = "<masked>";

/** How a configured `apiKeyHelper` renders. */
export const CONFIGURED_VALUE = "<configured>";

type FieldDisplay = "safe" | "url" | "configured";

/** A rule for a value of type `V`: a display, or rules for its parts. */
type FieldRule<V> =
	| FieldDisplay
	| (V extends readonly (infer E)[]
			? { readonly "[]": FieldRule<NonNullable<E>> }
			: V extends object
				? FieldRules<V>
				: never);

/** Rules per field of `T`; `"*"` covers record keys (provider ids, model ids, ...). */
type FieldRules<T> = { readonly [K in keyof T]?: FieldRule<NonNullable<T[K]>> } & {
	readonly "*"?: FieldRule<NonNullable<T[keyof T]>>;
};

const MODEL_OVERRIDE_FIELDS = {
	name: "safe",
	family: "safe",
	maxContextLength: "safe",
	maxInputTokens: "safe",
	maxOutputTokens: "safe",
	protocol: "safe",
	baseUrl: "url",
	supportsTools: "safe",
	supportsImages: "safe",
	supportsToolResultImages: "safe",
	supportedInputMediaTypes: "safe",
	supportsWebSearch: "safe",
	thinkingEffortLevels: "safe",
} as const satisfies FieldRules<ModelOverride>;

const CUSTOM_MODEL_FIELDS = {
	...MODEL_OVERRIDE_FIELDS,
	id: "safe",
} as const satisfies FieldRules<CustomModel>;

const PROVIDER_BLOCK_FIELDS = {
	enabled: "safe",
	baseUrl: "url",
	endpoint: "url",
	protocol: "safe",
	endpoints: { "*": "url" },
	models: {
		discovery: "safe",
		allow: "safe",
		deny: "safe",
		overrides: { "*": MODEL_OVERRIDE_FIELDS },
		custom: { "[]": CUSTOM_MODEL_FIELDS },
	},
	aws: { region: "safe", profile: "safe" },
	azure: { authMode: "safe", scope: "safe", tenantId: "safe" },
	googleCloud: { project: "safe", location: "safe" },
	// `account` becomes a URL authority (`https://<account>.snowflakecomputing.com`).
	snowflake: { account: "url", host: "url", home: "safe", connectionName: "safe" },
	databricks: { host: "url" },
	positaiLogin: { host: "url", clientId: "safe", scope: "safe" },
	apiKeyHelper: "configured",
	product: "safe",
	keyType: "safe",
} as const satisfies FieldRules<BuiltinProviderBlock>;

const CUSTOM_ENTRY_FIELDS = {
	...PROVIDER_BLOCK_FIELDS,
	type: "safe",
	apiKeyOptional: "safe",
} as const satisfies FieldRules<NonNullable<NonNullable<ProvidersMapFragment["custom"]>[string]>>;

const AGENT_ENGINES_FIELDS = {
	enabled: "safe",
	idleSessionMinutes: "safe",
	maxLiveSessions: "safe",
	downloadBinaries: "safe",
	claude: { enabled: "safe", executablePath: "safe", configDir: "safe" },
	copilot: {
		enabled: "safe",
		runtimePath: "safe",
		baseDirectory: "safe",
		defaultModel: "safe",
		allowNamedPrincipals: "safe",
	},
	codex: {
		enabled: "safe",
		executablePath: "safe",
		homeDirectory: "safe",
		defaultModel: "safe",
		allowNamedPrincipals: "safe",
	},
} as const satisfies FieldRules<AgentEnginesConfig>;

const PROVIDERS_CONFIG_FIELDS = {
	$schema: "url",
	version: "safe",
	providers: {
		"*": PROVIDER_BLOCK_FIELDS,
		default: { enabled: "safe" },
		custom: { "*": CUSTOM_ENTRY_FIELDS },
	},
	agentEngines: AGENT_ENGINES_FIELDS,
} as const satisfies FieldRules<ProvidersConfigFragment>;

/** The declarations above, walked by key at runtime. */
type RuleNode = FieldDisplay | { readonly [key: string]: RuleNode };

const ROOT: RuleNode = PROVIDERS_CONFIG_FIELDS;

/**
 * Mask the value found at `path` (from the config root) for display. Objects
 * keep their keys; every undeclared leaf becomes {@link MASKED_VALUE}.
 */
export function maskProvidersConfigValue(path: readonly string[], value: unknown): unknown {
	let rule: RuleNode | undefined = ROOT;
	for (const key of path) rule = childRule(rule, key);
	return maskWith(rule, value);
}

function childRule(rule: RuleNode | undefined, key: string): RuleNode | undefined {
	if (rule === undefined || typeof rule === "string") return undefined;
	// Own keys only: a header or model named `constructor` must not match.
	if (Object.hasOwn(rule, key)) return rule[key];
	return Object.hasOwn(rule, "*") ? rule["*"] : undefined;
}

function maskWith(rule: RuleNode | undefined, value: unknown): unknown {
	if (value === undefined) return undefined;
	switch (rule) {
		case "configured":
			return CONFIGURED_VALUE;
		case "safe":
			return isScalarOrScalarList(value) ? value : maskWith(undefined, value);
		case "url":
			return typeof value === "string" ? stripUrlSecrets(value) : MASKED_VALUE;
	}
	if (Array.isArray(value)) {
		const itemRule = rule !== undefined && Object.hasOwn(rule, "[]") ? rule["[]"] : undefined;
		return itemRule === undefined ? MASKED_VALUE : value.map((item) => maskWith(itemRule, item));
	}
	if (isPlainObject(value)) {
		return Object.fromEntries(
			Object.entries(value).map(([key, child]) => [key, maskWith(childRule(rule, key), child)]),
		);
	}
	return MASKED_VALUE;
}

export function isScalarOrScalarList(value: unknown): boolean {
	const isScalar = (v: unknown) =>
		v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean";
	return isScalar(value) || (Array.isArray(value) && value.every(isScalar));
}

/**
 * Remove userinfo, query string and fragment from a URL-like string.
 *
 * Only the text after the last `@` is certainly not userinfo: a password may
 * itself contain `/`, `\`, `?` or `#`, which a parser reads as the end of the
 * authority. So everything before the last `@` goes first (except a leading
 * `scheme:/` or `//`), even when that over-strips an `@` in a path or query.
 * What remains is read the way a client would (`new URL`), so a lenient
 * spelling such as `https:/host` is normalized; a bare host or anything
 * unparseable just loses its query and fragment.
 */
export function stripUrlSecrets(url: string): string {
	const trimmed = url.trim();
	const at = trimmed.lastIndexOf("@");
	const rest =
		at < 0
			? trimmed
			: (/^(?:[a-z][a-z0-9+.-]*:)?[/\\]+/i.exec(trimmed.slice(0, at))?.[0] ?? "") +
				trimmed.slice(at + 1);
	const parsed = parseUrlWithHost(rest);
	if (parsed) {
		// Keep a bare origin bare: `URL` would add a `/` path.
		const explicitRoot = /^[^?#]*\/(?:[?#]|$)/.test(rest);
		const path = parsed.pathname === "/" && !explicitRoot ? "" : parsed.pathname;
		return `${parsed.protocol}//${parsed.host}${path}`;
	}
	return rest.split(/[?#]/, 1)[0];
}

function parseUrlWithHost(url: string): URL | undefined {
	try {
		const parsed = new URL(url);
		return parsed.host === "" ? undefined : parsed;
	} catch {
		return undefined;
	}
}
