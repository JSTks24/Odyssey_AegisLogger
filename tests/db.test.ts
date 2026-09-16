/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils", () => ({
    getMessageStatus: (message: any) => {
        if (message?.ghostPinged) return "GHOST_PINGED";
        if (message?.deleted) return "DELETED";
        if (message?.editHistory?.length) return "EDITED";
        throw new Error("Unknown message status");
    },
    contentExcluded: () => false
}));

vi.mock("../utils/saveImage", () => ({
    getAttachmentBlobUrl: vi.fn(async () => null),
    cacheMessageImages: vi.fn(async () => { })
}));

import idb, { type DBMessageRecord, DBMessageStatus } from "../db";
import type { LoggedMessageJSON } from "../types";
import { getAttachmentBlobUrl } from "../utils/saveImage";

function makeMessage(id: string, overrides: Partial<LoggedMessageJSON> = {}): LoggedMessageJSON {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + Number(id)).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_everyone: false,
        ...overrides
    } as LoggedMessageJSON;
}

function makeRecord(id: string, status = DBMessageStatus.DELETED, overrides: Partial<LoggedMessageJSON> = {}): DBMessageRecord {
    const message = makeMessage(id, overrides);
    return {
        message_id: message.id,
        channel_id: message.channel_id,
        status,
        message
    };
}

async function countDb() {
    return idb.countMessagesIDB();
}

beforeAll(() => idb.dbReady);

beforeEach(async () => {
    await idb.clearMessagesIDB();
});

describe("idb.initIDB schema", () => {
    it("creates the messages store", () => {
        expect(Array.from((idb.connection as any).objectStoreNames)).toContain("messages");
    });

    it("reopening keeps existing data", async () => {
        await idb.addMessageIDB(makeMessage("1"), DBMessageStatus.DELETED);
        idb.connection.close();
        await idb.initIDB();

        expect(await countDb()).toBe(1);
    });
});

describe("message CRUD", () => {
    it("roundtrips a message via idb.addMessageIDB/idb.getMessageIDB", async () => {
        const message = makeMessage("10");
        await idb.addMessageIDB(message, DBMessageStatus.EDITED);

        const record = await idb.getMessageIDB("10");
        expect(record).not.toBeNull();
        expect(record!.message_id).toBe("10");
        expect(record!.status).toBe(DBMessageStatus.EDITED);
        expect(record!.message.content).toBe("content-10");
    });

    it("idb.addMessageIDB populates the in-memory cache", async () => {
        await idb.addMessageIDB(makeMessage("11"), DBMessageStatus.DELETED);

        expect(idb.cachedMessages.has("11")).toBe(true);
    });

    it("idb.hasMessageIDB detects stored and unknown ids", async () => {
        await idb.addMessageIDB(makeMessage("12"), DBMessageStatus.DELETED);

        expect(await idb.hasMessageIDB("12")).toBe(true);
        expect(await idb.hasMessageIDB("999")).toBe(false);
    });

    it("idb.deleteMessageIDB removes record and cache entry", async () => {
        await idb.addMessageIDB(makeMessage("13"), DBMessageStatus.DELETED);
        await idb.deleteMessageIDB("13");

        expect(await idb.getMessageIDB("13")).toBeUndefined();
        expect(idb.cachedMessages.has("13")).toBe(false);
    });

    it("idb.deleteMessagesBulkIDB removes many records at once", async () => {
        await idb.addMessageRecordsIDB([makeRecord("20"), makeRecord("21"), makeRecord("22")]);
        await idb.deleteMessagesBulkIDB(["20", "22"]);

        expect(await idb.getAllMessageIdsIDB()).toEqual(["21"]);
    });

    it("idb.getAllMessageIdsIDB returns primary keys only", async () => {
        await idb.addMessageRecordsIDB([makeRecord("30"), makeRecord("31")]);

        expect(await idb.getAllMessageIdsIDB()).toEqual(["30", "31"]);
    });
});

