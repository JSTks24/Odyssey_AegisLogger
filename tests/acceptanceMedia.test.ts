/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";

import { afterEach, describe, expect, it } from "vitest";

// @ts-ignore -- the actual ESM acceptance entrypoint is exercised here
import b01 from "../scripts/accept-b01.mjs";
// @ts-ignore -- acceptance helpers are plain ESM
import acceptance from "../scripts/acceptanceLib.mjs";

const base = "blob:https://discord.com/local-resource";
const target = { scenarioId: "thumbnail", messageId: "111", view: "chat", kind: "img", base };
const outputDirs: string[] = [];

function pageProbe({ loaded = true, preview = false, video = false, poster = false, log = false } = {}) {
    const handlers = new Map<string, (event: any) => void>();
    const managed = new Set([base]);
    let decodeRequests = 0;
    let metadataLoads = 0;
    const row = { id: "chat-messages-222-111", classList: { contains: () => false } };
    const logContext = { __reactFiber$test: { memoizedProps: {}, return: { memoizedProps: { message: { id: "log-111" } }, return: null } } };
    const logPreview = { parentElement: { querySelector(selector: string) { return selector === ":scope > .aegis-modal-msg-context" ? logContext : null; } } };
    const el = {
        tagName: video ? "VIDEO" : "IMG",
        currentSrc: base + "#",
        complete: loaded,
        naturalWidth: loaded ? 120 : 0,
        readyState: loaded ? 1 : 0,
        videoWidth: loaded ? 120 : 0,
        preload: "none",
        networkState: 1,
        error: null,
        load() { metadataLoads++; },
        getAttribute(attr: string) { return attr === "src" || (attr === "poster" && poster) ? base + "#" : null; },
        closest(selector: string) {
            if (selector.includes("chat-messages")) return preview || log ? null : row;
            if (selector.includes("role=")) return preview || log ? {} : null;
            if (selector.includes(".aegis-modal-msg-preview")) return log ? logPreview : null;
            if (selector === ".aegis-modal-content-inner") return log ? {} : null;
            if (selector === "video" || selector === "video, audio") return video ? this : null;
            return null;
        }
    };
    const context: any = {
        window: { Vencord: { Plugins: { plugins: { AegisLogger: { imageUtils: {
            resolveManagedAttachmentBase(url: string) { return managed.has(url.split(/[?#]/, 1)[0]) ? url.split(/[?#]/, 1)[0] : null; }
        } } } } } },
        document: {
            querySelectorAll() { return [el]; },
            addEventListener(name: string, handler: any) { handlers.set(name, handler); },
            removeEventListener(name: string) { handlers.delete(name); }
        },
        Image: class {
            constructor() { decodeRequests++; }
            onload: (() => void) | null = null;
            onerror: (() => void) | null = null;
            naturalWidth = 0;
            set src(_url: string) { this.onerror?.(); }
        },
        Date
    };
    vm.createContext(context);
    vm.runInContext(b01.expressions.install, context);
    context.window.__aegisAccept.state.scenarioId = "thumbnail";
    context.window.__aegisAccept.state.previewMessageId = "111";
    const client = { async evalJson(expression: string) { return vm.runInContext(expression, context); } };
    return { context, el, client, managed, decodeRequests() { return decodeRequests; }, metadataLoads() { return metadataLoads; }, error() { handlers.get("error")?.({ target: el }); } };
}

function mediaReport(verdict: any) {
    return acceptance.buildAcceptanceReport({
        scriptVersion: "media-test",
        startedAt: new Date().toISOString(),
        results: [{ name: "actual-media-pipeline", status: verdict.pass ? "pass" : verdict.blocked ? "blocked" : "fail", detail: verdict }],
        extra: { resourceSummary: verdict.summary }
    });
}

afterEach(() => {
    for (const directory of outputDirs.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("B01 media evidence pipeline", () => {
    it("captures event-time managed identity in the actual page probe", async () => {
        const page = pageProbe();
        page.error();
        page.managed.clear();
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const verdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [target], observed });

        expect(verdict.pass).toBe(false);
        expect(mediaReport(verdict).exitCode).toBe(1);
        expect(verdict.summary.managedFailures[0]).toMatchObject({
            url: base + "#", managedBase: base, scenarioId: "thumbnail", messageId: "111", view: "chat", kind: "img", ownership: "managed", ownershipBasis: "event-time-registry"
        });
        expect(verdict.summary.managedFailures[0].elementId).toBeTruthy();
        expect(verdict.summary.managedFailures[0].timestamp).toBeGreaterThan(0);
    });

    it("blocks when the actual probe has neither current nor historical ownership", async () => {
        const page = pageProbe();
        page.managed.clear();
        page.context.window.__aegisAccept.state.history.clear();
        page.error();
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const verdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [target], observed });

        expect(verdict.blocked).toBe(true);
        expect(mediaReport(verdict).exitCode).toBe(2);
        expect(verdict.summary.unknownFailures).toHaveLength(1);
        expect(verdict.summary.otherFailures).toHaveLength(0);
    });

    it("finds an owned Log-only URL outside the hydration sample collection", async () => {
        const monitor = b01.createMediaMonitor({ resolveOwnership: async () => ({ ownership: "managed", managedBase: base, ownershipBasis: "live-registry" }) });
        monitor.setScenario("thumbnail");
        monitor.ingestCdp({ method: "Log.entryAdded", params: { entry: { level: "error", url: base + "?format=webp#", text: "Failed to load resource", stackTrace: { callFrames: [{ functionName: "thumbnailFormatter" }] } } } });
        await monitor.flush();
        const verdict = await b01.settleMediaScenario({ client: { evalJson: async () => [] }, monitor, scenarioId: "thumbnail", targets: [target], observed: [{ ...target, loaded: true }] });

        expect(mediaReport(verdict).exitCode).toBe(1);
        expect(verdict.summary.managedFailures[0]).toMatchObject({ channel: "log-entry", url: base + "?format=webp#", ownershipBasis: "live-registry", provenance: { callFrames: [{ functionName: "thumbnailFormatter" }] } });
    });

    it("uses request-time identity when Network failure arrives after revoke and scene switch", async () => {
        let current = true;
        const monitor = b01.createMediaMonitor({ resolveOwnership: async () => current ? { ownership: "managed", managedBase: base, ownershipBasis: "request-time-registry" } : { ownership: "unknown", ownershipBasis: "released" } });
        monitor.setScenario("thumbnail");
        monitor.ingestCdp({ method: "Network.requestWillBeSent", params: { requestId: "r1", timestamp: 42, request: { url: base + "?format=webp#" }, initiator: { type: "script", stack: { callFrames: [{ functionName: "formatImage" }] } } } });
        await monitor.flush();
        current = false;
        monitor.setScenario("lightbox");
        monitor.ingestCdp({ method: "Network.loadingFailed", params: { requestId: "r1", errorText: "net::ERR_FILE_NOT_FOUND" } });
        await monitor.flush();

        expect(monitor.summary({ scenarioId: "thumbnail" }).managedFailures[0]).toMatchObject({ requestId: "r1", scenarioId: "thumbnail", ownership: "managed", managedBase: base, provenance: { type: "script" } });
        expect(monitor.summary({ scenarioId: "lightbox" }).managedFailures).toHaveLength(0);
    });

    it("awaits delayed ownership before producing the verdict and report", async () => {
        let resolveLookup: (value: any) => void = () => { };
        const monitor = b01.createMediaMonitor({ resolveOwnership: () => new Promise(resolve => { resolveLookup = resolve; }) });
        monitor.setScenario("thumbnail");
        monitor.ingestCdp({ method: "Log.entryAdded", params: { entry: { level: "error", url: base } } });
        let finished = false;
        const pending = b01.settleMediaScenario({ client: { evalJson: async () => [] }, monitor, scenarioId: "thumbnail", targets: [target], observed: [{ ...target, loaded: true }] }).then((verdict: any) => { finished = true; return verdict; });
        await Promise.resolve();
        await Promise.resolve();
        expect(finished).toBe(false);
        resolveLookup({ ownership: "managed", managedBase: base, ownershipBasis: "delayed-registry" });
        const verdict = await pending;

        expect(monitor.pendingCount()).toBe(0);
        expect(mediaReport(verdict).exitCode).toBe(1);
    });

    it("preserves ownership timeouts as unknown blocking evidence", async () => {
        const monitor = b01.createMediaMonitor({ resolveOwnership: () => new Promise(() => { }), resolutionTimeoutMs: 5 });
        monitor.setScenario("thumbnail");
        monitor.ingestCdp({ method: "Log.entryAdded", params: { entry: { level: "error", url: base } } });
        const verdict = await b01.settleMediaScenario({ client: { evalJson: async () => [] }, monitor, scenarioId: "thumbnail", targets: [target], observed: [{ ...target, loaded: true }] });

        expect(verdict.summary.unknownFailures[0].ownershipBasis).toBe("ownership-query-timeout");
        expect(mediaReport(verdict).exitCode).toBe(2);
    });

    it("does not discard thumbnail failure when another copy of the original is loaded", async () => {
        const page = pageProbe({ loaded: false });
        page.error();
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const observed = await page.client.evalJson(b01.expressions.probe);
        observed.push({ ...target, view: "preview", elementId: "original", loaded: true });
        const verdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [target], observed });

        expect(verdict.pass).toBe(false);
        expect(mediaReport(verdict).exitCode).toBe(1);
        expect(verdict.summary.managedFailures).toHaveLength(1);
    });

    it("does not let a loaded background chat image stand in for a lightbox", async () => {
        const page = pageProbe();
        page.context.window.__aegisAccept.state.scenarioId = "lightbox";
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("lightbox");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const verdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "lightbox", targets: [{ ...target, scenarioId: "lightbox", view: "preview" }], observed });

        expect(observed[0].view).toBe("chat");
        expect(verdict.pass).toBe(false);
        expect(verdict.evidence.missing).toBe(1);
    });

    it("maps a Log media preview through its sibling context instead of the outer dialog", async () => {
        const page = pageProbe({ log: true });
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const logTarget = { ...target, view: "log", messageId: "log-111" };
        const logVerdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [logTarget], observed });
        const previewVerdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [{ ...logTarget, view: "preview" }], observed });

        expect(observed[0]).toMatchObject({ view: "log", messageId: "log-111", loaded: true });
        expect(logVerdict.pass).toBe(true);
        expect(previewVerdict.pass).toBe(false);
        page.error();
        const failed = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [logTarget], observed });
        expect(failed.summary.managedFailures[0]).toMatchObject({ view: "log", messageId: "log-111" });
    });

    it("requires successful image decoding for poster even when the video is loaded", async () => {
        const page = pageProbe({ video: true, poster: true });
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const videoObserved = await page.client.evalJson(b01.expressions.probe);
        const videoVerdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [{ ...target, kind: "video" }], observed: videoObserved });
        expect(page.decodeRequests()).toBe(0);
        page.context.window.__aegisAccept.state.scenarioId = "poster";
        page.context.window.__aegisAccept.state.decodePosters = true;
        monitor.setScenario("poster");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const posterVerdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "poster", targets: [{ ...target, scenarioId: "poster", kind: "poster" }], observed });

        expect(videoVerdict.pass).toBe(true);
        expect(posterVerdict.pass).toBe(false);
        expect(observed.find((item: any) => item.kind === "poster").decodeFailed).toBe(true);
        expect(posterVerdict.summary.managedFailures[0]).toMatchObject({ channel: "poster-decode-probe", scenarioId: "poster", messageId: "111", elementId: "media-1", kind: "poster", view: "chat" });
        expect(monitor.summary({ scenarioId: "thumbnail" }).managedFailures).toHaveLength(0);
    });

    it("starts only metadata loading for an idle video and restores its preload setting", async () => {
        const page = pageProbe({ loaded: false, video: true });
        const actions = page.context.window.__aegisAccept.prepareVideos([{ ...target, kind: "video" }]);

        expect(actions[0]).toMatchObject({ preload: "none", readyState: 0, action: "metadata-load-without-playback" });
        expect(page.metadataLoads()).toBe(1);
        expect(page.el.preload).toBe("metadata");
        expect(page.decodeRequests()).toBe(0);
        await page.client.evalJson(b01.expressions.remove);
        expect(page.el.preload).toBe("none");
    });

    it("keeps a fully evidenced non-target preload failure as an observation", async () => {
        const page = pageProbe();
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        const observed = await page.client.evalJson(b01.expressions.probe);
        const initiator = { type: "script", url: "https://discord.com/preload-module.js", stack: { callFrames: [{ functionName: "preloadCachedImage" }] } };
        monitor.ingestCdp({ method: "Network.requestWillBeSent", params: { requestId: "preload-1", request: { url: base + "?format=webp#" }, initiator } });
        await monitor.flush();
        monitor.ingestDom([{ scenarioId: "thumbnail", channel: "network", url: base + "?format=webp#", requestId: "preload-1", provenance: initiator, nonBlockingEvidence: { requestId: "preload-1", initiator, targetLoadedElement: observed[0], preloadConfirmed: true, notTargetComponent: true, targetLoaded: true, source: "request initiator and actual probe target capture" } }]);
        const verdict = await b01.settleMediaScenario({ client: page.client, monitor, scenarioId: "thumbnail", targets: [target], observed });

        expect(verdict.pass).toBe(true);
        expect(verdict.summary.observations).toHaveLength(1);
        expect(mediaReport(verdict)).toHaveProperty("resourceSummary.total", 1);
        expect(b01.evaluateBlobInvestigation(monitor.ledger.events()).status).toBe("pass");
    });

    it("does not accept an incomplete preload explanation", async () => {
        const monitor = b01.createMediaMonitor({ resolveOwnership: async () => ({ ownership: "managed", managedBase: base }) });
        monitor.setScenario("thumbnail");
        monitor.ingestDom([{ scenarioId: "thumbnail", channel: "network", url: base, nonBlockingEvidence: { targetLoaded: true, source: "loaded elsewhere" } }]);
        const verdict = await b01.settleMediaScenario({ client: { evalJson: async () => [] }, monitor, scenarioId: "thumbnail", targets: [target], observed: [{ ...target, loaded: true }] });

        expect(verdict.pass).toBe(false);
        expect(verdict.summary.observations).toHaveLength(0);
    });

    it("records historical Log replay separately with its actual timestamp", async () => {
        const monitor = b01.createMediaMonitor({ resolveOwnership: async () => ({ ownership: "unknown" }) });
        monitor.ingestCdp({ method: "Log.entryAdded", params: { entry: { level: "error", url: base, timestamp: Date.now() - 60000, text: "old error replayed by Log.enable" } } });
        await monitor.flush();

        expect(monitor.summary().total).toBe(0);
        expect(monitor.historicalEvents()[0]).toMatchObject({ historicalReplay: true, url: base, description: "old error replayed by Log.enable" });
    });

    it("keeps the remaining Blob investigation blocked when the old failure is not reproduced", () => {
        const investigation = b01.evaluateBlobInvestigation([]);

        expect(investigation.status).toBe("blocked");
        expect(investigation.evidence.source.missingIdentityFields).toContain("messageId");
    });

    it("does not resolve the remaining Blob cause using a console-only URL", async () => {
        const monitor = b01.createMediaMonitor({ resolveOwnership: async () => ({ ownership: "managed", managedBase: base, ownershipBasis: "registry" }) });
        monitor.setScenario("thumbnail");
        monitor.ingestCdp({ method: "Log.entryAdded", params: { entry: { level: "error", url: base + "?format=webp#" } } });
        await monitor.flush();

        expect(b01.evaluateBlobInvestigation(monitor.ledger.events()).status).toBe("blocked");
    });

    it("retains an identified target Blob failure in the investigation", async () => {
        const page = pageProbe({ loaded: false });
        const monitor = b01.createMediaMonitor({ client: page.client });
        monitor.setScenario("thumbnail");
        page.error();
        const events = await page.client.evalJson(b01.expressions.drain);
        monitor.ingestDom(events.map((event: any) => ({ ...event, url: base + "?format=webp#", provenance: { stack: { callFrames: [{ functionName: "thumbnailSource" }] } } })));
        await monitor.flush();

        expect(b01.evaluateBlobInvestigation(monitor.ledger.events()).status).toBe("fail");
    });

    it("writes initialization failures through the actual B01 runner", async () => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-b01-"));
        outputDirs.push(directory);
        const report = await b01.run({ pageWs: "unused", outDir: directory, adapters: { connect: async () => { throw new Error("test connection failure"); } } });

        expect(report.exitCode).toBe(1);
        expect(report.fatal).toContain("test connection failure");
        expect(JSON.parse(fs.readFileSync(path.join(directory, "b01-report.json"), "utf8")).exitCode).toBe(1);
    });

    it.each(["close", "drain"])("still removes the actual page probe after %s cleanup fails", async failure => {
        const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-b01-cleanup-"));
        outputDirs.push(directory);
        const page = pageProbe();
        const { state } = page.context.window.__aegisAccept;
        const order: string[] = [];
        const ws = {
            addEventListener() { },
            removeEventListener() { order.push("remove-cdp-listener"); },
            close() { order.push("close-websocket"); }
        };
        const client = {
            async send(method: string) {
                if (method === "Runtime.enable") throw new Error("setup failure");
                return {};
            },
            async evalJson(expression: string) {
                if (expression.includes("closeAllModals")) {
                    order.push("close-modals");
                    if (failure === "close") throw new Error("close cleanup failed");
                    return true;
                }
                if (expression === b01.expressions.drain) {
                    order.push("drain-events");
                    if (failure === "drain") throw new Error("drain cleanup failed");
                }
                if (expression === b01.expressions.remove) {
                    order.push("remove-page-probe-start");
                    await new Promise(resolve => setTimeout(resolve, 5));
                    const result = await page.client.evalJson(expression);
                    order.push("remove-page-probe-end");
                    return result;
                }
                return page.client.evalJson(expression);
            },
            dispose() { order.push("dispose-client"); }
        };
        const report = await b01.run({ pageWs: "unused", outDir: directory, adapters: { connect: async () => ({ ws, client }) } });

        expect(report.exitCode).toBe(1);
        expect(report.cleanupErrors).toContain(`Error: ${failure} cleanup failed`);
        expect(page.context.window.__aegisAccept).toBeUndefined();
        page.error();
        expect(state.events).toHaveLength(0);
        expect(order.indexOf("remove-page-probe-end")).toBeLessThan(order.indexOf("remove-cdp-listener"));
        expect(order.indexOf("remove-cdp-listener")).toBeLessThan(order.indexOf("dispose-client"));
        expect(order.at(-1)).toBe("close-websocket");
        expect(JSON.parse(fs.readFileSync(path.join(directory, "b01-report.json"), "utf8")).exitCode).toBe(1);
    });
});
