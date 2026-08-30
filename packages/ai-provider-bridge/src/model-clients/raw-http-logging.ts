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
 * Output: two files per HTTP call sharing a
 * `{timestamp}-{provider}-{model}-{nonce}-{seq}` base name (the nonce makes
 * the name unique across processes sharing a directory). Files are published
 * via temp-file-plus-rename, so an existing `.http` file always holds
 * complete contents.
 *
 * - `...-request.http`: request line, headers (best-effort reconstruction; the
 *   Fetch API hides exact wire order/casing), blank line, then the body
 *   byte-for-byte as sent.
 * - `...-response.http`: status line, headers, blank line, then the body
 *   byte-for-byte as received (SSE chunks concatenated verbatim). Written when
 *   the body stream completes; on error or cancellation, whatever bytes
 *   arrived plus an `[error: ...]` marker.
 *
 * Credential-bearing header values (authorization, api-key, token, secret,
 * etc.) are replaced with `[REDACTED]`. Bodies are never modified.
 *
 * All logging failures are swallowed: the wrapped fetch never throws for
 * logging reasons and never alters the bytes seen by the SDK.
 */

const ENV_VAR = "PA_RAW_HTTP_LOG_DIR";

/**
 * Node builtins are looked up lazily (never imported statically) so this
 * module stays bundleable for browser targets like the Positron webview
 * frontend, which shares chunks with the model clients. Outside Node,
 * `nodeFs` is undefined and logging is simply disabled.
 */
const nodeFs =
	typeof process !== "undefined"
		? (process.getBuiltinModule?.("node:fs") as typeof import("node:fs") | undefined)
		: undefined;

/**
 * Headers whose values are replaced with [REDACTED] in log files. "token"
 * only matches as a trailing segment (`x-auth-token`, `session-token`) so
 * rate-limit headers like `anthropic-ratelimit-tokens-remaining` survive.
 */
const SENSITIVE_HEADER_PATTERN =
	/authorization|api[-_]?key|secret|x-amz-security-token|(?:^|[-_])token$|cookie/i;

let configuredOutputDir: string | undefined;
let sequence = 0;

/**
 * Process-unique filename component: multiple Assistant/RStudio/TUI processes
 * can share one log directory, and millisecond timestamps plus a
 * process-local sequence would collide between them.
 */
const processNonce =
	typeof globalThis.crypto?.randomUUID === "function"
		? globalThis.crypto.randomUUID()
		: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

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
	sequence = 0;
}

/**
 * Resolve the active output directory for this call, or undefined if logging
 * is disabled. Env var wins and is always-on; the configured dir is
 * late-binding (must exist on disk).
 */
