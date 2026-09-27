/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type { GitError, GitResult } from "../types";

type MockNative = {
    getRepoInfo: () => Promise<GitResult>;
    getNewCommits: () => Promise<GitResult>;
    update: () => Promise<GitResult>;
};

const { mockNative } = vi.hoisted(() => ({
    mockNative: {
        getRepoInfo: async () => ({ ok: true, value: { repo: "", branch: "", gitHash: "" } }),
        getNewCommits: async () => ({ ok: true, value: [] }),
        update: async () => ({ ok: true, value: "" })
    } as MockNative
}));

vi.mock("../utils/misc", () => ({ getNative: () => mockNative }));
vi.mock("../settings", () => ({ settings: { store: { language: "en" } } }));
vi.mock("@api/Notifications", () => ({ showNotification: vi.fn() }));
vi.mock("@utils/native", () => ({ relaunch: vi.fn() }));

import { showNotification } from "@api/Notifications";

import { parseGitLog } from "../native/updater";
import updater from "../utils/updater";

const commit = (hash: string) => ({ hash, author: "JST", message: "msg" });

beforeEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    mockNative.getRepoInfo = async () => ({ ok: true, value: { repo: "https://github.com/JSTks24/Odyssey_AegisLogger", branch: "main", gitHash: "h1" } });
    mockNative.getNewCommits = async () => ({ ok: true, value: [commit("h2")] });
    mockNative.update = async () => ({ ok: true, value: "" });
});

describe("parseGitLog", () => {
    it("parses hash, author and message per line", () => {
        const commits = parseGitLog("abc123;JST;Fix thing\ndef456;Alice;Add feature; with semicolon");

        expect(commits).toEqual([
            { hash: "abc123", author: "JST", message: "Fix thing" },
            { hash: "def456", author: "Alice", message: "Add feature; with semicolon" }
        ]);
    });

    it("returns an empty list for empty output", () => {
        expect(parseGitLog("")).toEqual([]);
    });

    it("drops blank and malformed lines", () => {
        expect(parseGitLog("\n   \ngarbage\nh2;JST;ok")).toEqual([
            { hash: "h2", author: "JST", message: "ok" }
        ]);
    });
});

describe("deriveUpdateState", () => {
    it("is up to date when there are no new commits", () => {
        expect(updater.deriveUpdateState([], "h1")).toEqual({ isOutdated: false, isNewer: false });
    });

    it("is outdated when the local hash is not among the new commits", () => {
        expect(updater.deriveUpdateState([commit("h2"), commit("h3")], "h1")).toEqual({ isOutdated: true, isNewer: false });
    });

    it("treats the local hash inside the list as locally newer", () => {
        expect(updater.deriveUpdateState([commit("h2"), commit("h1")], "h1")).toEqual({ isOutdated: false, isNewer: true });
    });

    it("works without repo info", () => {
        expect(updater.deriveUpdateState([commit("h2")], undefined)).toEqual({ isOutdated: true, isNewer: false });
    });
});

describe("isNotGitRepoError", () => {
    const error = (message: string): GitError => ({ ok: false, cmd: "git pull", message, error: null });

    it("detects git's not-a-repository stderr", () => {
        expect(updater.isNotGitRepoError(error("fatal: not a git repository (or any of the parent directories): .git"))).toBe(true);
    });

    it("detects the native pre-check marker", () => {
        expect(updater.isNotGitRepoError(error("not a git repository"))).toBe(true);
    });

    it("rejects unrelated errors", () => {
        expect(updater.isNotGitRepoError(error("Could not resolve host"))).toBe(false);
    });
});

describe("checkForUpdates", () => {
    it("marks outdated and stores the new commits", async () => {
        await updater.checkForUpdates();

        expect(updater.isOutdated).toBe(true);
        expect(updater.changes).toEqual([commit("h2")]);
        expect(updater.lastError).toBeUndefined();
    });

    it("keeps lastError when the native check fails", async () => {
        mockNative.getNewCommits = async () => ({ ok: false, cmd: "git fetch", message: "Could not resolve host", error: null });

        await updater.checkForUpdates();

        expect(updater.lastError?.cmd).toBe("git fetch");
    });
});

describe("checkForUpdatesAndNotify", () => {
    it("does nothing on web", async () => {
        vi.stubGlobal("IS_WEB", true);
        const getNewCommits = vi.fn();
        mockNative.getNewCommits = getNewCommits;

        await updater.checkForUpdatesAndNotify(true);

        expect(getNewCommits).not.toHaveBeenCalled();
    });

    it("notifies after the delay when updates are available", async () => {
        vi.stubGlobal("IS_WEB", false);
        vi.useFakeTimers();
        try {
            await updater.checkForUpdatesAndNotify(true);
            vi.advanceTimersByTime(15_000);

            expect(showNotification).toHaveBeenCalledOnce();
            expect(showNotification).toHaveBeenCalledWith(expect.objectContaining({ title: "AegisLogger" }));
        } finally {
            vi.useRealTimers();
        }
    });

    it("does not notify when up to date", async () => {
        vi.stubGlobal("IS_WEB", false);
        mockNative.getNewCommits = async () => ({ ok: true, value: [] });

        await updater.checkForUpdatesAndNotify(true);

        expect(showNotification).not.toHaveBeenCalled();
    });
});
