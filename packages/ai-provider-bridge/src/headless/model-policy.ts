/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import { resolveModels } from "ai-config";
import type { Protocol, ResolvedProvider } from "ai-config";

import type { ModelInfo } from "../types.js";
import type { HeadlessModel } from "./types.js";

/** A model's resolved wire protocol and endpoint; undefined fields fall back to the client default. */
export interface ModelRoute {
	readonly protocol: Protocol | undefined;
	readonly baseUrl: string | undefined;
}

export interface ResolvedModels {
	readonly models: HeadlessModel[];
	readonly routes: ReadonlyMap<string, ModelRoute>;
}

/**
 * Resolve discovered models against a provider's catalog entry: its model
 * policy and its connection routing. Declared `custom` models appear even when
 * discovery never reported them.
 */
export function applyModelPolicy(
	provider: Pick<ResolvedProvider, "models" | "connection"> | undefined,
	providerId: string,
	models: readonly ModelInfo[],
): ResolvedModels {
	const vendors = new Map(models.map((model) => [model.id, model.vendor]));
	const resolved = resolveModels(provider?.models, models, provider?.connection, { providerId });
	return {
		models: resolved.map((model) => describe(model, vendors.get(model.id), providerId)),
		routes: new Map(
			resolved.map((model) => [
				model.id,
				{ protocol: model.resolvedProtocol, baseUrl: model.resolvedBaseUrl },
			]),
		),
	};
}

function describe(
	model: { id: string; name: string },
	vendor: string | undefined,
	providerId: string,
): HeadlessModel {
	return { id: model.id, name: model.name, vendor: vendor ?? providerId, providerId };
}
