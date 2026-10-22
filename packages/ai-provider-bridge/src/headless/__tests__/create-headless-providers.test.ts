/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingHttpHeaders, Server } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";

import { mintCustomProviderId } from "ai-config";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ProviderRegistry } from "../../providers/ProviderRegistry";
import type { LMStreamPart, Logger } from "../../types";
import { createHeadlessProviders } from "../create-headless-providers";
import type { HeadlessCatalogChange, HeadlessProviders } from "../types";

const watchers = vi.hoisted(() => [] as { disposed: boolean }[]);

vi.mock("ai-config/node", async (importOriginal) => {
	const original = await importOriginal<typeof import("ai-config/node")>();
	return {
		...original,
		watchResolvedProviderCatalog: (
			...args: Parameters<typeof original.watchResolvedProviderCatalog>
		) => {
			const handle = original.watchResolvedProviderCatalog(...args);
			const record = { disposed: false };
			watchers.push(record);
			return {
				ready: handle.ready,
				dispose: () => {
					record.disposed = true;
					handle.dispose();
				},
			};
		},
	};
});

const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {} };
const customId = mintCustomProviderId("gateway");
const offWithDeclared = {
	discovery: "off",
	custom: [
		{
			id: "declared",
			name: "Declared",
			maxContextLength: 100000,
			supportsTools: true,
			supportsImages: false,
			supportsToolResultImages: false,
			supportsWebSearch: false,
		},
	],
};

let dir: string;
let configPath: string;
let providers: HeadlessProviders | undefined;
let server: Server | undefined;
let requestHeaders: IncomingHttpHeaders[] = [];
let requestUrls: (string | undefined)[] = [];

function customEntry(overrides: Record<string, unknown> = {}) {
	return {
		type: "openai-compatible",
		baseUrl: "http://127.0.0.1:1",
		...overrides,
	};
}

async function writeProviders(custom: Record<string, unknown>) {
	await writeFile(configPath, JSON.stringify({ providers: { custom: { gateway: custom } } }));
}

async function writePositAi(positai: Record<string, unknown>) {
	await writeFile(configPath, JSON.stringify({ providers: { positai } }));
}

function create() {
	providers = createHeadlessProviders({
		logger,
		userAgent: "test/1.0",
		catalog: { configPath, envVars: {} },
	});
	return providers;
}

async function startModelServer(
	modelIdsFor: (authorization: string | undefined) => string[] = () => ["m1", "m2"],
): Promise<string> {
	server = createServer((req, res) => {
		requestHeaders.push(req.headers);
		requestUrls.push(req.url);
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				data: modelIdsFor(req.headers.authorization).map((id) => ({ id })),
				chat: [{ id: "m1", display_name: "M1" }],
			}),
		);
	});
	await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("model server has no port");
	}
	return `http://127.0.0.1:${address.port}`;
}

beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), "headless-providers-"));
	configPath = path.join(dir, "providers.json");
});

afterEach(async () => {
	providers?.dispose();
	providers = undefined;
	watchers.length = 0;
	requestHeaders = [];
	requestUrls = [];
	vi.restoreAllMocks();
	await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
	server = undefined;
	await rm(dir, { recursive: true, force: true });
});

