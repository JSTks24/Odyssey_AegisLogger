import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    settings: { plugins: {} } as { plugins: Record<string, Record<string, unknown> | undefined> },
    store: {} as Record<string, unknown>
}));

vi.mock("@api/Settings", () => ({
    Settings: state.settings
}));

vi.mock("../settings", () => ({
    settings: { store: state.store }
}));

import { Settings } from "@api/Settings";
import { applyLegacyPluginSettings, mapLegacyPluginSettings } from "../utils/legacySettings";

const LEGACY_BLOCK: Record<string, unknown> = {
    enabled: true,
    saveImages: true,
    sortNewest: true,
    cacheMessagesFromServers: true,
    ignoreBots: true,
    messageLimit: 0,
    cacheLimit: 50000,
    whitelistedIds: "1380075940285124724,1134557553011998840",
    blacklistedIds: "",
    attachmentFileExtensions: "png,jpg",
    messagesToDisplayAtOnceInLogs: 100,
    logsDir: "C:\\old\\MessageLoggerData",
    imageCacheDir: "C:\\old\\MessageLoggerData\\savedImages",
    autoCheckForUpdates: true,
    saveMessages: true
};

const EXPECTED_MAPPED: Record<string, unknown> = {
    saveImages: true,
    sortNewest: true,
    ignoreBots: true,
    messageLimit: 0,
    cacheLimit: 50000,
    whitelistedIds: "1380075940285124724,1134557553011998840",
    blacklistedIds: "",
    attachmentFileExtensions: "png,jpg",
    messagesToDisplayAtOnceInLogs: 100
};

beforeEach(() => {
    state.settings.plugins = {
        MessageLogger: { ignoreUsers: "", ignoreChannels: "", ignoreGuilds: "" }
    };
    for (const key of Object.keys(state.store)) delete state.store[key];
});

describe("mapLegacyPluginSettings", () => {
    it("keeps every migratable key value and drops legacy-only keys", () => {
        const mapped = mapLegacyPluginSettings(LEGACY_BLOCK);

        expect(mapped).toEqual(EXPECTED_MAPPED);
        expect(mapped).not.toHaveProperty("logsDir");
        expect(mapped).not.toHaveProperty("imageCacheDir");
        expect(mapped).not.toHaveProperty("enabled");
        expect(mapped).not.toHaveProperty("autoCheckForUpdates");
        expect(mapped).not.toHaveProperty("saveMessages");
        expect(mapped).not.toHaveProperty("cacheMessagesFromServers");
    });

    it("returns an empty object for empty or missing legacy blocks", () => {
        expect(mapLegacyPluginSettings({})).toEqual({});
        expect(mapLegacyPluginSettings(undefined as any)).toEqual({});
    });
});

describe("applyLegacyPluginSettings", () => {
    it("writes overlapping values into the store and removes the legacy plugin block", () => {
        state.settings.plugins.MessageLoggerEnhanced = { ...LEGACY_BLOCK };

        expect(applyLegacyPluginSettings()).toBe(true);
        expect(state.store).toEqual(EXPECTED_MAPPED);
        expect(Settings.plugins.MessageLoggerEnhanced).toBeUndefined();
        expect(Settings.plugins.MessageLogger).toEqual({ ignoreUsers: "", ignoreChannels: "", ignoreGuilds: "" });
    });

    it("does nothing and returns false when no legacy block exists", () => {
        state.store.alreadyPresent = "keep";

        expect(applyLegacyPluginSettings()).toBe(false);
        expect(state.store).toEqual({ alreadyPresent: "keep" });
        expect(Object.keys(Settings.plugins)).toEqual(["MessageLogger"]);
    });

    it("is self-gating: a second run finds nothing left to migrate", () => {
        state.settings.plugins.MessageLoggerEnhanced = { ...LEGACY_BLOCK };

        expect(applyLegacyPluginSettings()).toBe(true);
        expect(applyLegacyPluginSettings()).toBe(false);
        expect(state.store).toEqual(EXPECTED_MAPPED);
    });
});
