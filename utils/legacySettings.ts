/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Settings } from "@api/Settings";

import { settings } from "../settings";

const LEGACY_PLUGIN_NAME = "MessageLoggerEnhanced";

const MIGRATABLE_KEYS = [
    "ShowLogsButton",
    "messagesToDisplayAtOnceInLogs",
    "sortNewest",
    "saveImages",
    "attachmentSizeLimitInMegabytes",
    "attachmentFileExtensions",
    "messageLimit",
    "cacheLimit",
    "alwaysLogDirectMessages",
    "alwaysLogCurrentChannel",
    "ignoreBots",
    "ignoreSelf",
    "ignoreMutedGuilds",
    "ignoreMutedCategories",
    "ignoreMutedChannels",
    "whitelistedIds",
    "blacklistedIds",
    "permanentlyRemoveLogByDefault",
    "hideMessageFromMessageLoggers",
    "hideMessageFromMessageLoggersDeletedMessage",
];

export function mapLegacyPluginSettings(legacy: Record<string, unknown>): Record<string, unknown> {
    const mapped: Record<string, unknown> = {};
    if (!legacy) return mapped;

    for (const key of MIGRATABLE_KEYS) {
        if (key in legacy) mapped[key] = legacy[key];
    }
    return mapped;
}

export function applyLegacyPluginSettings(): boolean {
    const legacy = (Settings.plugins as Record<string, Record<string, unknown> | undefined>)[LEGACY_PLUGIN_NAME];
    if (!legacy) return false;

    for (const [key, value] of Object.entries(mapLegacyPluginSettings(legacy)))
        (settings.store as Record<string, unknown>)[key] = value;

    delete (Settings.plugins as Record<string, unknown>)[LEGACY_PLUGIN_NAME];
    return true;
}
