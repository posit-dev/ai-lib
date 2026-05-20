/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2025 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * GitHub Copilot SDK Model Client
 *
 * Auth: pass a GitHub OAuth token via the constructor. If omitted, the SDK falls
 * back to the GitHub CLI's stored auth (useful for local development).
 *
 * Architecture — promise-bridged tool loop:
 *
 * The Copilot SDK owns the agent loop *internally* (one session.send() call covers
 * the entire multi-turn conversation), but we still want the host request loop
 * to execute tools, enforce permissions, and render tool UI. We bridge by
 * suspending each tool handler on a deferred promise: when Copilot invokes a
 * handler, we emit a normal `tool-call` stream chunk, close the current stream
 * segment, and await the deferred. The host request loop processes the tool,
 * calls chat() again with the tool result, and we resolve the deferred — which
 * lets the same Copilot session continue into its next turn.
 *
 * `SessionDriver` owns the long-lived CopilotSession, the pending deferreds,
 * and the swappable stream controller. `CopilotSdkClient.chat()` detects
 * continuation (trailing tool message with matching deferred IDs) vs. a fresh
 * turn and delegates accordingly.
 */

import { CopilotClient, defineTool, approveAll } from "@github/copilot-sdk";
import type { CopilotSession, Tool as CopilotTool } from "@github/copilot-sdk";
import type { ModelMessage, FinishReason, LanguageModelUsage } from "ai";

import type { StepLogger } from "../StepLogger";
import type { AiToolWithJsonSchema, CancellationToken, LMStreamPart, Logger } from "../types";
import { startCopilotCliServer, type CopilotCliServer } from "./copilot-cli-server";
import type { ModelClient } from "./ModelClient";

// ---------------------------------------------------------------------------
// Prompt helpers
// ---------------------------------------------------------------------------

type ContentPart = { type: string };

type FilePart = {
	type: "file";
	data: string | Uint8Array | URL;
	mediaType: string;
	filename?: string;
};

function isFilePart(part: ContentPart): part is FilePart {
	return part.type === "file" && "data" in part && "mediaType" in part;
}

function extractTextFromParts(parts: ReadonlyArray<ContentPart>): string {
	return parts
		.filter((p): p is { type: "text"; text: string } => p.type === "text" && "text" in p)
		.map((p) => p.text)
		.join("");
}

export type CopilotBlobAttachment = {
	type: "blob";
	data: string;
	mimeType: string;
	displayName?: string;
};

export type CopilotPrompt = {
	systemContent: string | undefined;
	userPrompt: string;
	attachments: CopilotBlobAttachment[];
};

function stripDataUrlPrefix(data: string): string {
	const match = /^data:[^;]+;base64,/.exec(data);
	return match ? data.slice(match[0].length) : data;
}

function toBlobAttachment(part: FilePart, logger?: Logger): CopilotBlobAttachment | undefined {
	let base64: string;
	if (part.data instanceof Uint8Array) {
		base64 = Buffer.from(part.data).toString("base64");
	} else if (typeof part.data === "string") {
		base64 = stripDataUrlPrefix(part.data);
	} else {
		logger?.warn(
			`[copilot] dropping ${part.mediaType} URL attachment (${String(part.data)}) — Copilot SDK blobs require base64 data`,
		);
		return undefined;
	}
	return {
		type: "blob",
		data: base64,
		mimeType: part.mediaType,
		displayName: part.filename,
	};
}

/**
 * Flattens a Vercel AI message array into a single prompt string for the
 * Copilot SDK's session.send(). Only called on the FIRST chat() call in a turn;
 * subsequent calls resume the existing session via deferred resolution and do
 * not re-send the prompt.
 */
