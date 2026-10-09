/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import acceptance, {
    ACCEPTANCE_LIB_VERSION,
    createCdpClient,
    createResourceLedger,
    evaluateEnvironment,
    evaluateMediaTargets,
    recordResult,
    waitFor,
    WaitTimeoutError
} from "./acceptanceLib.mjs";

const SCRIPT_VERSION = "accept-b01/6 2026-09-30 (lib " + ACCEPTANCE_LIB_VERSION + ")";
const FORBIDDEN_STARTUP_FLAGS = [
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "CalculateNativeWinOcclusion"
];
const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const windowScript = path.join(scriptDir, "v01-window.ps1");
const DEFAULT_BLOB_SOURCE = {
    kind: "query-before-fragment-pattern",
    inputProvided: false,
    missingIdentityFields: ["messageId", "elementId", "requestId", "provenance"]
};

function readHistoricalBlobSource(file) {
    if (file == null) return { ok: true, source: DEFAULT_BLOB_SOURCE };
    try {
        const source = JSON.parse(readFileSync(file, "utf8"));
        if (typeof source?.url !== "string" || !source.url.startsWith("blob:")) return { ok: false, error: "historical_blob_source_invalid" };
        return {
            ok: true,
            source: {
                inputProvided: true,
                report: typeof source.report === "string" ? source.report : null,
                url: source.url,
                scenarioId: typeof source.scenarioId === "string" ? source.scenarioId : null,
                ...Object.fromEntries(DEFAULT_BLOB_SOURCE.missingIdentityFields.filter(field => source[field] != null).map(field => [field, source[field]])),
                missingIdentityFields: DEFAULT_BLOB_SOURCE.missingIdentityFields.filter(field => source[field] == null)
            }
        };
    } catch {
        return { ok: false, error: "historical_blob_source_unavailable" };
    }
}

