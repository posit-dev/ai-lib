/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Raw HTTP request/response logging
 *
 * A fetch wrapper that captures the exact bytes sent to and received from an
 * LLM provider, for debugging wire-level problems (e.g. a provider rejecting a
 * request as invalid) where the AI SDK's structured request/response view
 * (JsonRequestLogger) hides the actual wire format.
 *
 * Opt-in, two mechanisms:
 *
 * 1. Late-binding directory: `configureRawHttpLogging({ outputDir })` is called
 *    once at startup by @assistant/node with the platform log dir. Logging is
 *    active only while that directory exists on disk — a developer enables it
 *    mid-session with `mkdir -p <dir>` and disables it by removing the dir.
 * 2. Explicit override: the `PA_RAW_HTTP_LOG_DIR` environment variable. When
 *    set, the directory is created automatically and logging is always on.
 *
 * Output: two files per HTTP call sharing a `{timestamp}-{provider}-{model}-{seq}`
 * base name:
 *
 * - `...-request.http`: request line, headers (best-effort reconstruction; the
 *   Fetch API hides exact wire order/casing), blank line, then the body
 *   byte-for-byte as sent.
 * - `...-response.http`: status line, headers, blank line, then the body
 *   byte-for-byte as received (SSE chunks concatenated verbatim). Written when
 *   the body stream completes; on error, whatever bytes arrived plus an
 *   `[error: ...]` marker.
 *
 * Credential-bearing header values (authorization, api-key, token, secret,
 * etc.) are replaced with `[REDACTED]`. Bodies are never modified.
 *
 * All logging failures are swallowed: the wrapped fetch never throws for
 * logging reasons and never alters the bytes seen by the SDK.
 */

import { existsSync, mkdirSync, writeFile } from "node:fs";
import { join } from "node:path";

const ENV_VAR = "PA_RAW_HTTP_LOG_DIR";

/**
 * Headers whose values are replaced with [REDACTED] in log files. "token"
 * only matches as a trailing segment (`x-auth-token`, `session-token`) so
 * rate-limit headers like `anthropic-ratelimit-tokens-remaining` survive.
 */
const SENSITIVE_HEADER_PATTERN =
	/authorization|api[-_]?key|secret|x-amz-security-token|(?:^|[-_])token$/i;

let configuredOutputDir: string | undefined;
let envDirCreated = false;
let sequence = 0;

/**
 * Register the late-binding output directory. Called once at startup by
 * @assistant/node. Logging via this directory is active only while it exists
 * on disk (checked per chat() call).
 */
export function configureRawHttpLogging(config: { outputDir: string }): void {
	configuredOutputDir = config.outputDir;
}

/** Test hook: reset module state between tests. */
export function resetRawHttpLoggingForTests(): void {
	configuredOutputDir = undefined;
	envDirCreated = false;
	sequence = 0;
}

/**
 * Resolve the active output directory for this call, or undefined if logging
 * is disabled. Env var wins and is always-on; the configured dir is
 * late-binding (must exist on disk).
 */
function resolveOutputDir(): string | undefined {
	const envDir = process.env[ENV_VAR];
	if (envDir) {
		if (!envDirCreated) {
			try {
				mkdirSync(envDir, { recursive: true });
				envDirCreated = true;
			} catch {
				return undefined;
			}
		}
		return envDir;
	}
	if (configuredOutputDir && existsSync(configuredOutputDir)) {
		return configuredOutputDir;
	}
	return undefined;
}

/** Make a string safe for use in a file name. */
function sanitizeForFilename(value: string): string {
	return value.replace(/[^a-zA-Z0-9._-]/g, "-");
}

/** Filesystem-safe timestamp (colons and dots are problematic on Windows). */
function timestamp(): string {
	return new Date().toISOString().replace(/[:.]/g, "-");
}

function redactHeaders(headers: Headers): string[] {
	const lines: string[] = [];
	headers.forEach((value, name) => {
		lines.push(`${name}: ${SENSITIVE_HEADER_PATTERN.test(name) ? "[REDACTED]" : value}`);
	});
	return lines;
}

/**
 * Result of capturing a request body. `immediate` is set when the bytes are
 * available synchronously (the common case: the AI SDK sends JSON strings).
 * `pending` is set for stream bodies, where the bytes only become available
 * as the underlying fetch consumes the stream.
 */
type CapturedBody = { immediate: Buffer | undefined } | { pending: Promise<Buffer> };

/**
 * Best-effort extraction of the request body as raw bytes, without disturbing
 * the body that will be passed to the underlying fetch.
 *
 * - string/Buffer/TypedArray/ArrayBuffer bodies are copied directly.
 * - ReadableStream bodies are tee'd: `init.body` is replaced with one branch
 *   and the other is buffered in the background for the log.
 * - Request-object bodies are cloned before the original is consumed.
 */