export function extractPrompt(
	messages: ReadonlyArray<{ role: string; content: unknown }>,
	logger?: Logger,
): CopilotPrompt {
	let systemContent: string | undefined;
	const turns: string[] = [];
	const attachments: CopilotBlobAttachment[] = [];

	for (const msg of messages) {
		if (msg.role === "system") {
			systemContent = typeof msg.content === "string" ? msg.content : undefined;
		} else if (msg.role === "user") {
			const parts = msg.content as ReadonlyArray<ContentPart>;
			const segments: string[] = [];
			for (const part of parts) {
				if (part.type === "text" && "text" in part) {
					segments.push((part as { text: string }).text);
				} else if (isFilePart(part)) {
					const attachment = toBlobAttachment(part, logger);
					if (attachment) {
						attachments.push(attachment);
						const label = part.filename ?? part.mediaType;
						segments.push(`[attached: ${label}]`);
					}
				}
			}
			const text = segments.join("");
			if (text) turns.push(`User: ${text}`);
		} else if (msg.role === "assistant") {
			const text = extractTextFromParts(msg.content as ReadonlyArray<ContentPart>);
			if (text) turns.push(`Assistant: ${text}`);
		} else if (msg.role === "tool") {
			for (const part of msg.content as Array<{
				type: string;
				toolName?: string;
				output?: { type: string; value?: string };
			}>) {
				if (part.type === "tool-result" && part.output) {
					const text =
						part.output.type === "text" ? (part.output.value ?? "") : JSON.stringify(part.output);
					turns.push(`Tool result (${part.toolName ?? "unknown"}): ${text}`);
				}
			}
		}
	}

	return { systemContent, userPrompt: turns.join("\n\n"), attachments };
}

// ---------------------------------------------------------------------------
// Token accounting
// ---------------------------------------------------------------------------

interface TokenCounts {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

function makeUsage({ input, output, cacheRead, cacheWrite }: TokenCounts): LanguageModelUsage {
	const totalInput = input || undefined;
	const totalOutput = output || undefined;
	return {
		inputTokens: totalInput,
		inputTokenDetails: {
			noCacheTokens: input - cacheRead || undefined,
			cacheReadTokens: cacheRead || undefined,
			cacheWriteTokens: cacheWrite || undefined,
		},
		outputTokens: totalOutput,
		outputTokenDetails: {
			textTokens: undefined,
			reasoningTokens: undefined,
		},
		totalTokens: input + output || undefined,
	};
}

// ---------------------------------------------------------------------------
// Deferred + AsyncChannel — minimal utilities for the promise bridge
// ---------------------------------------------------------------------------

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (err: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/**
 * A minimal single-consumer async queue. The driver pushes stream chunks as
 * they arrive from the Copilot session; the request loop iterates them.
 * Each stream segment uses its own channel — swapping channels between
 * segments is how we end one chat() return value and start the next while
 * the underlying Copilot session stays alive.
 */
class AsyncChannel<T> implements AsyncIterable<T>, AsyncIterator<T> {
	private readonly queue: T[] = [];
	private pending: {
		resolve: (r: IteratorResult<T>) => void;
		reject: (e: unknown) => void;
	} | null = null;
	private closed = false;
	private error: unknown = null;

	push(value: T): void {
		if (this.closed) return;
		if (this.pending) {
			const p = this.pending;
			this.pending = null;
			p.resolve({ value, done: false });
			return;
		}
		this.queue.push(value);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.pending) {
			const p = this.pending;
			this.pending = null;
			p.resolve({ value: undefined as unknown as T, done: true });
		}
	}

	fail(error: unknown): void {
		if (this.closed) return;
		this.closed = true;
		this.error = error;
		if (this.pending) {
			const p = this.pending;
			this.pending = null;
			p.reject(error);
		}
	}

	isClosed(): boolean {
		return this.closed;
	}

	[Symbol.asyncIterator](): AsyncIterator<T> {
		return this;
	}

	async next(): Promise<IteratorResult<T>> {
		if (this.queue.length > 0) {
			return { value: this.queue.shift()!, done: false };
		}
		if (this.error) {
			const err = this.error;
			this.error = null;
			throw err;
		}
		if (this.closed) {
			return { value: undefined as unknown as T, done: true };
		}
		return new Promise<IteratorResult<T>>((resolve, reject) => {
			this.pending = { resolve, reject };
		});
	}
}

// ---------------------------------------------------------------------------
// SessionDriver
// ---------------------------------------------------------------------------

type ChatParams = Parameters<ModelClient["chat"]>[0];

type TrailingToolMessage = {
	results: Array<{ toolCallId: string; result: string }>;
};

/**
 * Pulls `role: "tool"` results off the end of the messages array. Used to
 * detect whether a chat() call is a tool-result continuation of the current
 * Copilot session. Returns null if the trailing message isn't a tool message
 * or has no tool-result parts.
 */
function findTrailingToolMessage(
	messages: ReadonlyArray<ModelMessage>,
): TrailingToolMessage | null {
	if (messages.length === 0) return null;
	const last = messages[messages.length - 1];
	if (last.role !== "tool") return null;
	const parts = last.content as Array<{
		type: string;
		toolCallId?: string;
		output?: { type: string; value?: unknown };
	}>;
	const results: Array<{ toolCallId: string; result: string }> = [];
	for (const part of parts) {
		if (part.type !== "tool-result" || !part.toolCallId) continue;
		const output = part.output;
		let serialized: string;
		if (!output) {
			serialized = "";
		} else if (output.type === "text" && typeof output.value === "string") {
			serialized = output.value;
		} else {
			serialized = JSON.stringify(output.value ?? output);
		}
		results.push({ toolCallId: part.toolCallId, result: serialized });
	}
	return results.length > 0 ? { results } : null;
}

class SessionDriver {
	private session: CopilotSession | null = null;
	private readonly pending = new Map<string, Deferred<string>>();
	private channel: AsyncChannel<LMStreamPart> | null = null;

