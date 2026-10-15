/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";

import { DATA_DIR } from "@main/utils/constants";
import fs from "fs/promises";
import path from "path";

import { getDefaultNativeDataDir, getDefaultNativeImageDir } from ".";
import { ensureDirectoryExists } from "./utils";

interface MLSettings {
    logsDir: string;
    imageCacheDir: string;
}

const SETTINGS_FILE = "settings.json";
const LEGACY_DATA_DIR_NAME = "MessageLoggerData";
const LEGACY_SETTINGS_FILE = "mlSettings.json";

let migration: Promise<void> | null = null;

async function pathExists(p: string) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

async function migrateLegacyData() {
    try {
        const newDir = await getDefaultNativeDataDir();
        const legacyDir = path.join(DATA_DIR, LEGACY_DATA_DIR_NAME);

        if (!await pathExists(newDir)) {
            if (await pathExists(legacyDir))
                await fs.rename(legacyDir, newDir);
        } else if (await pathExists(legacyDir)) {
            console.warn(`[AegisLogger] legacy data dir "${legacyDir}" still exists next to "${newDir}", remove it manually after verifying nothing is missing`);
        }

        await ensureDirectoryExists(newDir);

        const settingsFile = path.join(newDir, SETTINGS_FILE);
        const legacyFile = path.join(newDir, LEGACY_SETTINGS_FILE);
        if (!await pathExists(settingsFile) && await pathExists(legacyFile)) {
            const raw = await fs.readFile(legacyFile, "utf8");
            await fs.writeFile(settingsFile, raw.replaceAll(LEGACY_DATA_DIR_NAME, "AegisLoggerData"), "utf8");
            await fs.unlink(legacyFile);
        }
    } catch { }
}

export async function getSettings(): Promise<MLSettings> {
    await (migration ??= migrateLegacyData());

    try {
        const settings = await fs.readFile(await getSettingsFilePath(), "utf8");
        return JSON.parse(settings);
    } catch (err) {
        const settings = {
            logsDir: await getDefaultNativeDataDir(),
            imageCacheDir: await getDefaultNativeImageDir(),
        };
        try {
            await saveSettings(settings);
        } catch (err) { }

        return settings;
    }
}

export async function saveSettings(settings: MLSettings) {
    if (!settings) return;
    const target = await getSettingsFilePath();
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
        await fs.writeFile(temporary, JSON.stringify(settings, null, 4), "utf8");
        await fs.rename(temporary, target);
    } finally {
        await fs.unlink(temporary).catch(() => { });
    }
}

async function getSettingsFilePath() {
    const dataDir = await getDefaultNativeDataDir();
    await ensureDirectoryExists(dataDir);

    return path.join(dataDir, SETTINGS_FILE);
}