describe("createHeadlessProviders", () => {
	it("lists a custom entry in the catalog and the mappings", async () => {
		await writeProviders(customEntry());
		const headless = create();

		const catalog = await headless.getCatalog();
		const mappings = await headless.getProviderMappings();

		expect(catalog.find((entry) => entry.id === customId)).toMatchObject({
			id: customId,
			enabled: true,
			custom: true,
		});
		expect(mappings.find((mapping) => mapping.providerId === customId)).toMatchObject({
			providerId: customId,
			requiresSession: false,
		});
	});

	it("notifies listeners when a file write changes enabled state", async () => {
		await writeProviders(customEntry());
		const headless = create();
		await headless.getCatalog();
		const changes: HeadlessCatalogChange[] = [];
		headless.onDidChangeCatalog((change) => changes.push(change));

		await writeProviders(customEntry({ enabled: false }));

		await vi.waitFor(() => expect(changes).toHaveLength(1), { timeout: 5000 });
		expect(changes[0]?.enabledChanged).toBe(true);
		expect(changes[0]?.catalog.find((entry) => entry.id === customId)?.enabled).toBe(false);
	});

	it("stops notifying a disposed listener", async () => {
		await writeProviders(customEntry());
		const headless = create();
		await headless.getCatalog();
		const listener = vi.fn();
		headless.onDidChangeCatalog(listener).dispose();
		const second = vi.fn();
		headless.onDidChangeCatalog(second);

		await writeProviders(customEntry({ enabled: false }));

		await vi.waitFor(() => expect(second).toHaveBeenCalledTimes(1), { timeout: 5000 });
		expect(listener).not.toHaveBeenCalled();
	});

	describe("dispose", () => {
		const disposedMessage = /disposed/;

		it("stops the catalog watcher and is idempotent", async () => {
			await writeProviders(customEntry());
			const headless = create();
			await headless.getCatalog();

			headless.dispose();
			headless.dispose();

			expect(watchers).toEqual([{ disposed: true }]);
		});

		it("rejects calls after disposal without restarting the watcher", async () => {
			await writeProviders(customEntry());
			const headless = create();
			await headless.getCatalog();
			headless.dispose();

			await expect(headless.getCatalog()).rejects.toThrow(disposedMessage);
			await expect(headless.getProviderMappings()).rejects.toThrow(disposedMessage);
			await expect(headless.listModels("anthropic", "sk-1")).rejects.toThrow(disposedMessage);
			await expect(
				headless
					.streamChat(
						{ providerId: "anthropic", modelId: "m", systemPrompt: "", messages: [] },
						{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
					)
					[Symbol.asyncIterator]()
					.next(),
			).rejects.toThrow(disposedMessage);
			expect(watchers).toEqual([{ disposed: true }]);
		});

		it("returns a no-op subscription after disposal", async () => {
			const headless = create();
			headless.dispose();

			expect(() => headless.onDidChangeCatalog(vi.fn()).dispose()).not.toThrow();
		});

		it("aborts a catalog load that disposal interrupts", async () => {
			await writeProviders(customEntry());
			const headless = create();

			const pending = headless.getCatalog();
			headless.dispose();

			await expect(pending).rejects.toThrow(disposedMessage);
			expect(watchers).toEqual([{ disposed: true }]);
		});
	});

	describe("listModels", () => {
		it("is uncredentialed without a token", async () => {
			await writeProviders(customEntry({ type: "anthropic" }));

			expect(await create().listModels(customId, undefined)).toEqual({
				credentialed: false,
				models: [],
			});
		});

		it("lists models from a key-optional entry without a token or an Authorization header", async () => {
			await writeProviders(customEntry({ baseUrl: await startModelServer() }));

			const listing = await create().listModels(customId, undefined);

			expect(listing.credentialed).toBe(true);
			expect(listing.models.map((model) => model.id)).toEqual(["m1", "m2"]);
			expect(requestHeaders.map((headers) => headers.authorization)).toEqual([undefined]);
		});

		it("sends the session token to a key-optional entry when there is one", async () => {
			await writeProviders(customEntry({ baseUrl: await startModelServer() }));

			await create().listModels(customId, "sk-1");

			expect(requestHeaders.map((headers) => headers.authorization)).toEqual(["Bearer sk-1"]);
		});

		it("rediscovers with the current token when it changes on the same instance", async () => {
			const baseUrl = await startModelServer((authorization) => [
				`for ${authorization ?? "anonymous"}`,
			]);
			await writeProviders(customEntry({ baseUrl }));
			const headless = create();
			const modelIds = async (token: string | undefined) =>
				(await headless.listModels(customId, token)).models.map((model) => model.id);

			expect(await modelIds("sk-a")).toEqual(["for Bearer sk-a"]);
			expect(await modelIds("sk-a")).toEqual(["for Bearer sk-a"]);
			expect(await modelIds("sk-b")).toEqual(["for Bearer sk-b"]);
			expect(await modelIds(undefined)).toEqual(["for anonymous"]);
			expect(requestHeaders.map((headers) => headers.authorization)).toEqual([
				"Bearer sk-a",
				"Bearer sk-b",
				undefined,
			]);
		});

		it("lists Posit AI models from the catalog base URL", async () => {
			await writePositAi({ baseUrl: await startModelServer() });

			const listing = await create().listModels("positai", "tok-1");

			expect(listing.models.map((model) => model.id)).toEqual(["m1"]);
			expect(requestUrls).toEqual(["/models"]);
		});

		it("lists Posit AI models from the default gateway when no base URL is set", async () => {
			const fetchSpy = vi
				.spyOn(globalThis, "fetch")
				.mockResolvedValue(Response.json({ chat: [{ id: "m1", display_name: "M1" }] }));

			await create().listModels("positai", "tok-1");

			expect(fetchSpy.mock.calls.map(([url]) => url)).toEqual(["https://gateway.posit.ai/models"]);
		});

		it("is uncredentialed for an unknown provider", async () => {
			expect(await create().listModels("no-such-provider", "tok")).toEqual({
				credentialed: false,
				models: [],
			});
		});

		it("is credentialed with no models when the policy filters out every model", async () => {
			await writeProviders(
				customEntry({ baseUrl: await startModelServer(), models: { deny: ["m1", "m2"] } }),
			);

			expect(await create().listModels(customId, "sk-1")).toEqual({
				credentialed: true,
				models: [],
			});
		});

		it("lists configured models without a request when discovery is off", async () => {
			await writeProviders(
				customEntry({ baseUrl: await startModelServer(), models: offWithDeclared }),
			);

			const listing = await create().listModels(customId, undefined);

			expect(listing).toEqual({
				credentialed: true,
				models: [{ id: "declared", name: "Declared", vendor: customId, providerId: customId }],
			});
			expect(requestUrls).toEqual([]);
		});
	});

	describe("streamChat", () => {
		it("throws without credentials", async () => {
			await writeProviders(customEntry({ type: "anthropic" }));
			const stream = create().streamChat(
				{ providerId: customId, modelId: "m1", systemPrompt: "", messages: [] },
				{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
			);

			await expect(stream[Symbol.asyncIterator]().next()).rejects.toThrow(
				`No credentials for provider ${customId}`,
			);
		});

		async function* partsOf(...parts: LMStreamPart[]) {
			yield* parts;
		}

		async function collect(stream: AsyncIterable<string>) {
			const text: string[] = [];
			const failure = await (async () => {
				for await (const chunk of stream) {
					text.push(chunk);
				}
			})().then(
				() => undefined,
				(error: unknown) => error,
			);
			return { text, failure };
		}

		async function streamServedParts(...parts: LMStreamPart[]) {
			await writeProviders(customEntry({ baseUrl: await startModelServer() }));
			vi.spyOn(ProviderRegistry.prototype, "getClientForProviderOrKind").mockReturnValue({
				chat: async () => partsOf(...parts),
			});
			return collect(
				create().streamChat(
					{ providerId: customId, modelId: "m1", systemPrompt: "", messages: [] },
					{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
				),
			);
		}

		it("yields the text received before a stream error, then rejects", async () => {
			const error = new Error("connection reset");

			const result = await streamServedParts(
				{ type: "text-delta", id: "1", text: "partial" },
				{ type: "error", error },
			);

			expect(result).toEqual({ text: ["partial"], failure: error });
		});

		describe("routing", () => {
			async function sendTo(headless: HeadlessProviders, modelId: string) {
				await collect(
					headless.streamChat(
						{
							providerId: customId,
							modelId,
							systemPrompt: "",
							messages: [{ role: "user", content: "hi" }],
						},
						{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
					),
				);
			}

			it("sends to the Responses endpoint for a provider with a Responses protocol", async () => {
				await writeProviders(
					customEntry({
						baseUrl: await startModelServer(),
						protocol: "openai-responses",
						models: { allow: ["m1"] },
					}),
				);

				await sendTo(create(), "m1");

				expect(requestUrls).toEqual(["/models", "/responses"]);
			});

			it("sends to a model's overridden base URL", async () => {
				const baseUrl = await startModelServer();
				await writeProviders(
					customEntry({ baseUrl, models: { overrides: { m1: { baseUrl: `${baseUrl}/m1` } } } }),
				);

				await sendTo(create(), "m1");

				expect(requestUrls).toEqual(["/models", "/m1/chat/completions"]);
			});

			it("routes a declared model without a discovery request when discovery is off", async () => {
				await writeProviders(
					customEntry({
						baseUrl: await startModelServer(),
						protocol: "openai-responses",
						models: offWithDeclared,
					}),
				);

				await sendTo(create(), "declared");

				expect(requestUrls).toEqual(["/responses"]);
			});

			it("rejects a model the policy denies without sending it", async () => {
				await writeProviders(
					customEntry({ baseUrl: await startModelServer(), models: { deny: ["m1"] } }),
				);

				const result = await collect(
					create().streamChat(
						{ providerId: customId, modelId: "m1", systemPrompt: "", messages: [] },
						{ isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) },
					),
				);

				expect(result.failure).toEqual(
					new Error(`Model "m1" is no longer available from "${customId}".`),
				);
				expect(requestUrls).toEqual(["/models"]);
			});

			it("routes by the current catalog after a change", async () => {
				const baseUrl = await startModelServer();
				await writeProviders(customEntry({ baseUrl }));
				const headless = create();
				await headless.listModels(customId, undefined);
				const changed = new Promise<void>((resolve) =>
					headless.onDidChangeCatalog(() => resolve()),
				);

				await writeProviders(customEntry({ baseUrl, protocol: "openai-responses" }));
				await changed;
				await sendTo(headless, "m1");

				expect(requestUrls).toEqual(["/models", "/models", "/responses"]);
			});
		});
	});
});