describe("bulk writes", () => {
    it("idb.addMessageRecordsIDB stores whole records and dedupes via put", async () => {
        await idb.addMessageRecordsIDB([makeRecord("40"), makeRecord("41")]);

        const updated = makeRecord("40");
        updated.message.content = "edited-content";
        await idb.addMessageRecordsIDB([updated]);

        const record = await idb.getMessageIDB("40");
        expect(record!.message.content).toBe("edited-content");
        expect(await countDb()).toBe(2);
    });

    it("idb.addMessagesBulkIDB with duplicate key aborts the transaction (ConstraintError)", async () => {
        await idb.addMessageIDB(makeMessage("50"), DBMessageStatus.DELETED);

        await expect(
            idb.addMessagesBulkIDB([makeMessage("50"), makeMessage("51")] as any)
        ).rejects.toBeDefined();

        expect(await countDb()).toBe(1);
    });

    it("idb.addMessagesBulkIDB derives status from the message when omitted", async () => {
        const message = makeMessage("60", { deleted: true });
        await idb.addMessagesBulkIDB([message] as any);

        const record = await idb.getMessageIDB("60");
        expect(record!.status).toBe(DBMessageStatus.DELETED);
    });

    it("idb.addMessagesBulkIDB rejects messages without derivable status", async () => {
        const message = makeMessage("61");

        await expect(idb.addMessagesBulkIDB([message] as any)).rejects.toThrow("Unknown message status");
    });
});

