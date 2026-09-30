/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
    buildAcceptanceReport,
    computeExitCode,
    createResourceLedger,
    evaluateEnvironment,
    evaluateForegroundPaging,
    evaluateLastPage,
    evaluateMediaTargets,
    evaluateRecovery,
    evaluateTabSwitch
// @ts-ignore -- scripts are plain ESM without declarations; types are exercised at runtime
} from "../scripts/acceptanceLib.mjs";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));

const ids = (...list: string[]): string[] => list;

describe("A01 recovery criteria", () => {
    const visible = { duringVis: "visible", afterVis: "visible", modalOpenAfter: true, occlusionExpected: false };

    it("fails when paging stays completely flat even though the window recovered", () => {
        const flat = ids("a", "b", "c");
        const verdict = evaluateRecovery({
            beforeIds: flat,
            expectedNextIds: ids("d", "e"),
            autoIds: flat,
            scrolledIds: flat,
            ...visible
        });

        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.expectedHits).toBe(0);
    });

    it("passes when an expected next-page record appears after restore without duplicates", () => {
        const verdict = evaluateRecovery({
            beforeIds: ids("a", "b", "c"),
            expectedNextIds: ids("d", "e"),
            autoIds: ids("a", "b", "c"),
            scrolledIds: ids("a", "b", "c", "d"),
            ...visible
        });

        expect(verdict.pass).toBe(true);
    });

    it("fails when the newly added records are duplicates", () => {
        const verdict = evaluateRecovery({
            beforeIds: ids("a", "b", "c"),
            expectedNextIds: ids("d", "e"),
            autoIds: ids("a", "b", "c"),
            scrolledIds: ids("a", "b", "c", "a"),
            ...visible
        });

        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.duplicates).toBeGreaterThan(0);
    });

    it("fails when the new records belong to another dataset", () => {
        const verdict = evaluateRecovery({
            beforeIds: ids("a", "b", "c"),
            expectedNextIds: ids("d", "e"),
            autoIds: ids("a", "b", "c"),
            scrolledIds: ids("a", "b", "c", "x9"),
            ...visible
        });

        expect(verdict.pass).toBe(false);
    });

    it("is blocked instead of passed when the occlusion never reached hidden", () => {
        const verdict = evaluateRecovery({
            beforeIds: ids("a", "b"),
            expectedNextIds: ids("c"),
            duringVis: "visible",
            afterVis: "visible",
            autoIds: ids("a", "b", "c"),
            scrolledIds: ids("a", "b", "c"),
            modalOpenAfter: true,
            occlusionExpected: true
        });

        expect(verdict.blocked).toBe(true);
        expect(verdict.pass).toBe(false);
    });

    it("fails when the modal is gone after restore", () => {
        const verdict = evaluateRecovery({
            beforeIds: ids("a"),
            expectedNextIds: ids("b"),
            duringVis: "hidden",
            afterVis: "visible",
            autoIds: ids("a"),
            scrolledIds: ids("a", "b"),
            modalOpenAfter: false,
            occlusionExpected: false
        });

        expect(verdict.pass).toBe(false);
    });
});

describe("A01 foreground paging criteria", () => {
    it("fails when only the first page is shown", () => {
        const verdict = evaluateForegroundPaging({
            beforeIds: ids("a", "b"),
            afterIds: ids("a", "b"),
            expectedNextIds: ids("c", "d")
        });

        expect(verdict.pass).toBe(false);
    });

    it("passes when the expected next page arrives and nothing is dropped", () => {
        const verdict = evaluateForegroundPaging({
            beforeIds: ids("a", "b"),
            afterIds: ids("a", "b", "c", "d"),
            expectedNextIds: ids("c", "d")
        });

        expect(verdict.pass).toBe(true);
    });

    it("fails when the loaded records are foreign or duplicated", () => {
        const foreign = evaluateForegroundPaging({ beforeIds: ids("a"), afterIds: ids("a", "x1"), expectedNextIds: ids("c") });
        const duplicated = evaluateForegroundPaging({ beforeIds: ids("a"), afterIds: ids("a", "a"), expectedNextIds: ids("c") });

        expect(foreign.pass).toBe(false);
        expect(duplicated.pass).toBe(false);
    });
});

