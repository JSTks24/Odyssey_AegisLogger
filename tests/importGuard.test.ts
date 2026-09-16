/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import * as ts from "typescript";
import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const TSCONFIG = join(ROOT, "tsconfig.json");
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "idb", "native-file-system-adapter", "streamparser-json"]);
const UNRESOLVED_CODES = new Set([2304, 2552, 2305, 2724]);
const NAME_PATTERNS = [/Cannot find name '([^']+)'/, /has no exported member '([^']+)'/];

function toPosix(path: string) {
    return path.split(sep).join("/");
}

function isOwnSource(file: string) {
    const rel = toPosix(relative(ROOT, file));
    if (rel.startsWith("..")) return false;
    return !rel.split("/").slice(0, -1).some(part => SKIP_DIRS.has(part));
}

function readConfig() {
    const config = ts.readConfigFile(TSCONFIG, ts.sys.readFile);
    return ts.parseJsonConfigFileContent(config.config, ts.sys, ROOT);
}

function readBuildTimeGlobals() {
    const vencordRoot = resolve(ROOT, readConfig().options.paths!["@webpack/common"][0], "../../..");
    const names = new Set<string>();

    for (const file of [
        join(vencordRoot, "src", "globals.d.ts"),
        join(vencordRoot, "packages", "vencord-types", "globals.d.ts")
    ]) {
        for (const match of readFileSync(file, "utf-8").matchAll(/export var (\w+)/g)) names.add(match[1]);
    }

    return names;
}

function unresolvedName(diagnostic: ts.Diagnostic) {
    const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
    for (const pattern of NAME_PATTERNS) {
        const match = text.match(pattern);
        if (match) return match[1];
    }
    return null;
}

describe("unresolved identifier guard", () => {
    it("finds the project sources to check", () => {
        expect(readConfig().fileNames.filter(isOwnSource).length).toBeGreaterThan(20);
    });

    it("resolves every referenced name in own source files", () => {
        const parsed = readConfig();
        const program = ts.createProgram({
            rootNames: parsed.fileNames.filter(isOwnSource),
            options: { ...parsed.options, noEmit: true }
        });
        const globals = readBuildTimeGlobals();
        const offenders: string[] = [];

        for (const diagnostic of program.getSemanticDiagnostics()) {
            if (!UNRESOLVED_CODES.has(diagnostic.code)) continue;

            const { file } = diagnostic;
            if (file == null || !isOwnSource(file.fileName)) continue;

            const name = unresolvedName(diagnostic);
            if (name != null && globals.has(name)) continue;

            const { line } = file.getLineAndCharacterOfPosition(diagnostic.start);
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, " ");
            offenders.push(`${toPosix(relative(ROOT, file.fileName))}:${line + 1} TS${diagnostic.code} ${message}`);
        }

        expect(offenders, `unresolved names in own source:\n${offenders.join("\n")}`).toEqual([]);
    }, 180000);
});
