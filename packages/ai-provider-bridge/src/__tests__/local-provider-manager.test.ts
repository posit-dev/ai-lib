/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	LOCAL_PROVIDER_IDS,
	LocalProviderManager,
	type LocalProviderManagerOptions,
	isLocalProviderId,
} from "../local-providers";

// ---- Mock helpers ----

function createMockOptions(
	overrides: Partial<LocalProviderManagerOptions> = {},
): LocalProviderManagerOptions {
	return {
		readSettings: vi.fn().mockResolvedValue(undefined),
		mutateSettings: vi.fn().mockResolvedValue(undefined),
		watchSettings: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		isEnabled: vi.fn().mockReturnValue(true),
		watchEnabled: vi.fn().mockReturnValue({ dispose: vi.fn() }),
		logger: { warn: vi.fn(), info: vi.fn() },
		...overrides,
	};
}

describe("LOCAL_PROVIDER_IDS", () => {
	it("contains ollama and lmstudio", () => {
		expect(LOCAL_PROVIDER_IDS).toEqual(["ollama", "lmstudio"]);
	});
});

describe("isLocalProviderId", () => {
	it("returns true for local providers", () => {
		expect(isLocalProviderId("ollama")).toBe(true);
		expect(isLocalProviderId("lmstudio")).toBe(true);
	});

	it("returns false for non-local providers", () => {
		expect(isLocalProviderId("anthropic")).toBe(false);
		expect(isLocalProviderId("positai")).toBe(false);
	});
});