describe("A01 tab switch criteria", () => {
    it("fails when the click did nothing even though rows are stable", () => {
        const verdict = evaluateTabSwitch({ tabBefore: 0, tabAfter: 0, clickedFound: true, resultIds: ids("a", "b"), expectedIdSet: ids("c", "d") });
        expect(verdict.pass).toBe(false);
    });

    it("passes when a smaller but correct result set is shown", () => {
        const verdict = evaluateTabSwitch({ tabBefore: 0, tabAfter: 1, clickedFound: true, resultIds: ids("c"), expectedIdSet: ids("c", "d") });
        expect(verdict.pass).toBe(true);
    });

    it("fails when a late stale request republishes records of the old tab", () => {
        const verdict = evaluateTabSwitch({ tabBefore: 0, tabAfter: 1, clickedFound: true, resultIds: ids("c", "a"), expectedIdSet: ids("c", "d") });
        expect(verdict.pass).toBe(false);
    });
});

describe("A01 last page criteria", () => {
    it("refuses to declare the end while expected records are still missing", () => {
        const verdict = evaluateLastPage({
            displayedIds: ids("a", "b"),
            expectedAllIds: ids("a", "b", "c"),
            loadInFlight: false,
            afterRestoreIds: ids("a", "b"),
            afterRestoreInFlight: false
        });

        expect(verdict.blocked).toBe(true);
        expect(verdict.pass).toBe(false);
    });

    it("fails while a request is still in flight", () => {
        const verdict = evaluateLastPage({
            displayedIds: ids("a", "b", "c"),
            expectedAllIds: ids("a", "b", "c"),
            loadInFlight: true,
            afterRestoreIds: ids("a", "b", "c"),
            afterRestoreInFlight: true
        });

        expect(verdict.pass).toBe(false);
    });

    it("passes at the real end with a stable restore", () => {
        const verdict = evaluateLastPage({
            displayedIds: ids("a", "b", "c"),
            expectedAllIds: ids("a", "b", "c"),
            loadInFlight: false,
            afterRestoreIds: ids("a", "b", "c"),
            afterRestoreInFlight: false
        });

        expect(verdict.pass).toBe(true);
    });

    it("fails when the restore appended or duplicated records", () => {
        const appended = evaluateLastPage({ displayedIds: ids("a", "b", "c"), expectedAllIds: ids("a", "b", "c"), loadInFlight: false, afterRestoreIds: ids("a", "b", "c", "d"), afterRestoreInFlight: false });
        const duplicated = evaluateLastPage({ displayedIds: ids("a", "b", "c"), expectedAllIds: ids("a", "b", "c"), loadInFlight: false, afterRestoreIds: ids("a", "b", "c", "a"), afterRestoreInFlight: false });

        expect(appended.pass).toBe(false);
        expect(duplicated.pass).toBe(false);
    });

    it.each([{ displayedIds: ids("a", "a", "b") }, { displayedIds: ids("b", "a") }])("rejects an invalid original sequence even when restore fixes it: $displayedIds", ({ displayedIds }) => {
        const verdict = evaluateLastPage({
            displayedIds,
            expectedAllIds: ids("a", "b"),
            loadInFlight: false,
            afterRestoreIds: ids("a", "b"),
            afterRestoreInFlight: false
        });

        expect(verdict.blocked).toBe(false);
        expect(verdict.pass).toBe(false);
    });
});

describe("A01 environment proof", () => {
    const forbidden = ["--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows"];

    it("fails when a throttling-disabling switch is present in the real command line", () => {
        const verdict = evaluateEnvironment({
            commandLine: "Discord.exe --remote-debugging-port=9222 --disable-renderer-backgrounding",
            forbiddenFlags: forbidden,
            requiredEvidence: ["ua"]
        });

        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.forbiddenHits).toContain("--disable-renderer-backgrounding");
    });

    it("passes only with a recorded clean command line and complete evidence", () => {
        const clean = evaluateEnvironment({ commandLine: "Discord.exe --remote-debugging-port=9222", forbiddenFlags: forbidden, requiredEvidence: ["ua"] });
        const unrecorded = evaluateEnvironment({ commandLine: null, forbiddenFlags: forbidden, requiredEvidence: [] });

        expect(clean.pass).toBe(true);
        expect(unrecorded.blocked).toBe(true);
    });
});

