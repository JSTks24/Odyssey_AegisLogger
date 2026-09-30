/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/web", () => ({ chooseFile: vi.fn(async () => null) }));
vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { store: { saveImages: false, messageLimit: 0, exclusionRules: "" } },
    Native: {
        startNativeLogExport: vi.fn(async () => "stream"),
        writeNativeLogChunk: vi.fn(async () => { }),
        finishNativeLogExport: vi.fn(async () => { }),
        cancelNativeLogExport: vi.fn(async () => { }),
        startNativeLogImport: vi.fn(async () => "file"),
        readNativeLogChunk: vi.fn(async () => null),
        closeNativeLogImport: vi.fn(async () => { }),
        getSettings: vi.fn(async () => ({ imageCacheDir: "savedImages", logsDir: "" }))
    }
}));
vi.mock("../db", () => ({
    default: {
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
vi.mock("../utils/saveImage", () => ({
    acquireAttachmentBlobUrl: vi.fn(async () => null),
    clearAttachmentBlobCache: vi.fn()
}));
vi.mock("../utils/i18n", () => ({ t: vi.fn((key: string) => key) }));

import { chooseFile } from "@utils/web";
import { Toasts } from "@webpack/common";

import idb, { type DBMessageRecord, DBMessageStatus } from "../db";
import { Native, settings } from "../index";
import { t } from "../utils/i18n";
import { acquireAttachmentBlobUrl } from "../utils/saveImage";
import { exportLogs, importLogs, parsePreservedExportPath } from "../utils/settingsUtils";

function makeMessage(id: string, overrides: Record<string, any> = {}) {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: [],
        deleted: true,
        ...overrides
    };
}

function makeRecord(id: string, overrides: Record<string, any> = {}): DBMessageRecord {
    const message = makeMessage(id, overrides);
    return {
        message_id: message.id,
        channel_id: message.channel_id,
        status: DBMessageStatus.DELETED,
        message,
        timestamp: message.timestamp,
        timestampMs: Date.parse(message.timestamp)
    } as DBMessageRecord;
}

const encoder = new TextEncoder();

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

const importedRecords = () => vi.mocked(idb.upsertMessageRecordsIDB).mock.calls.map(call => call[0]);

const writtenChunks = () => vi.mocked(Native.writeNativeLogChunk).mock.calls.map(call => call[1] as string);

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_WEB", true);
    settings.store.messageLimit = 0;
    vi.mocked(idb.upsertMessageRecordsIDB).mockImplementation(async (records: DBMessageRecord[]) => ({ inserted: records.length, duplicates: 0 }));
    vi.mocked(idb.countMessagesIDB).mockImplementation(async () => 0);
});

describe("importLogs", () => {
    it("imports valid messages and reports their count", async () => {

        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1"), makeMessage("2"), makeMessage("3")] })]) as any);

        const summary = await importLogs();

        expect(summary).toEqual({ imported: 3, duplicates: 0, invalid: 0, trimmed: 0, retained: 0 });
        expect(importedRecords().flat().map(record => record.message_id)).toEqual(["1", "2", "3"]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });

    it("writes batches of at most 50 records", async () => {
        const messages = Array.from({ length: 120 }, (_, i) => makeMessage(String(i + 1)));
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages })]) as any);

        await importLogs();

        expect(importedRecords().map(batch => batch.length)).toEqual([50, 50, 20]);
    });

    it("accepts records wrapped in an item.message property", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [{ message: makeMessage("1") }, { message: makeMessage("2") }] })]) as any);

        await importLogs();

        expect(importedRecords().flat().map(record => record.message_id)).toEqual(["1", "2"]);
    });

    it("accepts legacy files that batch several records inside one array", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [[{ message: makeMessage("1") }, { message: makeMessage("2") }], { message: makeMessage("3") }] })]) as any);

        const summary = await importLogs();

        expect(summary!.imported).toBe(3);
        expect(importedRecords().flat().map(record => record.message_id)).toEqual(["1", "2", "3"]);
    });

    it("skips invalid records and reports how many were dropped", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({
            messages: [
                makeMessage("1"),
                { channel_id: "100", timestamp: "2026-01-01T00:00:00.000Z", author: { id: "u1" }, content: "missing id" },
                { id: "2", timestamp: "2026-01-01T00:00:00.000Z", author: { id: "u1" } },
                { id: "3", channel_id: "100", author: { id: "u1" } },
                { id: "4", channel_id: "100", timestamp: "not a date", author: { id: "u1" } },
                { id: "5", channel_id: "100", timestamp: "2026-01-01T00:00:00.000Z" },
                makeMessage("6")
            ]
        })]) as any);

        const summary = await importLogs();

        expect(importedRecords().flat().map(record => record.message_id)).toEqual(["1", "6"]);
        expect(summary).toEqual({ imported: 2, duplicates: 0, invalid: 5, trimmed: 0, retained: 0 });
    });

    it("fills in the optional arrays that a record is missing", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({
            messages: [{ id: "1", channel_id: "100", timestamp: "2026-01-01T00:00:00.000Z", author: { id: "u1" }, deleted: true }]
        })]) as any);

        await importLogs();

        const [record] = importedRecords()[0];
        expect(record.message.attachments).toEqual([]);
        expect(record.message.embeds).toEqual([]);
        expect(record.message.mentions).toEqual([]);
        expect(record.message.editHistory).toEqual([]);
        expect(record.message.content).toBe("");
        expect(record.status).toBe(DBMessageStatus.DELETED);
    });

    it("keeps the stored status of a record instead of recomputing it", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({
            messages: [{ status: DBMessageStatus.GHOST_PINGED, message: makeMessage("1") }]
        })]) as any);

        await importLogs();

        expect(importedRecords()[0][0].status).toBe(DBMessageStatus.GHOST_PINGED);
    });

    it("counts duplicates reported by the store", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1"), makeMessage("2"), makeMessage("3")] })]) as any);
        vi.mocked(idb.upsertMessageRecordsIDB).mockResolvedValue({ inserted: 1, duplicates: 2 });

        const summary = await importLogs();

        expect(summary).toEqual({ imported: 1, duplicates: 2, invalid: 0, trimmed: 0, retained: 0 });
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });

    it("fails without a store write when every record is a duplicate", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1")] })]) as any);
        vi.mocked(idb.upsertMessageRecordsIDB).mockResolvedValue({ inserted: 0, duplicates: 1 });

        const summary = await importLogs();

        expect(summary).toEqual({ imported: 0, duplicates: 1, invalid: 0, trimmed: 0, retained: 0 });
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "FAILURE" }));
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "FAILURE" }));
    });

    it("salvages the pending tail when the stream turns out malformed", async () => {
        const valid = Array.from({ length: 60 }, (_, i) => makeMessage(String(i + 1)));
        const firstChunk = JSON.stringify({ messages: valid }).slice(0, -2);
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([firstChunk, ',{"bad json']) as any);

        const summary = await importLogs();

        expect(summary).toBeNull();
        expect(importedRecords().map(batch => batch.length)).toEqual([50, 10]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "FAILURE" }));
    });

    it("applies the same retention rule to salvaged partial data and reports what was saved", async () => {
        const valid = Array.from({ length: 60 }, (_, i) => makeMessage(String(i + 1)));
        const firstChunk = JSON.stringify({ messages: valid }).slice(0, -2);
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([firstChunk, ',{"bad json']) as any);
        settings.store.messageLimit = 100;
        vi.mocked(idb.enforceMessageLimitIDB).mockResolvedValueOnce(4);

        const summary = await importLogs();

        expect(summary).toBeNull();
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.type).toBe("FAILURE");
        expect(toast.message).toBe("import.failedPartial import.trimmed");
    });

    it("falls back to the generic failure toast when nothing was saved", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile(["{bad json"]) as any);

        await importLogs();

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.message).toBe("import.failed");
    });

    it("reports the records trimmed away when the import failed before saving anything", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile(["{bad json"]) as any);
        settings.store.messageLimit = 100;
        vi.mocked(idb.enforceMessageLimitIDB).mockResolvedValueOnce(2);

        await importLogs();

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.message).toBe("import.failed import.trimmed");
    });

    it("reports the records trimmed away when every record was a duplicate", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1")] })]) as any);
        vi.mocked(idb.upsertMessageRecordsIDB).mockResolvedValue({ inserted: 0, duplicates: 1 });
        settings.store.messageLimit = 100;
        vi.mocked(idb.enforceMessageLimitIDB).mockResolvedValueOnce(3);

        const summary = await importLogs();

        expect(summary!.trimmed).toBe(3);

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.message).toBe("import.allDuplicates import.trimmed");
    });

    it("reports an empty import file", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [] })]) as any);

        const summary = await importLogs();

        expect(summary).toEqual({ imported: 0, duplicates: 0, invalid: 0, trimmed: 0, retained: 0 });
        expect(idb.upsertMessageRecordsIDB).not.toHaveBeenCalled();
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "FAILURE" }));
    });

    it("restores multi byte characters that are split across chunks", async () => {
        const payload = JSON.stringify({ messages: [makeMessage("1", { content: "中文😀" })] });
        const splitAt = payload.indexOf("中") + 1;
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([payload.slice(0, splitAt), payload.slice(splitAt)]) as any);

        const summary = await importLogs();

        expect(summary!.imported).toBe(1);
        expect(importedRecords()[0][0].message.content).toBe("中文😀");
    });

    it("applies the message limit after a successful import", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1")] })]) as any);

        await importLogs();

        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
    });

    it("reports trimmed records and the retained total when the limit cuts into the import", async () => {
        settings.store.messageLimit = 2;
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1"), makeMessage("2"), makeMessage("3")] })]) as any);
        vi.mocked(idb.enforceMessageLimitIDB).mockResolvedValueOnce(1);
        vi.mocked(idb.countMessagesIDB).mockResolvedValueOnce(2);

        const summary = await importLogs();

        expect(summary).toEqual({ imported: 3, duplicates: 0, invalid: 0, trimmed: 1, retained: 2 });

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.type).toBe("SUCCESS");
        expect(toast.message).toContain("import.success");
        expect(toast.message).toContain("import.trimmed");
    });

    it("keeps the full backup untouched when the limit is disabled", async () => {
        settings.store.messageLimit = 0;
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([JSON.stringify({ messages: [makeMessage("1"), makeMessage("2"), makeMessage("3")] })]) as any);

        const summary = await importLogs();

        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
        expect(summary!.imported).toBe(3);
        expect(summary!.trimmed).toBe(0);

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(toast.message).not.toContain("import.trimmed");
    });
});

