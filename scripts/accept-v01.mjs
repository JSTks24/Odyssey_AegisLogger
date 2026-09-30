/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import acceptance from "./acceptanceLib.mjs";

const SCRIPT_VERSION = "accept-v01/6 2026-09-30";
const FORBIDDEN_STARTUP_FLAGS = [
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-background-timer-throttling",
    "CalculateNativeWinOcclusion"
];
const windowScript = path.join(path.dirname(fileURLToPath(import.meta.url)), "v01-window.ps1");
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const sameIds = (a, b) => a.length === b.length && a.every((id, index) => id === b[index]);

const SETTINGS_EXPRESSION = `(() => {
    const store = window.Vencord.Plugins.plugins.AegisLogger.settings.store;
    return { pageSize: store.messagesToDisplayAtOnceInLogs, sortNewest: !!store.sortNewest };
})()`;
const SCROLL_BOTTOM = `(() => {
    let el = document.querySelector('.aegis-modal-content-inner');
    while (el && el.parentElement) {
        el = el.parentElement;
        if (el.scrollHeight > el.clientHeight + 10) break;
    }
    if (el == null) return false;
    el.scrollTop = el.scrollHeight;
    return true;
})()`;
const CLOSE_MODAL = "window.Vencord.Webpack.findByProps('closeAllModals', 'openModal').closeAllModals() ?? 1";
const INSTALL_READ_PROBE = `(() => {
    if (window.__aegisV01ReadProbe != null) return { installed: false, reason: 'probe already installed' };
    const idb = window.Vencord.Plugins.plugins.AegisLogger.idb;
    const names = ['getDateStortedMessagesByStatusIDB', 'countMessagesByStatusIDB', 'getMessagesByIDsIDB', 'hydrateRecords'];
    if (names.some(name => typeof idb[name] !== 'function')) return { installed: false, reason: 'required read method missing' };
    const originals = new Map();
    const wrappers = new Map();
    const calls = [];
    let nextId = 0;
    for (const name of names) {
        const original = idb[name];
        originals.set(name, original);
        const wrapper = function(...args) {
            const tabs = [...document.querySelectorAll('.aegis-modal-tab-bar-item')];
            const tabIndex = tabs.findIndex(el => /selected/i.test(String(el.className)));
            const statuses = name === 'getDateStortedMessagesByStatusIDB' ? [args[2]]
                : name === 'countMessagesByStatusIDB' ? [args[0]]
                : name === 'hydrateRecords' ? [...new Set((args[0] ?? []).map(record => record.status).filter(Boolean))] : [];
            const call = { id: ++nextId, name, tabIndex, statuses, startedAt: Date.now(), settledAt: null, rejected: null };
            calls.push(call);
            let result;
            try { result = original.apply(this, args); }
            catch (error) { call.settledAt = Date.now(); call.rejected = String(error); throw error; }
            Promise.resolve(result).then(
                () => { call.settledAt = Date.now(); },
                error => { call.settledAt = Date.now(); call.rejected = String(error); }
            );
            return result;
        };
        wrappers.set(name, wrapper);
        idb[name] = wrapper;
    }
    window.__aegisV01ReadProbe = {
        snapshot() { return { sampledAt: Date.now(), nextId, calls: calls.map(call => ({ ...call, statuses: [...call.statuses] })) }; },
        restore() {
            for (const name of names) if (idb[name] !== wrappers.get(name)) throw new Error('read method changed during V01 probe: ' + name);
            for (const name of names) idb[name] = originals.get(name);
            delete window.__aegisV01ReadProbe;
            return true;
        }
    };
    return { installed: true, names };
})()`;
const READ_PROBE_SNAPSHOT = "window.__aegisV01ReadProbe?.snapshot() ?? null";
const RESTORE_READ_PROBE = "window.__aegisV01ReadProbe?.restore() ?? false";
const COMMIT_FRAMES = `new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(true); }));
})`;

