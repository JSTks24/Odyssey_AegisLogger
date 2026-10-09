/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitResult, UpdateStatus } from "../types";

const { mockNative } = vi.hoisted(() => ({
    mockNative: {
        getUpdateStatus: vi.fn<() => Promise<GitResult>>(),
        update: vi.fn<() => Promise<GitResult>>()
    }
}));

vi.mock("../utils/misc", () => ({ getNative: () => mockNative }));
vi.mock("../settings", () => ({ settings: { store: { language: "en" } } }));
vi.mock("@api/Notifications", () => ({ showNotification: vi.fn() }));
vi.mock("@utils/native", () => ({ relaunch: vi.fn() }));

import { showNotification } from "@api/Notifications";
import { Alerts } from "@webpack/common";

import { parseGitLog } from "../native/updater";
import updater from "../utils/updater";

const commit = (hash: string) => ({ hash, author: "author", message: "change" });
const status = (patch: Partial<UpdateStatus> = {}): UpdateStatus => ({
    info: { repo: "https://example.test/plugin", branch: "main", gitHash: "h1", installedHash: "h1" },
    changes: [commit("h2")],
    state: "behind",
    pendingBuild: false,
    ...patch
});
const failure = () => ({ ok: false, cmd: "AegisLogger check", message: "network_failed", error: null } as const);

beforeEach(() => {
    updater.stop();
    updater.start();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockNative.getUpdateStatus.mockResolvedValue({ ok: true, value: status() });
    mockNative.update.mockResolvedValue({ ok: true, value: status({ changes: [], state: "current" }) });
});

describe("parseGitLog", () => {
    it("preserves semicolons in subjects and ignores malformed rows", () => {
        expect(parseGitLog("\ninvalid\nabc;Alice;fix; more\n")).toEqual([
            { hash: "abc", author: "Alice", message: "fix; more" }
        ]);
    });
});

describe("update status", () => {
    it("checks the shared installer once and exposes installed information", async () => {
        expect(await updater.checkForUpdates()).toBe(true);
        expect(mockNative.getUpdateStatus).toHaveBeenCalledOnce();
        expect(updater.repoInfo?.installedHash).toBe("h1");
        expect(updater.changes).toEqual([commit("h2")]);
    });

    it("offers a build retry even with no new commits", async () => {
        mockNative.getUpdateStatus.mockResolvedValue({ ok: true, value: status({ state: "current", changes: [], pendingBuild: true }) });
        expect(await updater.checkForUpdates()).toBe(true);
        expect(updater.pendingBuild).toBe(true);
    });

    it.each(["ahead", "diverged", "detached", "missing_upstream", "dirty"] as const)("does not offer unsafe update in %s state", async state => {
        mockNative.getUpdateStatus.mockResolvedValue({ ok: true, value: status({ state }) });
        expect(await updater.checkForUpdates()).toBe(false);
        expect(updater.state).toBe(state);
        expect(updater.isNewer).toBe(state === "ahead");
    });

    it("clears a previous update offer after failed checking", async () => {
        await updater.checkForUpdates();
        mockNative.getUpdateStatus.mockResolvedValue(failure());
        expect(await updater.checkForUpdates()).toBe(false);
        expect(updater.isOutdated).toBe(false);
        expect(updater.changes).toEqual([]);
        expect(updater.lastError?.message).toBe("network_failed");
    });

    it("coalesces concurrent checks", async () => {
        const pending = Promise.withResolvers<GitResult>();
        mockNative.getUpdateStatus.mockReturnValue(pending.promise);
        const first = updater.checkForUpdates();
        const second = updater.checkForUpdates();
        pending.resolve({ ok: true, value: status() });
        await Promise.all([first, second]);
        expect(mockNative.getUpdateStatus).toHaveBeenCalledOnce();
    });

    it("handles rejected native checks", async () => {
        mockNative.getUpdateStatus.mockRejectedValue(new Error("offline"));
        expect(await updater.checkForUpdates()).toBe(false);
        expect(updater.lastError?.message).toBe("operation_failed");
    });
});

describe("update completion and lifecycle", () => {
    it("uses the shared transaction without invoking the host rebuild IPC", async () => {
        const rebuild = vi.fn();
        vi.stubGlobal("VencordNative", { updater: { rebuild } });
        expect(await updater.update()).toBe(true);
        expect(rebuild).not.toHaveBeenCalled();
        expect(Alerts.show).toHaveBeenCalledWith(expect.objectContaining({ title: "Update Success!" }));
    });

    it("refreshes pending build state after failure and keeps recovery feedback", async () => {
        mockNative.update.mockResolvedValue(failure());
        mockNative.getUpdateStatus.mockResolvedValue({ ok: true, value: status({ state: "current", changes: [], pendingBuild: true }) });
        expect(await updater.update()).toBe(false);
        expect(updater.pendingBuild).toBe(true);
        expect(updater.isOutdated).toBe(true);
        expect(updater.lastError?.message).toBe("network_failed");
    });

    it("rejects duplicate update requests", async () => {
        const pending = Promise.withResolvers<GitResult>();
        mockNative.update.mockReturnValue(pending.promise);
        const first = updater.update();
        expect(await updater.update()).toBe(false);
        pending.resolve({ ok: true, value: status({ state: "current" }) });
        await first;
        expect(mockNative.update).toHaveBeenCalledOnce();
    });

    it("drops late results after stopping", async () => {
        const pending = Promise.withResolvers<GitResult>();
        mockNative.getUpdateStatus.mockReturnValue(pending.promise);
        const check = updater.checkForUpdates();
        updater.stop();
        pending.resolve({ ok: true, value: status() });
        expect(await check).toBe(false);
        expect(updater.isOutdated).toBe(false);
    });

    it("does not revive an update waiting for a retired check after restarting", async () => {
        const pending = Promise.withResolvers<GitResult>();
        mockNative.getUpdateStatus.mockReturnValue(pending.promise);
        const check = updater.checkForUpdates();
        const update = updater.update();
        updater.stop();
        updater.start();
        pending.resolve({ ok: true, value: status() });
        await check;
        expect(await update).toBe(false);
        expect(mockNative.update).not.toHaveBeenCalled();
    });

    it("cancels delayed notifications and stale notification clicks", async () => {
        vi.stubGlobal("IS_WEB", false);
        vi.useFakeTimers();
        try {
            await updater.checkForUpdatesAndNotify(true);
            updater.stop();
            vi.advanceTimersByTime(15000);
            expect(showNotification).not.toHaveBeenCalled();
            updater.start();
            await updater.checkForUpdatesAndNotify(true);
            vi.advanceTimersByTime(15000);
            const notification = vi.mocked(showNotification).mock.calls[0][0];
            updater.stop();
            notification.onClick?.();
            expect(mockNative.update).not.toHaveBeenCalled();
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not check on web", async () => {
        vi.stubGlobal("IS_WEB", true);
        await updater.checkForUpdatesAndNotify(true);
        expect(mockNative.getUpdateStatus).not.toHaveBeenCalled();
    });
});
