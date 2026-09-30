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
	const status = (error as { response?: { status?: unknown } }).response?.status;
	if (typeof status === "number") return status === 429 || status >= 500;
	// Request timeouts arrive as named aborts with no error code.
	const name = (error as { name?: unknown }).name;
	if (name === "AbortError" || name === "TimeoutError") return true;
	const code = (error as { code?: unknown }).code;
	return typeof code === "string" && TRANSIENT_NETWORK_CODES.has(code);
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

async function tokenFrom(auth: GoogleAuth): Promise<string | undefined> {
	const client = await auth.getClient();
	const { token } = await client.getAccessToken();
	return token ?? undefined;
}

/**
 * A cloud-platform access token for the Vertex REST API. An inline failure is
 * surfaced rather than masked by an ADC "no credentials" error, because setting
 * both inline variables signals explicit intent; transient token-service
 * failures pass through unchanged.
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
			const token = await tokenFrom(auth);
			if (!token) {
				throw new Error("Failed to obtain access token from Application Default Credentials");
			}
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
