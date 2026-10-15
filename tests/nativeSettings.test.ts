/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import path from "node:path";

import fs from "fs/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ root: "", data: "" }));
vi.mock("@main/utils/constants", () => ({ get DATA_DIR() { return state.root; } }));
vi.mock("../native", () => ({
    getDefaultNativeDataDir: async () => state.data,
    getDefaultNativeImageDir: async () => `${state.data}/savedImages`
}));

beforeEach(async () => {
    vi.resetModules();
    state.root = await fs.mkdtemp(path.join(process.cwd(), ".aegislogger-settings-test-"));
    state.data = path.join(state.root, "AegisLoggerData");
    await fs.mkdir(state.data);
});

afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(state.root, { recursive: true, force: true });
});

describe("native settings persistence", () => {
    it("keeps the previous settings intact when the final replacement fails", async () => {
        const original = { logsDir: "previous-logs", imageCacheDir: "previous-images" };
        const filename = path.join(state.data, "settings.json");
        await fs.writeFile(filename, JSON.stringify(original));
        const { saveSettings } = await import("../native/settings");
        vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("locked settings"));

        await expect(saveSettings({ logsDir: "new-logs", imageCacheDir: "new-images" })).rejects.toThrow("locked settings");

        expect(JSON.parse(await fs.readFile(filename, "utf8"))).toEqual(original);
        expect(await fs.readdir(state.data)).toEqual(["settings.json"]);
    });

    it("atomically replaces the settings and leaves no temporary files", async () => {
        const { saveSettings, getSettings } = await import("../native/settings");
        const updated = { logsDir: "new-logs", imageCacheDir: "new-images" };

        await saveSettings(updated);

        expect(await getSettings()).toEqual(updated);
        expect(await fs.readdir(state.data)).toEqual(["settings.json"]);
    });
});
