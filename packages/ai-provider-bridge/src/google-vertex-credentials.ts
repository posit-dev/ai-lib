/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Google Vertex credential source resolution.
 *
 * Owns the Vertex credential precedence — a brokered access token, then an
 * inline service account (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`), then
 * Application Default Credentials — so model discovery, the chat SDK and the
 * auth-error guidance all act on the same resolved source.
 */

import type * as NodeFs from "node:fs";
import type * as NodePath from "node:path";

import {
	readSdkCredentialEnvironment,
	type SdkCredentialEnvironment,
} from "ai-credentials/store-backend";
import {
	GoogleAuth,
	OAuth2Client,
	type GoogleAuthOptions,
	type JWTInput,
} from "google-auth-library";

// Looked up lazily so this module stays bundleable for browser targets.
const nodeFs =
	typeof process !== "undefined"
		? (process.getBuiltinModule?.("node:fs") as typeof NodeFs | undefined)
		: undefined;
const nodePath =
	typeof process !== "undefined"
		? (process.getBuiltinModule?.("node:path") as typeof NodePath | undefined)
		: undefined;

type CredentialEnvironment = Readonly<Record<string, string | undefined>>;

/** The credential Vertex requests authenticate with, in precedence order. */
export type GoogleVertexCredentialSource =
	/** A token from a credential broker (e.g. Positron's auth extension). */
	| { kind: "brokered"; accessToken: string }
	/** A service account from `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`. */
	| { kind: "inline"; serviceAccount: JWTInput }
	/**
	 * Application Default Credentials. `keyFilename` is the captured ADC path
	 * from a host that scrubbed process.env; when undefined, google-auth-library
	 * resolves ADC from the ambient environment itself.
	 */
	| { kind: "adc"; keyFilename: string | undefined };

const CLOUD_PLATFORM_SCOPE = "https://www.googleapis.com/auth/cloud-platform";

const INLINE_SERVICE_ACCOUNT_ERROR = "InlineServiceAccountError";

/** The inline service-account variables were set but Google rejected them; ADC is deliberately not tried. */
class InlineServiceAccountError extends Error {
	constructor(cause: string) {
		super(`Inline service-account credentials failed: ${cause}`);
		this.name = INLINE_SERVICE_ACCOUNT_ERROR;
	}
}

/** Whether Google rejected the inline service-account credentials while minting a token. */
export function isInlineServiceAccountError(error: unknown): boolean {
	return error instanceof Error && error.name === INLINE_SERVICE_ACCOUNT_ERROR;
}

const ADC_ERROR = "ApplicationDefaultCredentialsError";

/** Application Default Credentials could not be loaded or were rejected, e.g. a missing key file. */
class ApplicationDefaultCredentialsError extends Error {
	constructor(cause: string) {
		super(`Application Default Credentials failed: ${cause}`);
		this.name = ADC_ERROR;
	}
}

/** Whether Application Default Credentials failed for a reason other than a transient network error. */
export function isApplicationDefaultCredentialsError(error: unknown): boolean {
	return error instanceof Error && error.name === ADC_ERROR;
}

const TRANSIENT_NETWORK_CODES: ReadonlySet<string> = new Set([
	"ECONNRESET",
	"ETIMEDOUT",
	"ECONNREFUSED",
	"ECONNABORTED",
	"ENOTFOUND",
	"EAI_AGAIN",
	"ENETUNREACH",
	"EHOSTUNREACH",
]);

/** A token-exchange failure that says nothing about the credentials: throttling, a server error, or no response. */
function isTransientTokenError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false;
	if (
		"response" in error &&
		typeof error.response === "object" &&
		error.response !== null &&
		"status" in error.response
	) {
		const { status } = error.response;
		if (typeof status === "number") return status === 429 || status >= 500;
	}
	// Request timeouts arrive as named aborts with no error code.
	if ("name" in error && (error.name === "AbortError" || error.name === "TimeoutError")) {
		return true;
	}
	return (
		"code" in error && typeof error.code === "string" && TRANSIENT_NETWORK_CODES.has(error.code)
	);
}

/** The inline service account, or undefined unless both the email and the private key are set. */
function inlineServiceAccount(sdkEnvironment: SdkCredentialEnvironment): JWTInput | undefined {
	const clientEmail = sdkEnvironment.googleClientEmail;
	const privateKey = sdkEnvironment.googlePrivateKey;
	if (!clientEmail || !privateKey) return undefined;
	return {
		client_email: clientEmail,
		// google-auth-library needs literal newlines; pasted keys carry escaped `\n`.
		private_key: privateKey.replace(/\\n/g, "\n"),
		...(sdkEnvironment.googlePrivateKeyId && {
			private_key_id: sdkEnvironment.googlePrivateKeyId,
		}),
	};
}

/**
 * Decide which credential Vertex requests use: the brokered token when one is
 * supplied, else the inline service account, else Application Default
 * Credentials. Reads the captured `credentialEnvironment` when a scrubbing host
 * supplies one, `process.env` otherwise.
 */
export function resolveGoogleVertexCredentialSource(
	accessToken: string | undefined,
	credentialEnvironment: CredentialEnvironment | undefined,
): GoogleVertexCredentialSource {
	if (accessToken) return { kind: "brokered", accessToken };
	const sdkEnvironment = readSdkCredentialEnvironment(credentialEnvironment ?? process.env);
	const serviceAccount = inlineServiceAccount(sdkEnvironment);
	if (serviceAccount) return { kind: "inline", serviceAccount };
	return {
		kind: "adc",
		keyFilename: credentialEnvironment ? sdkEnvironment.googleApplicationCredentials : undefined,
	};
}

/** google-auth-library options for the Vertex chat SDK, or undefined to let it resolve ADC itself. */
export function googleVertexAuthOptions(
	source: GoogleVertexCredentialSource,
): GoogleAuthOptions | undefined {
	switch (source.kind) {
		case "brokered": {
			const authClient = new OAuth2Client();
			authClient.setCredentials({ access_token: source.accessToken });
			return { authClient };
		}
		case "inline":
			return { credentials: source.serviceAccount, scopes: [CLOUD_PLATFORM_SCOPE] };
		case "adc":
			return source.keyFilename ? { keyFilename: source.keyFilename } : undefined;
	}
}

/** Where gcloud writes ADC, following google-auth-library's well-known file lookup. */
function wellKnownAdcFile(path: typeof NodePath): string | undefined {
	const configDir =
		process.platform === "win32"
			? process.env.APPDATA
			: process.env.HOME && path.join(process.env.HOME, ".config");
	return configDir && path.join(configDir, "gcloud", "application_default_credentials.json");
}

/**
 * Where the credential comes from, for logs. For ADC this names the file
 * google-auth-library will read and whether it exists, since a stale
 * `GOOGLE_APPLICATION_CREDENTIALS` path fails without falling back to gcloud's file.
 */
export function describeGoogleVertexCredentialSource(source: GoogleVertexCredentialSource): string {
	switch (source.kind) {
		case "brokered":
			return "a token from the host's credential broker";
		case "inline":
			return "the inline service account in GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY";
		case "adc": {
			// With no captured path, google-auth-library reads the ambient environment itself.
			const envFile =
				source.keyFilename ??
				readSdkCredentialEnvironment(process.env).googleApplicationCredentials;
			if (envFile) {
				const missing = nodeFs && !nodeFs.existsSync(envFile) ? ", which does not exist" : "";
				return `Application Default Credentials from GOOGLE_APPLICATION_CREDENTIALS (${envFile}${missing})`;
			}
			if (!nodeFs || !nodePath) return "Application Default Credentials";
			const gcloudFile = wellKnownAdcFile(nodePath);
			if (gcloudFile && nodeFs.existsSync(gcloudFile)) {
				return `Application Default Credentials from gcloud's file (${gcloudFile})`;
			}
			return `Application Default Credentials with no file (GOOGLE_APPLICATION_CREDENTIALS is unset and there is no gcloud file at ${gcloudFile ?? "the default location"}), so only the metadata server can supply them`;
		}
	}
}

