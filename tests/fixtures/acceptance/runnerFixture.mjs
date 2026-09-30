/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import path from "node:path";

import acceptance from "../../../scripts/acceptanceLib.mjs";

const mode = process.argv[2];
const outDir = process.argv[3];
const report = await acceptance.runAcceptance({
    scriptVersion: "runnerFixture/2",
    reportPath: path.join(outDir, "report.json"),
    execute: async ({ results, scope }) => {
        scope.add(async () => {
            await new Promise(resolve => setTimeout(resolve, 15));
            fs.writeFileSync(path.join(outDir, "cleanup-marker.txt"), "cleaned");
        });
        if (mode === "throw") throw new Error("boom");
        if (mode === "cleanup-fail") scope.add(async () => { throw new Error("cleanup failed"); });
        acceptance.recordResult(results, "fixture", mode === "fail" ? "fail" : mode === "blocked" ? "blocked" : "pass", null);
    },
    cleanup: async () => {
        if (!fs.existsSync(path.join(outDir, "cleanup-marker.txt"))) throw new Error("close happened before async cleanup");
        fs.writeFileSync(path.join(outDir, "closed-marker.txt"), "closed");
    }
});
process.exitCode = report.exitCode;