	// Per-segment state — reset on each new segment.
	private segmentTextStarted = false;
	private segmentReasoningStarted = false;
	private segmentTextId = "text-0";
	private segmentReasoningId = "reasoning-0";
	private segmentClosed = false;
	private closeScheduled = false;
	private segmentCounter = 0;

	// Persistent across segments.
	private readonly counts: TokenCounts = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
	private disposed = false;
	private toolCallCounter = 0;

	// Cancellation bound to the currently-active segment's token.
	private cancellationDisposable: { dispose(): void } | null = null;

	constructor(
		private readonly client: CopilotClient,
		private readonly logger: Logger | undefined,
		private readonly onEnded: () => void,
	) {}

	hasPending(toolCallId: string): boolean {
		return this.pending.has(toolCallId);
	}

	/** Start a fresh Copilot session for the given params and return the first segment's stream. */
	start(params: ChatParams): AsyncIterable<LMStreamPart> {
		this.openSegment(params.cancellationToken);
		void this.initializeAndSend(params);
		return this.channel!;
	}

	/**
	 * Resume the existing Copilot session by resolving the deferreds that its
	 * tool handlers are suspended on. Returns a fresh stream segment that will
	 * receive the session's subsequent events.
	 */
	continue(
		toolResults: Array<{ toolCallId: string; result: string }>,
		cancellationToken: CancellationToken,
	): AsyncIterable<LMStreamPart> {
		this.openSegment(cancellationToken);

		for (const { toolCallId, result } of toolResults) {
			const deferred = this.pending.get(toolCallId);
			if (!deferred) {
				this.logger?.warn(`[copilot] continue() got tool result for unknown id ${toolCallId}`);
				continue;
			}
			this.pending.delete(toolCallId);
			// Resolving the deferred wakes the suspended handler, which returns
			// into the SDK; subsequent events flow into the new channel.
			deferred.resolve(result);
		}

		return this.channel!;
	}

	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		this.cancellationDisposable?.dispose();
		this.cancellationDisposable = null;

		const err = new Error("Copilot session disposed");
		for (const deferred of this.pending.values()) {
			deferred.reject(err);
		}
		this.pending.clear();

		// Close the current segment if still open.
		this.channel?.close();
		this.channel = null;

		if (this.session) {
			try {
				await this.session.disconnect();
			} catch {
				/* ignore — session may already be gone */
			}
			this.session = null;
		}

		this.onEnded();
	}

	// -----------------------------------------------------------------------
	// Internal helpers
	// -----------------------------------------------------------------------

	private openSegment(cancellationToken: CancellationToken): void {
		this.channel = new AsyncChannel<LMStreamPart>();
		this.segmentTextStarted = false;
		this.segmentReasoningStarted = false;
		this.segmentClosed = false;
		this.closeScheduled = false;
		this.segmentCounter++;
		this.segmentTextId = `text-${this.segmentCounter}`;
		this.segmentReasoningId = `reasoning-${this.segmentCounter}`;

		this.cancellationDisposable?.dispose();
		this.cancellationDisposable = cancellationToken.onCancellationRequested(() => {
			this.fail(new Error("Copilot request cancelled"));
		});
	}

