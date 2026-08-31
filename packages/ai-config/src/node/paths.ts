/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * Centralized path and env-var constants for providers.json.
 *
 * All filesystem paths and environment variable names are defined here so
 * a future rename is a one-line edit.
 */

import * as os from "os";
import * as path from "path";

/** Directory containing cross-product AI configuration. */
export const AI_CONFIG_DIR = path.join(os.homedir(), ".posit", "ai");

/** Full path to the providers.json config file. */
export const PROVIDERS_CONFIG_PATH = path.join(AI_CONFIG_DIR, "providers.json");

/**
 * Environment variable whose value is a JSON fragment of **enforced** config
 * — the sealed admin overlay. When set, the fragment deep-merges over every
 * lower-precedence source with enforced keys winning (arrays replace, objects
 * per-key merge) and can never be overridden.
 */
export const ENFORCED_ENV_VAR = "POSIT_AI_PROVIDERS_ENFORCED";

/**
 * Environment variable whose value is a JSON fragment of **default** config
 * — Workbench admin defaults. Sits below the user file and the legacy
 * Positron settings layer, so a user's `providers.json` (or legacy
 * `authentication.*`) overrides it. Uses the same relaxed fragment shape as
 * the enforced overlay.
 */
export const DEFAULT_ENV_VAR = "POSIT_AI_PROVIDERS_DEFAULT";

/**
 * Lockfile path used for cross-process safe writes to providers.json.
 * Hidden file next to the config file.
 */
export const PROVIDERS_LOCKFILE_PATH = `${PROVIDERS_CONFIG_PATH}.lock`;

/**
 * Hosted `providers.schema.json`, seeded into new `providers.json` files as
 * `$schema` so editors (VS Code, Positron) can fetch and cache it for hover
 * text and validation. Covers `PROVIDERS_CONFIG_VERSION` 1; a future breaking
 * schema change gets its own versioned URL alongside a bumped config version.
 */
export const PROVIDERS_SCHEMA_URL = "https://assistant.posit.co/schemas/providers.schema.json";

/**
 * The legacy `$schema` value seeded before the schema was hosted at
 * {@link PROVIDERS_SCHEMA_URL}. `mutateProvidersConfig` migrates any file
 * whose `$schema` still exactly matches this literal — see `mutate-config.ts`.
 */
export const LEGACY_PROVIDERS_SCHEMA_PATH = "./providers.schema.json";
