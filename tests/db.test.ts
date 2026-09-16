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

import {
    addMessageIDB,
    addMessageRecordsIDB,
    addMessagesBulkIDB,
    cachedMessages,
    clearMessagesIDB,
    countMessagesByStatusIDB,
    countMessagesIDB,
    db,
    dbReady,
    DBMessageStatus,
    deleteMessageIDB,
    deleteMessagesBulkIDB,
    getAllMessageIdsIDB,
    getAllMessagesIDB,
    getDateStortedMessagesByStatusIDB,
    getDistinctLogEntities,
    getMessageIDB,
    getMessagesByChannelAndAfterTimestampIDB,
    getMessagesByStatusIDB,
    getMessagesForChannelIDB,
    getOldestMessagesIDB,
    hasMessageIDB,
    initIDB,
    iterateAllMessagesIDB
} from "../db";
import type { DBMessageRecord, LoggedMessageJSON } from "../types";

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
    return countMessagesIDB();
}

beforeAll(() => dbReady);

beforeEach(async () => {
    await clearMessagesIDB();
});

describe("initIDB schema", () => {
    it("creates the messages store", () => {
        expect(Array.from((db as any).objectStoreNames)).toContain("messages");
    });

    it("reopening keeps existing data", async () => {
        await addMessageIDB(makeMessage("1"), DBMessageStatus.DELETED);
        db.close();
        await initIDB();

        expect(await countDb()).toBe(1);
    });
});

describe("message CRUD", () => {
    it("roundtrips a message via addMessageIDB/getMessageIDB", async () => {
        const message = makeMessage("10");
        await addMessageIDB(message, DBMessageStatus.EDITED);

        const record = await getMessageIDB("10");
        expect(record).not.toBeNull();
        expect(record!.message_id).toBe("10");
        expect(record!.status).toBe(DBMessageStatus.EDITED);
        expect(record!.message.content).toBe("content-10");
    });

    it("addMessageIDB populates the in-memory cache", async () => {
        await addMessageIDB(makeMessage("11"), DBMessageStatus.DELETED);

        expect(cachedMessages.has("11")).toBe(true);
    });

    it("hasMessageIDB detects stored and unknown ids", async () => {
        await addMessageIDB(makeMessage("12"), DBMessageStatus.DELETED);

        expect(await hasMessageIDB("12")).toBe(true);
        expect(await hasMessageIDB("999")).toBe(false);
    });

    it("deleteMessageIDB removes record and cache entry", async () => {
        await addMessageIDB(makeMessage("13"), DBMessageStatus.DELETED);
        await deleteMessageIDB("13");

        expect(await getMessageIDB("13")).toBeUndefined();
        expect(cachedMessages.has("13")).toBe(false);
    });

    it("deleteMessagesBulkIDB removes many records at once", async () => {
        await addMessageRecordsIDB([makeRecord("20"), makeRecord("21"), makeRecord("22")]);
        await deleteMessagesBulkIDB(["20", "22"]);

        expect(await getAllMessageIdsIDB()).toEqual(["21"]);
    });

    it("getAllMessageIdsIDB returns primary keys only", async () => {
        await addMessageRecordsIDB([makeRecord("30"), makeRecord("31")]);

        expect(await getAllMessageIdsIDB()).toEqual(["30", "31"]);
    });
});

describe("bulk writes", () => {
    it("addMessageRecordsIDB stores whole records and dedupes via put", async () => {
        await addMessageRecordsIDB([makeRecord("40"), makeRecord("41")]);

        const updated = makeRecord("40");
        updated.message.content = "edited-content";
        await addMessageRecordsIDB([updated]);

        const record = await getMessageIDB("40");
        expect(record!.message.content).toBe("edited-content");
        expect(await countDb()).toBe(2);
    });

    it("addMessagesBulkIDB with duplicate key aborts the transaction (ConstraintError)", async () => {
        await addMessageIDB(makeMessage("50"), DBMessageStatus.DELETED);

        await expect(
            addMessagesBulkIDB([makeMessage("50"), makeMessage("51")] as any)
        ).rejects.toBeDefined();

        expect(await countDb()).toBe(1);
    });

    it("addMessagesBulkIDB derives status from the message when omitted", async () => {
        const message = makeMessage("60", { deleted: true });
        await addMessagesBulkIDB([message] as any);

        const record = await getMessageIDB("60");
        expect(record!.status).toBe(DBMessageStatus.DELETED);
    });

    it("addMessagesBulkIDB rejects messages without derivable status", async () => {
        const message = makeMessage("61");

        await expect(addMessagesBulkIDB([message] as any)).rejects.toThrow("Unknown message status");
    });
});

