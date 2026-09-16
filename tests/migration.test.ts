/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils", () => ({
    getMessageStatus: (message: any) => {
        if (message?.ghostPinged) return "GHOST_PINGED";
        if (message?.deleted) return "DELETED";
        if (message?.editHistory?.length) return "EDITED";
        throw new Error("Unknown message status");
    }
}));

vi.mock("../utils/saveImage", () => ({
    getAttachmentBlobUrl: vi.fn(async () => null)
}));

vi.mock("../db", async importOriginal => {
    const actual = await importOriginal<typeof import("../db")>();
    return {
        ...actual,
        default: {
            ...actual.default,
            addMessageRecordsIDB: vi.fn(actual.default.addMessageRecordsIDB)
        }
    };
});

import idb from "../db";

const addRecordSpy = idb.addMessageRecordsIDB;
import {
    clearLegacyLogs,
    countLegacyRemaining,
    isLegacyDbCleared,
    legacyDbExists,
    migrateLegacyImages,
    migrateLegacyLogs
} from "../utils/migration";

const LEGACY_DB_NAME = "MessageLoggerIDB";
const LEGACY_IMAGE_DB_NAME = "MessageLoggerImageData";
const IMAGE_DB_NAME = "AegisLoggerImageData";

function makeLegacyRecord(id: string, status: string | null = "DELETED") {
    const message: any = {
        id,
        channel_id: "100",
        content: `legacy-${id}`,
        author: { id: "u1", username: "alice" },
        attachments: []
    };
    if (status === null) delete (message as any).deleted;
    else message.deleted = true;

    const record: any = {
        message_id: id,
        channel_id: "100",
        status,
        message
    };
    if (status === null) delete record.status;
    return record;
}

function seedLegacyDb(records: any[], storeName = "messages"): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(LEGACY_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains(storeName))
                request.result.createObjectStore(storeName, storeName === "messages" ? { keyPath: "message_id" } : undefined);
        };
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction(storeName, "readwrite");
            for (const record of records) tx.objectStore(storeName).put(record);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
    });
}

async function deleteLegacyDb() {
    for (const name of [LEGACY_DB_NAME, LEGACY_IMAGE_DB_NAME]) {
        await new Promise<void>(resolve => {
            const request = indexedDB.deleteDatabase(name);
            request.onsuccess = () => resolve();
            request.onerror = () => resolve();
            request.onblocked = () => resolve();
        });
    }
}

function seedLegacyImageDb(entries: { key: string; value: Uint8Array; }[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(LEGACY_IMAGE_DB_NAME, 1);
        request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains("MessageLoggerImageStore"))
                request.result.createObjectStore("MessageLoggerImageStore");
        };
        request.onsuccess = () => {
            const db = request.result;
            const tx = db.transaction("MessageLoggerImageStore", "readwrite");
            for (const { key, value } of entries) tx.objectStore("MessageLoggerImageStore").put(value, key);
            tx.oncomplete = () => {
                db.close();
                resolve();
            };
            tx.onerror = () => reject(tx.error);
        };
        request.onerror = () => reject(request.error);
    });
}