describe("A03 resource failure ledger", () => {
    const base = "blob:https://discord.com/1111";

    it("counts a managed failure that only appears in the Log channel", () => {
        const ledger = createResourceLedger();
        ledger.addEvent({ channel: "log-entry", url: `${base}?format=webp`, managedBase: base });
        ledger.addEvent({ channel: "console", url: `${base}?format=webp`, managedBase: base });

        const summary = ledger.summary();
        expect(summary.managedFailures).toHaveLength(1);
        expect(summary.managedFailures[0].channel).toBe("log-entry");
    });

    it("keeps a dom-only error as a managed failure", () => {
        const ledger = createResourceLedger();
        ledger.addEvent({ channel: "dom-error", url: base, tagName: "IMG", managedBase: base });

        expect(ledger.summary().managedFailures).toHaveLength(1);
    });

    it("preserves the full url beyond display truncation length", () => {
        const ledger = createResourceLedger();
        const longUrl = `${base}${"a".repeat(300)}`;
        ledger.addEvent({ channel: "console", url: longUrl, managedBase: base });

        expect(ledger.summary().managedFailures[0].url).toBe(longUrl);
        expect(ledger.summary().managedFailures[0].url.length).toBeGreaterThan(140);
    });

    it("attributes events across scenario boundaries without double counting", () => {
        const ledger = createResourceLedger();
        ledger.addEvent({ channel: "console", url: `${base}?a`, managedBase: base, scenario: "s1" });
        ledger.addEvent({ channel: "console", url: `${base}?a`, managedBase: base, scenario: "s1" });
        ledger.addEvent({ channel: "dom-error", url: `${base}?b`, managedBase: base, scenario: "s2" });

        const summary = ledger.summary();
        expect(summary.total).toBe(3);
        expect(summary.managedFailures).toHaveLength(2);

        const scenarios = summary.managedFailures.map(event => event.scenario);
        expect(scenarios).toContain("s1");
        expect(scenarios).toContain("s2");
    });

    it("keeps unrelated https failures as diagnostics instead of managed failures", () => {
        const ledger = createResourceLedger();
        ledger.addEvent({ channel: "network", url: "https://cdn.discordapp.com/missing.png" });

        const summary = ledger.summary();
        expect(summary.managedFailures).toHaveLength(0);
        expect(summary.otherFailures).toHaveLength(1);
        expect(summary.otherFailures[0].url).toContain("https://");
    });
});

describe("A03 media target assertions", () => {
    const base = "blob:https://discord.com/2222";

    it("fails when the expected media never appears", () => {
        const verdict = evaluateMediaTargets({ targets: [{ kind: "img", base }], observed: [], ledgerSummary: { managedFailures: [] } });
        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.missing).toBe(1);
    });

    it("fails when other media loaded but the target did not", () => {
        const verdict = evaluateMediaTargets({
            targets: [{ kind: "img", base }],
            observed: [{ base: "blob:https://discord.com/other", loaded: true }],
            ledgerSummary: { managedFailures: [] }
        });

        expect(verdict.pass).toBe(false);
    });

    it("passes when the target is present, loaded and error free", () => {
        const verdict = evaluateMediaTargets({
            targets: [{ kind: "img", base }],
            observed: [{ kind: "img", base, loaded: true }],
            ledgerSummary: { managedFailures: [] }
        });

        expect(verdict.pass).toBe(true);
    });

    it("fails when the target is present but a failure was recorded for it", () => {
        const verdict = evaluateMediaTargets({
            targets: [{ kind: "img", base }],
            observed: [{ kind: "img", base, loaded: true }],
            ledgerSummary: { managedFailures: [{ managedBase: base }] }
        });

        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.errored).toBe(1);
    });

    it("is blocked when the scenario declares no targets at all", () => {
        const verdict = evaluateMediaTargets({ targets: [], observed: [{ base, loaded: true }], ledgerSummary: { managedFailures: [] } });
        expect(verdict.blocked).toBe(true);
        expect(verdict.pass).toBe(false);
    });
});

describe("A02 exit codes", () => {
    it("returns zero only when every required item passed", () => {
        expect(computeExitCode([{ status: "pass" }, { status: "pass" }], null)).toBe(0);
    });

    it("returns non-zero for failure, blocked, fatal and empty results", () => {
        expect(computeExitCode([{ status: "pass" }, { status: "fail" }], null)).toBe(1);
        expect(computeExitCode([{ status: "pass" }, { status: "blocked" }], null)).toBe(2);
        expect(computeExitCode([{ status: "pass" }], new Error("boom"))).toBe(1);
        expect(computeExitCode([], null)).toBe(1);
        expect(computeExitCode(null, null)).toBe(1);
    });

    it("builds the report with the exit code consistent with the results", () => {
        const report = buildAcceptanceReport({ scriptVersion: "t", libVersion: "t", startedAt: "now", results: [{ status: "fail" }], fatal: null });
        expect(report.exitCode).toBe(1);
    });
});

describe("A02 source guard: scripts must not override the summary exit code", () => {
    const readScript = (name: string) => fs.readFileSync(path.join(scriptDir, "..", "scripts", name), "utf8");

    it("accept-b01.mjs has no unconditional success exit", () => {
        expect(readScript("accept-b01.mjs")).not.toMatch(/process\.exit\(0\)/);
    });

    it("accept-v01.mjs has no unconditional success exit", () => {
        expect(readScript("accept-v01.mjs")).not.toMatch(/process\.exit\(0\)/);
    });
});
