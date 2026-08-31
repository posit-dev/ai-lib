/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type * as NodeFs from "node:fs";

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
 *   byte-for-byte as sent. A body that exists but cannot be captured safely
 *   (e.g. a keepalive or no-cors Request) is replaced with a
 *   `[body omitted: ...]` marker so the log never implies an empty body. If a
 *   request stream fails or is cancelled, partial bytes plus an `[error: ...]`
 *   marker are recorded.
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
		? (process.getBuiltinModule?.("node:fs") as typeof NodeFs | undefined)
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
/**
 * Validate and harden a log directory. Log bodies are unredacted (prompts,
 * tool output), so the directory must be a real directory — not a symlink —
 * owned by this user, and is tightened to owner-only when it isn't already:
 * mkdir's mode applies only to directories it creates, so a pre-existing
 * directory keeps whatever (possibly permissive) mode it was created with.
 * Returns false — disabling logging — when validation or hardening fails,
 * rather than writing sensitive bodies into a directory another local
 * principal controls.
 */
function secureOutputDir(dir: string): boolean {
	if (!nodeFs) {
		return false;
	}
	try {
		const stat = nodeFs.lstatSync(dir);
		if (!stat.isDirectory()) {
			return false;
		}
		// Ownership and permission bits are POSIX concepts; on Windows the
		// real-directory check above is all that applies.
		if (process.platform !== "win32" && typeof process.getuid === "function") {
			if (stat.uid !== process.getuid()) {
				return false;
			}
			if ((stat.mode & 0o777) !== 0o700) {
				nodeFs.chmodSync(dir, 0o700);
			}
		}
		return true;
	} catch {
		return false;
	}
}