describe("LocalProviderManager", () => {
	let options: LocalProviderManagerOptions;
	let manager: LocalProviderManager;

	beforeEach(() => {
		options = createMockOptions();
		manager = new LocalProviderManager(options);
	});

	describe("initialize()", () => {
		it("reads settings and populates cache from providers section", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: {
					ollama: { endpoint: "http://localhost:11434" },
				},
			});

			await manager.initialize();

			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");
			expect(manager.getEndpoint("lmstudio")).toBeUndefined();
		});

		it("treats undefined readSettings result as empty config (ENOENT)", async () => {
			vi.mocked(options.readSettings).mockResolvedValue(undefined);

			await manager.initialize();

			expect(manager.getEndpoint("ollama")).toBeUndefined();
			expect(manager.getEndpoint("lmstudio")).toBeUndefined();
		});

		it("starts a settings file watcher", async () => {
			await manager.initialize();
			expect(options.watchSettings).toHaveBeenCalledWith(expect.any(Function));
		});

		it("starts a feature-gate watcher", async () => {
			await manager.initialize();
			expect(options.watchEnabled).toHaveBeenCalledWith(expect.any(Function));
		});
	});

	describe("getEndpoint()", () => {
		it("returns undefined before initialize", () => {
			expect(manager.getEndpoint("ollama")).toBeUndefined();
		});

		it("returns cached value after initialize", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { lmstudio: { endpoint: "http://localhost:1234/v1" } },
			});
			await manager.initialize();
			expect(manager.getEndpoint("lmstudio")).toBe("http://localhost:1234/v1");
		});

		it("corrects a stored bare default host to its versioned form (lmstudio)", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: {
					ollama: { endpoint: "http://localhost:11434" },
					lmstudio: { endpoint: "http://localhost:1234" },
				},
			});
			await manager.initialize();
			// Previously stored bare-root LM Studio endpoints keep working now
			// that clients trust endpoints as given (see base-url.ts).
			expect(manager.getEndpoint("lmstudio")).toBe("http://localhost:1234/v1");
			// Ollama has no version segment (native API) — returned as stored.
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");
		});

		it("returns a custom lmstudio endpoint as stored, without correction", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { lmstudio: { endpoint: "http://gpu-box:1234" } },
			});
			await manager.initialize();
			expect(manager.getEndpoint("lmstudio")).toBe("http://gpu-box:1234");
		});

		it("treats non-string endpoint values as unset", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: {
					ollama: { endpoint: 42 },
					lmstudio: { endpoint: {} },
				},
			});
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBeUndefined();
			expect(manager.getEndpoint("lmstudio")).toBeUndefined();
		});

		it("treats non-object providers root as empty", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({ providers: "bad" });
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBeUndefined();
		});

		it("treats non-object provider entry as unset", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: "bad" },
			});
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBeUndefined();
		});
	});

	describe("setEndpoint()", () => {
		it("calls mutateSettings with correct mutation", async () => {
			await manager.initialize();
			await manager.setEndpoint("ollama", "http://localhost:11434");

			expect(options.mutateSettings).toHaveBeenCalledWith(expect.any(Function));

			// Verify the mutator sets the right key
			const mutator = vi.mocked(options.mutateSettings).mock.calls[0][0];
			const config: Record<string, unknown> = {};
			mutator(config);
			expect(config).toEqual({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
		});

		it("normalizes malformed providers root when writing", async () => {
			await manager.initialize();
			await manager.setEndpoint("ollama", "http://localhost:11434");

			const mutator = vi.mocked(options.mutateSettings).mock.calls[0][0];
			const config: Record<string, unknown> = { providers: "bad" };
			mutator(config);
			expect(config).toEqual({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
		});

		it("normalizes malformed provider entry when writing", async () => {
			await manager.initialize();
			await manager.setEndpoint("ollama", "http://localhost:11434");

			const mutator = vi.mocked(options.mutateSettings).mock.calls[0][0];
			const config: Record<string, unknown> = { providers: { ollama: "bad" } };
			mutator(config);
			expect(config).toEqual({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
		});

		it("updates cache immediately", async () => {
			await manager.initialize();
			await manager.setEndpoint("ollama", "http://localhost:11434");
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");
		});

		it("fires onDidChange when value changes", async () => {
			await manager.initialize();
			const callback = vi.fn();
			manager.onDidChange(callback);

			await manager.setEndpoint("ollama", "http://localhost:11434");

			expect(callback).toHaveBeenCalledWith(["ollama"]);
		});

		it("does not fire onDidChange when value is unchanged", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
			await manager.initialize();
			const callback = vi.fn();
			manager.onDidChange(callback);

			await manager.setEndpoint("ollama", "http://localhost:11434");

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("clearEndpoint()", () => {
		it("calls mutateSettings with deletion mutation", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
			await manager.initialize();

			await manager.clearEndpoint("ollama");

			const mutator = vi.mocked(options.mutateSettings).mock.calls[0][0];
			const config: Record<string, unknown> = {
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			};
			mutator(config);
			// Should prune empty parents
			expect(config).toEqual({});
		});

		it("removes from cache and fires onDidChange", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");

			const callback = vi.fn();
			manager.onDidChange(callback);

			await manager.clearEndpoint("ollama");

			expect(manager.getEndpoint("ollama")).toBeUndefined();
			expect(callback).toHaveBeenCalledWith(["ollama"]);
		});

		it("does not fire when provider already has no endpoint", async () => {
			await manager.initialize();
			const callback = vi.fn();
			manager.onDidChange(callback);

			await manager.clearEndpoint("lmstudio");

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("isEnabled()", () => {
		it("delegates to injected callback", () => {
			vi.mocked(options.isEnabled).mockReturnValue(false);
			expect(manager.isEnabled()).toBe(false);

			vi.mocked(options.isEnabled).mockReturnValue(true);
			expect(manager.isEnabled()).toBe(true);
		});
	});

	describe("file watcher triggers reload", () => {
		it("preserves last good cache on parse failure", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");

			// Get the watcher onChange callback
			const watcherOnChange = vi.mocked(options.watchSettings).mock.calls[0][0];

			// Simulate a parse error on next read
			vi.mocked(options.readSettings).mockRejectedValue(new SyntaxError("bad json"));

			watcherOnChange();
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Cache should be preserved
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");
			expect(options.logger.warn).toHaveBeenCalled();
		});

		it("clears cache when settings returns undefined (file deleted)", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: { ollama: { endpoint: "http://localhost:11434" } },
			});
			await manager.initialize();
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:11434");

			const watcherOnChange = vi.mocked(options.watchSettings).mock.calls[0][0];
			vi.mocked(options.readSettings).mockResolvedValue(undefined);

			const callback = vi.fn();
			manager.onDidChange(callback);

			watcherOnChange();
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(manager.getEndpoint("ollama")).toBeUndefined();
			expect(callback).toHaveBeenCalledWith(["ollama"]);
		});

		it("fires onDidChange only for providers whose endpoints changed", async () => {
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: {
					ollama: { endpoint: "http://localhost:11434" },
					lmstudio: { endpoint: "http://localhost:1234/v1" },
				},
			});
			await manager.initialize();

			const watcherOnChange = vi.mocked(options.watchSettings).mock.calls[0][0];

			// Only ollama changes
			vi.mocked(options.readSettings).mockResolvedValue({
				providers: {
					ollama: { endpoint: "http://localhost:99999" },
					lmstudio: { endpoint: "http://localhost:1234/v1" },
				},
			});

			const callback = vi.fn();
			manager.onDidChange(callback);

			watcherOnChange();
			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(callback).toHaveBeenCalledWith(["ollama"]);
			expect(manager.getEndpoint("ollama")).toBe("http://localhost:99999");
			expect(manager.getEndpoint("lmstudio")).toBe("http://localhost:1234/v1");
		});
	});

	describe("feature-gate watcher", () => {
		it("fires onDidChange with all provider IDs when feature gate changes", async () => {
			await manager.initialize();

			// Get the watchEnabled callback
			const enabledOnChange = vi.mocked(options.watchEnabled).mock.calls[0][0];

			const callback = vi.fn();
			manager.onDidChange(callback);

			enabledOnChange();

			expect(callback).toHaveBeenCalledWith([...LOCAL_PROVIDER_IDS]);
		});
	});

	describe("onDidChange()", () => {
		it("returns a disposable that unsubscribes the callback", async () => {
			await manager.initialize();
			const callback = vi.fn();
			const disposable = manager.onDidChange(callback);

			disposable.dispose();
			await manager.setEndpoint("ollama", "http://localhost:11434");

			expect(callback).not.toHaveBeenCalled();
		});
	});

	describe("dispose()", () => {
		it("stops both watchers", async () => {
			const settingsDispose = vi.fn();
			const enabledDispose = vi.fn();
			vi.mocked(options.watchSettings).mockReturnValue({ dispose: settingsDispose });
			vi.mocked(options.watchEnabled).mockReturnValue({ dispose: enabledDispose });

			await manager.initialize();
			manager.dispose();

			expect(settingsDispose).toHaveBeenCalled();
			expect(enabledDispose).toHaveBeenCalled();
		});

		it("clears all change callbacks", async () => {
			await manager.initialize();
			const callback = vi.fn();
			manager.onDidChange(callback);

			manager.dispose();
			// Simulate a settings change after dispose
			await manager.setEndpoint("ollama", "http://localhost:11434");

			expect(callback).not.toHaveBeenCalled();
		});
	});
});