function captureRequestBody(
	input: string | URL | Request,
	init: RequestInit | undefined,
): CapturedBody {
	const body = init?.body;
	if (body === null || body === undefined) {
		if (input instanceof Request && input.body !== null) {
			const clone = input.clone();
			return {
				pending: clone.arrayBuffer().then((buf) => Buffer.from(buf)),
			};
		}
		return { immediate: undefined };
	}
	if (typeof body === "string") {
		return { immediate: Buffer.from(body, "utf8") };
	}
	if (body instanceof ArrayBuffer) {
		return { immediate: Buffer.from(body) };
	}
	if (ArrayBuffer.isView(body)) {
		return { immediate: Buffer.from(body.buffer, body.byteOffset, body.byteLength) };
	}
	if (body instanceof ReadableStream) {
		const [forFetch, forLog] = body.tee();
		init!.body = forFetch;
		return {
			pending: (async () => {
				const chunks: Buffer[] = [];
				const reader = forLog.getReader();
				for (;;) {
					const { done, value } = await reader.read();
					if (done) {
						break;
					}
					chunks.push(Buffer.from(value));
				}
				return Buffer.concat(chunks);
			})(),
		};
	}
	// URLSearchParams, FormData, Blob, etc. — not produced by the AI SDK;
	// skip capture rather than risk disturbing the request.
	return { immediate: undefined };
}

function formatRequestFile(
	method: string,
	url: URL,
	headers: Headers,
	body: Buffer | undefined,
): Buffer {
	const lines = [
		`${method} ${url.pathname}${url.search} HTTP/1.1`,
		`host: ${url.host}`,
		...redactHeaders(headers),
		"",
	];
	return Buffer.concat([Buffer.from(lines.join("\n") + "\n", "utf8"), body ?? Buffer.alloc(0)]);
}

function formatResponseFile(response: Response, body: Buffer, error?: unknown): Buffer {
	const lines = [
		`HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd(),
		...redactHeaders(response.headers),
		"",
	];
	const parts = [Buffer.from(lines.join("\n") + "\n", "utf8"), body];
	if (error !== undefined) {
		parts.push(
			Buffer.from(
				`\n\n[error: ${error instanceof Error ? error.message : String(error)}]\n`,
				"utf8",
			),
		);
	}
	return Buffer.concat(parts);
}

function writeLogFile(outputDir: string, baseName: string, suffix: string, contents: Buffer): void {
	writeFile(join(outputDir, `${baseName}-${suffix}.http`), contents, () => {
		// Errors are swallowed by design: logging must never break a request.
	});
}

/**
 * Wrap a fetch implementation so every call is logged to the active raw-HTTP
 * log directory. Returns undefined when logging is disabled, so callers can
 * conditionally spread the result into provider options without changing
 * behavior in the common case.
 *
 * @param fetchFn - The fetch the client would otherwise use (may be undefined
 *   to wrap the global fetch).
 * @param context - Provider and model names, used in log file names.
 */
export function withRawHttpLogging(
	fetchFn: typeof globalThis.fetch | undefined,
	context: { provider: string; model: string },
): typeof globalThis.fetch | undefined {
	const outputDir = resolveOutputDir();
	if (!outputDir) {
		return undefined;
	}
	const underlying = fetchFn ?? globalThis.fetch;
	const provider = sanitizeForFilename(context.provider);
	const model = sanitizeForFilename(context.model);

	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const baseName = `${timestamp()}-${provider}-${model}-${sequence++}`;

		// Capture the request (teeing stream bodies so the SDK's bytes are
		// undisturbed) and write the request file — immediately for
		// already-available bodies, in the background for stream bodies.
		try {
			const captured = captureRequestBody(input, init);
			let method = "POST";
			let url: URL | undefined;
			let requestHeaders = new Headers();
			if (input instanceof Request) {
				method = input.method;
				url = new URL(input.url);
				requestHeaders = new Headers(input.headers);
			}
			if (init) {
				if (init.method) {
					method = init.method;
				}
				if (init.headers) {
					requestHeaders = new Headers(init.headers);
				}
			}
			if (!url) {
				url = new URL(
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
				);
			}
			const resolvedUrl = url;
			const writeRequest = (body: Buffer | undefined) =>
				writeLogFile(
					outputDir,
					baseName,
					"request",
					formatRequestFile(method, resolvedUrl, requestHeaders, body),
				);
			if ("pending" in captured) {
				void captured.pending.then(writeRequest, () => writeRequest(undefined));
			} else {
				writeRequest(captured.immediate);
			}
		} catch {
			// Swallow: never let logging break the request.
		}

		let response: Response;
		try {
			response = await underlying(input, init);
		} catch (error) {
			// Record the transport-level failure, then rethrow.
			try {
				writeLogFile(
					outputDir,
					baseName,
					"response",
					Buffer.from(
						`HTTP/1.1 0 ERROR\n\n[error: ${error instanceof Error ? error.message : String(error)}]\n`,
						"utf8",
					),
				);
			} catch {
				// Swallow.
			}
			throw error;
		}

		// Tee the response body: the SDK reads the original; a background clone
		// accumulates the raw bytes and writes the response file on completion.
		try {
			const clone = response.clone();
			void (async () => {
				let body: Buffer;
				let error: unknown;
				try {
					body = Buffer.from(await clone.arrayBuffer());
				} catch (readError) {
					body = Buffer.alloc(0);
					error = readError;
				}
				try {
					writeLogFile(outputDir, baseName, "response", formatResponseFile(response, body, error));
				} catch {
					// Swallow.
				}
			})();
		} catch {
			// Swallow.
		}

		return response;
	};
}