async function tokenFrom(auth: GoogleAuth): Promise<string | undefined> {
	const client = await auth.getClient();
	const { token } = await client.getAccessToken();
	return token ?? undefined;
}

/**
 * A cloud-platform access token for the Vertex REST API. An inline failure is
 * surfaced rather than masked by an ADC "no credentials" error, because setting
 * both inline variables signals explicit intent. Other inline and ADC failures
 * come back as typed credential errors; transient token-service failures pass
 * through unchanged.
 */
export async function mintGoogleVertexAccessToken(
	source: GoogleVertexCredentialSource,
): Promise<string> {
	switch (source.kind) {
		case "brokered":
			return source.accessToken;
		case "inline": {
			const auth = new GoogleAuth({
				credentials: source.serviceAccount,
				scopes: [CLOUD_PLATFORM_SCOPE],
			});
			let token: string | undefined;
			try {
				token = await tokenFrom(auth);
			} catch (err) {
				if (isTransientTokenError(err)) throw err;
				const message = err instanceof Error ? err.message : String(err);
				throw new InlineServiceAccountError(message);
			}
			if (!token) throw new InlineServiceAccountError("no access token was returned");
			return token;
		}
		case "adc": {
			const auth = new GoogleAuth({
				scopes: [CLOUD_PLATFORM_SCOPE],
				keyFilename: source.keyFilename,
			});
			let token: string | undefined;
			try {
				token = await tokenFrom(auth);
			} catch (err) {
				if (isTransientTokenError(err)) throw err;
				const message = err instanceof Error ? err.message : String(err);
				throw new ApplicationDefaultCredentialsError(message);
			}
			if (!token) throw new ApplicationDefaultCredentialsError("no access token was returned");
			return token;
		}
	}
}

/**
 * Resolve a cloud-platform access token without a brokered token: inline
 * service-account env vars (`GOOGLE_CLIENT_EMAIL` + `GOOGLE_PRIVATE_KEY`,
 * optional `GOOGLE_PRIVATE_KEY_ID`) first, Application Default Credentials
 * otherwise.
 */
export function resolveGoogleVertexAccessToken(
	credentialEnvironment?: CredentialEnvironment,
): Promise<string> {
	return mintGoogleVertexAccessToken(
		resolveGoogleVertexCredentialSource(undefined, credentialEnvironment),
	);
}
