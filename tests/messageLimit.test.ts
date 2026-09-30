/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    settings: {
        store: {
            cacheLimit: 1000,
            messageLimit: 0,
            saveImages: false,
            exclusionRules: "",
            whitelistedIds: "",
            blacklistedIds: "",
            ignoreSelf: false,
            ignoreBots: false,
            ignoreMutedGuilds: false,
            ignoreMutedCategories: false,
            ignoreMutedChannels: false,
            alwaysLogDirectMessages: false,
            alwaysLogCurrentChannel: false
        }
    }
}));

vi.mock("../utils/saveImage", () => ({
    acquireAttachmentBlobUrl: vi.fn(async () => null),
    acquireAttachmentLease: vi.fn(() => null),
    createLeaseScope: () => ({ hold: vi.fn(), take: () => new Map(), releaseRecords: vi.fn(), release: vi.fn(), size: () => 0 }),
    displayAttachmentUrl: (url: string) => `${url}#`,
    normalizeAttachmentUrl: (url: string) => (url.endsWith("#") ? url.slice(0, -1) : url),
    clearAttachmentBlobCache: vi.fn(),
    registerBlobUrlReleaser: vi.fn(),
    settleAttachmentCache: vi.fn(async () => { }),
    getAttachmentBlobStats: vi.fn(() => ({ cached: 0, live: 0, inflight: 0, held: 0 })),
    cacheMessageImages: vi.fn(async () => { })
}));

vi.mock("@webpack", async importOriginal => ({
    ...(await importOriginal<Record<string, unknown>>()),
    findByPropsLazy: () => ({ getOrCreate: () => new Map<string, any>(), commit: () => { } })
}));

import idb, { DBMessageStatus } from "../db";
import { settings } from "../index";
import { addMessage, flushWrites } from "../LoggedMessageManager";
import messageHandlers, { cacheSentMessages } from "../messageHandlers";
import { cacheMessageImages } from "../utils/saveImage";
import searchIndex from "../utils/searchIndex";

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);

function makeMessage(id: string, index: number, overrides: Record<string, any> = {}) {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(BASE_TIME + index * 1000).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_everyone: false,
        ...overrides
    } as any;
}

function editHistoryFor(id: string, index: number) {
    return [{ content: `${id}-original`, timestamp: new Date(BASE_TIME + index * 1000 - 500).toISOString() }];
}

function editPayload(id: string, index: number, content = `content-${id}`) {
    return {
        message: {
            channel_id: "100",
            id,
            content,
            edited_timestamp: new Date(BASE_TIME + index * 1000 + 500).toISOString()
        }
    } as any;
}

const editMessage = (id: string, index: number, content?: string) =>
    messageHandlers.messageUpdateHandler(editPayload(id, index, content));

function provideMessages(ids: string[]) {
    messageHandlers.setGetMessage((_channelId: string, messageId: string) => {
        const index = ids.indexOf(messageId);
        if (index === -1) return null;
        return makeMessage(messageId, index, { editHistory: editHistoryFor(messageId, index) });
    });
}

const seedRecord = (id: string, index: number) => idb.addMessageIDB(makeMessage(id, index), DBMessageStatus.DELETED);

const rawKeys = () => idb.getAllMessageIdsIDB();

const rawRecord = (id: string) => idb.connection.get("messages", id);

function indexedIds() {
    const ids: string[] = [];
    searchIndex.forEach(entry => ids.push(entry.id));
    return ids;
}

function indexedContents() {
    const contents = new Map<string, string>();
    searchIndex.forEach(entry => contents.set(entry.id, entry.content));
    return contents;
}

beforeAll(async () => {
    await idb.dbReady;
});

beforeEach(async () => {
    vi.clearAllMocks();
    vi.mocked(cacheMessageImages).mockImplementation(async () => { });

    await idb.clearMessagesIDB();
    await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB(2000));

    settings.store.messageLimit = 0;
    settings.store.saveImages = false;
    settings.store.exclusionRules = "";
    cacheSentMessages.clear();
    messageHandlers.setCacheLimit(1000);
    messageHandlers.setGetMessage(null);
});

