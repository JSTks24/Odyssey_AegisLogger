/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { showNotification } from "@api/Notifications";
import { relaunch } from "@utils/native";
import { Alerts } from "@webpack/common";

import { Commit, GitError, GitInfo } from "../types";
import { t } from "./i18n";
import { getNative } from "./misc";

const Native = getNative();

let changes: Commit[] = [];
let isOutdated = false;
let isNewer = false;
let repoInfo: GitInfo | undefined;
let lastError: GitError | undefined;

function deriveUpdateState(newChanges: Commit[], gitHash?: string) {
    if (newChanges.length === 0) return { isOutdated: false, isNewer: false };

    if (gitHash != null && newChanges.some(change => change.hash === gitHash))
        return { isOutdated: false, isNewer: true };

    return { isOutdated: true, isNewer: false };
}

function isNotGitRepoError(error: GitError) {
    return error?.message?.includes("not a git repository") === true;
}

async function checkForUpdates() {
    lastError = undefined;

    const info = await Native.getRepoInfo();
    if (info.ok) repoInfo = info.value;

    const result = await Native.getNewCommits();
    if (!result.ok) {
        lastError = result;
        return false;
    }

    changes = result.value;
    const state = deriveUpdateState(changes, repoInfo?.gitHash);
    isOutdated = state.isOutdated;
    isNewer = state.isNewer;
    return isOutdated;
}

async function checkForUpdatesAndNotify(shouldNotify = false) {
    if (IS_WEB) return;

    const outdated = await checkForUpdates();
    if (!outdated || !shouldNotify) return;

    setTimeout(() => {
        showNotification({
            title: "AegisLogger",
            body: t("updater.notificationBody"),
            onClick: () => update()
        });
    }, 15_000);
}

async function update() {
    const result = await Native.update();
    if (!result.ok) {
        Alerts.show({
            title: t("updater.failedTitle"),
            body: isNotGitRepoError(result)
                ? t("updater.notGitRepo")
                : `${t("updater.pullFailed")}: ${result.cmd}\n${result.message}`
        });
        return;
    }

    const build = await VencordNative.updater.rebuild();
    if (!build.ok) {
        Alerts.show({
            title: t("updater.failedTitle"),
            body: t("updater.buildFailed")
        });
        return;
    }

    changes = [];
    isOutdated = false;

    Alerts.show({
        title: t("updater.successTitle"),
        body: t("updater.restartBody"),
        confirmText: t("updater.restartNow"),
        cancelText: t("updater.later"),
        onConfirm: () => relaunch()
    });
}

const updater = {
    get changes() { return changes; },
    get isOutdated() { return isOutdated; },
    get isNewer() { return isNewer; },
    get repoInfo() { return repoInfo; },
    get lastError() { return lastError; },
    deriveUpdateState,
    isNotGitRepoError,
    checkForUpdates,
    checkForUpdatesAndNotify,
    update,
};

export default updater;
