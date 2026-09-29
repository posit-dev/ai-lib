/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { describe, expect, it } from "vitest";

import { diffProviderCatalogs } from "../node/index.js";
import type { ResolvedProvider } from "../types.js";

function provider(id: string, overrides: Partial<ResolvedProvider> = {}): ResolvedProvider {
	return {
		id: id as ResolvedProvider["id"],
		clientKind: "openai-compatible",
		enabled: true,
		connection: { baseUrl: `https://${id}.example/v1` },
		connectionProvenance: {},
		models: undefined,
		...overrides,
	};
}

describe("diffProviderCatalogs", () => {
	it("returns no entries for equivalent catalogs", () => {
		expect(
			diffProviderCatalogs([provider("a"), provider("b")], [provider("a"), provider("b")]),
		).toEqual([]);
	});

	it("classifies each changed provider independently and omits unchanged ones", () => {
		const previous = [provider("a"), provider("b"), provider("c"), provider("d")];
		const current = [
			provider("a", { enabled: false }),
			provider("b", { connection: { baseUrl: "https://moved.example/v1" } }),
			provider("c"),
			provider("d", { models: { deny: ["m"] } }),
		];

		expect(diffProviderCatalogs(previous, current)).toEqual([
			{ id: "a", change: "updated", enabled: true, connection: false, models: false },
			{ id: "b", change: "updated", enabled: false, connection: true, models: false },
			{ id: "d", change: "updated", enabled: false, connection: false, models: true },
		]);
	});

	it("reports additions and removals with every category set, previous order first", () => {
		expect(
			diffProviderCatalogs(
				[provider("gone"), provider("kept")],
				[provider("new"), provider("kept")],
			),
		).toEqual([
			{ id: "gone", change: "removed", enabled: true, connection: true, models: true },
			{ id: "new", change: "added", enabled: true, connection: true, models: true },
		]);
	});

	it("puts client-kind, provenance, and auth-policy changes in the connection category", () => {
		const previous = [provider("kind"), provider("prov"), provider("auth")];
		const current = [
			provider("kind", { clientKind: "litellm" }),
			provider("prov", { connectionProvenance: { aws: { region: "environment" } } }),
			provider("auth", { authPolicy: { apiKeyOptional: true, source: "user" } }),
		];

		const diffs = diffProviderCatalogs(previous, current);
		expect(diffs.map((d) => [d.id, d.connection, d.enabled, d.models])).toEqual([
			["kind", true, false, false],
			["prov", true, false, false],
			["auth", true, false, false],
		]);
	});
});
