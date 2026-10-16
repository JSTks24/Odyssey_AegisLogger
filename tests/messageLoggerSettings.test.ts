/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    plain: { plugins: {} as Record<string, Record<string, any>> },
    changed: vi.fn(),
    legacyMigration: vi.fn(),
    defaultReads: vi.fn()
}));

vi.mock("@api/Settings", () => ({
    Settings: {
        get plugins() {
            return new Proxy(state.plain.plugins, {
                get(plugins, name: string) {
                    const local = plugins[name];
                    if (name !== "AegisLogger" || local == null) return local;
                    return new Proxy(local, {
                        get(value, key: string) {
                            const defaults: Record<string, unknown> = {
                                deleteStyle: "text", collapseDeleted: false, inlineEdits: true,
                                logDeletes: true, logEdits: true, logDeletedAttachments: true
                            };
                            if (!Object.hasOwn(value, key) && Object.hasOwn(defaults, key)) {
                                state.defaultReads(key);
                                value[key] = defaults[key];
                            }
                            return value[key];
                        }
                    });
                }
            });
        }
    },
    PlainSettings: state.plain,
    SettingsStore: { markAsChanged: state.changed }
}));

vi.mock("../utils/legacySettings", () => ({ applyLegacyPluginSettings: state.legacyMigration }));

import messageLoggerSettings from "../utils/messageLoggerSettings";

const keys = ["deleteStyle", "collapseDeleted", "inlineEdits", "logDeletes", "logEdits", "logDeletedAttachments"];

function makeTarget() {
    const onChange = vi.fn();
    const target = {
        settings: {
            pluginName: "MessageLogger",
            def: Object.fromEntries(keys.map(key => [key, key === "deleteStyle" ? { onChange } : {}])),
            get store() { return state.plain.plugins.MessageLogger; }
        }
    };
    return { target, onChange };
}

beforeEach(() => {
    messageLoggerSettings.restore();
    vi.clearAllMocks();
    state.plain.plugins = {
        AegisLogger: { enabled: true, ignoreBots: false, blacklistedIds: "own,duplicate", whitelistedIds: "allowed" },
        MessageLogger: {
            deleteStyle: "overlay", collapseDeleted: true, inlineEdits: false,
            logDeletes: false, logEdits: false, logDeletedAttachments: false,
            ignoreBots: true, ignoreSelf: true,
            ignoreUsers: " user,duplicate ", ignoreChannels: "channel,category", ignoreGuilds: "guild,user"
        }
    };
});

afterEach(() => messageLoggerSettings.restore());

describe("MessageLogger settings migration", () => {
    it("copies missing settings and merges ignore lists once without changing ML or the whitelist", () => {
        const source = structuredClone(state.plain.plugins.MessageLogger);
        const local = state.plain.plugins.AegisLogger;
        expect(messageLoggerSettings.migrate(local, source)).toBe(true);
        expect(local).toMatchObject({
            deleteStyle: "overlay", collapseDeleted: true, inlineEdits: false,
            logDeletes: false, logEdits: false, logDeletedAttachments: false,
            blacklistedIds: "own,duplicate,user,channel,category,guild",
            whitelistedIds: "allowed", ignoreBots: false, messageLoggerSettingsVersion: 1
        });
        local.blacklistedIds = "changed";
        source.ignoreUsers = "later";
        expect(messageLoggerSettings.migrate(local, source)).toBe(false);
        expect(local.blacklistedIds).toBe("changed");
        expect(state.plain.plugins.MessageLogger).toEqual({ ...source, ignoreUsers: " user,duplicate " });
    });

    it("keeps explicit false values and existing local choices", () => {
        const local = { deleteStyle: "text", collapseDeleted: false, inlineEdits: false, logDeletes: false, blacklistedIds: "" };
        messageLoggerSettings.migrate(local, { deleteStyle: "overlay", collapseDeleted: true, inlineEdits: true, logDeletes: true });
        expect(local).toMatchObject({ deleteStyle: "text", collapseDeleted: false, inlineEdits: false, logDeletes: false });
    });

    it("uses defaults for absent or invalid values and ignores malformed lists", () => {
        const local: Record<string, unknown> = { deleteStyle: "invalid", logEdits: "false" };
        messageLoggerSettings.migrate(local, { collapseDeleted: "yes", ignoreUsers: ["bad"], ignoreChannels: null });
        expect(local).toEqual({
            deleteStyle: "text", collapseDeleted: false, inlineEdits: true,
            logDeletes: true, logEdits: true, logDeletedAttachments: true,
            blacklistedIds: "", messageLoggerSettingsVersion: 1
        });
    });
});