describe("messageLimit through the edit entry", () => {
    it("keeps exactly the newest 100 records after 101 edits", async () => {
        settings.store.messageLimit = 100;

        const ids = Array.from({ length: 101 }, (_, i) => String(1000 + i));
        provideMessages(ids);

        for (let i = 0; i < ids.length; i++) await editMessage(ids[i], i);

        expect(await idb.countMessagesIDB()).toBe(100);

        const keys = await rawKeys();
        expect(keys).toHaveLength(100);
        expect(keys).not.toContain(ids[0]);
        expect(keys).toContain(ids[100]);
        expect(await rawRecord(ids[0])).toBeUndefined();

        const indexed = indexedIds();
        expect(indexed).toHaveLength(100);
        expect(indexed).not.toContain(ids[0]);
        expect(indexed).toContain(ids[100]);

        expect(idb.cachedMessages.has(ids[0])).toBe(false);
        expect(idb.cachedMessages.has(ids[100])).toBe(true);
    });

    it("keeps every record and index entry when the limit is disabled", async () => {
        settings.store.messageLimit = 0;

        const ids = Array.from({ length: 101 }, (_, i) => String(1200 + i));
        provideMessages(ids);

        for (let i = 0; i < ids.length; i++) await editMessage(ids[i], i);

        expect(await idb.countMessagesIDB()).toBe(101);
        expect(await rawKeys()).toHaveLength(101);
        expect(indexedIds()).toHaveLength(101);
        expect(indexedIds()).toContain(ids[0]);
    });

    it("trims on messageLimit even when the sent message cache limit is larger", async () => {
        settings.store.messageLimit = 5;
        messageHandlers.setCacheLimit(5000);

        const ids = Array.from({ length: 6 }, (_, i) => String(1700 + i));
        provideMessages(ids);

        for (let i = 0; i < ids.length; i++) await editMessage(ids[i], i);

        expect(await idb.countMessagesIDB()).toBe(5);
        expect(await rawRecord(ids[0])).toBeUndefined();
        expect(indexedIds()).toHaveLength(5);
    });

    it("keeps every record when only the sent message cache limit changes", async () => {
        settings.store.messageLimit = 0;
        messageHandlers.setCacheLimit(2);

        const ids = Array.from({ length: 5 }, (_, i) => String(1900 + i));
        provideMessages(ids);

        for (let i = 0; i < ids.length; i++) await editMessage(ids[i], i);

        expect(cacheSentMessages.size).toBe(0);
        expect(await idb.countMessagesIDB()).toBe(5);
        expect(await rawKeys()).toHaveLength(5);
        expect(indexedIds()).toHaveLength(5);
    });

    it("settles concurrent edits of different messages without exceeding the limit", async () => {
        settings.store.messageLimit = 100;

        const ids = Array.from({ length: 120 }, (_, i) => String(1800 + i));
        provideMessages(ids);

        await Promise.all(ids.map((id, i) => editMessage(id, i)));

        expect(await idb.countMessagesIDB()).toBe(100);

        const keys = await rawKeys();
        expect(keys).not.toContain(ids[0]);
        expect(keys).not.toContain(ids[19]);
        expect(keys).toContain(ids[20]);
        expect(keys).toContain(ids[119]);

        expect(indexedIds()).toHaveLength(100);
    });

    it("keeps a single record for repeated edits of the same message", async () => {
        settings.store.messageLimit = 100;
        const id = "2000";

        for (let i = 0; i < 5; i++) {
            messageHandlers.setGetMessage(() => makeMessage(id, 0, {
                content: `content-${id}-${i}`,
                editHistory: editHistoryFor(id, 0)
            }));
            await editMessage(id, 0, `content-${id}-${i}`);
        }

        expect(await idb.countMessagesIDB()).toBe(1);

        const record = await rawRecord(id);
        expect(record?.message.content).toBe(`content-${id}-4`);
        expect(indexedIds()).toEqual([id]);
        expect(indexedContents().get(id)).toBe(`content-${id}-4`);
    });

    it("does not run the post-write processing when the edit is excluded", async () => {
        settings.store.messageLimit = 5;
        settings.store.exclusionRules = "excluded-content";

        for (let i = 0; i < 6; i++) await seedRecord(String(1300 + i), i);
        expect(await idb.countMessagesIDB()).toBe(6);

        await messageHandlers.messageUpdateHandler({
            message: {
                channel_id: "100",
                id: "1400",
                content: "excluded-content here",
                author: { id: "u1", username: "alice" },
                edited_timestamp: new Date(BASE_TIME + 60_000).toISOString()
            }
        } as any);

        expect(await idb.countMessagesIDB()).toBe(6);
        expect(await rawRecord("1400")).toBeUndefined();
        expect(indexedIds()).toHaveLength(6);

        settings.store.exclusionRules = "";
        await addMessage(makeMessage("1401", 7), DBMessageStatus.DELETED);

        expect(await idb.countMessagesIDB()).toBe(5);
        expect(indexedIds()).toHaveLength(5);
        expect(await rawRecord("1400")).toBeUndefined();
    });

    it("does not run the post-write processing when the edit produces no change", async () => {
        settings.store.messageLimit = 5;

        for (let i = 0; i < 6; i++) await seedRecord(String(1600 + i), i);

        messageHandlers.setGetMessage(() => null);
        await messageHandlers.messageUpdateHandler({
            message: {
                channel_id: "100",
                id: "1600",
                content: "content-1600",
                author: { id: "u1", username: "alice" },
                edited_timestamp: new Date(BASE_TIME + 60_000).toISOString()
            }
        } as any);

        expect(await idb.countMessagesIDB()).toBe(6);
        expect(indexedIds()).toHaveLength(6);
    });

    it("does not run the post-write processing when the write itself fails", async () => {
        settings.store.messageLimit = 1;

        await seedRecord("2400", 0);
        await seedRecord("2401", 1);
        expect(await idb.countMessagesIDB()).toBe(2);

        const broken = makeMessage("2402", 2, {
            attachments: [{ id: "a1", filename: "broken.png", unserializable: () => { } }]
        });

        await expect(addMessage(broken, DBMessageStatus.DELETED)).rejects.toThrow();

        expect(await idb.countMessagesIDB()).toBe(2);
        expect(await rawRecord("2402")).toBeUndefined();
        expect(indexedIds()).toHaveLength(2);

        await addMessage(makeMessage("2403", 3), DBMessageStatus.DELETED);

        expect(await idb.countMessagesIDB()).toBe(1);
        expect(await rawRecord("2400")).toBeUndefined();
        expect(await rawRecord("2401")).toBeUndefined();
        expect(await rawRecord("2403")).toBeDefined();
        expect(indexedIds()).toEqual(["2403"]);
    });
});