async function readImageStore() {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(IMAGE_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    try {
        return await new Promise<{ key: string; value: any; }[]>(resolve => {
            const tx = db.transaction("AegisLoggerImageStore", "readonly");
            const request = tx.objectStore("AegisLoggerImageStore").openCursor();
            const out: { key: string; value: any; }[] = [];
            request.onsuccess = () => {
                const cursor = request.result;
                if (cursor) {
                    out.push({ key: String(cursor.key), value: cursor.value });
                    cursor.continue();
                } else {
                    resolve(out);
                }
            };
        });
    } finally {
        db.close();
    }
}

beforeEach(async () => {
    vi.mocked(addRecordSpy).mockClear();
    await idb.dbReady;
    await idb.clearMessagesIDB();
    await deleteLegacyDb();
});

describe("migrateLegacyLogs", () => {
    it("reports zero when the legacy database does not exist", async () => {
        const result = await migrateLegacyLogs();

        expect(result).toEqual({ migrated: 0, duplicates: 0, invalid: 0 });
        expect(await legacyDbExists()).toBe(false);
    });

    it("migrates all records into the new database", async () => {
        await seedLegacyDb([makeLegacyRecord("1"), makeLegacyRecord("2"), makeLegacyRecord("3")]);

        const result = await migrateLegacyLogs();

        expect(result.migrated).toBe(3);
        expect(result.duplicates).toBe(0);
        expect(await idb.countMessagesIDB()).toBe(3);

        const record = await idb.getMessageIDB("2");
        expect(record!.status).toBe("DELETED");
        expect(record!.message.content).toBe("legacy-2");
    });

    it("is idempotent: rerun skips already migrated records", async () => {
        await seedLegacyDb([makeLegacyRecord("1"), makeLegacyRecord("2")]);

        const first = await migrateLegacyLogs();
        const second = await migrateLegacyLogs();

        expect(first.migrated).toBe(2);
        expect(second.migrated).toBe(0);
        expect(second.duplicates).toBe(2);
        expect(await idb.countMessagesIDB()).toBe(2);
    });

    it("chunks large databases beyond the 2000 batch size", async () => {
        const records = Array.from({ length: 5000 }, (_, i) => makeLegacyRecord(String(i)));
        await seedLegacyDb(records);

        const result = await migrateLegacyLogs();

        expect(result.migrated).toBe(5000);
        expect(await idb.countMessagesIDB()).toBe(5000);
        expect(vi.mocked(addRecordSpy).mock.calls.map(call => call[0].length)).toEqual([2000, 2000, 1000]);
    });

    it("returns zero when the legacy database has no messages store", async () => {
        await seedLegacyDb([], "other");

        const result = await migrateLegacyLogs();

        expect(result.migrated).toBe(0);
        expect(await idb.countMessagesIDB()).toBe(0);
    });

    it("skips unusable records without aborting usable ones", async () => {
        await seedLegacyDb([
            makeLegacyRecord("10"),
            { message_id: "bad", channel_id: "100", message: { id: "bad", channel_id: "100" } },
            makeLegacyRecord("11", null)
        ]);

        const result = await migrateLegacyLogs();

        expect(result.migrated).toBe(1);
        expect(result.invalid).toBe(2);
        expect(await idb.getAllMessageIdsIDB()).toEqual(["10"]);
    });

    it("keeps already written chunks when a chunk write fails mid-way, and rerun finishes the job", async () => {
        const records = Array.from({ length: 4000 }, (_, i) => makeLegacyRecord(String(i)));
        await seedLegacyDb(records);

        const base = vi.mocked(addRecordSpy).getMockImplementation()!;
        vi.mocked(addRecordSpy)
            .mockImplementationOnce(base)
            .mockImplementationOnce(async () => { throw new Error("quota exceeded"); });

        await expect(migrateLegacyLogs()).rejects.toThrow("quota exceeded");
        expect(await idb.countMessagesIDB()).toBe(2000);

        const result = await migrateLegacyLogs();
        expect(result.migrated).toBe(2000);
        expect(result.duplicates).toBe(2000);
        expect(await idb.countMessagesIDB()).toBe(4000);
    });
});

describe("countLegacyRemaining", () => {
    it("counts legacy records that are not yet in the new database", async () => {
        await seedLegacyDb([makeLegacyRecord("1"), makeLegacyRecord("2"), makeLegacyRecord("3")]);
        await idb.addMessageRecordsIDB([makeLegacyRecord("1")]);

        expect(await countLegacyRemaining()).toBe(2);
    });

    it("returns zero after a full migration", async () => {
        await seedLegacyDb([makeLegacyRecord("1"), makeLegacyRecord("2")]);

        await migrateLegacyLogs();

        expect(await countLegacyRemaining()).toBe(0);
    });

    it("ignores unusable records instead of blocking deletion", async () => {
        await seedLegacyDb([makeLegacyRecord("5", null)]);

        expect(await countLegacyRemaining()).toBe(0);
    });
});

describe("migrateLegacyImages", () => {
    it("copies legacy images under the new cache dir prefix, idempotently", async () => {
        await seedLegacyImageDb([
            { key: "MessageLoggerData/savedImages/111.png", value: new Uint8Array([1, 2, 3]) },
            { key: "MessageLoggerData/savedImages/222.gif", value: new Uint8Array([4, 5]) }
        ]);
        await seedLegacyDb([makeLegacyRecord("1")]);
        await migrateLegacyLogs();

        const migrated = await migrateLegacyImages();
        const rerun = await migrateLegacyImages();

        expect(migrated).toBe(2);
        expect(rerun).toBe(0);
        const store = await readImageStore();
        const byKey = Object.fromEntries(store.map(e => [e.key, e.value]));
        expect(byKey["savedImages/111.png"]).toEqual(new Uint8Array([1, 2, 3]));
        expect(byKey["savedImages/222.gif"]).toEqual(new Uint8Array([4, 5]));
    });

    it("returns zero when the legacy image database does not exist", async () => {
        expect(await migrateLegacyImages()).toBe(0);
    });
});

describe("clearLegacyLogs", () => {
    it("deletes the legacy log and image databases so they no longer show up", async () => {
        await seedLegacyDb([makeLegacyRecord("1")]);
        await seedLegacyImageDb([{ key: "old/1.png", value: new Uint8Array([1]) }]);
        expect(await legacyDbExists()).toBe(true);

        await clearLegacyLogs();

        expect(await isLegacyDbCleared()).toBe(true);
        expect(await legacyDbExists()).toBe(false);
    });

    it("rejects instead of silently succeeding while another connection blocks deletion", async () => {
        await seedLegacyDb([makeLegacyRecord("1")]);
        const blocker = indexedDB.open(LEGACY_DB_NAME);
        await new Promise<void>(resolve => {
            blocker.onsuccess = () => resolve();
        });

        await expect(clearLegacyLogs()).rejects.toThrow();
        blocker.result.close();
    });
});