function stableChannelExpression(pageSize) {
    return `(async () => {
        const idb = window.Vencord.Plugins.plugins.AegisLogger.idb;
        const channels = window.Vencord.Webpack.findStore('ChannelStore');
        const permissions = window.Vencord.Webpack.findStore('PermissionStore');
        const counts = new Map();
        for (const status of ['DELETED', 'EDITED']) {
            for await (const batch of idb.iterateRawMessagesByStatusIDB(status, true)) {
                for (const record of batch) {
                    const channel = channels?.getChannel(record.channel_id);
                    if (channel == null || (channel.guild_id && permissions?.can?.(1024n, channel) !== true)) continue;
                    let item = counts.get(record.channel_id);
                    if (item == null) { item = { channel: record.channel_id, deleted: 0, edited: 0, lastTimestamp: 0 }; counts.set(record.channel_id, item); }
                    item[status === 'DELETED' ? 'deleted' : 'edited']++;
                    item.lastTimestamp = Math.max(item.lastTimestamp, record.timestampMs ?? (Date.parse(record.message?.timestamp ?? '') || 0));
                }
            }
        }
        return [...counts.values()].filter(item => item.deleted > ${pageSize * 3} && item.edited > ${pageSize})
            .map(item => ({ ...item, preferred: item.deleted >= 1000 && item.deleted <= 10000 && item.edited <= 10000 }))
            .sort((a, b) => Number(b.preferred) - Number(a.preferred) || a.lastTimestamp - b.lastTimestamp || a.deleted + a.edited - b.deleted - b.edited);
    })()`;
}

function baselineExpression({ status, sortNewest, channel = null }) {
    return `(async () => {
        const ids = [];
        const idb = window.Vencord.Plugins.plugins.AegisLogger.idb;
        for await (const batch of idb.iterateRawMessagesByStatusIDB(${JSON.stringify(status)}, ${JSON.stringify(sortNewest)})) {
            for (const record of batch) {
                if (${JSON.stringify(channel)} == null || record.channel_id === ${JSON.stringify(channel)}) ids.push(record.message_id);
            }
        }
        return ids;
    })()`;
}

function selectTabExpression(index) {
    return `(() => {
        const target = document.querySelectorAll('.aegis-modal-tab-bar-item')[${index}];
        if (target == null) return false;
        target.click();
        return true;
    })()`;
}

function statusOfTab(text) {
    if (/已删除|deleted/i.test(text ?? "")) return "DELETED";
    if (/已编辑|edited/i.test(text ?? "")) return "EDITED";
    if (/幽灵|ghost/i.test(text ?? "")) return "GHOST_PINGED";
    return null;
}

