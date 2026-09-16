/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const I18N_FILE = join(ROOT, "utils", "i18n.ts");

const DYNAMIC_KEYS = [
    "settings.group.interface",
    "settings.group.interfaceHint",
    "settings.group.capture",
    "settings.group.captureHint",
    "settings.group.filter",
    "settings.group.filterHint",
    "settings.group.storage",
    "settings.group.storageHint",
    "settings.group.data",
    "settings.group.dataHint",
    "filter.user",
    "filter.server",
    "filter.channel",
    "filter.has",
    "filter.before",
    "filter.after",
    "filter.message",
    "filter.during",
    "filter.pick.user",
    "filter.pick.server",
    "filter.pick.channel",
    "filter.pickGroup.user",
    "filter.pickGroup.server",
    "filter.pickGroup.channel",
    "filter.addFilter",
    "filter.exclude",
    "has.attachment",
    "has.image",
    "has.video",
    "has.file",
    "has.sound",
    "has.embed",
    "has.link"
];

const SKIP_DIRS = new Set([
    "node_modules",
    ".git",
    "tests",
    "dist",
    "streamparser-json",
    "native-file-system-adapter",
    "idb"
]);

const TABLE_KEY_PATTERN = /^ {4}"([^"]+)":/gm;
const T_CALL_PATTERN = /\bt\(\s*"([^"]+)"\s*[,)]/g;

function extractTableKeys(body: string) {
    return new Set([...body.matchAll(TABLE_KEY_PATTERN)].map(match => match[1]));
}

function readTranslationTables() {
    const source = readFileSync(I18N_FILE, "utf-8");
    const enStart = source.indexOf("const en:");
    const zhStart = source.indexOf("const zhCN:");
    const stringsStart = source.indexOf("const strings:");
    if (enStart < 0 || zhStart < 0 || stringsStart < 0) throw new Error("i18n table layout changed");
    return {
        en: extractTableKeys(source.slice(enStart, zhStart)),
        zhCN: extractTableKeys(source.slice(zhStart, stringsStart))
    };
}

function toPosix(path: string) {
    return path.split(sep).join("/");
}

function* walkSourceFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walkSourceFiles(full);
            continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        if (toPosix(relative(ROOT, full)) === "utils/i18n.ts") continue;
        yield full;
    }
}

const tables = readTranslationTables();

describe("i18n table parity", () => {
    it("extracts non-empty key sets from both tables", () => {
        expect(tables.en.size).toBeGreaterThan(0);
        expect(tables.zhCN.size).toBeGreaterThan(0);
    });

    it("keeps en and zhCN key sets identical", () => {
        const missingInZh = [...tables.en].filter(key => !tables.zhCN.has(key));
        const missingInEn = [...tables.zhCN].filter(key => !tables.en.has(key));

        expect(missingInZh, `keys missing in zhCN: ${missingInZh.join(", ")}`).toEqual([]);
        expect(missingInEn, `keys missing in en: ${missingInEn.join(", ")}`).toEqual([]);
    });
});

describe("static t() usage", () => {
    it("resolves every static t() literal in the source to keys present in both tables", () => {
        const used = new Map<string, string[]>();
        for (const file of walkSourceFiles(ROOT)) {
            const text = readFileSync(file, "utf-8");
            for (const match of text.matchAll(T_CALL_PATTERN)) {
                const sites = used.get(match[1]) ?? [];
                sites.push(toPosix(relative(ROOT, file)));
                used.set(match[1], sites);
            }
        }

        expect(used.size).toBeGreaterThan(0);

        const missing = [...used.keys()]
            .filter(key => !tables.en.has(key) || !tables.zhCN.has(key))
            .map(key => `${key} (used in ${used.get(key)!.join(", ")})`);

        expect(missing, `keys used in t() but missing from the tables: ${missing.join(", ")}`).toEqual([]);
    });
});

describe("dynamic key inventory", () => {
    it("covers every dynamically composed key in both tables", () => {
        const missing = DYNAMIC_KEYS.filter(key => !tables.en.has(key) || !tables.zhCN.has(key));

        expect(missing, `dynamic keys missing from the tables: ${missing.join(", ")}`).toEqual([]);
    });
});
