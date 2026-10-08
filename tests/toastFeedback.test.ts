/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/web", () => ({ chooseFile: vi.fn(async () => null) }));
vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    settings: { store: { messageLimit: 1000, saveImages: false, exclusionRules: "", logsDir: "", imageCacheDir: "savedImages" } },
    Native: {
        chooseDir: vi.fn(async () => null),
        startNativeLogExport: vi.fn(async () => "stream"),
        writeNativeLogChunk: vi.fn(async () => { }),
        finishNativeLogExport: vi.fn(async () => { }),
        cancelNativeLogExport: vi.fn(async () => { }),
        startNativeLogImport: vi.fn(async () => "file"),
        readNativeLogChunk: vi.fn(async () => null),
        closeNativeLogImport: vi.fn(async () => { })
    }
}));
vi.mock("../utils/saveImage", () => ({ clearAttachmentBlobCache: vi.fn() }));
vi.mock("../utils/i18n", () => ({ t: vi.fn((key: string) => key) }));
vi.mock("../db", () => ({
    default: {
        clearMessagesIDB: vi.fn(async () => { }),
        iterateRawMessagesIDB: vi.fn(),
        upsertMessageRecordsIDB: vi.fn(async () => ({ inserted: 0, duplicates: 0 })),
        enforceMessageLimitIDB: vi.fn(async () => 0),
        countMessagesIDB: vi.fn(async () => 0)
    },
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));
const updaterMock = vi.hoisted(() => ({
    changes: [] as unknown[],
    isOutdated: false,
    repoInfo: { repo: "https://example.com/owner/repo", gitHash: "abcdef1234" } as Record<string, any> | null,
    lastError: null as unknown,
    checkForUpdates: vi.fn(async () => false),
    update: vi.fn(async () => { }),
    isNotGitRepoError: vi.fn(() => false)
}));
vi.mock("../utils/updater", () => ({ default: updaterMock }));

import { Alerts, React, Toasts, useEffect, useState } from "@webpack/common";
import { chooseFile } from "@utils/web";

(globalThis as any).React = React;

import updaterModal from "../components/UpdaterModal";
import { ClearLogsButton } from "../components/ClearLogsButton";
import { SelectFolderInput } from "../components/settings/FolderSelectInput";
import idb from "../db";
import { Native, settings } from "../index";
import { exportLogs, importLogs } from "../utils/settingsUtils";

const encoder = new TextEncoder();

function makeMessage(id: string) {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: [],
        deleted: true
    };
}

function makeStreamFile(chunks: string[]) {
    let index = 0;
    return {
        stream: () => new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[index]));
                    index++;
                } else {
                    controller.close();
                }
            }
        })
    };
}

function clickable(node: any): any[] {
    const found: any[] = [];
    const walk = (current: any) => {
        if (!current || typeof current !== "object") return;
        if (current.props?.onClick) found.push(current);
        const kids = current.props?.children;
        if (Array.isArray(kids)) kids.forEach(walk);
        else walk(kids);
    };
    walk(node);
    return found;
}

const lastToast = () => vi.mocked(Toasts.show).mock.calls.at(-1)![0] as { text: string; variant: string };

const componentNodes = (node: any): any[] => clickable(node).filter(entry => typeof entry.type === "function");

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_WEB", false);
    vi.mocked(useState).mockImplementation((init: any) => [init, vi.fn()]);
    settings.store.logsDir = "";
    settings.store.imageCacheDir = "savedImages";
});