describe("messageLimit through the delete entries", () => {
    it("enforces the limit after a single delete and after a bulk delete", async () => {
        settings.store.messageLimit = 3;

        for (let i = 0; i < 3; i++) await seedRecord(String(2100 + i), i);

        const deleted = new Map([["2200", 3], ["2201", 4]]);
        messageHandlers.setGetMessage((_channelId: string, messageId: string) => {
            const index = deleted.get(messageId);
            return index == null ? null : makeMessage(messageId, index, { deleted: true });
        });

        await messageHandlers.messageDeleteHandler({ type: "MESSAGE_DELETE", channelId: "100", id: "2200" } as any);

        expect(await idb.countMessagesIDB()).toBe(3);
        expect(await rawRecord("2100")).toBeUndefined();
        expect(await rawRecord("2200")).toBeDefined();

        await messageHandlers.messageDeleteBulkHandler({ channelId: "100", guildId: undefined, ids: ["2201"] } as any);

        expect(await idb.countMessagesIDB()).toBe(3);
        expect(await rawRecord("2101")).toBeUndefined();
        expect(await rawRecord("2201")).toBeDefined();
        expect(indexedIds()).toHaveLength(3);
    });
});

describe("trimming against in-flight attachment downloads", () => {
    it("does not resurrect a trimmed record when its download finishes late", async () => {
        settings.store.saveImages = true;
        settings.store.messageLimit = 1;

        let releaseDownload: () => void = () => { };
        const downloadGate = new Promise<void>(resolve => { releaseDownload = resolve; });
        vi.mocked(cacheMessageImages).mockImplementation(async () => { await downloadGate; });

        const oldest = "2300";
        await addMessage(makeMessage(oldest, 0, {
            attachments: [{ id: "a1", filename: "gone.png", content_type: "image/png", deleted: true }]
        }), DBMessageStatus.EDITED);

        await vi.waitFor(() => expect(cacheMessageImages).toHaveBeenCalledTimes(1));

        const version = (await rawRecord(oldest))?.version;
        const updateSpy = vi.spyOn(idb, "updateMessageIfCurrentIDB");

        await addMessage(makeMessage("2301", 1), DBMessageStatus.DELETED);

        expect(await idb.countMessagesIDB()).toBe(1);
        expect(await rawRecord(oldest)).toBeUndefined();
        expect(indexedIds()).toEqual(["2301"]);

        releaseDownload();
        await flushWrites();

        expect(updateSpy).toHaveBeenCalledTimes(1);
        expect(updateSpy).toHaveBeenCalledWith(oldest, version, expect.any(Function));

        expect(await idb.countMessagesIDB()).toBe(1);
        expect(await rawRecord(oldest)).toBeUndefined();
        expect(indexedIds()).toEqual(["2301"]);

        updateSpy.mockRestore();
    });
});
