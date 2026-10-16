/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { PlainSettings, Settings, SettingsStore } from "@api/Settings";

import { applyLegacyPluginSettings } from "./legacySettings";

interface messageLoggerSettingsTarget {
    settings: {
        store: Record<string, unknown>;
        def: Record<string, { onChange?: (...args: any[]) => unknown; }>;
    };
}

const defaults = {
    deleteStyle: "text",
    collapseDeleted: false,
    inlineEdits: true,
    logDeletes: true,
    logEdits: true,
    logDeletedAttachments: true
};

let target: messageLoggerSettingsTarget | undefined;
let original: PropertyDescriptor | undefined;
let adaptedGetter: (() => Record<string, unknown>) | undefined;

function migrate(local: Record<string, unknown>, legacy: Record<string, unknown> = {}) {
    if (local.messageLoggerSettingsVersion === 1) return false;

    for (const [key, fallback] of Object.entries(defaults)) {
        const value = Object.hasOwn(local, key) ? local[key] : legacy[key];
        local[key] = key === "deleteStyle"
            ? value === "text" || value === "overlay" ? value : fallback
            : typeof value === "boolean" ? value : fallback;
    }

    const lists = [local.blacklistedIds, legacy.ignoreUsers, legacy.ignoreChannels, legacy.ignoreGuilds];
    const ids = lists.flatMap(value => typeof value === "string" ? value.split(",").map(id => id.trim()).filter(Boolean) : []);
    local.blacklistedIds = [...new Set(ids)].join(",");
    local.messageLoggerSettingsVersion = 1;
    return true;
}

function enabled() {
    return PlainSettings.plugins.AegisLogger?.enabled === true;
}

function prepare() {
    if (!enabled()) return;
    applyLegacyPluginSettings((Settings.plugins as Record<string, Record<string, unknown>>).AegisLogger);
    const local = PlainSettings.plugins.AegisLogger as Record<string, unknown>;
    if (migrate(local, PlainSettings.plugins.MessageLogger)) SettingsStore.markAsChanged();
}

function ready() {
    return target != null && Object.getOwnPropertyDescriptor(target.settings, "store")?.get === adaptedGetter;
}

function install(next: messageLoggerSettingsTarget) {
    if (target === next && ready()) return true;
    const descriptor = Object.getOwnPropertyDescriptor(next?.settings ?? {}, "store");
    if (!descriptor?.configurable || typeof descriptor.get !== "function" || next.settings.def == null
        || Object.keys(defaults).some(key => next.settings.def[key] == null)
        || typeof next.settings.def.deleteStyle.onChange !== "function") return false;

    target = next;
    original = descriptor;
    adaptedGetter = () => {
        if (!enabled()) return descriptor.get!.call(next.settings);
        prepare();
        const local = (Settings.plugins as Record<string, Record<string, unknown>>).AegisLogger;
        return {
            ...Object.fromEntries(Object.entries(defaults).map(([key, fallback]) => [key, local[key] ?? fallback])),
            ignoreBots: local.ignoreBots,
            ignoreSelf: local.ignoreSelf,
            ignoreUsers: "",
            ignoreChannels: "",
            ignoreGuilds: ""
        };
    };
    Object.defineProperty(next.settings, "store", { ...descriptor, get: adaptedGetter });
    return true;
}

function refreshStyle() {
    if (!ready()) return false;
    target!.settings.def.deleteStyle.onChange!();
    return true;
}

function restore() {
    if (ready() && original) Object.defineProperty(target!.settings, "store", original);
    target = undefined;
    original = undefined;
    adaptedGetter = undefined;
}

const messageLoggerSettings = { install, prepare, ready, refreshStyle, restore, migrate };

export default messageLoggerSettings;
