/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { relaunch } from "@utils/native";
import { Alerts } from "@webpack/common";

import { Commit, GitError, GitInfo, GitResult, UpdateState, UpdateStatus } from "../types";
import { t } from "./i18n";
import { getNative } from "./misc";

const Native = getNative();

let changes: Commit[] = [];
let isOutdated = false;
let isNewer = false;
let pendingBuild = false;
let state: UpdateState = "current";
let repoInfo: GitInfo | undefined;
let lastError: GitError | undefined;
let checkPromise: Promise<boolean> | undefined;
let updatePromise: Promise<boolean> | undefined;
let notificationTimer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;
let active = true;

function deriveUpdateState(newChanges: Commit[], _gitHash?: string) {
    return { isOutdated: newChanges.length > 0, isNewer: false };
}

function isNotGitRepoError(error: GitError) {
    return /not a git repository|plugin_repository_invalid/.test(error?.message ?? "");
}

function errorResult(cmd: string): GitError {
    return { ok: false, cmd, message: "operation_failed", error: null };
}

function applyStatus(status: UpdateStatus) {
    changes = status.changes;
    repoInfo = status.info;
    state = status.state;
    pendingBuild = status.pendingBuild;
    isNewer = state === "ahead";
    isOutdated = (state === "current" || state === "behind") && (pendingBuild || state === "behind");
    lastError = undefined;
}

async function performCheck(token: number) {
    try {
        const result: GitResult = await Native.getUpdateStatus();
        if (!active || token !== generation) return false;
        if (!result.ok) {
            lastError = result;
            isOutdated = false;
            changes = [];
            return false;
        }
        applyStatus(result.value);
        return isOutdated;
    } catch {
        if (active && token === generation) {
            lastError = errorResult("AegisLogger check");
            isOutdated = false;
            changes = [];
        }
        return false;
    }
}

async function checkForUpdates() {
    if (!active || updatePromise) return false;
    if (checkPromise) return checkPromise;
    checkPromise = performCheck(generation);
    const current = checkPromise;
    try {
        return await current;
    } finally {
        if (checkPromise === current) checkPromise = undefined;
    }
}

async function checkForUpdatesAndNotify(shouldNotify = false) {
    if (IS_WEB || !active) return;
    const token = generation;
    const outdated = await checkForUpdates();
    if (!outdated || !shouldNotify || !active || token !== generation) return;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = setTimeout(() => {
        notificationTimer = undefined;
        if (!active || token !== generation || !isOutdated) return;
        showNotification({
            title: "AegisLogger",
            body: pendingBuild ? t("updater.pendingBuild") : t("updater.notificationBody"),
            onClick: () => { if (active && token === generation) void update(); }
        });
    }, 15000);
}

async function performUpdate(token: number) {
    try {
        const result: GitResult = await Native.update();
        if (!active || token !== generation) return false;
        if (!result.ok) {
            lastError = result;
            await performCheck(token);
            if (!active || token !== generation) return false;
            lastError = result;
            Alerts.show({
                title: t("updater.failedTitle"),
                body: isNotGitRepoError(result) ? t("updater.notGitRepo") : `${t("updater.updateFailed")}: ${result.message}`
            });
            return false;
        }
        applyStatus(result.value);
        changes = [];
        isOutdated = false;
        pendingBuild = false;
        if (notificationTimer) clearTimeout(notificationTimer);
        notificationTimer = undefined;
        Alerts.show({
            title: t("updater.successTitle"),
            body: t("updater.restartBody"),
            confirmText: t("updater.restartNow"),
            cancelText: t("updater.later"),
            onConfirm: () => { if (active && token === generation) relaunch(); }
        });
        return true;
    } catch {
        if (active && token === generation) {
            lastError = errorResult("AegisLogger update");
            Alerts.show({ title: t("updater.failedTitle"), body: t("updater.updateFailed") });
        }
        return false;
    }
}

async function update() {
    if (!active || updatePromise) return false;
    const token = generation;
    if (checkPromise) await checkPromise;
    if (!active || token !== generation || updatePromise) return false;
    updatePromise = performUpdate(token);
    const current = updatePromise;
    try {
        return await current;
    } finally {
        if (updatePromise === current) updatePromise = undefined;
    }
}

function start() {
    active = true;
    generation++;
}

function stop() {
    active = false;
    generation++;
    if (notificationTimer) clearTimeout(notificationTimer);
    notificationTimer = undefined;
    checkPromise = undefined;
    updatePromise = undefined;
    changes = [];
    isOutdated = false;
    pendingBuild = false;
    isNewer = false;
    repoInfo = undefined;
    lastError = undefined;
    state = "current";
}

const updater = {
    get changes() { return changes; },
    get isOutdated() { return isOutdated; },
    get isNewer() { return isNewer; },
    get pendingBuild() { return pendingBuild; },
    get state() { return state; },
    get repoInfo() { return repoInfo; },
    get lastError() { return lastError; },
    deriveUpdateState,
    isNotGitRepoError,
    checkForUpdates,
    checkForUpdatesAndNotify,
    update,
    start,
    stop
};

export default updater;
