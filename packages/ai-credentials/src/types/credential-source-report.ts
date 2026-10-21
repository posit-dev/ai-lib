/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Secret-free explanation of where a provider's credentials come from, for
 * diagnostics such as a settings report.
 *
 * No field can hold a secret. Values are literals, booleans for presence,
 * environment variable names (never values), file paths, timestamps,
 * connection and profile names, provider ids, and reason codes whose wording
 * is fixed in {@link CREDENTIAL_STEP_REASON_TEXT}. Producers must keep it that
 * way: never add a free-form string, a parser or OS error message, or a
 * credential-bearing value.
 *
 * A renderer needs no provider knowledge: each report is a status plus the
 * steps in the order the app checks them, and each step names its kind, the
 * facts read for it, its outcome, and why.
 */

/** The overall verdict for one provider. */
export type CredentialReportStatus =
	/** The deciding step supplies a credential. */
	| "ready"
	/** No step supplies a credential, or the deciding one is not ready. */
	| "not-ready"
	/** The provider is disabled; its steps say what would be used. */
	| "disabled"
	/** The deciding state cannot be read without side effects, so it was not read. */
	| "not-checked";

/** What a step contributed. */
export type CredentialStepOutcome =
	/** This step decides the provider's credential. */
	| "used"
	/** This step would decide, but the provider is disabled. */
	| "would-be-used"
	/** Checked before the deciding step and passed over. */
	| "not-used"
	/** After the deciding step: the app does not look here. Facts are still shown. */
	| "not-consulted"
	/** This step's state cannot be read passively, so it was not read. */
	| "not-checked";

/** Fixed wording for every {@link CredentialStepReason}. */
export const CREDENTIAL_STEP_REASON_TEXT = {
	supplies: "supplies the credential",
	"managed-final": "a managed source decides, even when its credential is not ready",
	"managed-not-run": "no result yet; collecting this report never runs it",
	"no-managed-source": "no managed source handles this provider",
	"entra-mode": 'auth mode is "entra"; stored and environment keys are not used',
	"entra-no-endpoint": 'auth mode is "entra" but no endpoint is configured',
	"not-entra-mode": 'auth mode is not "entra"',
	"earlier-step-decided": "an earlier step decides",
	"stored-checked-first": "the stored credential is checked first",
	"nothing-stored": "nothing stored",
	"stored-unusable": "the stored record has no usable credential (cleared or incomplete)",
	"stored-signed-out": "the stored sign-in is not ready",
	"stored-key-ignored": "a stored API key is not accepted for this provider",
	"stored-key-empty": "the stored API key is empty",
	"no-environment-variables": "no environment variables apply to this provider",
	"no-variables-set": "none of its variables are set",
	"environment-unusable": "the variables that are set do not form a usable credential",
	"invalid-workspace-host": "the Databricks workspace URL is invalid",
	"selection-authoritative": "a selected connection is authoritative, even when it is missing",
	"connection-selected": "a connection is selected",
	"no-connection-selected": "no connection is selected",
	"no-manual-token": "no token is saved or set in the environment",
	"connection-not-found": "the connection is not in connections.toml",
	"no-default-connection": "connections.toml names no default connection",
	"catalog-not-configured":
		"no deliberate connection settings in providers.json or the environment",
	"no-local-endpoint": "no endpoint is configured",
	"ownership-only": "credentials are not inspected on this host; only their owner is shown",
} as const;

/** Why a step had its outcome. Rendered with {@link CREDENTIAL_STEP_REASON_TEXT}. */
export type CredentialStepReason = keyof typeof CREDENTIAL_STEP_REASON_TEXT;

interface CredentialStepBase {
	readonly outcome: CredentialStepOutcome;
	readonly reason: CredentialStepReason;
}

/** A host-managed source (Posit Workbench) or a providers.json `apiKeyHelper`. */
export interface ManagedCredentialStep extends CredentialStepBase {
	readonly kind: "managed";
	/** The source that handles the provider, or `none`. */
	readonly managedBy: "workbench" | "api-key-helper" | "other" | "none";
	/** The source's cached answer; `not-checked` when it has none yet. */
	readonly state: "none" | "available" | "pending" | "unavailable" | "not-checked";
	/** When an available managed credential expires, if known. */
	readonly expiresAt: string | null;
}

/** Microsoft Foundry's Entra mode, which never uses a stored or environment key. */
export interface EntraCredentialStep extends CredentialStepBase {
	readonly kind: "entra";
	readonly entraMode: boolean;
}

/** A credential saved in the credential store. */
export interface StoredCredentialStep extends CredentialStepBase {
	readonly kind: "stored";
	/** Where the store keeps its records (a file path), when known. */
	readonly location: string | null;
	readonly credentialType:
		| "none"
		| "api-key"
		| "oauth"
		| "oauth-client-credentials"
		| "local"
		| "aws"
		| "google-cloud"
		| "unusable";
	readonly readiness: "none" | "ready" | "pending" | "unauthenticated";
	/** When a stored sign-in token expires, if known. */
	readonly expiresAt: string | null;
}

/** Credential environment variables, by name; values are never read into the report. */
export interface EnvironmentCredentialStep extends CredentialStepBase {
	readonly kind: "environment";
	readonly variables: readonly { readonly name: string; readonly set: boolean }[];
}

/** A Snowflake `connections.toml` connection: the selected one, or the file's default. */
export interface SnowflakeConnectionStep extends CredentialStepBase {
	readonly kind: "snowflake-connection";
	readonly selection: "explicit" | "default";
	readonly connectionName: string | null;
	readonly found: boolean;
}

/** A manually entered Snowflake token (stored, or from the environment). */
export interface ManualTokenStep extends CredentialStepBase {
	readonly kind: "manual-token";
	readonly origin: "none" | "stored" | "environment";
}

/** A local provider's endpoint from settings. */
export interface LocalEndpointStep extends CredentialStepBase {
	readonly kind: "local-endpoint";
	readonly configured: boolean;
}

/**
 * Credentials built from connection settings alone. SDK chains are described
 * by their configuration (profile, region, project), not a verified identity.
 */
export interface CatalogFallbackStep extends CredentialStepBase {
	readonly kind: "catalog-fallback";
	readonly method: "aws-sdk-chain" | "google-adc" | "keyless-endpoint" | "local-endpoint";
	/** Whether the settings count as deliberate configuration. */
	readonly configured: boolean;
	readonly awsRegion: string | null;
	readonly awsProfile: string | null;
	readonly googleProject: string | null;
	readonly googleLocation: string | null;
}

/** Who owns the credential on a host that reports ownership only. */
export interface HostOwnershipStep extends CredentialStepBase {
	readonly kind: "host-ownership";
	readonly owner: "vscode-authentication" | "secret-storage" | "local" | "unsupported" | "host";
}

export type CredentialSourceStep =
	| ManagedCredentialStep
	| EntraCredentialStep
	| StoredCredentialStep
	| EnvironmentCredentialStep
	| SnowflakeConnectionStep
	| ManualTokenStep
	| LocalEndpointStep
	| CatalogFallbackStep
	| HostOwnershipStep;

/** Where one provider's credentials come from. */
export interface CredentialSourceReport {
	readonly providerId: string;
	readonly status: CredentialReportStatus;
	/**
	 * The credential belongs to the server operator, not the signed-in user
	 * (authenticated standalone: provider definitions and credential storage
	 * are process-wide).
	 */
	readonly operatorOwned: boolean;
	/** In the order the app checks them. */
	readonly steps: readonly CredentialSourceStep[];
}