	private async initializeAndSend(params: ChatParams): Promise<void> {
		try {
			const { systemContent, userPrompt, attachments } = extractPrompt(
				params.messages,
				this.logger,
			);
			const copilotTools = this.buildTools(params.tools ?? {});

			this.logger?.debug(
				`[copilot] start session model=${params.model} tools=[${copilotTools.map((t) => t.name).join(", ")}]`,
			);

			this.session = await this.client.createSession({
				model: params.model,
				tools: copilotTools,
				// Whitelist only our tools so every CLI built-in (bash, read, write,
				// edit, etc.) is disabled — the host app owns the tool surface.
				availableTools: copilotTools.map((t) => t.name),
				streaming: true,
				// Replace the CLI's baseline system prompt — its boilerplate references
				// built-in tools we've disabled, which would make the model hallucinate
				// tool access.
				systemMessage: { mode: "replace", content: systemContent ?? "" },
				onPermissionRequest: approveAll,
				infiniteSessions: { enabled: false },
			});

			this.wireEvents(this.session);

			// session.send() returns only when the session becomes idle. We don't
			// await it here — events drive the stream and dispose() tears down.
			void this.session
				.send({
					prompt: userPrompt,
					...(attachments.length > 0 ? { attachments } : {}),
				})
				.catch((err) => {
					this.fail(err);
				});
		} catch (error) {
			this.fail(error);
		}
	}

	private buildTools(tools: Record<string, AiToolWithJsonSchema>): CopilotTool[] {
		return Object.entries(tools).map(([name, t]) =>
			defineTool(name, {
				description: t.description ?? "",
				// Spread produces a plain Record<string, unknown> from JSONSchema7.
				parameters: { ...t.inputSchema.jsonSchema },
				// Copilot CLI ships built-ins (bash, read, write, edit, etc.) whose
				// names collide with our tool surface. Force override — our
				// implementations apply the host app's permission model.
				overridesBuiltInTool: true,
				handler: async (_args, invocation) => {
					const { toolCallId } = invocation;
					const callNum = ++this.toolCallCounter;
					if (this.disposed) {
						return `Copilot session disposed before tool "${name}" (id=${toolCallId}) executed`;
					}
					this.logger?.debug(`[copilot] tool#${callNum} ${name} suspending id=${toolCallId}`);
					const deferred = createDeferred<string>();
					this.pending.set(toolCallId, deferred);
					// Schedule the segment close for after the current sync batch of
					// handler invocations. Copilot may fire multiple handlers in
					// parallel (Promise.all); all of them register their deferreds
					// synchronously before any await yields, so a microtask closes
					// the segment after the full batch has been collected.
					this.scheduleSegmentClose();
					return deferred.promise;
				},
			}),
		);
	}

