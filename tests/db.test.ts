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
import type { LoggedMessageJSON } from "../types";
import { DB_NAME } from "../utils/constants";
import messageChanges, { type messageChangeEvent } from "../utils/messageChanges";
import {
    acquireAttachmentLease,
    clearAttachmentBlobCache,
    getAttachmentBlobStats,
    registerBlobUrlReleaser,
    resetAttachmentBlobCacheForTests,
    setAttachmentBlobCacheBudget
} from "../utils/saveImage";
import { getImage } from "../utils/saveImage/ImageManager";

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

beforeAll(async () => {
    await idb.dbReady;
    idb.connection.close();
    await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => resolve();
    });
    await idb.initIDB();
});

const revoked: string[] = [];
let urlCounter = 0;

function stubAttachmentUrls() {
    (URL as any).createObjectURL = vi.fn(() => `blob:aegis-url-${++urlCounter}`);
    registerBlobUrlReleaser(url => { revoked.push(url); });
}

beforeEach(async () => {
    await idb.clearMessagesIDB();

    stubAttachmentUrls();
    resetAttachmentBlobCacheForTests();
    setAttachmentBlobCacheBudget(2000);
    vi.mocked(getImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    urlCounter = 0;
    revoked.length = 0;
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

    it("idb.addMessageRecordsIDB rewrites an existing primary key instead of aborting the batch", async () => {
        await idb.addMessageIDB(makeMessage("50"), DBMessageStatus.DELETED);

        await idb.addMessageRecordsIDB([makeRecord("50"), makeRecord("51")]);

        expect(await countDb()).toBe(2);
    });

    it("idb.upsertMessageRecordsIDB reports how many records were inserted and how many already existed", async () => {
        await idb.addMessageIDB(makeMessage("60"), DBMessageStatus.DELETED);

        const first = await idb.upsertMessageRecordsIDB([makeRecord("60"), makeRecord("61")]);
        const second = await idb.upsertMessageRecordsIDB([makeRecord("60"), makeRecord("61")]);

        expect(first).toEqual({ inserted: 1, duplicates: 1 });
        expect(second).toEqual({ inserted: 0, duplicates: 2 });
        expect(await countDb()).toBe(2);
    });

    it("idb.upsertMessageRecordsIDB keeps the stored record untouched for duplicates", async () => {
        const existing = makeRecord("62");
        await idb.addMessageRecordsIDB([existing]);

        await idb.upsertMessageRecordsIDB([{ ...existing, message: makeMessage("62", { content: "replacement" }) }]);

        expect((await idb.getMessageIDB("62"))!.message.content).toBe("content-62");
    });
});

describe("idb.updateMessageIfCurrentIDB", () => {
    it("applies the mutation when the record version still matches", async () => {
        await idb.addMessageIDB(makeMessage("80", { content: "first" }), DBMessageStatus.DELETED);
        const record = await idb.getMessageIDB("80");

        const applied = await idb.updateMessageIfCurrentIDB("80", record!.version, message => { message.content = "changed"; });

        expect(applied).toBe(true);
        expect((await idb.getMessageIDB("80"))!.message.content).toBe("changed");
    });

    it("does nothing when the record was deleted meanwhile", async () => {
        await idb.addMessageIDB(makeMessage("81"), DBMessageStatus.DELETED);
        const record = await idb.getMessageIDB("81");
        await idb.deleteMessageIDB("81");

        const applied = await idb.updateMessageIfCurrentIDB("81", record!.version, message => { message.content = "resurrect"; });

        expect(applied).toBe(false);
        expect(await idb.getMessageIDB("81")).toBeUndefined();
    });

    it("does nothing when the record was rewritten with a new version", async () => {
        await idb.addMessageIDB(makeMessage("82", { content: "first" }), DBMessageStatus.DELETED);
        const record = await idb.getMessageIDB("82");
        await idb.addMessageIDB(makeMessage("82", { content: "second" }), DBMessageStatus.EDITED);

        const applied = await idb.updateMessageIfCurrentIDB("82", record!.version, message => { message.content = "stale"; });

        expect(applied).toBe(false);
        expect((await idb.getMessageIDB("82"))!.message.content).toBe("second");
    });

    it("does not let a stale task touch a re-created record with the same id", async () => {
        await idb.addMessageIDB(makeMessage("83", { content: "old" }), DBMessageStatus.DELETED);
        const stale = await idb.getMessageIDB("83");
        await idb.deleteMessageIDB("83");
        await idb.upsertMessageRecordsIDB([makeRecord("83", DBMessageStatus.DELETED)]);

        const applied = await idb.updateMessageIfCurrentIDB("83", stale!.version, message => { message.content = "polluted"; });

        expect(applied).toBe(false);
        expect((await idb.getMessageIDB("83"))!.message.content).toBe("content-83");
    });

    it("survives records written before the version field existed", async () => {
        await idb.connection.put("messages", makeRecord("84"));

        const record = await idb.getMessageIDB("84");
        expect(record!.version).toBeUndefined();

        const applied = await idb.updateMessageIfCurrentIDB("84", undefined, message => { message.content = "patched"; });

        expect(applied).toBe(true);
        expect((await idb.getMessageIDB("84"))!.message.content).toBe("patched");
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

    it("idb.enforceMessageLimitIDB trims the oldest rows beyond the limit", async () => {
        await idb.enforceMessageLimitIDB(2);

        expect(await countDb()).toBe(2);
        expect(await idb.getAllMessageIdsIDB()).toEqual(["72", "73"]);
    });

    it("idb.enforceMessageLimitIDB does nothing when the limit is disabled or already satisfied", async () => {
        expect(await idb.enforceMessageLimitIDB(0)).toBe(0);
        expect(await countDb()).toBe(4);

        expect(await idb.enforceMessageLimitIDB(4)).toBe(0);
        expect(await countDb()).toBe(4);
    });

    it("idb.enforceMessageLimitIDB reports how many records were evicted", async () => {
        const evicted = await idb.enforceMessageLimitIDB(2);

        expect(evicted).toBe(2);
        expect(await countDb()).toBe(2);
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
        const hydrate = vi.mocked(getImage);
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

    it("idb.getDateStortedMessagesByStatusIDB returns raw records without hydrating", async () => {
        await idb.addMessageRecordsIDB([
            makeRecord("92", DBMessageStatus.DELETED, { attachments: [{ id: "a3", url: "u3", proxy_url: "p3", filename: "c.png" }] }),
            makeRecord("93", DBMessageStatus.DELETED, { attachments: [{ id: "a4", url: "u4", proxy_url: "p4", filename: "d.png" }] })
        ]);
        const hydrate = vi.mocked(getImage);
        hydrate.mockClear();

        const records = await idb.getDateStortedMessagesByStatusIDB(true, 10, DBMessageStatus.DELETED);

        expect(records.some(r => r.message_id === "93")).toBe(true);
        expect(hydrate).not.toHaveBeenCalled();
        expect(records.flatMap(r => r.message.attachments.map(a => a.url))).toEqual(expect.arrayContaining(["u3", "u4"]));
    });

    it("idb.hydrateRecords touches exactly the records it is given", async () => {
        const hydrate = vi.mocked(getImage);
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
        const hydrate = vi.mocked(getImage);
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
        const hydrate = vi.mocked(getImage);
        hydrate.mockClear();

        const entities = await idb.getDistinctLogEntities();

        expect(entities.guildIds).toContain("g9");
        expect(hydrate).not.toHaveBeenCalled();
    });

    it("idb.getMessagesByChannelAndAfterTimestampIDB bounds by channel and timestamp", async () => {
        const hydrated = await idb.getMessagesByChannelAndAfterTimestampIDB("200", "2026-01-01T00:00:00.000Z");

        expect(hydrated.records).toHaveLength(2);
        hydrated.scope.release();

        const empty = await idb.getMessagesByChannelAndAfterTimestampIDB("999", "2026-01-01T00:00:00.000Z");
        expect(empty.records).toHaveLength(0);
        empty.scope.release();
    });

    it("idb.iterateRawMessagesIDB yields batches of the requested size", async () => {
        const sizes: number[] = [];
        for await (const batch of idb.iterateRawMessagesIDB(3)) {
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

describe("idb.hydrateRecords ownership", () => {
    const makeAttachments = (prefix: string, count: number): any[] =>
        Array.from({ length: count }, (_, index) => ({
            id: `${prefix}-${index}`,
            url: `u-${prefix}-${index}`,
            proxy_url: `p-${prefix}-${index}`,
            filename: `${prefix}-${index}.png`
        }));

    it("returns display copies with leased urls and leaves the given records untouched", async () => {
        const source = [
            makeRecord("101", DBMessageStatus.DELETED, { attachments: makeAttachments("own", 2) })
        ];

        const hydrated = await idb.hydrateRecords(source);

        expect(hydrated.records).not.toBe(source);
        expect(hydrated.records[0].message).not.toBe(source[0].message);
        expect(hydrated.records[0].message.attachments).not.toBe(source[0].message.attachments);
        expect(source[0].message.attachments.map(attachment => attachment.url)).toEqual(["u-own-0", "u-own-1"]);
        expect(hydrated.records[0].message.attachments.map(attachment => attachment.url)).toEqual(["blob:aegis-url-1#", "blob:aegis-url-2#"]);
        expect(hydrated.scope.size()).toBe(2);
        expect(revoked).toEqual([]);

        hydrated.scope.release();

        expect(getAttachmentBlobStats().held).toBe(0);
    });

    it("keeps the cached message free of temporary blob urls", async () => {
        await idb.addMessageRecordsIDB([makeRecord("102", DBMessageStatus.DELETED, { attachments: makeAttachments("cache", 1) })]);
        const stored = await idb.getMessageIDB("102");

        const hydrated = await idb.hydrateRecords([stored!]);

        expect(hydrated.records[0].message.attachments[0].url).toBe("blob:aegis-url-1#");
        expect(stored!.message.attachments[0].url).toBe("u-cache-0");
        expect(idb.cachedMessages.get("102")?.attachments[0].url).toBe("u-cache-0");

        hydrated.scope.release();
    });

    it("keeps every url valid when the cache budget is smaller than the batch", async () => {
        setAttachmentBlobCacheBudget(2);

        const first = await idb.hydrateRecords([makeRecord("110", DBMessageStatus.DELETED, { attachments: makeAttachments("small-a", 1) })]);
        const second = await idb.hydrateRecords([makeRecord("111", DBMessageStatus.DELETED, { attachments: makeAttachments("small-b", 2) })]);

        const urls = [...first.records, ...second.records].flatMap(record => record.message.attachments.map(attachment => attachment.url));

        expect(urls).toEqual(["blob:aegis-url-1#", "blob:aegis-url-2#", "blob:aegis-url-3#"]);
        expect(revoked).toEqual([]);
        expect(getAttachmentBlobStats().held).toBe(3);
        for (const url of urls) expect(acquireAttachmentLease(url.slice(0, -1))).not.toBeNull();

        first.scope.release();
        second.scope.release();
    });

    it("keeps all 3000 urls of a 1000 message batch valid", async () => {
        const source = Array.from({ length: 1000 }, (_, index) =>
            makeRecord(String(index), DBMessageStatus.DELETED, { attachments: makeAttachments(`bulk${index}`, 3) })
        );

        const hydrated = await idb.hydrateRecords(source);

        const attachments = hydrated.records.flatMap(record => record.message.attachments);
        expect(attachments).toHaveLength(3000);
        expect(attachments.every(attachment => attachment.url.startsWith("blob:"))).toBe(true);
        expect(revoked).toEqual([]);
        expect(getAttachmentBlobStats().held).toBe(3000);

        hydrated.scope.release();
    });

    it("releases everything it already acquired when the batch is cancelled midway", async () => {
        let reads = 0;

        vi.mocked(getImage).mockImplementation(async () => {
            reads++;

            return new Uint8Array([1]);
        });

        const hydrated = await idb.hydrateRecords(
            [makeRecord("120", DBMessageStatus.DELETED, { attachments: makeAttachments("cancel", 4) })],
            () => reads >= 4
        );

        expect(reads).toBe(4);
        expect(hydrated.scope.size()).toBe(0);
        expect(getAttachmentBlobStats().held).toBe(0);
        expect(revoked).toEqual([]);

        clearAttachmentBlobCache();

        expect(revoked).toHaveLength(4);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps a cancelled batch from publishing urls into its display copies", async () => {
        const hydrated = await idb.hydrateRecords(
            [makeRecord("121", DBMessageStatus.DELETED, { attachments: makeAttachments("early", 1) })],
            () => true
        );

        expect(hydrated.scope.size()).toBe(0);
        expect(hydrated.records[0].message.attachments[0].url).toBe("u-early-0");
    });
});

describe("idb change notifications", () => {
    function trackChanges() {
        const events: messageChangeEvent[] = [];
        const unsubscribe = messageChanges.subscribe(event => { events.push(event); });

        return { events, unsubscribe };
    }

    it("notifies the id that was just written", async () => {
        const { events, unsubscribe } = trackChanges();

        try {
            await idb.addMessageIDB(makeMessage("201") as any, DBMessageStatus.DELETED);

            expect(events).toEqual([{ ids: ["201"], cleared: false }]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies only the records a bulk upsert actually inserted", async () => {
        await idb.addMessageRecordsIDB([makeRecord("202")]);
        const { events, unsubscribe } = trackChanges();

        try {
            const result = await idb.upsertMessageRecordsIDB([makeRecord("202"), makeRecord("203")]);

            expect(result).toEqual({ inserted: 1, duplicates: 1 });
            expect(events).toEqual([{ ids: ["203"], cleared: false }]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies every record written in bulk", async () => {
        const { events, unsubscribe } = trackChanges();

        try {
            await idb.addMessageRecordsIDB([makeRecord("204"), makeRecord("205")]);

            expect(events).toEqual([{ ids: ["204", "205"], cleared: false }]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies a conditional update only when it was applied", async () => {
        await idb.addMessageRecordsIDB([makeRecord("206")]);
        const stored = (await idb.getMessageIDB("206"))!;
        const { events, unsubscribe } = trackChanges();

        try {
            const stale = await idb.updateMessageIfCurrentIDB("206", (stored.version ?? 0) - 1, message => { message.content = "stale"; });
            const applied = await idb.updateMessageIfCurrentIDB("206", stored.version, message => { message.content = "fresh"; });

            expect(stale).toBe(false);
            expect(applied).toBe(true);
            expect(events).toEqual([{ ids: ["206"], cleared: false }]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies single and bulk deletions", async () => {
        await idb.addMessageRecordsIDB([makeRecord("207"), makeRecord("208"), makeRecord("209")]);
        const { events, unsubscribe } = trackChanges();

        try {
            await idb.deleteMessageIDB("207");
            await idb.deleteMessagesBulkIDB(["208", "209"]);

            expect(events).toEqual([
                { ids: ["207"], cleared: false },
                { ids: ["208", "209"], cleared: false }
            ]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies the ids dropped by the message limit", async () => {
        await idb.addMessageRecordsIDB([makeRecord("210"), makeRecord("211"), makeRecord("212")]);
        const { events, unsubscribe } = trackChanges();

        try {
            const evicted = await idb.enforceMessageLimitIDB(1);

            expect(evicted).toBe(2);
            expect(events).toHaveLength(1);
            expect(events[0].cleared).toBe(false);
            expect(events[0].ids.sort()).toEqual(["210", "211"]);
        } finally {
            unsubscribe();
        }
    });

    it("notifies a clear instead of per record deletions", async () => {
        await idb.addMessageRecordsIDB([makeRecord("213")]);
        const { events, unsubscribe } = trackChanges();

        try {
            await idb.clearMessagesIDB();

            expect(events).toEqual([{ ids: [], cleared: true }]);
        } finally {
            unsubscribe();
        }
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