function resolveOutputDir(): string | undefined {
	if (!nodeFs || typeof process === "undefined") {
		return undefined;
	}
	const envDir = process.env[ENV_VAR];
	if (envDir) {
		// Idempotent: recreates the directory if it was deleted mid-session
		// and picks up env-var changes between calls.
		try {
			nodeFs.mkdirSync(envDir, { recursive: true });
		} catch {
			return undefined;
		}
		return envDir;
	}
	if (configuredOutputDir && nodeFs.existsSync(configuredOutputDir)) {
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

/** Result of capturing a request: the body bytes and what to pass on. */
interface CapturedRequest {
	body: CapturedBody;
	/**
	 * The input the underlying fetch must be called with. Identical to the
	 * caller's input unless a bodyful Request had to be rewritten with a
	 * recording body — the caller's Request is never mutated.
	 */
	input: string | URL | Request;
	/**
	 * The init the underlying fetch must be called with. Identical to the
	 * caller's init unless the body had to be wrapped for capture, in which
	 * case this is a copy — the caller's object is never mutated.
	 */
	init: RequestInit | undefined;
}

/**
 * Wrap a stream so each chunk is recorded as the real consumer pulls it.
 * Reads are pull-through — no eager draining — so backpressure propagates to
 * the source and the log branch can never buffer ahead of the consumer.
 * Cancellation is forwarded to the source. `onFinish` fires exactly once with
 * the accumulated bytes, plus an error when the stream failed or was
 * cancelled.
 */
function recordPassThrough(
	source: ReadableStream<Uint8Array>,
	onFinish: (body: Buffer, error?: unknown) => void,
): ReadableStream<Uint8Array> {
	const chunks: Buffer[] = [];
	const reader = source.getReader();
	let finished = false;
	const finish = (error?: unknown) => {
		if (!finished) {
			finished = true;
			onFinish(Buffer.concat(chunks), error);
		}
	};
	return new ReadableStream<Uint8Array>({
		async pull(controller) {
			try {
				const { done, value } = await reader.read();
				if (done) {
					controller.close();
					finish();
					return;
				}
				chunks.push(Buffer.from(value));
				controller.enqueue(value);
			} catch (error) {
				finish(error);
				controller.error(error);
			}
		},
		async cancel(reason) {
			// Forward cancellation to the source, then record what arrived.
			try {
				await reader.cancel(reason);
			} catch {
				// Swallow: logging must never break the request.
			}
			finish(new Error("stream cancelled by consumer"));
		},
	});
}

/**
 * Best-effort extraction of the request body as raw bytes, without disturbing
 * the body that will be passed to the underlying fetch.
 *
 * - string/Buffer/TypedArray/ArrayBuffer bodies are copied directly.
 * - ReadableStream bodies are wrapped in a recording pass-through placed in a
 *   *copy* of the init (the caller's init is never mutated).
 * - Request-object bodies get the same pass-through via a rewritten Request
 *   (the caller's Request is never mutated).
 */
function captureRequestBody(
	input: string | URL | Request,
	init: RequestInit | undefined,
): CapturedRequest {
	const body = init?.body;
	if (body === null || body === undefined) {
		if (input instanceof Request && input.body !== null) {
			let resolveDone!: (body: Buffer) => void;
			const done = new Promise<Buffer>((resolve) => {
				resolveDone = resolve;
			});
			const recorded = recordPassThrough(input.body, (accumulated) => resolveDone(accumulated));
			// Rewrite the input with the recording body. `duplex: "half"` is
			// required by undici for stream bodies.
			const rewritten = new Request(input, { body: recorded, duplex: "half" });
			return { body: { pending: done }, input: rewritten, init };
		}
		return { body: { immediate: undefined }, input, init };
	}
	if (typeof body === "string") {
		return { body: { immediate: Buffer.from(body, "utf8") }, input, init };
	}
	if (body instanceof ArrayBuffer) {
		return { body: { immediate: Buffer.from(body) }, input, init };
	}
	if (ArrayBuffer.isView(body)) {
		return {
			body: { immediate: Buffer.from(body.buffer, body.byteOffset, body.byteLength) },
			input,
			init,
		};
	}
	if (body instanceof ReadableStream) {
		let resolveDone!: (body: Buffer) => void;
		const done = new Promise<Buffer>((resolve) => {
			resolveDone = resolve;
		});
		const recorded = recordPassThrough(body, (accumulated) => resolveDone(accumulated));
		return { body: { pending: done }, input, init: { ...init, body: recorded } };
	}
	// URLSearchParams, FormData, Blob, etc. — not produced by the AI SDK;
	// skip capture rather than risk disturbing the request.
	return { body: { immediate: undefined }, input, init };
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

/**
 * Wrap a response so its body is recorded as the real consumer pulls it
 * (cancellation and backpressure propagate to the network stream). `onFinish`
 * fires when the stream completes, fails, or is cancelled — with whatever
 * bytes arrived. Responses without a body finish immediately.
 */
function captureResponseForLog(
	response: Response,
	onFinish: (body: Buffer, error?: unknown) => void,
): Response {
	if (!response.body) {
		onFinish(Buffer.alloc(0));
		return response;
	}
	const recorded = recordPassThrough(response.body, onFinish);
	const wrapped = new Response(recorded, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
	// The Response constructor cannot set url/redirected/type; shadow them so
	// the wrapper preserves the original fetch metadata.
	Object.defineProperty(wrapped, "url", { value: response.url });
	Object.defineProperty(wrapped, "redirected", { value: response.redirected });
	Object.defineProperty(wrapped, "type", { value: response.type });
	return wrapped;
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
	// Forward slash works on Windows for fs calls; avoids importing node:path.
	const finalPath = `${outputDir}/${baseName}-${suffix}.http`;
	// Publish via temp file + rename: an existing final path always holds
	// complete contents, so log viewers and tests can poll for existence.
	nodeFs?.writeFile(`${finalPath}.tmp`, contents, (error) => {
		// Errors are swallowed by design: logging must never break a request.
		if (error) {
			return;
		}
		nodeFs.rename(`${finalPath}.tmp`, finalPath, () => {});
	});
}

/**
 * Wrap a fetch implementation so every call is logged to the active raw-HTTP
 * log directory. Returns undefined when logging is disabled, so callers can
 * conditionally spread the result into provider options without changing
 * behavior in the common case.
 *
 * The returned fetch narrows the Response contract slightly: the response is
 * a wrapper preserving status, statusText, headers, body, url, redirected,
 * and type, but its headers are a fresh (mutable) Headers object rather than
 * the original guard. Callers that only consume status/headers/body — the AI
 * SDK included — are unaffected.
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
	// Resolve the global fetch per call so test doubles installed after the
	// wrapper is created are honored.
	const underlying =
		fetchFn ?? ((...args: Parameters<typeof globalThis.fetch>) => globalThis.fetch(...args));
	const provider = sanitizeForFilename(context.provider);
	const model = sanitizeForFilename(context.model);

	return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
		const baseName = `${timestamp()}-${provider}-${model}-${processNonce}-${sequence++}`;

		// Capture the request (wrapping stream bodies in a recording
		// pass-through so the SDK's bytes are undisturbed) and write the
		// request file — immediately for already-available bodies, when the
		// stream finishes for stream bodies.
		let fetchInput = input;
		let fetchInit = init;
		try {
			const captured = captureRequestBody(input, init);
			fetchInput = captured.input;
			fetchInit = captured.init;
			// Fetch defaults to GET when neither the Request nor init say
			// otherwise.
			let method = "GET";
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
			if ("pending" in captured.body) {
				void captured.body.pending.then(writeRequest, () => writeRequest(undefined));
			} else {
				writeRequest(captured.body.immediate);
			}
		} catch {
			// Swallow: never let logging break the request.
		}

		let response: Response;
		try {
			response = await underlying(fetchInput, fetchInit);
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

		// Record the response body as the SDK consumes it: the pull-through
		// wrapper keeps cancellation and backpressure intact, and the response
		// file is written when the stream finishes with whatever bytes arrived.
		try {
			const original = response;
			response = captureResponseForLog(response, (body, error) => {
				try {
					writeLogFile(outputDir, baseName, "response", formatResponseFile(original, body, error));
				} catch {
					// Swallow.
				}
			});
		} catch {
			// Swallow.
		}

		return response;
	};
}