	private wireEvents(session: CopilotSession): void {
		session.on("assistant.usage", (event) => {
			const d = event.data;
			this.counts.input += d.inputTokens ?? 0;
			this.counts.output += d.outputTokens ?? 0;
			this.counts.cacheRead += d.cacheReadTokens ?? 0;
			this.counts.cacheWrite += d.cacheWriteTokens ?? 0;

			// Classify billing: cost === 0 is non-counted (agent follow-ups
			// carry X-Initiator: agent), cost === 1 is a standard premium
			// request, cost > 1 is a premium-model multiplier.
			const cost = d.cost;
			const initiator = d.initiator ?? "user";
			const kind =
				cost === undefined || cost === 0
					? "non-counted"
					: cost > 1
						? `premium×${cost}`
						: "standard";
			this.logger?.debug(
				`[copilot] usage model=${d.model} ${kind} initiator=${initiator} in=${d.inputTokens ?? 0} out=${d.outputTokens ?? 0} cacheR=${d.cacheReadTokens ?? 0} cacheW=${d.cacheWriteTokens ?? 0}${d.copilotUsage ? ` aiu=${d.copilotUsage.totalNanoAiu}` : ""}`,
			);
		});

		session.on("tool.execution_start", (event) => {
			const d = event.data;
			this.logger?.info(
				`[copilot] tool.execution_start ${d.toolName} id=${d.toolCallId}${d.parentToolCallId ? ` parent=${d.parentToolCallId}` : ""}`,
			);
			// Plain tool-call — no `providerExecuted`, no `dynamic`. The host
			// request loop will execute this tool and deliver the result via the
			// next chat() call, which resolves the handler's deferred.
			this.enqueue({
				type: "tool-call",
				toolCallId: d.toolCallId,
				toolName: d.toolName,
				input: d.arguments ?? {},
				dynamic: true,
			});
		});

		// Streaming reasoning deltas.
		session.on("assistant.reasoning_delta", (event) => {
			const delta = event.data.deltaContent;
			if (!delta) return;
			if (!this.segmentReasoningStarted) {
				this.enqueue({ type: "reasoning-start", id: this.segmentReasoningId });
				this.segmentReasoningStarted = true;
			}
			this.enqueue({ type: "reasoning-delta", id: this.segmentReasoningId, text: delta });
		});

		// Non-streaming fallback: complete thinking text as a single event.
		session.on("assistant.reasoning", (event) => {
			if (this.segmentReasoningStarted) return;
			const content = event.data.content;
			if (!content) return;
			this.enqueue({ type: "reasoning-start", id: this.segmentReasoningId });
			this.enqueue({ type: "reasoning-delta", id: this.segmentReasoningId, text: content });
			this.segmentReasoningStarted = true;
		});

		session.on("assistant.message_delta", (event) => {
			const delta = event.data.deltaContent;
			if (!delta) return;
			if (!this.segmentTextStarted) {
				this.enqueue({ type: "text-start", id: this.segmentTextId });
				this.segmentTextStarted = true;
			}
			this.enqueue({ type: "text-delta", id: this.segmentTextId, text: delta });
		});

		// Non-streaming fallback: full message content without deltas.
		session.on("assistant.message", (event) => {
			if (this.segmentTextStarted) return;
			const content = event.data.content;
			if (!content) return;
			this.enqueue({ type: "text-start", id: this.segmentTextId });
			this.enqueue({ type: "text-delta", id: this.segmentTextId, text: content });
			this.segmentTextStarted = true;
		});

		session.on("session.error", (event) => {
			const { errorType, message, statusCode } = event.data;
			const prefix = statusCode !== undefined ? `[${errorType} ${statusCode}]` : `[${errorType}]`;
			this.fail(new Error(`Copilot ${prefix} ${message}`));
		});

		session.on("session.idle", () => {
			// Entire conversation turn is complete — close the last segment with
			// stop reason and tear the driver down.
			this.closeSegment("stop");
			void this.dispose();
		});
	}

	private enqueue(part: LMStreamPart): void {
		if (this.disposed || this.segmentClosed) return;
		this.channel?.push(part);
	}

	private scheduleSegmentClose(): void {
		if (this.closeScheduled || this.segmentClosed) return;
		this.closeScheduled = true;
		// Microtask runs after all synchronous handler invocations in the
		// current batch have registered their deferreds (Promise.all yields
		// only after all the handlers' sync prefixes run). By then every
		// tool-call chunk for this iteration has been enqueued.
		queueMicrotask(() => {
			this.closeScheduled = false;
			this.closeSegment("tool-calls");
		});
	}

	private closeSegment(reason: FinishReason): void {
		if (this.segmentClosed) return;
		this.segmentClosed = true;
		const channel = this.channel;
		if (!channel || channel.isClosed()) return;

		if (this.segmentReasoningStarted) {
			channel.push({ type: "reasoning-end", id: this.segmentReasoningId });
		}
		if (this.segmentTextStarted) {
			channel.push({ type: "text-end", id: this.segmentTextId });
		}

		const usage = makeUsage(this.counts);
		// finish-step carries usage that the request loop uses for token tracking.
		channel.push({
			type: "finish-step",
			response: { id: "", modelId: "", timestamp: new Date() },
			usage,
			finishReason: reason,
			rawFinishReason: reason,
			providerMetadata: undefined,
		});
		channel.push({
			type: "finish",
			finishReason: reason,
			rawFinishReason: reason,
			totalUsage: usage,
		});
		channel.close();
	}

	private fail(error: unknown): void {
		if (this.disposed) return;
		this.channel?.push({ type: "error", error });
		this.channel?.close();
		for (const deferred of this.pending.values()) {
			deferred.reject(error);
		}
		this.pending.clear();
		void this.dispose();
	}
}

// ---------------------------------------------------------------------------
// CopilotSdkClient
// ---------------------------------------------------------------------------

const DEFAULT_CONVERSATION_KEY = "__default__";

/** Exported for unit testing. Derives the per-conversation routing key. */
export function conversationKeyFor(params: {
	metadata?: { sessionId?: string; conversationId?: string };
}): string {
	// Prefer conversationId. The request loop sets `sessionId: conversationId`
	// (see packages/core/src/request-loop/request-loop.ts) so the two usually
	// coincide. The fallback keeps callers that omit metadata functional.
	return params.metadata?.conversationId ?? params.metadata?.sessionId ?? DEFAULT_CONVERSATION_KEY;
}