function resolveOutputDir(): string | undefined {
	if (!nodeFs || typeof process === "undefined") {
		return undefined;
	}
	const envDir = process.env[ENV_VAR];
	if (envDir) {
		// Idempotent: recreates the directory if it was deleted mid-session
		// and picks up env-var changes between calls.
		try {
			nodeFs.mkdirSync(envDir, { recursive: true, mode: 0o700 });
		} catch {
			return undefined;
		}
		return secureOutputDir(envDir) ? envDir : undefined;
	}
	// Late binding: logging is active only while the configured directory
	// exists on disk and passes the same ownership/mode hardening.
	if (configuredOutputDir && secureOutputDir(configuredOutputDir)) {
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
 * Terminal state of a recorded stream. A discriminated union rather than an
 * optional error value because the Streams API permits `controller.error()`
 * with no argument, in which case reads reject with `undefined` — a value an
 * optional `error` field cannot distinguish from a clean completion.
 */
type StreamTerminal = { kind: "complete" } | { kind: "error"; error: unknown };

/**
 * Result of capturing a request body. `immediate` is set when the bytes are
 * available synchronously (the common case: the AI SDK sends JSON strings).
 * `pending` is set for stream bodies, where the bytes only become available
 * as the underlying fetch consumes the stream. Its result retains the
 * terminal stream state so partial bytes are not mistaken for a complete
 * body. `omittedReason` is set when a body exists but could not be captured,
 * so the log records a marker instead of a misleading empty body.
 */
interface PendingCapturedBodyResult {
	body: Buffer;
	omittedReason?: string;
	terminal: StreamTerminal;
}

interface PendingCapturedBody {
	pending: Promise<PendingCapturedBodyResult>;
	finalize: (omittedReason: string) => void;
}

type CapturedBody = { immediate: Buffer | undefined; omittedReason?: string } | PendingCapturedBody;

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
 * the accumulated bytes and the terminal state: complete, or error when the
 * stream failed or was cancelled.
 */
function recordPassThrough(
	source: ReadableStream<Uint8Array>,
	onFinish: (body: Buffer, terminal: StreamTerminal) => void,
): { stream: ReadableStream<Uint8Array>; finish: (terminal: StreamTerminal) => void } {
	const chunks: Buffer[] = [];
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let finished = false;
	const getReader = () => (reader ??= source.getReader());
	const finish = (terminal: StreamTerminal) => {
		if (!finished) {
			finished = true;
			onFinish(Buffer.concat(chunks), terminal);
		}
	};
	const stream = new ReadableStream<Uint8Array>(
		{
			async pull(controller) {
				try {
					const { done, value } = await getReader().read();
					if (done) {
						controller.close();
						finish({ kind: "complete" });
						return;
					}
					chunks.push(Buffer.from(value));
					controller.enqueue(value);
				} catch (error) {
					finish({ kind: "error", error });
					controller.error(error);
				}
			},
			async cancel(reason) {
				// Record partial bytes even when source cancellation rejects, but
				// preserve that source failure for the caller.
				try {
					await getReader().cancel(reason);
				} finally {
					finish({ kind: "error", error: new Error("stream cancelled by consumer") });
				}
			},
		},
		// Prevent the wrapper from pulling (and locking) the source until its
		// consumer asks for bytes. This also keeps failed Request rewrites safe.
		{ highWaterMark: 0 },
	);
	return { stream, finish };
}

function captureRequestStream(source: ReadableStream<Uint8Array>): {
	body: PendingCapturedBody;
	stream: ReadableStream<Uint8Array>;
} {
	let resolveDone!: (result: PendingCapturedBodyResult) => void;
	const pending = new Promise<PendingCapturedBodyResult>((resolve) => {
		resolveDone = resolve;
	});
	let omittedReason: string | undefined;
	const recorded = recordPassThrough(source, (body, terminal) =>
		resolveDone({ body, omittedReason, terminal }),
	);
	return {
		body: {
			pending,
			finalize(reason) {
				omittedReason = reason;
				// The truncation is explained by the omittedReason marker; the
				// recording itself ends without a stream error.
				recorded.finish({ kind: "complete" });
			},
		},
		stream: recorded.stream,
	};
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
			// Fetch forbids streaming bodies for keepalive and no-cors requests.
			// Preserve a valid caller-owned Request and omit body capture rather
			// than rewriting it into an invalid one.
			const keepalive = init?.keepalive ?? input.keepalive;
			const mode = init?.mode ?? input.mode;
			if (keepalive || mode === "no-cors") {
				return {
					body: {
						immediate: undefined,
						omittedReason: "keepalive/no-cors request cannot be rewritten with a capture body",
					},
					input,
					init,
				};
			}

			const captured = captureRequestStream(input.body);
			try {
				// Rewrite the input with the recording body. `duplex: "half"` is
				// required by undici for stream bodies.
				const rewritten = new Request(input, { body: captured.stream, duplex: "half" });
				return { body: captured.body, input: rewritten, init };
			} catch {
				// The captured stream has a zero high-water mark and has not locked the source,
				// so falling back to the original Request is safe.
				return {
					body: {
						immediate: undefined,
						omittedReason: "request could not be rewritten with a capture body",
					},
					input,
					init,
				};
			}
		}
		return { body: { immediate: undefined }, input, init };
	}
	if (typeof body === "string") {
		return { body: { immediate: Buffer.from(body, "utf8") }, input, init };
	}
	if (body instanceof ArrayBuffer) {
		return { body: { immediate: Buffer.from(new Uint8Array(body)) }, input, init };
	}
	if (ArrayBuffer.isView(body)) {
		return {
			body: {
				immediate: Buffer.from(new Uint8Array(body.buffer, body.byteOffset, body.byteLength)),
			},
			input,
			init,
		};
	}
	if (body instanceof ReadableStream) {
		const captured = captureRequestStream(body);
		return { body: captured.body, input, init: { ...init, body: captured.stream } };
	}
	// URLSearchParams, FormData, Blob, etc. — not produced by the AI SDK;
	// preserve the body and mark the capture omission rather than risk changing
	// fetch's serialization or multipart boundary.
	return {
		body: { immediate: undefined, omittedReason: "body type cannot be captured safely" },
		input,
		init,
	};
}

function formatErrorMarker(error: unknown): Buffer {
	return Buffer.from(
		`\n\n[error: ${error instanceof Error ? error.message : String(error)}]\n`,
		"utf8",
	);
}

