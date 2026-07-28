/*---------------------------------------------------------------------------------------------
 *  Copyright (C) 2026 Posit Software, PBC. All rights reserved.
 *--------------------------------------------------------------------------------------------*/

/**
 * PROVIDER-SETTINGS-MIGRATION(legacy-positron): delete this module with the
 * legacy settings channels.
 *
 * Public surface of the legacy-settings module: the map, the translator, and
 * their types. The source builders in `sources.ts` are loader-internal and
 * deliberately absent here.
 */

export { LEGACY_CONNECTION_ROWS, legacySettingKeys } from "./map.js";
export type { LegacyConnectionRow } from "./map.js";
export { translateLegacyPositronSettings } from "./translate.js";
export type {
	LegacySettingsReader,
	SettingMigration,
	TranslatedLegacySettings,
} from "./translate.js";