describe("MessageLogger early settings adapter", () => {
    it("migrates before startup patch predicates without initializing AegisLogger.settings.pluginName", () => {
        const { target } = makeTarget();
        const source = structuredClone(state.plain.plugins.MessageLogger);
        expect(messageLoggerSettings.install(target)).toBe(true);
        expect(state.changed).not.toHaveBeenCalled();
        expect(target.settings.store.collapseDeleted).toBe(true);
        expect(target.settings.store.logDeletedAttachments).toBe(false);
        expect(state.legacyMigration).toHaveBeenCalledWith(state.plain.plugins.AegisLogger);
        expect(state.changed).toHaveBeenCalledTimes(1);
        expect(state.defaultReads).not.toHaveBeenCalled();
        expect(state.plain.plugins.MessageLogger).toEqual(source);
    });

    it("uses local settings even when native values later disagree", () => {
        const { target } = makeTarget();
        messageLoggerSettings.install(target);
        messageLoggerSettings.prepare();
        Object.assign(state.plain.plugins.AegisLogger, { logEdits: true, ignoreBots: false, deleteStyle: "text" });
        Object.assign(state.plain.plugins.MessageLogger, { logEdits: false, ignoreBots: true, deleteStyle: "overlay" });
        expect(target.settings.store).toMatchObject({
            logEdits: true, ignoreBots: false, deleteStyle: "text",
            ignoreUsers: "", ignoreChannels: "", ignoreGuilds: ""
        });
    });

    it("leaves disabled installations unmigrated and uses the original ML store", () => {
        const { target } = makeTarget();
        state.plain.plugins.AegisLogger.enabled = false;
        messageLoggerSettings.install(target);
        expect(target.settings.store).toBe(state.plain.plugins.MessageLogger);
        expect(state.changed).not.toHaveBeenCalled();
        expect(state.legacyMigration).not.toHaveBeenCalled();
        expect(state.plain.plugins.AegisLogger).not.toHaveProperty("messageLoggerSettingsVersion");
    });

    it("restores ML behavior when AegisLogger is disabled after using the adapter", () => {
        const { target, onChange } = makeTarget();
        messageLoggerSettings.install(target);
        state.plain.plugins.AegisLogger.deleteStyle = "text";
        messageLoggerSettings.refreshStyle();
        expect(onChange).toHaveBeenCalledOnce();
        expect(target.settings.store.deleteStyle).toBe("text");
        state.plain.plugins.AegisLogger.enabled = false;
        expect(target.settings.store.deleteStyle).toBe("overlay");
    });

    it("installs idempotently and restores the exact original descriptor", () => {
        const { target } = makeTarget();
        const original = Object.getOwnPropertyDescriptor(target.settings, "store");
        messageLoggerSettings.install(target);
        const adapted = Object.getOwnPropertyDescriptor(target.settings, "store");
        messageLoggerSettings.install(target);
        expect(Object.getOwnPropertyDescriptor(target.settings, "store")).toEqual(adapted);
        messageLoggerSettings.restore();
        expect(Object.getOwnPropertyDescriptor(target.settings, "store")).toEqual(original);
    });

    it("does not overwrite a later adapter during cleanup and reports lost ownership", () => {
        const { target } = makeTarget();
        messageLoggerSettings.install(target);
        const replacement = () => ({ custom: true });
        Object.defineProperty(target.settings, "store", { configurable: true, get: replacement });
        expect(messageLoggerSettings.ready()).toBe(false);
        expect(messageLoggerSettings.refreshStyle()).toBe(false);
        messageLoggerSettings.restore();
        expect(Object.getOwnPropertyDescriptor(target.settings, "store")?.get).toBe(replacement);
    });

    it("rejects incompatible setting contracts", () => {
        const { target } = makeTarget();
        Object.defineProperty(target.settings, "store", { configurable: false });
        expect(messageLoggerSettings.install(target)).toBe(false);
        expect(messageLoggerSettings.ready()).toBe(false);
    });

    it("rejects missing patch controls instead of silently claiming independence", () => {
        const { target } = makeTarget();
        delete target.settings.def.collapseDeleted;
        expect(messageLoggerSettings.install(target)).toBe(false);
        expect(messageLoggerSettings.ready()).toBe(false);
    });

    it("rejects a missing definition object without failing module evaluation", () => {
        const { target } = makeTarget();
        target.settings.def = undefined as any;
        expect(messageLoggerSettings.install(target)).toBe(false);
        expect(messageLoggerSettings.ready()).toBe(false);
    });
});