describe("queries and indexes", () => {
    beforeEach(async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("70", DBMessageStatus.DELETED, { guildId: "g1" }),
            makeRecord("71", DBMessageStatus.EDITED, { guildId: "g1" }),
            makeRecord("72", DBMessageStatus.GHOST_PINGED, { guildId: "g2", channel_id: "200" }),
            makeRecord("73", DBMessageStatus.DELETED, { guildId: "g2", channel_id: "200" })
        ]);
    });

    it("idb.getMessagesByStatusIDB filters by status index", async () => {
        const records = await idb.getMessagesByStatusIDB(DBMessageStatus.DELETED);

        expect(records.map(r => r.message_id)).toEqual(["70", "73"]);
    });

    it("idb.countMessagesByStatusIDB counts via index", async () => {
        expect(await idb.countMessagesByStatusIDB(DBMessageStatus.DELETED)).toBe(2);
        expect(await idb.countMessagesByStatusIDB(DBMessageStatus.EDITED)).toBe(1);
    });

    it("idb.getMessagesForChannelIDB filters by channel index", async () => {
        const records = await idb.getMessagesForChannelIDB("200");

        expect(records.map(r => r.message_id)).toEqual(["72", "73"]);
    });

    it("idb.getOldestMessagesIDB returns the oldest n records", async () => {
        const records = await idb.getOldestMessagesIDB(2);

        expect(records.map(r => r.message_id)).toEqual(["70", "71"]);
    });

    it("idb.getDateStortedMessagesByStatusIDB sorts newest first", async () => {
        const records = await idb.getDateStortedMessagesByStatusIDB(true, 10, DBMessageStatus.DELETED);

        expect(records.map(r => r.message_id)).toEqual(["73", "70"]);
    });

    it("idb.iterateRawMessagesByStatusIDB walks the status index newest first without hydrating", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("90", DBMessageStatus.DELETED, { attachments: [{ id: "a1", url: "u1", proxy_url: "p1", filename: "a.png" }] }),
            makeRecord("91", DBMessageStatus.DELETED, { attachments: [{ id: "a2", url: "u2", proxy_url: "p2", filename: "b.png" }] })
        ]);
        const hydrate = vi.mocked(getAttachmentBlobUrl);
        hydrate.mockClear();

        const ids: string[] = [];
        for await (const batch of idb.iterateRawMessagesByStatusIDB(DBMessageStatus.DELETED, true))
            ids.push(...batch.map(r => r.message_id).filter(id => id === "90" || id === "91"));

        expect(ids).toEqual(["91", "90"]);
        expect(hydrate).not.toHaveBeenCalled();
    });

    it("idb.iterateRawMessagesByStatusIDB can stop after one batch", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("92", DBMessageStatus.DELETED),
            makeRecord("93", DBMessageStatus.DELETED),
            makeRecord("94", DBMessageStatus.DELETED)
        ]);

        const batches: number[] = [];
        for await (const batch of idb.iterateRawMessagesByStatusIDB(DBMessageStatus.DELETED, true, 2)) {
            batches.push(batch.length);
            break;
        }

        expect(batches).toEqual([2]);
    });

    it("idb.getDateStortedMessagesByStatusIDB hydrates only the rows it returns", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("92", DBMessageStatus.DELETED, { attachments: [{ id: "a3", url: "u3", proxy_url: "p3", filename: "c.png" }] }),
            makeRecord("93", DBMessageStatus.DELETED, { attachments: [{ id: "a4", url: "u4", proxy_url: "p4", filename: "d.png" }] })
        ]);
        const hydrate = vi.mocked(getAttachmentBlobUrl);
        hydrate.mockClear();

        const records = await idb.getDateStortedMessagesByStatusIDB(true, 10, DBMessageStatus.DELETED);
        const expected = records.reduce((sum, r) => sum + r.message.attachments.length, 0);

        expect(records.some(r => r.message_id === "93")).toBe(true);
        expect(hydrate).toHaveBeenCalledTimes(expected);
    });

    it("idb.hydrateRecords touches exactly the records it is given", async () => {
        const hydrate = vi.mocked(getAttachmentBlobUrl);
        hydrate.mockClear();

        await idb.hydrateRecords([
            makeRecord("94", DBMessageStatus.DELETED, { attachments: [{ id: "a5", url: "u5", proxy_url: "p5", filename: "e.png" }] }),
            makeRecord("95", DBMessageStatus.DELETED, { attachments: [{ id: "a6", url: "u6", proxy_url: "p6", filename: "f.png" }] })
        ]);

        expect(hydrate).toHaveBeenCalledTimes(2);
    });

    it("idb.iterateRawMessagesIDB yields batches without hydrating attachments", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("96", DBMessageStatus.DELETED, { attachments: [{ id: "a7", url: "u7", proxy_url: "p7", filename: "g.png" }] })
        ]);
        const hydrate = vi.mocked(getAttachmentBlobUrl);
        hydrate.mockClear();

        const ids: string[] = [];
        for await (const batch of idb.iterateRawMessagesIDB(3)) {
            expect(batch.length).toBeLessThanOrEqual(3);
            ids.push(...batch.map(r => r.message_id));
        }

        expect(ids).toContain("96");
        expect(hydrate).not.toHaveBeenCalled();
    });

    it("idb.getDistinctLogEntities aggregates without hydrating attachments", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("97", DBMessageStatus.DELETED, { guildId: "g9", attachments: [{ id: "a8", url: "u8", proxy_url: "p8", filename: "h.png" }] })
        ]);
        const hydrate = vi.mocked(getAttachmentBlobUrl);
        hydrate.mockClear();

        const entities = await idb.getDistinctLogEntities();

        expect(entities.guildIds).toContain("g9");
        expect(hydrate).not.toHaveBeenCalled();
    });

    it("idb.getMessagesByChannelAndAfterTimestampIDB bounds by channel and timestamp", async () => {
        const records = await idb.getMessagesByChannelAndAfterTimestampIDB("200", "2026-01-01T00:00:00.000Z");

        expect(records).toHaveLength(2);

        const none = await idb.getMessagesByChannelAndAfterTimestampIDB("999", "2026-01-01T00:00:00.000Z");
        expect(none).toHaveLength(0);
    });

    it("idb.iterateAllMessagesIDB yields batches of the requested size", async () => {
        const sizes: number[] = [];
        for await (const batch of idb.iterateAllMessagesIDB(3)) {
            sizes.push(batch.length);
        }

        expect(sizes).toEqual([3, 1]);
    });

    it("idb.getDistinctLogEntities aggregates authors, guilds and channels", async () => {
        const entities = await idb.getDistinctLogEntities();

        expect(entities.authors.map(a => a.id)).toEqual(["u1"]);
        expect(entities.guildIds).toEqual(["g1", "g2"]);
        expect(entities.channelIds).toEqual(["100", "200"]);
    });
});

describe("idb.clearMessagesIDB disaster handling", () => {
    it("wipes everything and rebuilds the db", async () => {
        await idb.addMessageRecordsIDB([makeRecord("80"), makeRecord("81")]);

        await idb.clearMessagesIDB();

        expect(await countDb()).toBe(0);
        expect(idb.cachedMessages.size).toBe(0);
    });

    it("falls back to chunked deletion when deleteDatabase fails", async () => {
        await idb.addMessageRecordsIDB([makeRecord("82"), makeRecord("83")]);

        const spy = vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
            const request: any = {};
            setTimeout(() => request.onerror?.(new Event("error")), 0);
            return request as IDBOpenDBRequest;
        });

        try {
            await idb.clearMessagesIDB();
        } finally {
            spy.mockRestore();
        }

        expect(await countDb()).toBe(0);
    });
});