function formatRequestFile(
	method: string,
	url: URL,
	headers: Headers,
	body: Buffer | undefined,
	omittedReason: string | undefined,
	terminal: StreamTerminal,
): Buffer {
	const lines = [
		`${method} ${url.pathname}${url.search} HTTP/1.1`,
		`host: ${url.host}`,
		...redactHeaders(headers),
		"",
	];
	const parts = [Buffer.from(lines.join("\n") + "\n", "utf8"), body ?? Buffer.alloc(0)];
	if (omittedReason !== undefined) {
		parts.push(Buffer.from(`\n\n[body omitted: ${omittedReason}]\n`, "utf8"));
	}
	if (terminal.kind === "error") {
		parts.push(formatErrorMarker(terminal.error));
	}
	return Buffer.concat(parts);
}

/**
 * Wrap a response so its body is recorded as the real consumer pulls it
 * (cancellation and backpressure propagate to the network stream). `onFinish`
 * fires when the stream completes, fails, or is cancelled — with whatever
 * bytes arrived. Responses without a body finish immediately.
 */
function captureResponseForLog(
	response: Response,
	onFinish: (body: Buffer, terminal: StreamTerminal) => void,
): Response {
	if (!response.body) {
		onFinish(Buffer.alloc(0), { kind: "complete" });
		return response;
	}
	const recorded = recordPassThrough(response.body, onFinish);
	const wrapped = new Response(recorded.stream, {
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

function formatResponseFile(response: Response, body: Buffer, terminal: StreamTerminal): Buffer {
	const lines = [
		`HTTP/1.1 ${response.status} ${response.statusText}`.trimEnd(),
		...redactHeaders(response.headers),
		"",
	];
	const parts = [Buffer.from(lines.join("\n") + "\n", "utf8"), body];
	if (terminal.kind === "error") {
		parts.push(formatErrorMarker(terminal.error));
	}
	return Buffer.concat(parts);
}

function writeLogFile(outputDir: string, baseName: string, suffix: string, contents: Buffer): void {
	// Forward slash works on Windows for fs calls; avoids importing node:path.
	const finalPath = `${outputDir}/${baseName}-${suffix}.http`;
	// Publish via temp file + rename: an existing final path always holds
	// complete contents, so log viewers and tests can poll for existence.
	// The temp path is unique per file (the base name carries a process nonce
	// and a sequence number) and created exclusively ("wx"), so the write
	// never follows a pre-planted symlink or overwrites a stale temp file;
	// rename then atomically replaces the final directory entry without
	// following anything there. Owner-only mode: bodies are deliberately
	// unredacted (prompts, source, tool output), and rename preserves the
	// temp file's mode.
	nodeFs?.writeFile(`${finalPath}.tmp`, contents, { mode: 0o600, flag: "wx" }, (error) => {
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
		let finalizePendingRequest: ((omittedReason: string) => void) | undefined;
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
			const writeRequest = (
				body: Buffer | undefined,
				omittedReason: string | undefined,
				terminal: StreamTerminal,
			) =>
				writeLogFile(
					outputDir,
					baseName,
					"request",
					formatRequestFile(method, resolvedUrl, requestHeaders, body, omittedReason, terminal),
				);
			if ("pending" in captured.body) {
				finalizePendingRequest = captured.body.finalize;
				void captured.body.pending.then(({ body, omittedReason, terminal }) =>
					writeRequest(body, omittedReason, terminal),
				);
			} else {
				// Non-stream bodies have no terminal stream state.
				writeRequest(captured.body.immediate, captured.body.omittedReason, {
					kind: "complete",
				});
			}
		} catch {
			// Swallow: never let logging break the request.
		}

		let response: Response;
		try {
			response = await underlying(fetchInput, fetchInit);
		} catch (error) {
			// If fetch failed before consuming a streaming upload, publish the
			// request half without reading or cancelling the caller's source.
			finalizePendingRequest?.("request stream did not finish before fetch failed");
			// Record the transport-level failure, then rethrow.
			try {
				writeLogFile(
					outputDir,
					baseName,
					"response",
					Buffer.concat([Buffer.from("HTTP/1.1 0 ERROR", "utf8"), formatErrorMarker(error)]),
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
			response = captureResponseForLog(response, (body, terminal) => {
				try {
					writeLogFile(
						outputDir,
						baseName,
						"response",
						formatResponseFile(original, body, terminal),
					);
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