function blobBase(url) {
    if (typeof url !== "string" || !url.startsWith("blob:")) return null;
    return url.split(/[?#]/, 1)[0];
}

function installProbe() {
    if (window.__aegisAccept != null) return "already";
    const state = { events: [], scenarioId: "initialization", previewMessageId: null, decodePosters: false, serial: 0, elements: new WeakMap(), history: new Map(), posters: new Map(), metadataLoads: [] };
    const baseOf = url => typeof url === "string" && url.startsWith("blob:") ? url.split(/[?#]/, 1)[0] : null;
    const identity = el => {
        if (!state.elements.has(el)) state.elements.set(el, "media-" + ++state.serial);
        const preview = el.closest("[role=\"dialog\"], [class*=imageModal], [class*=mediaModal], [class*=carouselModal]");
        const logPreview = el.closest(".aegis-modal-msg-preview, .aegis-modal-removed-attachments");
        const context = el.closest(".aegis-modal-msg-context") ?? logPreview?.parentElement?.querySelector(":scope > .aegis-modal-msg-context");
        const inLog = context != null || logPreview != null || el.closest(".aegis-modal-content-inner") != null;
        const row = el.closest("[id^=\"chat-messages-\"]");
        const view = inLog ? "log" : row != null ? "chat" : preview != null ? "preview" : "other";
        let messageId = view === "preview" ? state.previewMessageId : null;
        if (view === "chat" && row?.id) messageId = row.id.match(/-(\d+)$/)?.[1] ?? messageId;
        if (inLog) {
            for (const anchor of [el, logPreview, context]) {
                if (anchor == null) continue;
                const key = Object.keys(anchor).find(k => k.startsWith("__reactFiber$"));
                let fiber = key != null ? anchor[key] : null;
                for (let i = 0; i < 18 && fiber; i++, fiber = fiber.return) {
                    const id = fiber.memoizedProps?.message?.message_id ?? fiber.memoizedProps?.message?.id;
                    if (typeof id === "string") { messageId = id; break; }
                }
                if (messageId != null) break;
            }
        }
        return { elementId: state.elements.get(el), messageId, view };
    };
    const ownership = url => {
        const base = baseOf(url);
        try {
            const resolver = window.Vencord?.Plugins?.plugins?.AegisLogger?.imageUtils?.resolveManagedAttachmentBase;
            if (typeof resolver !== "function") return { ownership: "unknown", managedBase: null, ownershipBasis: "resolver-unavailable", base };
            const managedBase = resolver(url);
            if (typeof managedBase === "string") {
                state.history.set(managedBase, { timestamp: Date.now(), scenarioId: state.scenarioId });
                return { ownership: "managed", managedBase, ownershipBasis: "event-time-registry", base };
            }
            if (state.history.has(base)) return { ownership: "managed", managedBase: base, ownershipBasis: "historical-registry", base };
            return { ownership: "unknown", managedBase: null, ownershipBasis: "registry-miss-without-origin-evidence", base };
        } catch (error) {
            return { ownership: "unknown", managedBase: null, ownershipBasis: "resolver-error: " + String(error), base };
        }
    };
    const kindOf = (el, attr) => attr === "poster" ? "poster" : el.tagName === "IMG" ? "img" : el.closest("video") != null || el.tagName === "VIDEO" ? "video" : "audio";
    const domError = event => {
        const el = event.target;
        if (el?.tagName == null) return;
        const url = el.currentSrc || el.getAttribute?.("src") || el.getAttribute?.("poster") || el.getAttribute?.("href");
        if (baseOf(url) == null) return;
        state.events.push({
            scenarioId: state.scenarioId,
            timestamp: Date.now(),
            channel: "dom-error",
            url,
            tagName: el.tagName,
            kind: kindOf(el, el.getAttribute?.("src") ? "src" : "poster"),
            ...identity(el),
            ...ownership(url)
        });
    };
    const sample = (selector = "img, video, audio, source") => {
        const out = [];
        for (const el of document.querySelectorAll(selector)) {
            for (const attr of ["src", "poster"]) {
                const url = attr === "src" ? el.currentSrc || el.getAttribute(attr) : el.getAttribute(attr);
                if (baseOf(url) == null) continue;
                const media = el.closest("video, audio") ?? el;
                const host = identity(el);
                const posterKey = `${state.scenarioId}|${host.elementId}|${url}`;
                let loaded = el.tagName === "IMG" ? el.complete && el.naturalWidth > 0 : media.readyState > 0 && (media.videoWidth ?? 1) > 0;
                if (attr === "poster") {
                    if (state.decodePosters && !state.posters.has(posterKey)) {
                        const entry = { loaded: false, failed: false, settled: false, image: new Image() };
                        const { scenarioId } = state;
                        entry.image.onload = () => { entry.loaded = entry.image.naturalWidth > 0; entry.settled = true; };
                        entry.image.onerror = () => {
                            entry.failed = true;
                            entry.settled = true;
                            state.events.push({ scenarioId, timestamp: Date.now(), channel: "poster-decode-probe", tagName: el.tagName, kind: "poster", url, ...host, ...ownership(url), provenance: { type: "script", url: "aegis-acceptance-poster-decode", stack: { callFrames: [{ functionName: "acceptancePosterDecode" }] } } });
                        };
                        state.posters.set(posterKey, entry);
                        entry.image.src = url;
                    }
                    loaded = state.posters.get(posterKey)?.loaded === true;
                }
                out.push({
                    scenarioId: state.scenarioId,
                    timestamp: Date.now(),
                    attr,
                    tagName: el.tagName,
                    kind: kindOf(el, attr),
                    url,
                    ...host,
                    ...ownership(url),
                    loaded,
                    currentSrc: media.currentSrc ?? null,
                    preload: media.preload ?? null,
                    readyState: media.readyState ?? null,
                    networkState: media.networkState ?? null,
                    mediaError: media.error != null ? { code: media.error.code, message: media.error.message ?? null } : null,
                    decodeAttempted: attr === "poster" && state.posters.has(posterKey),
                    decodeSettled: attr === "poster" && state.posters.get(posterKey)?.settled === true,
                    decodeFailed: attr === "poster" && state.posters.get(posterKey)?.failed === true
                });
            }
        }
        return out;
    };
    const prepareVideos = targets => {
        const actions = [];
        for (const el of document.querySelectorAll("video")) {
            const host = identity(el);
            const url = el.currentSrc || el.getAttribute("src");
            const base = ownership(url).managedBase ?? baseOf(url);
            if (!targets.some(target => target.messageId === host.messageId && target.view === host.view && target.base === base)) continue;
            const before = { ...host, base, preload: el.preload, readyState: el.readyState, networkState: el.networkState, mediaError: el.error != null ? { code: el.error.code, message: el.error.message ?? null } : null };
            let action = "already-loading-or-loaded";
            if (el.readyState === 0 && el.error == null && el.networkState !== 2) {
                state.metadataLoads.push({ element: el, previousPreload: el.preload });
                el.preload = "metadata";
                el.load();
                action = "metadata-load-without-playback";
            }
            actions.push({ ...before, action, timestamp: Date.now() });
        }
        return actions;
    };
    document.addEventListener("error", domError, true);
    window.__aegisAccept = { state, domError, sample, ownership, prepareVideos };
    sample();
    return "installed";
}

const expressions = {
    install: `(${installProbe.toString()})()`,
    remove: `(() => {
        const probe = window.__aegisAccept;
        if (probe == null) return "absent";
        document.removeEventListener("error", probe.domError, true);
        for (const entry of probe.state.posters.values()) { entry.image.onload = null; entry.image.onerror = null; }
        for (const entry of probe.state.metadataLoads) entry.element.preload = entry.previousPreload;
        delete window.__aegisAccept;
        return "removed";
    })()`,
    drain: "(() => window.__aegisAccept?.state.events.splice(0) ?? [])()",
    probe: "(() => window.__aegisAccept?.sample() ?? [])()"
};

function createMediaMonitor({ client, ledger = createResourceLedger(), resolveOwnership, resolutionTimeoutMs = 5000 } = {}) {
    let scenarioId = "initialization";
    const startedAt = Date.now();
    const history = new Map();
    const requests = new Map();
    const requestHistory = new Map();
    const pending = new Set();
    const historicalEvents = [];
    const resolve = resolveOwnership ?? (url => client.evalJson(`(() => window.__aegisAccept?.ownership(${JSON.stringify(url)}) ?? { ownership: "unknown", ownershipBasis: "probe-unavailable" })()`));
    const remember = entries => {
        for (const entry of entries) {
            const base = entry.managedBase ?? entry.base;
            if (base != null && (entry.ownership === "managed" || entry.managedBase != null)) history.set(base, { ownership: "managed", managedBase: base, ownershipBasis: entry.ownershipBasis ?? "sampled-managed-resource" });
        }
    };
    const lookup = async event => {
        const base = blobBase(event.url);
        if (event.ownership === "managed" || event.managedBase != null) { remember([event]); return event; }
        if (history.has(base)) return { ...event, ...history.get(base), ownershipBasis: "historical-managed-resource" };
        let timer;
        let evidence;
        try {
            evidence = await Promise.race([
                Promise.resolve().then(() => resolve(event.url)),
                new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout({ ownership: "unknown", ownershipBasis: "ownership-query-timeout" }), resolutionTimeoutMs); })
            ]);
        } catch (error) {
            evidence = { ownership: "unknown", ownershipBasis: "ownership-query-error: " + String(error) };
        } finally {
            clearTimeout(timer);
        }
        if (evidence?.ownership === "managed" || evidence?.managedBase != null) {
            const resolved = { ...event, ...evidence, base, managedBase: evidence.managedBase ?? base, ownership: "managed" };
            remember([resolved]);
            return resolved;
        }
        if (history.has(base)) return { ...event, ...history.get(base), ownershipBasis: "historical-managed-resource" };
        return { ...event, base, ownership: evidence?.ownership === "unmanaged" ? "unmanaged" : "unknown", managedBase: null, ownershipBasis: evidence?.ownershipBasis ?? "no-origin-evidence" };
    };
    const enqueue = async event => {
        const owned = await lookup(event);
        ledger.addEvent(owned);
        return owned;
    };
    const track = promise => {
        pending.add(promise);
        promise.finally(() => pending.delete(promise)).catch(() => { });
        return promise;
    };
    const addFailure = event => {
        if (blobBase(event.url) == null) return;
        track(enqueue({ scenarioId, timestamp: Date.now(), ...event, base: blobBase(event.url) }));
    };
    const ingestCdp = message => {
        const params = message.params ?? {};
        if (message.method === "Network.requestWillBeSent" && blobBase(params.request?.url) != null) {
            const event = { scenarioId, timestamp: Date.now(), sourceTimestamp: params.timestamp ?? null, wallTime: params.wallTime ?? null, resourceType: params.type ?? null, url: params.request.url, requestId: params.requestId, provenance: params.initiator ?? null };
            const ownershipTask = track(lookup(event));
            requests.set(params.requestId, { event, ownershipTask });
            requestHistory.set(params.requestId, { event, ownershipTask });
        }
        if (message.method === "Network.loadingFailed" && requests.has(params.requestId)) {
            const request = requests.get(params.requestId);
            requests.delete(params.requestId);
            const event = { ...request.event, channel: "network", errorText: params.errorText ?? null, canceled: params.canceled ?? null, blockedReason: params.blockedReason ?? null, failureTimestamp: Date.now() };
            track(request.ownershipTask.then(owned => enqueue({ ...event, ...owned, channel: "network", timestamp: event.failureTimestamp })));
        }
        if (message.method === "Network.loadingFinished") requests.delete(params.requestId);
        if (message.method === "Log.entryAdded" && ["error", "warning"].includes(params.entry?.level)) {
            const { entry } = params;
            const url = blobBase(entry.url) != null ? entry.url : String(entry.text ?? "").match(/blob:[^\s"']+/)?.[0];
            const request = requestHistory.get(entry.networkRequestId);
            const event = { scenarioId: request?.event.scenarioId ?? scenarioId, timestamp: Date.now(), sourceTimestamp: entry.timestamp ?? null, channel: "log-entry", url, requestId: entry.networkRequestId ?? null, provenance: entry.stackTrace ?? request?.event.provenance ?? null, description: entry.text ?? null };
            if (typeof entry.timestamp === "number" && entry.timestamp > 0 && entry.timestamp < startedAt) historicalEvents.push({ ...event, historicalReplay: true });
            else addFailure(event);
        }
        if (message.method === "Runtime.consoleAPICalled" && params.type === "error") {
            for (const arg of params.args ?? []) {
                const url = String(arg.value ?? arg.description ?? "").match(/blob:[^\s"']+/)?.[0];
                addFailure({ channel: "console", url, sourceTimestamp: params.timestamp ?? null, provenance: params.stackTrace ?? null });
            }
        }
    };
    return {
        ledger,
        setScenario(value) { scenarioId = value; },
        remember,
        ingestCdp,
        ingestDom(events) { for (const event of events) addFailure(event); },
        async flush() {
            while (pending.size > 0) await Promise.allSettled([...pending]);
            return ledger.summary();
        },
        summary(options) { return ledger.summary(options); },
        pendingCount() { return pending.size; },
        history() { return [...history.entries()].map(([base, evidence]) => ({ base, ...evidence })); },
        historicalEvents() { return [...historicalEvents]; },
        requestHistory() { return [...requestHistory.values()].map(request => request.event); },
        unresolvedRequests() { return [...requests.values()].map(request => request.event); }
    };
}

async function settleMediaScenario({ client, monitor, scenarioId, targets, observed }) {
    monitor.ingestDom(await client.evalJson(expressions.drain));
    monitor.remember(observed);
    await monitor.flush();
    const summary = monitor.summary({ scenarioId });
    const verdict = evaluateMediaTargets({ targets, observed, ledgerSummary: summary });
    return { ...verdict, summary };
}

function evaluateBlobInvestigation(events, source = DEFAULT_BLOB_SOURCE) {
    const reproduced = events.filter(event => {
        const query = event.url.indexOf("?");
        const fragment = event.url.indexOf("#");
        return query >= 0 && (fragment < 0 || query < fragment) && /[?&]format=webp(?:&|#|$)/.test(event.url);
    });
    const identified = reproduced.filter(event => event.ownership === "managed" && event.messageId != null && event.elementId != null && event.view != null && event.kind != null && event.provenance != null);
    const observations = reproduced.filter(acceptance.isVerifiedMediaObservation);
    const targetFailures = identified.filter(event => !observations.includes(event));
    const status = targetFailures.length > 0 ? "fail" : reproduced.length > 0 && observations.length === reproduced.length ? "pass" : "blocked";
    return {
        status,
        evidence: {
            source,
            reason: targetFailures.length > 0 ? "managed-target-failure-reproduced" : status === "pass" ? "explicit-non-target-preload-provenance-and-target-display-confirmed" : reproduced.length === 0 ? "shape-not-reproduced-original-component-identity-missing" : "resource-or-component-or-request-provenance-unresolved",
            reproduced,
            targetFailures,
            observations
        }
    };
}

function discordWindow() {
    return execFileSync("powershell", ["-NoProfile", "-Command", "$p = Get-Process Discord | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; Write-Output ($p.Id.ToString() + '|' + $p.MainWindowHandle.ToString())"], { encoding: "utf8", windowsHide: true }).trim();
}

function processCommandLine(pid) {
    return execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`], { encoding: "utf8", windowsHide: true }).trim();
}

function windowOp(op, hwnd) {
    return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowScript, "-Op", op, "-Hwnd", String(hwnd)], { encoding: "utf8", windowsHide: true }).trim();
}

async function run({ pageWs, outDir, historicalSourcePath, adapters = {} }) {
    const historical = readHistoricalBlobSource(historicalSourcePath);
    let ws;
    let client;
    let monitor;
    let listener;
    let probeInstalled = false;
    const hydratedBases = new Set();
    const mediaScenarios = [];
    const pause = adapters.pause ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    const op = adapters.windowOp ?? windowOp;

    return acceptance.runAcceptance({
        scriptVersion: SCRIPT_VERSION,
        reportPath: path.join(outDir, "b01-report.json"),
        execute: async ({ results, scope }) => {
            if (!historical.ok) {
                recordResult(results, "历史 Blob 证据输入", "fail", { reason: historical.error });
                return;
            }
            if (adapters.connect != null) ({ ws, client } = await adapters.connect(pageWs));
            else {
                ws = new WebSocket(pageWs);
                client = createCdpClient(ws, { timeoutMs: 30000 });
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
                    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
                    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws connect failed")); }, { once: true });
                });
            }
            monitor = createMediaMonitor({ client });
            await client.evalJson(expressions.install);
            probeInstalled = true;
            listener = event => {
                try { monitor.ingestCdp(JSON.parse(String(event.data))); }
                catch (error) { recordResult(results, "CDP 媒体事件解析", "fail", { message: String(error) }); }
            };
            ws.addEventListener("message", listener);
            scope.add(() => ws.removeEventListener("message", listener));
            scope.add(async () => {
                if (!probeInstalled) return;
                await client.evalJson(expressions.remove);
                probeInstalled = false;
            });
            scope.add(async () => {
                if (!probeInstalled) return;
                monitor.ingestDom(await client.evalJson(expressions.drain));
                const summary = await monitor.flush();
                recordResult(results, "收尾媒体错误结算", summary.managedFailures.length > 0 ? "fail" : summary.unknownFailures.length > 0 ? "blocked" : "pass", summary);
                const investigation = evaluateBlobInvestigation(monitor.ledger.events(), historical.source);
                recordResult(results, "query-before-fragment Blob 失败定向核实", investigation.status, investigation.evidence);
            });
            scope.add(async () => {
                if (!probeInstalled) return;
                await client.evalJson("window.Vencord.Webpack.findByProps(\"closeAllModals\", \"openModal\").closeAllModals() ?? 1");
            });
            await Promise.all([client.send("Runtime.enable"), client.send("Log.enable"), client.send("Network.enable")]);

            const [pid, hwnd] = (adapters.discordWindow ?? discordWindow)().split("|");
            const commandLine = (adapters.processCommandLine ?? processCommandLine)(pid);
            const visible = async () => {
                op("restore", hwnd);
                return waitFor(client, "document.visibilityState === \"visible\" ? \"visible\" : null", { label: "window visible", timeoutMs: 8000, intervalMs: 400 });
            };
            const visibility = await visible();
            const env = await client.evalJson("({ ua: navigator.userAgent, build: window.DiscordNative?.app?.getBuildNumber?.() ?? null })");
            const buildIdentity = await client.evalJson("(() => { const utils = window.Vencord.Webpack.findByProps(\"toURLSafe\"); return utils != null && utils.toURLSafe.toString().includes(\"guardManagedBlobUrl\"); })()");
            const environment = evaluateEnvironment({ commandLine, forbiddenFlags: FORBIDDEN_STARTUP_FLAGS, requiredEvidence: [env?.ua, commandLine, visibility] });
            recordResult(results, "环境: 普通启动参数 + 页面可见 + 加载构建", environment.pass && buildIdentity ? "pass" : environment.blocked ? "blocked" : "fail", { ...environment.evidence, ...env, buildIdentity });
            if (!environment.pass || !buildIdentity) return;

            const begin = async (id, previewMessageId = null) => {
                monitor.ingestDom(await client.evalJson(expressions.drain));
                await monitor.flush();
                monitor.setScenario(id);
                await client.evalJson(`(() => { const state = window.__aegisAccept.state; state.scenarioId = ${JSON.stringify(id)}; state.previewMessageId = ${JSON.stringify(previewMessageId)}; state.decodePosters = false; return true; })()`);
                monitor.remember(await client.evalJson(expressions.probe));
            };
            const observe = async () => {
                const observed = await client.evalJson(expressions.probe);
                monitor.remember(observed);
                return observed.map(item => ({ ...item, base: item.managedBase ?? item.base }));
            };
            const settle = async (id, name, targets, observed, detail = {}) => {
                const verdict = await settleMediaScenario({ client, monitor, scenarioId: id, targets, observed });
                const entry = { scenarioId: id, targets, observed, verdict, ...detail };
                mediaScenarios.push(entry);
                recordResult(results, name, verdict.pass ? "pass" : verdict.blocked ? "blocked" : "fail", entry);
                return verdict;
            };
            const hydrate = async messageId => {
                const result = await client.evalJson(`(async () => {
                    const p = window.Vencord.Plugins.plugins.AegisLogger;
                    const records = await p.idb.getMessagesByIDsIDB([${JSON.stringify(messageId)}]);
                    if (!records.length) return null;
                    const hydrated = await p.idb.hydrateRecords(records);
                    try {
                        return {
                            channelId: records[0].channel_id,
                            guildId: records[0].message.guildId ?? null,
                            targets: (hydrated.records[0].message.attachments ?? []).filter(a => typeof a.url === "string" && a.url.startsWith("blob:")).map(a => ({ id: a.id, contentType: a.content_type ?? "", url: a.url, base: p.imageUtils.resolveManagedAttachmentBase(a.url) }))
                        };
                    } finally { hydrated.scope.release(); }
                })()`);
                if (result == null) return null;
                for (const target of result.targets) if (target.base != null) hydratedBases.add(target.base);
                monitor.remember(result.targets.filter(target => target.base != null).map(target => ({ ...target, ownership: "managed", managedBase: target.base, ownershipBasis: "active-hydration" })));
                return result;
            };
            const samples = async (status, contentType) => client.evalJson(`(async () => {
                const p = window.Vencord.Plugins.plugins.AegisLogger;
                const out = [];
                for await (const batch of p.idb.iterateRawMessagesIDB(500)) {
                    for (const r of batch) {
                        if (${JSON.stringify(status)} != null && r.status !== ${JSON.stringify(status)}) continue;
                        const channel = window.Vencord.Webpack.Common.ChannelStore.getChannel(r.channel_id);
                        if (channel == null || (channel.type !== 0 && channel.type !== 1)) continue;
                        const count = (r.message.attachments ?? []).filter(a => a.path != null && (a.content_type ?? "").startsWith(${JSON.stringify(contentType)})).length;
                        if (count >= ${status === "EDITED" ? 2 : 1}) out.push({ id: r.message_id, count });
                    }
                    if (out.length >= 100) break;
                }
                return out.sort((a, b) => b.count - a.count).slice(0, 4);
            })()`);
            const waitLoaded = async (targets, label, messageId = null) => {
                let observed = [];
                try {
                    await waitFor({ evalJson: async () => {
                        if (messageId != null) await client.evalJson(`(() => { const row = document.querySelector('[id$="-${messageId}"]'); row?.scrollIntoView({ block: "center" }); return row != null; })()`);
                        observed = await observe();
                        return targets.every(target => {
                            const matches = observed.filter(item => item.scenarioId === target.scenarioId && item.messageId === target.messageId && item.view === target.view && item.kind === target.kind && item.base === target.base);
                            return matches.length > 0 && (matches.every(item => item.loaded) || matches.some(item => item.decodeFailed || item.mediaError != null));
                        });
                    } }, "targets", { label, timeoutMs: 20000, intervalMs: 600 });
                } catch (error) { if (!(error instanceof WaitTimeoutError)) throw error; }
                return observed;
            };
            const chat = async (id, name, status, contentType) => {
                await begin(id);
                const candidates = await samples(status, contentType);
                let lastEvidence = null;
                for (const candidate of candidates) {
                    const sample = await hydrate(candidate.id);
                    if (sample == null || sample.targets.length === 0) continue;
                    const route = sample.guildId != null ? `/channels/${sample.guildId}/${sample.channelId}/${candidate.id}` : `/channels/@me/${sample.channelId}/${candidate.id}`;
                    await visible();
                    await client.evalJson(`(() => { window.Vencord.Webpack.Common.NavigationRouter.transitionTo(${JSON.stringify(route)}); return true; })()`);
                    try {
                        await waitFor(client, `document.querySelector('[id$="-${candidate.id}"]') != null`, { label: "message row", timeoutMs: 12000, intervalMs: 600 });
                    } catch (error) {
                        if (!(error instanceof WaitTimeoutError)) throw error;
                        lastEvidence = { messageId: candidate.id, route, reason: "message-row-not-reachable" };
                        continue;
                    }
                    await client.evalJson(`(() => { document.querySelector('[id$="-${candidate.id}"]').scrollIntoView({ block: "center" }); return true; })()`);
                    const targets = sample.targets.filter(target => target.base != null && target.contentType.startsWith(contentType)).map(target => ({ scenarioId: id, messageId: candidate.id, view: "chat", kind: contentType === "video" ? "video" : "img", base: target.base }));
                    if (targets.length === 0) continue;
                    const loadPreparation = contentType === "video" ? await client.evalJson(`window.__aegisAccept.prepareVideos(${JSON.stringify(targets)})`) : [];
                    const observed = await waitLoaded(targets, name, candidate.id);
                    const hostMounted = observed.some(item => item.messageId === candidate.id && item.view === "chat" && item.kind === (contentType === "video" ? "video" : "img"));
                    if (!hostMounted) recordResult(results, name, "blocked", { reason: "target-message-media-host-not-mounted-during-check", targets, observed, route, loadPreparation });
                    else await settle(id, name, targets, observed, { route, loadPreparation });
                    if (contentType === "video") {
                        const posterScenarioId = id + "-poster";
                        await begin(posterScenarioId);
                        await client.evalJson("(() => { window.__aegisAccept.state.decodePosters = true; return true; })()");
                        const posterTargets = targets.map(target => ({ ...target, scenarioId: posterScenarioId, kind: "poster" }));
                        const posterObserved = await waitLoaded(posterTargets, name + " poster decode", candidate.id);
                        const hasPosterHost = posterObserved.some(item => item.messageId === candidate.id && item.kind === "poster" && item.view === "chat");
                        if (!hasPosterHost) recordResult(results, "聊天视频 poster 解码", "blocked", { reason: "poster-host-not-mounted-during-decode-check", targets: posterTargets, observed: posterObserved });
                        else await settle(posterScenarioId, "聊天视频 poster 解码", posterTargets, posterObserved, { note: "封面通过需要实际图片解码；视频本体成功不能代替封面" });
                    }
                    return { messageId: candidate.id, targets };
                }
                await monitor.flush();
                recordResult(results, name, "blocked", { reason: "no-reachable-cached-media-sample", lastEvidence });
                return null;
            };

            await begin("boundary");
            const boundarySamples = await samples(null, "image");
            if (boundarySamples.length === 0) recordResult(results, "受管/非受管 URL 处理边界", "blocked", { reason: "no-cached-image-sample" });
            else {
                const sample = await hydrate(boundarySamples[0].id);
                const display = sample?.targets[0]?.url;
                if (display == null) recordResult(results, "受管/非受管 URL 处理边界", "blocked", { reason: "hydration-has-no-managed-target" });
                else {
                    const boundary = await client.evalJson(`(() => {
                        const utils = window.Vencord.Webpack.findByProps("toURLSafe");
                        const display = ${JSON.stringify(display)};
                        const guarded = utils.toURLSafe(display);
                        guarded.searchParams.append("format", "webp");
                        guarded.searchParams.set("width", "320");
                        return { display, managedStaysDisplay: guarded.toString() === display, httpsIntact: utils.toURLSafe("https://cdn.discordapp.com/a.png?size=128").toString() === "https://cdn.discordapp.com/a.png?size=128", unknownBlobUntouched: utils.toURLSafe("blob:https://discord.com/not-ours").toString() === "blob:https://discord.com/not-ours" };
                    })()`);
                    recordResult(results, "受管/非受管 URL 处理边界", boundary.managedStaysDisplay && boundary.httpsIntact && boundary.unknownBlobUntouched ? "pass" : "fail", boundary);
                }
            }

            await chat("chat-video", "聊天视频本体", null, "video");
            const image = await chat("chat-image", "聊天图片", null, "image");
            await begin("lightbox", image?.messageId ?? null);
            if (image == null) recordResult(results, "独立放大预览", "blocked", { reason: "chat-image-sample-unavailable" });
            else {
                const target = image.targets[0];
                const clicked = await client.evalJson(`(() => {
                    const p = window.__aegisAccept;
                    const item = p.sample().find(item => item.view === "chat" && item.messageId === ${JSON.stringify(image.messageId)} && item.kind === "img" && item.base === ${JSON.stringify(target.base)} && item.loaded);
                    if (item == null) return false;
                    const el = [...document.querySelectorAll("img")].find(el => (el.currentSrc || el.getAttribute("src")) === item.url && el.closest('[id$="-${image.messageId}"]'));
                    if (el == null) return false;
                    el.click();
                    return true;
                })()`);
                if (!clicked) recordResult(results, "独立放大预览", "fail", { reason: "target-not-clickable", target });
                else {
                    const targets = [{ ...target, scenarioId: "lightbox", view: "preview" }];
                    let observed = [];
                    try {
                        await waitFor({ evalJson: async () => {
                            observed = (await client.evalJson("(() => window.__aegisAccept.sample().filter(item => item.view === \"preview\"))()")).map(item => ({ ...item, base: item.managedBase ?? item.base }));
                            const matches = observed.filter(item => item.scenarioId === "lightbox" && item.view === "preview" && item.messageId === image.messageId && item.base === target.base && item.kind === "img");
                            return matches.length > 0 && matches.every(item => item.loaded);
                        } }, "lightbox", { label: "lightbox scoped image", timeoutMs: 15000, intervalMs: 600 });
                    } catch (error) { if (!(error instanceof WaitTimeoutError)) throw error; }
                    if (observed.length === 0) recordResult(results, "独立放大预览", "blocked", { reason: "preview-component-region-unproven", targets });
                    else await settle("lightbox", "独立放大预览", targets, observed);
                    await client.evalJson("window.Vencord.Webpack.findByProps(\"closeAllModals\", \"openModal\").closeAllModals() ?? 1");
                }
            }
            await chat("chat-edited", "编辑多附件", "EDITED", "image");

            await begin("log-modal");
            await client.evalJson("window.Vencord.Plugins.plugins.AegisLogger.openLogModal() ?? 1");
            let logRowsReady = true;
            try {
                await waitFor(client, "document.querySelectorAll('.aegis-modal-msg-context').length > 0", { label: "log-modal rows", timeoutMs: 20000 });
            } catch (error) {
                if (!(error instanceof WaitTimeoutError)) throw error;
                logRowsReady = false;
                recordResult(results, "日志窗存档图媒体", "blocked", { reason: "log-modal-rows-precondition-timeout", snapshot: await client.evalJson("({ visibility: document.visibilityState, modalPresent: document.querySelector('.aegis-modal-content-inner') != null, rowCount: document.querySelectorAll('.aegis-modal-msg-context').length, loading: document.querySelector('.aegis-modal-load-more-text')?.textContent ?? null, errorText: document.querySelector('.aegis-modal-error')?.textContent ?? null })") });
            }
            const logTargets = [];
            let logObserved = [];
            for (let round = 0; logRowsReady && round < 6 && logTargets.length === 0; round++) {
                const ids = await client.evalJson(`(() => {
                    const ids = [];
                    for (const row of document.querySelectorAll('.aegis-modal-msg-context')) {
                        const key = Object.keys(row).find(k => k.startsWith('__reactFiber$'));
                        let fiber = key != null ? row[key] : null;
                        for (let i = 0; i < 18 && fiber; i++, fiber = fiber.return) {
                            const id = fiber.memoizedProps?.message?.message_id ?? fiber.memoizedProps?.message?.id;
                            if (typeof id === "string") { ids.push(id); break; }
                        }
                    }
                    return ids;
                })()`);
                for (const id of ids) {
                    const sample = await hydrate(id);
                    for (const target of sample?.targets ?? []) if (target.base != null && target.contentType.startsWith("image")) logTargets.push({ scenarioId: "log-modal", messageId: id, view: "log", kind: "img", base: target.base });
                    if (logTargets.length >= 24) break;
                }
                await client.evalJson("(() => { let el = document.querySelector('.aegis-modal-content-inner'); while (el?.parentElement) { el = el.parentElement; if (el.scrollHeight > el.clientHeight + 10) break; } if (el != null) el.scrollTop = el.scrollHeight; return true; })()");
                await pause(1500);
            }
            if (logRowsReady && logTargets.length === 0) recordResult(results, "日志窗存档图媒体", "blocked", { reason: "no-image-in-loaded-pages" });
            else if (logTargets.length > 0) {
                logObserved = await waitLoaded(logTargets, "log modal images");
                await settle("log-modal", "日志窗存档图媒体", logTargets, logObserved);
            }
            await client.evalJson("window.Vencord.Webpack.findByProps(\"closeAllModals\", \"openModal\").closeAllModals() ?? 1");
            monitor.ingestDom(await client.evalJson(expressions.drain));
            const summary = await monitor.flush();
            recordResult(results, "全程媒体错误归属与影响", summary.managedFailures.length > 0 ? "fail" : summary.unknownFailures.length > 0 ? "blocked" : "pass", summary);
        },
        cleanup: async () => {
            try {
                if (ws != null && listener != null) ws.removeEventListener("message", listener);
                if (monitor != null) await monitor.flush();
                if (client != null) client.dispose();
            } finally {
                if (ws != null) ws.close();
            }
        },
        extra: () => ({ resourceSummary: monitor?.summary() ?? null, resourceEvents: monitor?.ledger.events() ?? [], resourceHistory: monitor?.history() ?? [], requestHistory: monitor?.requestHistory() ?? [], unresolvedRequests: monitor?.unresolvedRequests() ?? [], historicalEvents: monitor?.historicalEvents() ?? [], targetedBlobInvestigation: evaluateBlobInvestigation(monitor?.ledger.events() ?? [], historical.source), hydratedBases: [...hydratedBases], mediaScenarios })
    });
}

const b01 = { run, createMediaMonitor, settleMediaScenario, evaluateBlobInvestigation, readHistoricalBlobSource, expressions, blobBase };

export default b01;

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const args = process.argv.slice(2);
    const [pageWs, outDir] = args;
    const historicalIndex = args.indexOf("--historical-blob-source");
    const historicalSourcePath = historicalIndex < 0 ? undefined : args[historicalIndex + 1];
    if (pageWs == null || outDir == null) process.exitCode = 2;
    else if (historicalIndex >= 0 && historicalSourcePath == null) {
        process.stderr.write("--historical-blob-source requires a JSON file path\n");
        process.exitCode = 2;
    } else process.exitCode = (await run({ pageWs, outDir, historicalSourcePath })).exitCode;
}
