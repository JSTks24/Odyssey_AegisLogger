/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import path from "node:path";

export const ACCEPTANCE_LIB_VERSION = "acceptance-lib/5 2026-09-30";

export class WaitTimeoutError extends Error {
    constructor(label, lastValue) {
        super(`waitFor timed out: ${label}`);
        this.name = "WaitTimeoutError";
        this.label = label;
        this.lastValue = lastValue;
    }
}

export function createCleanupScope() {
    const fns = [];
    const errors = [];
    return {
        add(fn) {
            if (typeof fn === "function") fns.push(fn);
        },
        async run() {
            while (fns.length > 0) {
                try {
                    await fns.pop()();
                } catch (error) {
                    errors.push(String(error));
                }
            }
            return [...errors];
        },
        size() {
            return fns.length;
        }
    };
}

export function createCdpClient(ws, { timeoutMs = 30000 } = {}) {
    let msgId = 0;
    let disconnected = false;
    const pending = new Map();
    const cancelPending = reason => {
        disconnected = true;
        for (const request of pending.values()) {
            clearTimeout(request.timer);
            request.reject(new Error(reason));
        }
        pending.clear();
    };
    const onMessage = ev => {
        let msg;
        try {
            msg = JSON.parse(String(ev.data));
        } catch {
            cancelPending("invalid CDP response");
            return;
        }
        if (msg == null || typeof msg !== "object") {
            cancelPending("invalid CDP response");
            return;
        }
        const request = pending.get(msg.id);
        if (request == null) return;
        pending.delete(msg.id);
        clearTimeout(request.timer);
        if (msg.error) request.reject(new Error(JSON.stringify(msg.error)));
        else request.resolve(msg.result);
    };
    const onClose = () => cancelPending("CDP connection closed");
    const onError = () => cancelPending("CDP connection failed");
    ws.addEventListener("message", onMessage);
    ws.addEventListener("close", onClose);
    ws.addEventListener("error", onError);
    const send = (method, params = {}) => new Promise((resolve, reject) => {
        if (disconnected) {
            reject(new Error("CDP connection closed"));
            return;
        }
        const id = ++msgId;
        const timer = setTimeout(() => {
            pending.delete(id);
            reject(new Error(`cdp timeout: ${method}`));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        try {
            ws.send(JSON.stringify({ id, method, params }));
        } catch (error) {
            clearTimeout(timer);
            pending.delete(id);
            reject(error);
        }
    });
    const evalJson = async expression => {
        const result = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
        if (result?.exceptionDetails) throw new Error("page eval failed: " + JSON.stringify(result.exceptionDetails));
        return result?.result?.value;
    };
    return {
        send, evalJson, timeoutMs,
        dispose() {
            cancelPending("CDP client disposed");
            ws.removeEventListener("message", onMessage);
            ws.removeEventListener("close", onClose);
            ws.removeEventListener("error", onError);
        },
        pendingCount() {
            return pending.size;
        }
    };
}

export async function waitFor(client, expression, { label = expression.slice(0, 60), timeoutMs = 15000, intervalMs = 300 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastValue = null;
    while (Date.now() < deadline) {
        lastValue = await client.evalJson(expression);
        if (lastValue) return lastValue;
        await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new WaitTimeoutError(label, lastValue);
}

const collectLogRowsExpression = `(() => {
    const elements = [...document.querySelectorAll('.aegis-modal-msg-context')];
    const ids = [];
    let unidentified = 0;
    for (const el of elements) {
        const key = Object.keys(el).find(k => k.startsWith('__reactFiber$'));
        let fiber = key == null ? null : el[key];
        let id = null;
        for (let depth = 0; depth < 14 && fiber; depth++, fiber = fiber.return) {
            const message = fiber.memoizedProps?.message;
            const candidate = message?.message_id ?? message?.id;
            if (typeof candidate === 'string') { id = candidate; break; }
        }
        if (id == null) unidentified++;
        else ids.push(id);
    }
    const input = document.querySelector('.aegis-modal-header input');
    const inputValue = input?.value ?? null;
    let query = inputValue;
    let querySource = input == null ? 'missing' : 'input';
    const inputKey = input == null ? null : Object.keys(input).find(key => key.startsWith('__reactFiber$'));
    let queryFiber = inputKey == null ? null : input[inputKey];
    let rootFiber = queryFiber;
    while (rootFiber?.return) rootFiber = rootFiber.return;
    if (rootFiber?.stateNode?.current != null && rootFiber.stateNode.current !== rootFiber && queryFiber?.alternate != null) queryFiber = queryFiber.alternate;
    for (let depth = 0; depth < 32 && queryFiber; depth++, queryFiber = queryFiber.return) {
        if (typeof queryFiber.memoizedProps?.query === 'string') {
            query = queryFiber.memoizedProps.query;
            querySource = 'react-props';
            break;
        }
    }
    const tabs = [...document.querySelectorAll('.aegis-modal-tab-bar-item')];
    return {
        ids, rowCount: elements.length, unidentified,
        query, querySource, inputValue,
        selectedIndex: tabs.findIndex(el => /selected/i.test(String(el.className))),
        tabTexts: tabs.map(el => el.textContent),
        loadInFlight: !!(document.querySelector('.aegis-modal-load-more-text') || document.querySelector('.aegis-modal-loading-state') || document.querySelector('.aegis-modal-search-status')),
        modalOpen: input != null, vis: document.visibilityState
    };
})()`;

export function identityDiff(previousIds, nextIds) {
    const previous = new Set(previousIds);
    const next = new Set(nextIds);
    return {
        added: [...next].filter(id => !previous.has(id)),
        removed: [...previous].filter(id => !next.has(id)),
        duplicates: nextIds.length - next.size
    };
}

function checkPrefix(ids, expected) {
    const duplicates = ids.length - new Set(ids).size;
    const mismatches = ids.filter((id, index) => id !== expected[index]).length;
    return { pass: duplicates === 0 && mismatches === 0 && ids.length <= expected.length, duplicates, mismatches };
}

function expectedSequence(options) {
    return options.expectedAllIds ?? [...(options.beforeIds ?? []), ...(options.expectedNextIds ?? [])];
}

export function evaluateForegroundPaging(options) {
    const { beforeIds, afterIds, baselineStable = true, unidentified = 0, intervention = false } = options;
    const expected = expectedSequence(options);
    const before = checkPrefix(beforeIds, expected);
    const after = checkPrefix(afterIds, expected);
    const diff = identityDiff(beforeIds, afterIds);
    const blocked = !baselineStable || intervention;
    return {
        pass: !blocked && unidentified === 0 && before.pass && after.pass && diff.removed.length === 0 && afterIds.length > beforeIds.length,
        blocked,
        evidence: {
            beforeCount: beforeIds.length, afterCount: afterIds.length, expectedCount: expected.length,
            expectedHits: diff.added.filter(id => expected.includes(id)).length,
            added: diff.added.length, removed: diff.removed.length, duplicates: after.duplicates,
            mismatches: after.mismatches, unidentified, baselineStable, intervention
        }
    };
}

export function evaluateRecovery(options) {
    const { beforeIds, autoIds, duringVis, afterVis, modalOpenAfter, occlusionExpected,
        baselineStable = true, unidentified = 0, intervention = false } = options;
    const finalIds = options.scrolledIds ?? autoIds;
    const expected = expectedSequence(options);
    const before = checkPrefix(beforeIds, expected);
    const auto = checkPrefix(autoIds, expected);
    const final = checkPrefix(finalIds, expected);
    const diff = identityDiff(beforeIds, finalIds);
    const autoDiff = identityDiff(autoIds, finalIds);
    const blocked = !baselineStable || intervention || (occlusionExpected && duringVis !== "hidden");
    return {
        pass: !blocked && unidentified === 0 && before.pass && auto.pass && final.pass && afterVis === "visible"
            && modalOpenAfter && diff.removed.length === 0 && autoDiff.removed.length === 0 && finalIds.length > beforeIds.length,
        blocked,
        evidence: {
            beforeCount: beforeIds.length, expectedNext: Math.max(0, expected.length - beforeIds.length),
            duringVis, afterVis, modalOpenAfter, autoNew: identityDiff(beforeIds, autoIds).added.length,
            scrolledNew: diff.added.length, expectedHits: diff.added.filter(id => expected.includes(id)).length,
            duplicates: final.duplicates, mismatches: final.mismatches, removed: diff.removed.length,
            autoRemoved: autoDiff.removed.length, unidentified, baselineStable, intervention
        }
    };
}

export function evaluateLateRequestRecovery(options) {
    const { beforeIds, firstGrowthIds, secondGrowthIds, afterVis, firstRequestObserved = false,
        baselineStable = true, unidentified = 0, intervention = false } = options;
    const expected = expectedSequence(options);
    const before = checkPrefix(beforeIds, expected);
    const first = checkPrefix(firstGrowthIds, expected);
    const second = checkPrefix(secondGrowthIds, expected);
    const firstDiff = identityDiff(beforeIds, firstGrowthIds);
    const secondDiff = identityDiff(firstGrowthIds, secondGrowthIds);
    const blocked = !firstRequestObserved || !baselineStable || intervention;
    return {
        pass: !blocked && unidentified === 0 && afterVis === "visible" && before.pass && first.pass && second.pass
            && firstDiff.added.length > 0 && firstDiff.removed.length === 0 && secondDiff.added.length > 0 && secondDiff.removed.length === 0,
        blocked,
        evidence: {
            beforeCount: beforeIds.length, firstCount: firstGrowthIds.length, secondCount: secondGrowthIds.length,
            firstGrowthHits: firstDiff.added.length, secondGrowthHits: secondDiff.added.length,
            secondRemoved: secondDiff.removed.length, duplicates: second.duplicates, mismatches: second.mismatches,
            afterVis, firstRequestObserved, unidentified, baselineStable, intervention
        }
    };
}

export function evaluateTabSwitch(options) {
    const { tabBefore, tabAfter, clickedFound, resultIds, baselineStable = true, unidentified = 0, intervention = false } = options;
    const expected = options.expectedAllIds ?? options.expectedIdSet;
    const result = checkPrefix(resultIds, expected);
    const lateIds = options.lateResultIds ?? resultIds;
    const late = checkPrefix(lateIds, expected);
    const blocked = !baselineStable || intervention || expected.length === 0;
    return {
        pass: !blocked && unidentified === 0 && clickedFound && tabAfter !== tabBefore
            && (options.targetTab == null || tabAfter === options.targetTab) && resultIds.length > 0 && result.pass && late.pass
            && identityDiff(resultIds, lateIds).removed.length === 0,
        blocked,
        evidence: { tabBefore, tabAfter, clickedFound, resultCount: resultIds.length, foreign: result.mismatches,
            duplicates: result.duplicates + late.duplicates, lateMismatches: late.mismatches, unidentified, baselineStable, intervention }
    };
}

export function evaluateLastPage(options) {
    const { displayedIds, expectedAllIds, loadInFlight, afterRestoreIds, afterRestoreInFlight,
        baselineStable = true, unidentified = 0, intervention = false } = options;
    const before = checkPrefix(displayedIds, expectedAllIds);
    const after = checkPrefix(afterRestoreIds, expectedAllIds);
    const reached = before.pass && displayedIds.length === expectedAllIds.length && !loadInFlight;
    const diff = identityDiff(displayedIds, afterRestoreIds);
    const blocked = !baselineStable || intervention || (!reached && before.pass && unidentified === 0);
    return {
        pass: reached && !blocked && unidentified === 0 && after.pass && afterRestoreIds.length === expectedAllIds.length
            && !afterRestoreInFlight && diff.added.length === 0 && diff.removed.length === 0,
        blocked,
        evidence: { displayed: displayedIds.length, expected: expectedAllIds.length,
            missing: expectedAllIds.filter(id => !displayedIds.includes(id)).length, foreign: before.mismatches,
            loadInFlight, afterRestoreAdded: diff.added.length, afterRestoreRemoved: diff.removed.length,
            afterRestoreInFlight, duplicates: before.duplicates + after.duplicates, unidentified, baselineStable, intervention }
    };
}

export function evaluateEnvironment({ commandLine, forbiddenFlags, requiredEvidence }) {
    const recorded = typeof commandLine === "string" && commandLine.length > 0;
    const flagged = recorded ? forbiddenFlags.filter(flag => commandLine.includes(flag)) : forbiddenFlags;
    const evidenceComplete = requiredEvidence.every(item => item != null && item !== "");
    return {
        pass: recorded && flagged.length === 0 && evidenceComplete,
        blocked: !recorded,
        evidence: { recorded, forbiddenHits: flagged, evidenceComplete, commandLine: recorded ? commandLine : null }
    };
}

function blobBase(url) {
    if (typeof url !== "string" || !url.startsWith("blob:")) return null;
    return url.split(/[?#]/, 1)[0];
}

function isVerifiedMediaObservation(event) {
    const proof = event.nonBlockingEvidence;
    const shown = proof?.targetLoadedElement;
    const sourceRecorded = proof?.initiator != null && event.provenance != null
        && JSON.stringify(proof.initiator) === JSON.stringify(event.provenance)
        && (typeof proof.initiator.url === "string" || proof.initiator.stack?.callFrames?.length > 0);
    return proof?.preloadConfirmed === true && proof?.notTargetComponent === true
        && proof?.targetLoaded === true && typeof proof.source === "string" && proof.source.length > 0
        && event.requestId != null && proof.requestId === event.requestId && sourceRecorded
        && shown?.loaded === true && shown.base === event.base
        && [shown.elementId, shown.messageId, shown.view, shown.kind].every(value => typeof value === "string" && value.length > 0);
}

export function createResourceLedger() {
    const events = [];
    return {
        addEvent(event) {
            const url = String(event.url ?? "");
            const managedBase = event.managedBase ?? (event.ownership === "managed" ? blobBase(url) : null);
            const ownership = managedBase != null ? "managed" : event.ownership ?? (blobBase(url) != null ? "unknown" : "unmanaged");
            const stored = {
                ...event, channel: String(event.channel ?? "unknown"), url,
                ts: event.ts ?? Date.now(), scenarioId: event.scenarioId ?? event.scenario ?? "unattributed",
                scenario: event.scenarioId ?? event.scenario ?? "unattributed", managedBase,
                base: managedBase ?? blobBase(url), ownership,
                ownershipBasis: event.ownershipBasis ?? (managedBase != null ? "recorded-resource-identity" : "not-established"),
                requestId: event.requestId ?? null, elementId: event.elementId ?? null,
                messageId: event.messageId ?? null, kind: event.kind ?? null
            };
            events.push(stored);
            return stored;
        },
        events() {
            return events.map(event => ({ ...event }));
        },
        summary({ scenarioId, scenarioBoundaries = {} } = {}) {
            const managedFailures = [];
            const unknownFailures = [];
            const otherFailures = [];
            const observations = [];
            const seen = new Set();
            for (let index = 0; index < events.length; index++) {
                const event = { ...events[index] };
                if (event.scenarioId === "unattributed") {
                    for (const [name, boundary] of Object.entries(scenarioBoundaries)) {
                        if (index >= boundary.from && index < boundary.to) event.scenarioId = name;
                    }
                    event.scenario = event.scenarioId;
                }
                if (scenarioId != null && event.scenarioId !== scenarioId) continue;
                if (isVerifiedMediaObservation(event)) {
                    observations.push(event);
                    continue;
                }
                const key = JSON.stringify([event.scenarioId, event.base, event.url, event.elementId, event.messageId, event.kind, event.requestId]);
                if (seen.has(key)) continue;
                seen.add(key);
                if (event.ownership === "managed") managedFailures.push(event);
                else if (event.ownership === "unknown") unknownFailures.push(event);
                else otherFailures.push(event);
            }
            return { managedFailures, unknownFailures, otherFailures, observations, total: events.length };
        }
    };
}

function sameTarget(target, item) {
    if (target.base !== (item.base ?? item.managedBase)) return false;
    return ["scenarioId", "messageId", "kind", "elementId", "view"].every(key => target[key] == null || item[key] === target[key]);
}

function failureTouches(target, failure) {
    if (target.base !== (failure.managedBase ?? failure.base)) return false;
    return ["scenarioId", "messageId", "kind", "elementId", "view"].every(key => failure[key] == null || target[key] == null || failure[key] === target[key]);
}

export function evaluateMediaTargets({ targets, observed, ledgerSummary }) {
    const failures = ledgerSummary.managedFailures ?? [];
    const unknown = ledgerSummary.unknownFailures ?? [];
    const details = targets.map(target => {
        const matches = observed.filter(item => sameTarget(target, item));
        return { ...target, present: matches.length > 0,
            loaded: matches.length > 0 && matches.every(item => item.loaded === true),
            error: failures.some(failure => failureTouches(target, failure)) };
    });
    const missing = details.filter(item => !item.present).length;
    const unloaded = details.filter(item => item.present && !item.loaded).length;
    const errored = details.filter(item => item.error).length;
    const unknownCount = unknown.filter(event => targets.length === 0 || targets.some(target => target.scenarioId == null || event.scenarioId === target.scenarioId)).length;
    const failed = missing > 0 || unloaded > 0 || errored > 0;
    return {
        pass: targets.length > 0 && !failed && unknownCount === 0,
        blocked: !failed && (targets.length === 0 || unknownCount > 0),
        evidence: { expected: targets.length, missing, unloaded, errored, unknown: unknownCount,
            targets: details, details: details.map(item => `${item.kind}:${item.present ? (item.loaded ? "loaded" : "unloaded") : "absent"}${item.error ? ":error" : ""}`) }
    };
}

export function computeExitCode(results, fatal) {
    if (fatal != null || !Array.isArray(results) || results.length === 0) return 1;
    if (results.some(result => result.status === "fail")) return 1;
    if (results.some(result => result.status === "blocked")) return 2;
    return results.every(result => result.status === "pass") ? 0 : 1;
}

export function buildAcceptanceReport({ scriptVersion, libVersion, startedAt, results, fatal, cleanupErrors = [], extra = {} }) {
    return {
        ...extra, scriptVersion, libVersion, startedAt, finishedAt: new Date().toISOString(), results, cleanupErrors,
        fatal: fatal != null ? String(fatal) : null,
        exitCode: cleanupErrors.length > 0 ? 1 : computeExitCode(results, fatal),
        writeError: null
    };
}

export function finishAcceptance({ reportPath, report }) {
    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    return report.exitCode;
}

export function recordResult(results, name, status, detail) {
    results.push({ name, status, detail: detail ?? null });
    const mark = status === "pass" ? "PASS" : status === "fail" ? "FAIL" : status === "blocked" ? "BLOCKED" : "SKIP";
    console.log(`${mark} | ${name}${detail != null ? ` | ${JSON.stringify(detail).slice(0, 260)}` : ""}`);
}

async function runAcceptance({ scriptVersion, reportPath, execute, cleanup, extra = () => ({}) }) {
    const scope = createCleanupScope();
    const results = [];
    const startedAt = new Date().toISOString();
    let fatal = null;
    let additional = {};
    try {
        await execute({ results, scope });
    } catch (error) {
        fatal = error;
        recordResult(results, "执行异常", "fail", { message: String(error), lastValue: error?.lastValue ?? null });
    }
    const cleanupErrors = await scope.run();
    if (cleanup != null) {
        try {
            await cleanup();
        } catch (error) {
            cleanupErrors.push(String(error));
        }
    }
    try {
        additional = typeof extra === "function" ? await extra() : extra;
    } catch (error) {
        fatal ??= error;
        recordResult(results, "报告证据结算失败", "fail", { message: String(error) });
    }
    const report = buildAcceptanceReport({ scriptVersion, libVersion: ACCEPTANCE_LIB_VERSION, startedAt, results, fatal, cleanupErrors, extra: additional });
    try {
        finishAcceptance({ reportPath, report });
    } catch (error) {
        report.exitCode = 1;
        report.writeError = String(error);
    }
    return report;
}

export default {
    ACCEPTANCE_LIB_VERSION, WaitTimeoutError, createCleanupScope, createCdpClient, waitFor, collectLogRowsExpression,
    identityDiff, checkPrefix, blobBase, evaluateForegroundPaging, evaluateRecovery, evaluateLateRequestRecovery,
    evaluateTabSwitch, evaluateLastPage, evaluateEnvironment, createResourceLedger, evaluateMediaTargets, isVerifiedMediaObservation,
    computeExitCode, buildAcceptanceReport, finishAcceptance, recordResult, runAcceptance
};