export class CopilotSdkClient implements ModelClient {
	private readonly githubToken: string | undefined;
	private readonly logger: Logger | undefined;
	private client: CopilotClient | null = null;
	private cliServer: CopilotCliServer | null = null;
	private startPromise: Promise<void> | null = null;
	private disposed = false;
	private readonly driversByConversation = new Map<string, SessionDriver>();

	/**
	 * @param githubToken - GitHub OAuth token. Omit to fall back to GitHub CLI auth.
	 * @param logger - Optional logger for request diagnostics.
	 */
	constructor(githubToken?: string, logger?: Logger) {
		this.githubToken = githubToken || undefined;
		this.logger = logger;
	}

	/**
	 * Spawn the Copilot CLI under real `node` and attach via cliUrl. We do this
	 * instead of letting the SDK spawn via process.execPath, which is the
	 * Electron helper binary in the Positron extension host and breaks the
	 * CLI's commander parse even with ELECTRON_RUN_AS_NODE=1.
	 * Runs exactly once per client instance; subsequent calls await the same promise.
	 */
	private ensureStarted(): Promise<void> {
		if (this.disposed) {
			return Promise.reject(new Error("CopilotSdkClient has been disposed"));
		}
		this.startPromise ??= (async () => {
			this.cliServer = await startCopilotCliServer(this.githubToken);
			this.client = new CopilotClient({
				cliUrl: `localhost:${this.cliServer.port}`,
				logLevel: "warning",
			});
			await this.client.start();
		})();
		return this.startPromise;
	}

	async chat(params: {
		model: string;
		messages: ModelMessage[];
		systemPrompt?: string;
		maxOutputTokens?: number;
		tools?: Record<string, AiToolWithJsonSchema>;
		cancellationToken: CancellationToken;
		thinkingEffort?: string;
		contextLength?: number;
		webSearchEnabled?: boolean;
		metadata?: { sessionId?: string; conversationId?: string };
		stepLoggers?: StepLogger[];
	}): Promise<AsyncIterable<LMStreamPart>> {
		await this.ensureStarted();

		const key = conversationKeyFor(params);
		const driver = this.driversByConversation.get(key);

		// Continuation detection: if the trailing message is a tool message whose
		// toolCallIds all match currently-pending deferreds on the driver for this
		// conversation, this chat() call is a tool-result follow-up.
		const trailing = findTrailingToolMessage(params.messages);
		const canResume =
			driver !== undefined &&
			trailing !== null &&
			trailing.results.every((r) => driver.hasPending(r.toolCallId));

		if (canResume) {
			this.logger?.debug(
				`[copilot] continuing session (conv=${key}) with ${trailing!.results.length} tool result(s)`,
			);
			return driver.continue(trailing!.results, params.cancellationToken);
		}

		// Fresh turn on this conversation — tear down only its prior driver.
		// Other conversations' drivers are untouched.
		if (driver) {
			this.logger?.debug(`[copilot] starting fresh session (conv=${key}) — disposing prior driver`);
			await driver.dispose();
			this.driversByConversation.delete(key);
		}

		const next = new SessionDriver(this.client!, this.logger, () => {
			// The driver removes itself when it ends on its own (session.idle /
			// error). Guard against replacement: another fresh turn on the same
			// conversation may have already installed a new driver.
			if (this.driversByConversation.get(key) === next) {
				this.driversByConversation.delete(key);
			}
		});
		this.driversByConversation.set(key, next);
		return next.start(params);
	}

	/**
	 * Tear down all per-conversation drivers, stop the Copilot SDK client, and
	 * dispose the CLI server. Used by the provider factory when the
	 * authentication state transitions (sign-in or sign-out) and the CLI
	 * subprocess must be replaced. Once disposed, this client rejects further
	 * chat() calls — callers should obtain a new instance from the factory.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		const drivers = [...this.driversByConversation.values()];
		this.driversByConversation.clear();
		await Promise.allSettled(drivers.map((d) => d.dispose()));

		try {
			await this.client?.stop();
		} catch {
			/* client may never have started */
		}
		try {
			await this.cliServer?.dispose();
		} catch {
			/* best effort */
		}
		this.client = null;
		this.cliServer = null;
		this.startPromise = null;
	}
}
