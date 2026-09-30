/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("../utils", () => ({
    getMessageStatus: () => "DELETED",
    contentExcluded: () => false
}));

vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    settings: {
        store: {
            saveImages: false,
            messageLimit: 0,
            cacheLimit: 1000,
            attachmentSizeLimitInMegabytes: 8,
            attachmentFileExtensions: ""
        }
    }
}));

vi.mock("../utils/saveImage/ImageManager", () => ({
    getImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    downloadAttachment: vi.fn(async () => undefined),
    deleteImage: vi.fn(async () => { })
}));

import idb, { type DBMessageRecord, DBMessageStatus } from "../db";
import { DB_NAME, DB_VERSION } from "../utils/constants";

const LEGACY_RECORD = {
    message_id: "legacy-1",
    channel_id: "200",
    status: DBMessageStatus.DELETED,
    message: {
        id: "legacy-1",
        channel_id: "200",
        timestamp: "2026-01-01T12:00:00.000Z",
        author: { id: "u1", username: "alice" },
        content: "legacy",
        attachments: [],
        embeds: []
    }
};

const LEGACY_RECORD_TWO = {
    ...LEGACY_RECORD,
    message_id: "legacy-2",
    message: { ...LEGACY_RECORD.message, id: "legacy-2", timestamp: "2026-01-01T13:00:00.000Z" }
};

const openRaw = (version: number, upgrade: (db: IDBDatabase) => void) =>
    new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, version);
        request.onupgradeneeded = () => upgrade(request.result);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

const deleteDatabase = () =>
    new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
    });

const putRaw = (db: IDBDatabase, records: unknown[]) =>
    new Promise<void>((resolve, reject) => {
        const tx = db.transaction("messages", "readwrite");
        records.forEach(record => tx.objectStore("messages").put(record));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });

const indexNames = (db: IDBDatabase) => Array.from(db.transaction("messages").objectStore("messages").indexNames);

beforeAll(async () => {
    await idb.dbReady;
    idb.connection.close();
    await deleteDatabase();
});

afterAll(async () => {
    idb.connection.close();
    await deleteDatabase();
});

describe("database upgrade from version 1", () => {
    it("backfills the promoted timestamp fields and adds the time indexes", async () => {
        const legacy = await openRaw(1, db => {
            const store = db.createObjectStore("messages", { keyPath: "message_id" });
            store.createIndex("by_channel_id", "channel_id");
            store.createIndex("by_status", "status");
            store.createIndex("by_timestamp", "timestamp");
        });

        await putRaw(legacy, [LEGACY_RECORD, LEGACY_RECORD_TWO]);
        legacy.close();

        await idb.initIDB();

        expect(DB_VERSION).toBe(2);
        expect(indexNames(idb.connection as unknown as IDBDatabase)).toEqual(
            expect.arrayContaining(["by_timestamp", "by_channel_and_timestamp", "by_status_and_timestamp", "by_timestamp_ms"])
        );

        const first = (await idb.getMessageIDB("legacy-1")) as DBMessageRecord;
        expect(first.timestamp).toBe("2026-01-01T12:00:00.000Z");
        expect(first.timestampMs).toBe(Date.parse("2026-01-01T12:00:00.000Z"));
        expect(first.message.content).toBe("legacy");
        expect(await idb.countMessagesIDB()).toBe(2);
    });

    it("answers time ordered queries against the upgraded index", async () => {
        await idb.addMessageIDB({ ...LEGACY_RECORD.message, id: "legacy-3", timestamp: "2026-01-01T14:00:00.000Z" } as any, DBMessageStatus.DELETED);

        const newest = await idb.getDateStortedMessagesByStatusIDB(true, 2, DBMessageStatus.DELETED);
        expect(newest.map(record => record.message_id)).toEqual(["legacy-3", "legacy-2"]);

        const after = await idb.getMessagesByChannelAndAfterTimestampIDB("200", "2026-01-01T13:30:00.000Z");
        expect(after.records.map(record => record.message_id)).toEqual(["legacy-3"]);
        after.scope.release();
    });

    it("reopening an already upgraded database keeps the data and the indexes", async () => {
        idb.connection.close();
        await idb.initIDB();

        expect(await idb.countMessagesIDB()).toBe(3);
        expect(indexNames(idb.connection as unknown as IDBDatabase)).toContain("by_channel_and_timestamp");
    });
});
