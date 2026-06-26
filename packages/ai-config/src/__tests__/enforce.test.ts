/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, it, expect } from "vitest";

import { mergeEnforced } from "../enforce";
import type { ProvidersConfig } from "../types";

describe("mergeEnforced", () => {
	it("returns user config when enforced is empty", () => {
		const user: ProvidersConfig = {
			version: 1,
			providers: { anthropic: { baseUrl: "https://user.example.com" } },
		};
		const result = mergeEnforced(user, {});
		expect(result).toEqual(user);
	});

	it("enforced key wins over user key", () => {
		const user: ProvidersConfig = {
			providers: { anthropic: { baseUrl: "https://user.example.com" } },
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: { anthropic: { baseUrl: "https://admin.example.com" } },
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.baseUrl).toBe("https://admin.example.com");
	});

	it("user keys not in enforced are preserved", () => {
		const user: ProvidersConfig = {
			providers: {
				anthropic: { baseUrl: "https://user.example.com" },
				openai: { baseUrl: "https://openai.example.com" },
			},
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: { anthropic: { baseUrl: "https://admin.example.com" } },
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.baseUrl).toBe("https://admin.example.com");
		expect(result.providers?.openai?.baseUrl).toBe("https://openai.example.com");
	});

	it("deep-merges nested objects per key", () => {
		const user: ProvidersConfig = {
			providers: {
				anthropic: {
					customHeaders: { "x-team": "user-team", "x-other": "value" },
				},
			},
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: {
				anthropic: {
					customHeaders: { "x-gateway-auth": "admin-secret" },
				},
			},
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.customHeaders).toEqual({
			"x-team": "user-team",
			"x-other": "value",
			"x-gateway-auth": "admin-secret",
		});
	});

	it("enforced customHeaders key wins over user same key", () => {
		const user: ProvidersConfig = {
			providers: {
				anthropic: { customHeaders: { "x-team": "user-team" } },
			},
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: {
				anthropic: { customHeaders: { "x-team": "admin-team" } },
			},
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.customHeaders?.["x-team"]).toBe("admin-team");
	});

	it("arrays replace wholesale (v1 semantics)", () => {
		const user: ProvidersConfig = {
			providers: {
				anthropic: {
					models: {
						allow: ["model-a", "model-b", "model-c"],
					},
				},
			},
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: {
				anthropic: {
					models: {
						allow: ["model-a"],
					},
				},
			},
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.models?.allow).toEqual(["model-a"]);
	});

	it("enforced enabled wins over user enabled", () => {
		const user: ProvidersConfig = {
			providers: { anthropic: { enabled: true } },
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: { anthropic: { enabled: false } },
		};
		const result = mergeEnforced(user, enforced);
		expect(result.providers?.anthropic?.enabled).toBe(false);
	});

	it("does not mutate user config", () => {
		const user: ProvidersConfig = {
			providers: { anthropic: { baseUrl: "https://user.example.com" } },
		};
		const enforced: Partial<ProvidersConfig> = {
			providers: { anthropic: { baseUrl: "https://admin.example.com" } },
		};
		mergeEnforced(user, enforced);
		expect(user.providers?.anthropic?.baseUrl).toBe("https://user.example.com");
	});
});
