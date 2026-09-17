/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const INSTALL_SCRIPT = join(ROOT, "install.cmd");
const LOCAL_DEPLOY_SCRIPT = join(ROOT, "scripts", "deploy.cmd");
const MACHINE_PATH = ["MY_PROGRAM", "PROJECT"].join("_");

const SKIP_DIRS = new Set([
    ".git",
    ".playwright-mcp",
    "Vencord",
    "dist",
    "idb",
    "native-file-system-adapter",
    "node_modules",
    "streamparser-json"
]);

const TEXT_FILE = /\.(cmd|css|json|md|mjs|ts|tsx|ya?ml)$/;

function toPosix(path: string) {
    return path.split(sep).join("/");
}

function* walkTextFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            yield* walkTextFiles(full);
            continue;
        }
        if (TEXT_FILE.test(entry.name)) yield full;
    }
}

const source = new TextDecoder("gbk").decode(readFileSync(INSTALL_SCRIPT));

describe("install.cmd packaging", () => {
    it("stays a decodable GBK script with its Chinese text intact", () => {
        expect(source).not.toContain("\uFFFD");
        expect(source).toContain("一键安装");
    });

    it("keeps CRLF line endings", () => {
        expect(source).toContain("\r\n");
        expect(/[^\r]\n/.test(source)).toBe(false);
    });

    it("installs the Vencord checkout inside the script directory", () => {
        expect(source).toContain('set "VENCORD_DIR=%SCRIPT_DIR%\\Vencord"');
    });

    it("never writes into the user profile or the temp directory", () => {
        expect(source).not.toContain("%USERPROFILE%");
        expect(source).not.toContain("%TEMP%");
        expect(source).not.toContain("TEMP_EXE");
    });

    it("stages the installer download next to its final location", () => {
        expect(source).toContain('set "INSTALLER_TMP=%INSTALLER_DIR%\\VencordInstallerCli.exe.download"');
    });

    it("refuses to run against the plugin repository itself", () => {
        expect(source).toContain("Vencord 目录不能就是本仓库目录");
        expect(source).toContain("请不要在仓库目录里拉取 Vencord");
    });

    it("refuses to delete a pre-existing directory that is not a Vencord checkout", () => {
        expect(source).toContain("目标目录已存在且不是 Vencord 仓库");
        expect(source.match(/rd \/s \/q "%VENCORD_DIR%"/g)).toHaveLength(1);
    });
});

describe("published file set", () => {
    it("does not ship a machine-local deploy script", () => {
        expect(existsSync(LOCAL_DEPLOY_SCRIPT)).toBe(false);
    });

    it("keeps machine-local paths out of every published text file", () => {
        const offenders: string[] = [];
        for (const file of walkTextFiles(ROOT)) {
            if (readFileSync(file, "utf-8").includes(MACHINE_PATH)) offenders.push(toPosix(relative(ROOT, file)));
        }
        expect(offenders, `files leaking machine-local paths: ${offenders.join(", ")}`).toEqual([]);
    });
});