describe("exportLogs", () => {
    const exportToNative = async (records: DBMessageRecord[]) => {
        vi.stubGlobal("IS_WEB", false);
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { if (records.length) yield records; })());

        await exportLogs();

        return JSON.parse(writtenChunks().join(""));
    };

    it("writes a versioned file with every stored record field", async () => {
        const record = makeRecord("1", { attachments: [{ id: "a1", filename: "a.png" }] });
        const parsed = await exportToNative([record]);

        expect(parsed.format).toBe("aegis-logger-logs");
        expect(parsed.version).toBe(2);
        expect(parsed.messages).toEqual([record]);
        expect(parsed.messages[0].status).toBe(DBMessageStatus.DELETED);
        expect(parsed.messages[0].message.attachments).toHaveLength(1);
        expect(Native.finishNativeLogExport).toHaveBeenCalledWith("stream");
        expect(Native.cancelNativeLogExport).not.toHaveBeenCalled();
    });

    it("never hydrates attachments while exporting", async () => {
        await exportToNative([makeRecord("1", { attachments: [{ id: "a1", filename: "a.png" }] })]);

        expect(acquireAttachmentBlobUrl).not.toHaveBeenCalled();
    });

    it("cancels the stream and reports a failure when a chunk cannot be written", async () => {
        vi.stubGlobal("IS_WEB", false);
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield [makeRecord("1")]; })());
        vi.mocked(Native.writeNativeLogChunk).mockRejectedValueOnce(new Error("disk full"));

        await exportLogs();

        expect(Native.cancelNativeLogExport).toHaveBeenCalledWith("stream");
        expect(Native.finishNativeLogExport).not.toHaveBeenCalled();
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "FAILURE" }));
    });

    it("still produces a valid file for an empty database", async () => {
        const parsed = await exportToNative([]);

        expect(parsed.messages).toEqual([]);
        expect(Native.finishNativeLogExport).toHaveBeenCalledWith("stream");
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });
});
describe("export failure recovery notice", () => {
    const preservedPath = "C:\\logs\\export.json.aegis-tmp-1234";
    const preservedMessage = `Error invoking remote method 'AegisLogger.finishNativeLogExport': Error: Failed to replace "C:\\logs\\export.json"; the original file was kept. Preserved export: "${preservedPath}"`;

    const exportToNative = async (failure: Error) => {
        vi.stubGlobal("IS_WEB", false);
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield [makeRecord("1")]; })());
        vi.mocked(Native.finishNativeLogExport).mockRejectedValueOnce(failure);

        await exportLogs();

        return vi.mocked(Toasts.show).mock.calls.at(-1)![0];
    };

    it("parses the preserved path out of an ipc wrapped native failure", () => {
        expect(parsePreservedExportPath(new Error(preservedMessage))).toBe(preservedPath);
    });

    it("parses the preserved path out of a plain native failure message", () => {
        expect(parsePreservedExportPath(`Failed to replace "C:\\logs\\export.json"; the original file was kept. Preserved export: "${preservedPath}"`)).toBe(preservedPath);
    });

    it("parses the preserved path out of a raw message string", () => {
        expect(parsePreservedExportPath(`Preserved export: "${preservedPath}"`)).toBe(preservedPath);
    });

    it("reports no preserved path when the failure kept nothing", () => {
        expect(parsePreservedExportPath(new Error("disk full"))).toBeNull();
        expect(parsePreservedExportPath(undefined)).toBeNull();
        expect(parsePreservedExportPath("Error exporting logs")).toBeNull();
    });

    it("reports no preserved path when the marker has no quoted path", () => {
        expect(parsePreservedExportPath(new Error("Preserved export: "))).toBeNull();
        expect(parsePreservedExportPath(new Error("Preserved export: \"\""))).toBeNull();
        expect(parsePreservedExportPath(new Error("Preserved export: C:\\logs\\tmp"))).toBeNull();
    });

    it("shows the recovery location when the finished export was preserved", async () => {
        const toast = await exportToNative(new Error(preservedMessage));

        expect(toast.type).toBe("FAILURE");
        expect(toast.message).toBe("export.failedPreserved");
        expect(t).toHaveBeenCalledWith("export.failedPreserved", { path: preservedPath });
    });

    it("keeps the generic failure notice when nothing was preserved", async () => {
        const toast = await exportToNative(new Error("disk full"));

        expect(toast.type).toBe("FAILURE");
        expect(toast.message).toBe("export.failed");
        expect(t).not.toHaveBeenCalledWith("export.failedPreserved", expect.anything());
    });

    it("does not report a preserved backup when the export was cancelled", async () => {
        vi.stubGlobal("IS_WEB", false);
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield [makeRecord("1")]; })());
        vi.mocked(Native.writeNativeLogChunk).mockRejectedValueOnce(new Error("disk full"));

        await exportLogs();

        const toast = vi.mocked(Toasts.show).mock.calls.at(-1)![0];
        expect(Native.cancelNativeLogExport).toHaveBeenCalledWith("stream");
        expect(toast.message).toBe("export.failed");
        expect(t).not.toHaveBeenCalledWith("export.failedPreserved", expect.anything());
    });
});