function createPagingSession({ client, windowOp, waitFor = acceptance.waitFor, delay = sleep, results = [], scope }) {
    let readProbeDepth = 0;
    const readRows = () => client.evalJson(acceptance.collectLogRowsExpression);
    const baseline = context => client.evalJson(baselineExpression(context));
    const record = (name, verdict, detail) => {
        acceptance.recordResult(results, name, verdict.blocked ? "blocked" : verdict.pass ? "pass" : "fail", { ...verdict.evidence, ...detail });
        return verdict;
    };
    const waitRows = async (condition, label, timeoutMs = 15000) => {
        const expression = `(() => { const rows = ${acceptance.collectLogRowsExpression}; return (${condition}) ? rows : null; })()`;
        try {
            return await waitFor(client, expression, { label, timeoutMs, intervalMs: 50 });
        } catch (error) {
            if (!(error instanceof acceptance.WaitTimeoutError)) throw error;
            return readRows();
        }
    };
    const contextStable = (snapshot, context) => snapshot.query === (context.query ?? "")
        && statusOfTab(snapshot.tabTexts?.[snapshot.selectedIndex]) === context.status;
    const checkSettled = (verdict, snapshots) => {
        const loadSettled = snapshots.every(snapshot => !snapshot.loadInFlight);
        return { ...verdict, pass: verdict.pass && loadSettled, evidence: { ...verdict.evidence, loadSettled } };
    };
    const invalidBefore = (name, snapshot, expectedAllIds) => {
        const prefix = acceptance.checkPrefix(snapshot.ids, expectedAllIds);
        if (prefix.pass && snapshot.unidentified === 0) return null;
        return record(name, { pass: false, blocked: false, evidence: { reason: "initial DOM rows are not a complete identifiable prefix", ...prefix, unidentified: snapshot.unidentified } }, { before: snapshot, expectedAllIds });
    };
    const settledGrowth = (count, label) => waitRows(`!rows.loadInFlight && rows.ids.length > ${count}`, label, 20000);
    const contextEvidence = async (context, expectedAllIds, snapshot) => ({
        baselineStable: sameIds(expectedAllIds, await baseline(context))
            && contextStable(snapshot, context)
            && (await client.evalJson(SETTINGS_EXPRESSION)).sortNewest === context.sortNewest,
        unidentified: snapshot.unidentified
    });

    async function foreground({ name, context }) {
        const expectedAllIds = await baseline(context);
        const before = await readRows();
        const invalid = invalidBefore(name, before, expectedAllIds);
        if (invalid != null) return invalid;
        if (before.ids.length >= expectedAllIds.length) return record(name, { blocked: true, evidence: { reason: "no next page", before } });
        await client.evalJson(SCROLL_BOTTOM);
        const after = await settledGrowth(before.ids.length, name);
        const flags = await contextEvidence(context, expectedAllIds, after);
        const verdict = acceptance.evaluateForegroundPaging({ beforeIds: before.ids, afterIds: after.ids, expectedAllIds, ...flags, unidentified: before.unidentified + after.unidentified });
        return record(name, checkSettled(verdict, [after]), { context, expectedAllIds, before, after });
    }

    async function recoveryCycle({ name, context, enter, exit, occlusionExpected = true, hiddenTimeoutMs = 10000 }) {
        const expectedAllIds = await baseline(context);
        const before = await readRows();
        const invalid = invalidBefore(name, before, expectedAllIds);
        if (invalid != null) return invalid;
        if (before.ids.length >= expectedAllIds.length) return record(name, { blocked: true, evidence: { reason: "no next page", before } });
        let during;
        const intervention = false;
        try {
            await enter();
            during = await waitRows("rows.vis === 'hidden'", name + " hidden", hiddenTimeoutMs);
            await delay(2500);
        } finally {
            await exit();
        }
        const auto = await waitRows("rows.vis === 'visible' && !rows.loadInFlight", name + " restore", 20000);
        await client.evalJson(SCROLL_BOTTOM);
        const after = await settledGrowth(before.ids.length, name + " growth");
        const flags = await contextEvidence(context, expectedAllIds, after);
        const verdict = acceptance.evaluateRecovery({
            beforeIds: before.ids,
            expectedAllIds,
            duringVis: during.vis,
            afterVis: after.vis,
            autoIds: auto.ids,
            scrolledIds: after.ids,
            modalOpenAfter: after.modalOpen,
            occlusionExpected,
            intervention,
            ...flags,
            unidentified: before.unidentified + auto.unidentified + after.unidentified
        });
        return record(name, checkSettled(verdict, [auto, after]), { context, expectedAllIds, before, during, auto, after, intervention });
    }

    async function lateRequestCycle(args) {
        return withReadProbe(args.name, () => runLateRequestCycle(args));
    }

    async function runLateRequestCycle({ name, context, reset, hwnd }) {
        let expectedAllIds;
        let before;
        let observed;
        let observedReads;
        let requestIds = [];
        let firstRequestObserved = false;
        let attempts = 0;
        for (; attempts < 2; attempts++) {
            if (attempts > 0) await reset();
            expectedAllIds = await baseline(context);
            before = await readRows();
            const invalid = invalidBefore(name, before, expectedAllIds);
            if (invalid != null) return invalid;
            if (expectedAllIds.length <= before.ids.length + (await client.evalJson(SETTINGS_EXPRESSION)).pageSize) break;
            const triggerMark = (await client.evalJson(READ_PROBE_SNAPSHOT)).nextId;
            await client.evalJson(SCROLL_BOTTOM);
            observed = await waitRows("rows.loadInFlight", name + " in-flight precondition", 1500);
            observedReads = await client.evalJson(READ_PROBE_SNAPSHOT);
            requestIds = observedReads.calls.filter(call => call.id > triggerMark && call.settledAt == null).map(call => call.id);
            firstRequestObserved = observed.loadInFlight && requestIds.length > 0;
            if (firstRequestObserved) break;
        }
        if (!firstRequestObserved) {
            return record(name, { blocked: true, evidence: { reason: "first read promise was not observed pending after at most two attempts", attempts: Math.min(attempts + 1, 2) } }, { context, expectedAllIds, before, observed, observedReads, requestIds });
        }
        let during;
        let hiddenObservation;
        try {
            await windowOp("minimize", hwnd);
            const expression = `(() => {
                const rows = ${acceptance.collectLogRowsExpression};
                return rows.vis === 'hidden' ? { rows, reads: ${READ_PROBE_SNAPSHOT}, sampledAt: Date.now() } : null;
            })()`;
            try { hiddenObservation = await waitFor(client, expression, { label: name + " hidden with pending reads", timeoutMs: 10000, intervalMs: 50 }); }
            catch (error) {
                if (!(error instanceof acceptance.WaitTimeoutError)) throw error;
                return record(name, { blocked: true, evidence: { reason: "hidden state was not observed" } }, { before, observed, observedReads, requestIds });
            }
            during = hiddenObservation.rows;
            const stillPending = hiddenObservation.reads.calls.some(call => requestIds.includes(call.id) && call.settledAt == null);
            if (!stillPending) return record(name, { blocked: true, evidence: { reason: "captured reads had already settled before the first hidden observation" } }, { before, observed, observedReads, requestIds, hiddenObservation });
            await delay(3500);
        } finally {
            await windowOp("restore", hwnd);
        }
        const first = await waitRows("rows.vis === 'visible' && !rows.loadInFlight", name + " first settle", 20000);
        if (first.ids.length >= expectedAllIds.length) {
            return record(name, { blocked: true, evidence: { reason: "automatic loading consumed the final page; second load has no remaining records" } }, { context, expectedAllIds, before, first, during });
        }
        await client.evalJson(SCROLL_BOTTOM);
        const second = await settledGrowth(first.ids.length, name + " second settle");
        const flags = await contextEvidence(context, expectedAllIds, second);
        const verdict = acceptance.evaluateLateRequestRecovery({
            beforeIds: before.ids,
            expectedAllIds,
            afterVis: second.vis,
            firstGrowthIds: first.ids,
            secondGrowthIds: second.ids,
            firstRequestObserved,
            ...flags,
            baselineStable: flags.baselineStable && during.vis === "hidden",
            unidentified: before.unidentified + first.unidentified + second.unidentified
        });
        return record(name, checkSettled(verdict, [first, second]), { context, expectedAllIds, before, observed, observedReads, requestIds, hiddenObservation, during, first, second, attempts: attempts + 1 });
    }

    async function withReadProbe(name, execute) {
        if (readProbeDepth > 0) return execute();
        let probeInstalled = false;
        const restoreProbe = async () => {
            if (probeInstalled) {
                await client.evalJson(RESTORE_READ_PROBE);
                probeInstalled = false;
            }
        };
        scope?.add(restoreProbe);
        const installed = await client.evalJson(INSTALL_READ_PROBE);
        probeInstalled = installed.installed;
        if (!probeInstalled) return record(name, { blocked: true, evidence: { reason: installed.reason } });
        readProbeDepth++;
        try {
            return await execute();
        } finally {
            readProbeDepth--;
            await restoreProbe();
        }
    }

    async function completedContext({ name, context, targetIndex, mark }) {
        const expression = `(() => {
            const snapshot = ${READ_PROBE_SNAPSHOT};
            if (snapshot == null) return null;
            const calls = snapshot.calls.filter(call => call.id > ${mark}
                && (call.statuses.length > 0 ? call.statuses.includes(${JSON.stringify(context.status)}) : call.tabIndex === ${targetIndex}));
            return calls.some(call => call.name !== 'countMessagesByStatusIDB') && calls.every(call => call.settledAt != null)
                ? { ...snapshot, targetCalls: calls } : null;
        })()`;
        let newReadSettlement;
        try {
            newReadSettlement = await waitFor(client, expression, { label: name + " target read promises settled", timeoutMs: 25000, intervalMs: 50 });
        } catch (error) {
            if (!(error instanceof acceptance.WaitTimeoutError)) throw error;
            return { ready: false, reason: "target read promises were not observed or did not settle", readSnapshot: await client.evalJson(READ_PROBE_SNAPSHOT) };
        }
        const framesCommitted = await client.evalJson(COMMIT_FRAMES);
        if (!framesCommitted) return { ready: false, reason: "foreground commit frames were not observed", newReadSettlement };
        const snapshot = await waitRows(`rows.selectedIndex === ${targetIndex} && rows.query === ${JSON.stringify(context.query ?? "")} && !rows.loadInFlight && rows.ids.length > 0`, name + " committed context", 20000);
        return { ready: snapshot.selectedIndex === targetIndex && contextStable(snapshot, context) && !snapshot.loadInFlight && snapshot.ids.length > 0, snapshot, newReadSettlement };
    }

    async function prepareContext({ name, context, targetIndex = 0, trigger }) {
        return withReadProbe(name, async () => {
            const mark = (await client.evalJson(READ_PROBE_SNAPSHOT)).nextId;
            await trigger();
            return completedContext({ name, context, targetIndex, mark });
        });
    }

    async function prepareFreshContext({ name, context, targetIndex = 0, close, open }) {
        await close();
        const closed = await waitRows("!rows.modalOpen", name + " previous modal closed", 10000);
        if (closed.modalOpen) return { ready: false, reason: "previous modal did not close", snapshot: closed };
        return prepareContext({ name, context, targetIndex, trigger: () => open(context.query ?? "") });
    }

    async function tabSwitch(args) {
        return withReadProbe(args.name, () => runTabSwitch(args));
    }

    async function runTabSwitch({ name, context, targetIndex, requireOldRequest, reset }) {
        const expectedAllIds = await baseline(context);
        let before = await readRows();
        if (expectedAllIds.length === 0) return record(name, { blocked: true, evidence: { reason: "target tab has no existing records" } });
        let oldRequestObserved = false;
        let observed;
        let triggerMark;
        let oldRequestIds = [];
        let oldReads;
        if (requireOldRequest) {
            for (let attempt = 0; attempt < 2; attempt++) {
                if (attempt > 0 && reset != null) { await reset(); before = await readRows(); }
                triggerMark = (await client.evalJson(READ_PROBE_SNAPSHOT)).nextId;
                await client.evalJson(SCROLL_BOTTOM);
                observed = await waitRows("rows.loadInFlight", name + " old request precondition", 1500);
                oldReads = await client.evalJson(READ_PROBE_SNAPSHOT);
                oldRequestIds = oldReads.calls.filter(call => call.id > triggerMark && call.settledAt == null).map(call => call.id);
                oldRequestObserved = observed.loadInFlight && oldRequestIds.length > 0;
                if (oldRequestObserved) break;
            }
            if (!oldRequestObserved) return record(name, { blocked: true, evidence: { reason: "old read promise was not observed pending after two attempts" } }, { before, observed, context, oldReads });
        }
        const newRequestMark = (await client.evalJson(READ_PROBE_SNAPSHOT)).nextId;
        const clickedFound = await client.evalJson(selectTabExpression(targetIndex));
        const completed = await completedContext({ name, context, targetIndex, mark: newRequestMark });
        if (!completed.ready) return record(name, { blocked: true, evidence: { reason: completed.reason ?? "target context did not commit" } }, { context, before, completed });
        const settled = completed.snapshot;
        let oldReadSettlement;
        if (requireOldRequest) {
            const oldStatus = statusOfTab(before.tabTexts?.[before.selectedIndex]);
            const settleExpression = `(() => {
                const snapshot = ${READ_PROBE_SNAPSHOT};
                if (snapshot == null) return null;
                const calls = snapshot.calls.filter(call => ${JSON.stringify(oldRequestIds)}.includes(call.id)
                    || (call.id > ${triggerMark} && (call.statuses.length > 0 ? call.statuses.includes(${JSON.stringify(oldStatus)}) : call.tabIndex === ${before.selectedIndex})));
                return calls.length > 0 && calls.every(call => call.settledAt != null) ? { ...snapshot, oldCalls: calls } : null;
            })()`;
            try {
                oldReadSettlement = await waitFor(client, settleExpression, { label: name + " old read promises settled", timeoutMs: 20000, intervalMs: 50 });
            } catch (error) {
                if (!(error instanceof acceptance.WaitTimeoutError)) throw error;
                return record(name, { blocked: true, evidence: { reason: "old read promises did not settle before timeout" } }, { context, before, observed, settled, oldRequestIds, oldReads: await client.evalJson(READ_PROBE_SNAPSHOT) });
            }
        } else await delay(3000);
        const after = await readRows();
        const flags = await contextEvidence(context, expectedAllIds, after);
        const verdict = acceptance.evaluateTabSwitch({
            tabBefore: before.selectedIndex,
            tabAfter: after.selectedIndex,
            targetTab: targetIndex,
            clickedFound,
            resultIds: settled.ids,
            lateResultIds: after.ids,
            expectedAllIds,
            ...flags,
            unidentified: settled.unidentified + after.unidentified
        });
        return record(name, checkSettled(verdict, [settled, after]), { context, expectedAllIds, before, observed, settled, after, oldRequestObserved, triggerMark, oldRequestIds, oldReads, oldReadSettlement, newReadSettlement: completed.newReadSettlement, lateCheckDelayMs: requireOldRequest ? null : 3000 });
    }

    async function lastPage({ name, context, hwnd }) {
        const expectedAllIds = await baseline(context);
        let before = await readRows();
        let during;
        const invalid = invalidBefore(name, before, expectedAllIds);
        if (invalid != null) return invalid;
        for (let attempt = 0; before.ids.length < expectedAllIds.length && attempt < 12; attempt++) {
            await client.evalJson(SCROLL_BOTTOM);
            const next = await settledGrowth(before.ids.length, name + " reach end");
            if (next.ids.length <= before.ids.length) { before = next; break; }
            before = next;
        }
        const invalidEnd = invalidBefore(name, before, expectedAllIds);
        if (invalidEnd != null) return invalidEnd;
        try {
            await windowOp("minimize", hwnd);
            during = await waitRows("rows.vis === 'hidden'", name + " hidden", 10000);
            await delay(2500);
        } finally {
            await windowOp("restore", hwnd);
        }
        await waitRows("rows.vis === 'visible' && !rows.loadInFlight", name + " restore", 20000);
        await client.evalJson(SCROLL_BOTTOM);
        await delay(3000);
        const after = await readRows();
        const flags = await contextEvidence(context, expectedAllIds, after);
        const verdict = acceptance.evaluateLastPage({
            displayedIds: before.ids,
            expectedAllIds,
            loadInFlight: before.loadInFlight,
            afterRestoreIds: after.ids,
            afterRestoreInFlight: after.loadInFlight,
            ...flags,
            baselineStable: flags.baselineStable && during.vis === "hidden",
            unidentified: before.unidentified + after.unidentified
        });
        return record(name, verdict, { context, expectedAllIds, before, during, after });
    }

    return { readRows, baseline, waitRows, foreground, recoveryCycle, lateRequestCycle, tabSwitch, lastPage, prepareContext, prepareFreshContext };
}

