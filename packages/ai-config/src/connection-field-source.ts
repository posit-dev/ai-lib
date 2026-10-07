/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

import type { ResolvedConnectionFieldSource } from "./types.js";

/**
 * Whether a connection field's effective value is pinned: set by an
 * environment variable or an administrator's enforced config, both of which
 * outrank the user layer. A configure form shows a pinned field read-only and
 * a save must not change it or copy it into the user layer.
 */
export function isPinnedConnectionFieldSource(
	source: ResolvedConnectionFieldSource | undefined,
): source is "environment" | "enforced" {
	return source === "environment" || source === "enforced";
}