describe("toast feedback paths against the current host shape (R13-01 N03)", () => {
    it("clears logs after confirm with a success toast", async () => {
        const el = ClearLogsButton({}) as any;
        const button = clickable(el)[0];
        button.props.onClick();
        const alert = vi.mocked(Alerts.show).mock.calls.at(-1)![0] as any;
        await alert.onConfirm();
        expect(idb.clearMessagesIDB).toHaveBeenCalledTimes(1);
        expect(lastToast()).toMatchObject({ text: "clear.cleared", variant: "success" });
    });

    it("reports a failure toast when clearing logs throws", async () => {
        vi.mocked(idb.clearMessagesIDB).mockRejectedValueOnce(new Error("boom"));
        const el = ClearLogsButton({}) as any;
        clickable(el)[0].props.onClick();
        const alert = vi.mocked(Alerts.show).mock.calls.at(-1)![0] as any;
        await alert.onConfirm();
        expect(lastToast()).toMatchObject({ text: "clear.failed", variant: "critical" });
    });

    it("updates the folder setting and toasts success after choosing a directory", async () => {
        const el = SelectFolderInput({ settingsKey: "logsDir", successMessage: "folder.logsDirUpdated" }) as any;
        vi.mocked(Native.chooseDir).mockResolvedValue("C:\\logs\\dir");
        await componentNodes(el)[0].props.onClick();
        expect(Native.chooseDir).toHaveBeenCalledWith("logsDir");
        expect(settings.store.logsDir).toBe("C:\\logs\\dir");
        expect(lastToast()).toMatchObject({ text: "folder.logsDirUpdated", variant: "success" });
    });

    it("keeps the folder setting and toasts failure when choosing a directory fails", async () => {
        const el = SelectFolderInput({ settingsKey: "logsDir", successMessage: "folder.logsDirUpdated" }) as any;
        vi.mocked(Native.chooseDir).mockRejectedValueOnce(new Error("cancelled"));
        await componentNodes(el)[0].props.onClick();
        expect(settings.store.logsDir).toBe("");
        expect(lastToast()).toMatchObject({ text: "folder.updateFailed", variant: "critical" });
    });

    it("toasts no-updates when the update check finds nothing (N03 updater)", async () => {
        updaterMock.repoInfo = null;
        const modal = updaterModal.UpdaterModal({ modalProps: { onClose: vi.fn() } } as any);
        const effect = vi.mocked(useEffect).mock.calls.at(-1)![0] as () => Promise<void>;
        await effect();
        expect(updaterMock.checkForUpdates).toHaveBeenCalledTimes(1);
        expect(lastToast()).toMatchObject({ text: "updater.noUpdates", variant: "default" });
        expect(modal).toBeTruthy();
    });

    it("shows no toast when the update check ends in an error state", async () => {
        updaterMock.repoInfo = null;
        updaterMock.checkForUpdates.mockImplementationOnce(async () => {
            updaterMock.lastError = { cmd: "git", message: "not a repo" };
            return false;
        });
        updaterModal.UpdaterModal({ modalProps: { onClose: vi.fn() } } as any);
        const effect = vi.mocked(useEffect).mock.calls.at(-1)![0] as () => Promise<void>;
        await effect();
        expect(Toasts.show).not.toHaveBeenCalled();
    });

    it("toasts import success and failure branches (N03 import)", async () => {
        vi.stubGlobal("IS_WEB", true);
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1")] })]) as any);
        vi.mocked(idb.upsertMessageRecordsIDB).mockResolvedValue({ inserted: 1, duplicates: 0 } as any);
        await importLogs();
        expect(lastToast().variant).toBe("success");
        expect(lastToast().text).toContain("import.success");

        vi.mocked(chooseFile).mockRejectedValueOnce(new Error("no file"));
        await importLogs();
        expect(lastToast()).toMatchObject({ text: "import.failed", variant: "critical" });
    });

    it("toasts export success and failure branches (N03 export)", async () => {
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () {
            yield [{ message_id: "1", channel_id: "100" }];
        })());
        await exportLogs();
        expect(lastToast()).toMatchObject({ text: "export.success", variant: "success" });

        vi.mocked(Native.writeNativeLogChunk).mockRejectedValueOnce(new Error("disk full"));
        await exportLogs();
        expect(lastToast()).toMatchObject({ text: "export.failed", variant: "critical" });
    });
});