function nativeWindowOp(op, hwnd) {
    return execFileSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowScript, "-Op", op, "-Hwnd", String(hwnd)], { encoding: "utf8", windowsHide: true }).trim();
}

function nativeWindowInfo() {
    const line = execFileSync("powershell", ["-NoProfile", "-Command", "$p = Get-Process Discord | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1; Write-Output ($p.Id.ToString() + '|' + $p.MainWindowHandle.ToString())"], { encoding: "utf8", windowsHide: true }).trim();
    const [pid, hwnd] = line.split("|");
    const commandLine = execFileSync("powershell", ["-NoProfile", "-Command", `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: "utf8", windowsHide: true }).trim();
    return { pid, hwnd, commandLine };
}

async function run({ pageWs, outDir, adapters = {} }) {
    let ws;
    let client;
    let cover;
    const environment = {};
    const windowOp = adapters.windowOp ?? nativeWindowOp;
    const delay = adapters.delay ?? sleep;
    const waitFor = adapters.waitFor ?? acceptance.waitFor;
    const stopCover = async () => {
        if (cover == null || cover.exitCode != null) return;
        const child = cover;
        cover = null;
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("occlusion helper did not exit")), 5000);
            child.once("exit", () => { clearTimeout(timer); resolve(); });
            if (!child.kill()) { clearTimeout(timer); reject(new Error("occlusion helper could not be stopped")); }
        });
    };
    return acceptance.runAcceptance({
        scriptVersion: SCRIPT_VERSION,
        reportPath: path.join(outDir, "v01-report.json"),
        extra: () => ({ environment }),
        execute: async ({ results, scope }) => {
            if (adapters.client != null) client = adapters.client;
            else {
                ws = new WebSocket(pageWs);
                client = acceptance.createCdpClient(ws, { timeoutMs: 30000 });
                await new Promise((resolve, reject) => {
                    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 10000);
                    ws.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
                    ws.addEventListener("error", () => { clearTimeout(timer); reject(new Error("ws connect failed")); }, { once: true });
                });
            }
            const session = createPagingSession({ client, windowOp, delay, waitFor, results, scope });
            const info = await (adapters.windowInfo ?? nativeWindowInfo)();
            Object.assign(environment, info, await client.evalJson("({ ua: navigator.userAgent, vis: document.visibilityState, build: window.DiscordNative?.app?.getBuildNumber?.() ?? null })"));
            environment.buildIdentity = await client.evalJson("(() => { const utils = window.Vencord.Webpack.findByProps('toURLSafe'); return !!utils?.toURLSafe?.toString().includes('guardManagedBlobUrl'); })()");
            const env = acceptance.evaluateEnvironment({ commandLine: info.commandLine, forbiddenFlags: FORBIDDEN_STARTUP_FLAGS, requiredEvidence: [environment.ua, info.hwnd] });
            acceptance.recordResult(results, "环境：普通启动参数与构建标识", env.blocked ? "blocked" : env.pass ? "pass" : "fail", environment);
            if (!env.pass) return;
            if (!environment.buildIdentity) { acceptance.recordResult(results, "构建标识", "blocked", { reason: "required build marker was not observed" }); return; }
            scope.add(async () => { await stopCover(); await windowOp("restore", info.hwnd); });
            const settings = await client.evalJson(SETTINGS_EXPRESSION);
            const candidates = await client.evalJson(stableChannelExpression(settings.pageSize));
            environment.datasetCandidates = candidates.slice(0, 5);
            if (candidates.length === 0) { acceptance.recordResult(results, "稳定频道前提", "blocked", { reason: "no accessible existing channel has sufficient deleted and edited pages" }); return; }
            const chosenDataset = candidates[0];
            environment.dataset = chosenDataset;
            const context = { status: "DELETED", channel: chosenDataset.channel, query: `channel:${chosenDataset.channel}`, sortNewest: settings.sortNewest };
            let prepared;
            const closeModal = () => client.evalJson(CLOSE_MODAL);
            const openModal = query => client.evalJson(`window.Vencord.Plugins.plugins.AegisLogger.openLogModal(${JSON.stringify(query)}) ?? 1`);
            const openFresh = async () => {
                await windowOp("restore", info.hwnd);
                const visible = await session.waitRows("rows.vis === 'visible'", "initial foreground", 15000);
                if (visible.vis !== "visible") return false;
                prepared = await session.prepareFreshContext({ name: "稳定频道首屏", context, close: closeModal, open: openModal });
                return prepared.ready === true;
            };
            if (!await openFresh()) { acceptance.recordResult(results, "首屏前提", "blocked", { reason: "ordinary foreground did not become ready; no rescue intervention was used", prepared, snapshot: await session.readRows() }); return; }
            await session.foreground({ name: "前台基线：连续前缀增长，无重复或丢失", context });
            for (let round = 1; round <= 2; round++) {
                if (await openFresh()) await session.recoveryCycle({ name: `最小化恢复第 ${round} 轮`, context, enter: () => windowOp("minimize", info.hwnd), exit: () => windowOp("restore", info.hwnd) });
                else acceptance.recordResult(results, `最小化恢复第 ${round} 轮`, "blocked", { reason: "stable source context did not reopen", prepared });
            }
            if (await openFresh()) await session.lateRequestCycle({ name: "在途请求恢复后再次加载", context, reset: openFresh, hwnd: info.hwnd });
            else acceptance.recordResult(results, "在途请求恢复后再次加载", "blocked", { reason: "stable source context did not reopen", prepared });
            if (await openFresh()) await session.recoveryCycle({
                name: "完整遮挡解除后恢复", context, hiddenTimeoutMs: 25000,
                enter: async () => {
                    if (adapters.startCover != null) { cover = await adapters.startCover(info.hwnd); return; }
                    cover = spawn("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", windowScript, "-Op", "cover", "-Hwnd", String(info.hwnd)], { windowsHide: true, stdio: "ignore" });
                    await new Promise((resolve, reject) => { cover.once("spawn", resolve); cover.once("error", reject); });
                },
                exit: async () => { await stopCover(); await windowOp("restore", info.hwnd); }
            });
            else acceptance.recordResult(results, "完整遮挡解除后恢复", "blocked", { reason: "stable source context did not reopen", prepared });

            const tabs = await session.readRows();
            const targetIndex = tabs.tabTexts.findIndex(text => statusOfTab(text) === "EDITED");
            if (targetIndex < 0) acceptance.recordResult(results, "切换目标 tab", "blocked", { reason: "edited tab was not found" });
            else {
                await session.tabSwitch({ name: "普通切 tab：选中态与目标前缀", targetIndex, context: { ...context, status: "EDITED" } });
                if (await openFresh()) await session.tabSwitch({ name: "在途旧请求下切 tab：结算后仍是目标前缀", targetIndex, context: { ...context, status: "EDITED" }, requireOldRequest: true, reset: openFresh });
                else acceptance.recordResult(results, "在途旧请求下切 tab", "blocked", { reason: "source tab did not reopen" });
            }
            if (await openFresh()) {
                const reopened = await session.readRows();
                const reopenedContext = { ...context, status: statusOfTab(reopened.tabTexts?.[reopened.selectedIndex]) };
                const expectedAllIds = await session.baseline(reopenedContext);
                const verdict = acceptance.evaluateForegroundPaging({ beforeIds: [], afterIds: reopened.ids, expectedAllIds, unidentified: reopened.unidentified, baselineStable: sameIds(expectedAllIds, await session.baseline(reopenedContext)) });
                acceptance.recordResult(results, "关窗重开：首屏连续前缀", verdict.blocked ? "blocked" : verdict.pass ? "pass" : "fail", { ...verdict.evidence, reopened });
                await session.foreground({ name: "关窗重开后继续分页", context: reopenedContext });

                const lastPageCandidates = await client.evalJson(`(async () => {
                    const idb = window.Vencord.Plugins.plugins.AegisLogger.idb;
                    const counts = new Map();
                    for await (const batch of idb.iterateRawMessagesByStatusIDB(${JSON.stringify(reopenedContext.status)}, ${JSON.stringify(settings.sortNewest)})) {
                        for (const record of batch) counts.set(record.channel_id, (counts.get(record.channel_id) ?? 0) + 1);
                    }
                    return [...counts].filter(([, count]) => count > ${settings.pageSize} && count <= ${settings.pageSize * 3}).sort((a, b) => a[1] - b[1]);
                })()`);
                if (lastPageCandidates.length === 0) acceptance.recordResult(results, "末页恢复", "blocked", { reason: "no existing channel dataset between one and three pages" });
                else {
                    const channel = lastPageCandidates[0][0];
                    const channelContext = { ...reopenedContext, channel, query: `channel:${channel}` };
                    const lastPrepared = await session.prepareFreshContext({ name: "末页频道首屏", context: channelContext, close: closeModal, open: openModal });
                    if (lastPrepared.ready) await session.lastPage({ name: "末页恢复：完整序列保持不变", context: channelContext, hwnd: info.hwnd });
                    else acceptance.recordResult(results, "末页恢复", "blocked", { reason: "last-page channel context did not commit", prepared: lastPrepared });
                }
            } else acceptance.recordResult(results, "关窗重开", "blocked", { reason: "reopened modal did not settle" });
        },
        cleanup: async () => {
            try {
                if (client != null) await client.evalJson(CLOSE_MODAL);
            } finally {
                client?.dispose?.();
                ws?.close();
            }
        }
    });
}

const acceptanceV01 = { run, createPagingSession, baselineExpression, stableChannelExpression, readRowsExpression: acceptance.collectLogRowsExpression, settingsExpression: SETTINGS_EXPRESSION, scrollBottomExpression: SCROLL_BOTTOM, installReadProbeExpression: INSTALL_READ_PROBE, readProbeSnapshotExpression: READ_PROBE_SNAPSHOT, restoreReadProbeExpression: RESTORE_READ_PROBE };
export default acceptanceV01;

if (process.argv[1] != null && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    if (process.argv[2] == null || process.argv[3] == null) process.exitCode = 2;
    else {
        const report = await acceptanceV01.run({ pageWs: process.argv[2], outDir: process.argv[3] });
        process.exitCode = report.exitCode;
    }
}