describe("queries and indexes", () => {
    beforeEach(async () => {
        await addMessageRecordsIDB([
            makeRecord("70", DBMessageStatus.DELETED, { guildId: "g1" }),
            makeRecord("71", DBMessageStatus.EDITED, { guildId: "g1" }),
            makeRecord("72", DBMessageStatus.GHOST_PINGED, { guildId: "g2", channel_id: "200" }),
            makeRecord("73", DBMessageStatus.DELETED, { guildId: "g2", channel_id: "200" })
        ]);
    });

    it("getMessagesByStatusIDB filters by status index", async () => {
        const records = await getMessagesByStatusIDB(DBMessageStatus.DELETED);

        expect(records.map(r => r.message_id)).toEqual(["70", "73"]);
    });

    it("countMessagesByStatusIDB counts via index", async () => {
        expect(await countMessagesByStatusIDB(DBMessageStatus.DELETED)).toBe(2);
        expect(await countMessagesByStatusIDB(DBMessageStatus.EDITED)).toBe(1);
    });

    it("getMessagesForChannelIDB filters by channel index", async () => {
        const records = await getMessagesForChannelIDB("200");

        expect(records.map(r => r.message_id)).toEqual(["72", "73"]);
    });

    it("getOldestMessagesIDB returns the oldest n records", async () => {
        const records = await getOldestMessagesIDB(2);

        expect(records.map(r => r.message_id)).toEqual(["70", "71"]);
    });

    it("getDateStortedMessagesByStatusIDB sorts newest first", async () => {
        const records = await getDateStortedMessagesByStatusIDB(true, 10, DBMessageStatus.DELETED);

        expect(records.map(r => r.message_id)).toEqual(["73", "70"]);
    });

    it("getMessagesByChannelAndAfterTimestampIDB bounds by channel and timestamp", async () => {
        const records = await getMessagesByChannelAndAfterTimestampIDB("200", "2026-01-01T00:00:00.000Z");

        expect(records).toHaveLength(2);

        const none = await getMessagesByChannelAndAfterTimestampIDB("999", "2026-01-01T00:00:00.000Z");
        expect(none).toHaveLength(0);
    });

    it("iterateAllMessagesIDB yields batches of the requested size", async () => {
        const sizes: number[] = [];
        for await (const batch of iterateAllMessagesIDB(3)) {
            sizes.push(batch.length);
        }

        expect(sizes).toEqual([3, 1]);
    });

    it("getDistinctLogEntities aggregates authors, guilds and channels", async () => {
        const entities = await getDistinctLogEntities();

        expect(entities.authors.map(a => a.id)).toEqual(["u1"]);
        expect(entities.guildIds).toEqual(["g1", "g2"]);
        expect(entities.channelIds).toEqual(["100", "200"]);
    });
});

describe("clearMessagesIDB disaster handling", () => {
    it("wipes everything and rebuilds the db", async () => {
        await addMessageRecordsIDB([makeRecord("80"), makeRecord("81")]);

        await clearMessagesIDB();

        expect(await countDb()).toBe(0);
        expect(cachedMessages.size).toBe(0);
    });

    it("falls back to chunked deletion when deleteDatabase fails", async () => {
        await addMessageRecordsIDB([makeRecord("82"), makeRecord("83")]);

        const spy = vi.spyOn(indexedDB, "deleteDatabase").mockImplementation(() => {
            const request: any = {};
            setTimeout(() => request.onerror?.(new Event("error")), 0);
            return request as IDBOpenDBRequest;
        });

        try {
            await clearMessagesIDB();
        } finally {
            spy.mockRestore();
        }

        expect(await countDb()).toBe(0);
    });
});
