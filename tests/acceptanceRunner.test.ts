/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

const fixtureDir = path.dirname(fileURLToPath(import.meta.url));
const fixtureScript = path.join(fixtureDir, "fixtures", "acceptance", "runnerFixture.mjs");

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-runner-"));
const tempDirs: string[] = [];

function makeOutDir() {
    const dir = fs.mkdtempSync(path.join(tempRoot, "run-"));
    tempDirs.push(dir);
    return dir;
}

function runFixture(mode: string) {
    const outDir = makeOutDir();
    const result = spawnSync(process.execPath, [fixtureScript, mode, outDir], {
        encoding: "utf8",
        timeout: 30000
    });

    return { outDir, status: result.status, code: result.status === null ? -1 : result.status, stderr: result.stderr ?? "", stdout: result.stdout ?? "" };
}

afterAll(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
});

describe("acceptance runner finalization (real subprocess)", () => {
    it.each(["accept-b01.mjs", "accept-v01.mjs"])("writes an initialization failure from the actual %s CLI", scriptName => {
        const outDir = makeOutDir();
        const scriptPath = path.join(fixtureDir, "..", "scripts", scriptName);
        const run = spawnSync(process.execPath, [scriptPath, "invalid-websocket-url", outDir], { encoding: "utf8", timeout: 15000 });
        const reportName = scriptName === "accept-b01.mjs" ? "b01-report.json" : "v01-report.json";
        expect(run.status).toBe(1);
        const report = JSON.parse(fs.readFileSync(path.join(outDir, reportName), "utf8"));
        expect(report.exitCode).toBe(1);
        expect(report.fatal).toBeTruthy();
    });

    it("exits zero and writes the report when every item passed", () => {
        const run = runFixture("pass");

        expect(run.code).toBe(0);
        const report = JSON.parse(fs.readFileSync(path.join(run.outDir, "report.json"), "utf8"));
        expect(report.exitCode).toBe(0);
        expect(report.results).toHaveLength(1);
        expect(report.results[0].status).toBe("pass");
    });

    it("exits non-zero when an item failed and the code is not overwritten", () => {
        const run = runFixture("fail");

        expect(run.code).not.toBe(0);
        const report = JSON.parse(fs.readFileSync(path.join(run.outDir, "report.json"), "utf8"));
        expect(report.exitCode).not.toBe(0);
        expect(report.results.some((item: { status: string; }) => item.status === "fail")).toBe(true);
    });

    it("exits non-zero for a blocked required item", () => {
        const run = runFixture("blocked");

        expect(run.code).toBe(2);
        const report = JSON.parse(fs.readFileSync(path.join(run.outDir, "report.json"), "utf8"));
        expect(report.exitCode).toBe(2);
    });

    it("exits non-zero on an exception while still writing the report and running cleanup", () => {
        const run = runFixture("throw");

        expect(run.code).toBe(1);
        const report = JSON.parse(fs.readFileSync(path.join(run.outDir, "report.json"), "utf8"));
        expect(report.exitCode).toBe(1);
        expect(report.fatal).toContain("boom");
        expect(report.results.some((item: { status: string; }) => item.status === "fail")).toBe(true);
        expect(fs.existsSync(path.join(run.outDir, "cleanup-marker.txt"))).toBe(true);
        expect(fs.existsSync(path.join(run.outDir, "closed-marker.txt"))).toBe(true);
    });

    it("does not report complete success when async cleanup fails", () => {
        const run = runFixture("cleanup-fail");
        const report = JSON.parse(fs.readFileSync(path.join(run.outDir, "report.json"), "utf8"));
        expect(run.code).toBe(1);
        expect(report.exitCode).toBe(1);
        expect(report.cleanupErrors).toContain("Error: cleanup failed");
        expect(fs.existsSync(path.join(run.outDir, "closed-marker.txt"))).toBe(true);
    });
});
