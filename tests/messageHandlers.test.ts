/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { store: { saveImages: false, messageLimit: 0 } }
}));

vi.mock("../utils", () => ({
    cleanupMessage: (message: any) => message,
    cleanUpCachedMessage: (message: any) => message,
    contentExcluded: vi.fn(() => false),
    getIdList: vi.fn(() => []),
    hasPingged: vi.fn(() => false),
    isGhostPinged: vi.fn(() => false),
    shouldIgnore: vi.fn(() => false)
}));

vi.mock("../utils/saveImage", () => ({
    cacheMessageImages: vi.fn(async () => { })
}));

vi.mock("../db", () => ({
    default: {
        getMessageIDB: vi.fn(async () => undefined),
        addMessageIDB: vi.fn(async () => { }),
        updateMessageIfCurrentIDB: vi.fn(async () => false),
        enforceMessageLimitIDB: vi.fn(async () => 0)
    },
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));

import idb, { DBMessageStatus } from "../db";
import { settings } from "../index";
import { flushWrites } from "../LoggedMessageManager";
import messageHandlers, { cacheSentMessages } from "../messageHandlers";
import { cacheMessageImages } from "../utils/saveImage";

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

function makeMessage(id: string, overrides: Record<string, any> = {}) {
    return {
        id,
        channel_id: "100",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        ...overrides
    } as any;
}

function trackWrites() {
    const writtenById = new Map<string, any>();
    const order: { id: string; status: DBMessageStatus; message: any; }[] = [];

    vi.mocked(idb.getMessageIDB).mockImplementation(async (id: string) => writtenById.get(id));
    vi.mocked(idb.addMessageIDB).mockImplementation(async (message: any, status: DBMessageStatus) => {
        writtenById.set(message.id, { message_id: message.id, message, status });
        order.push({ id: message.id, status, message });
    });

    return { writtenById, order };
}

beforeEach(() => {
    vi.clearAllMocks();
    cacheSentMessages.clear();
    messageHandlers.setCacheLimit(1000);
    messageHandlers.setGetMessage(null);
});

describe("messageUpdateHandler ordering", () => {
    it("keeps a later delete from overtaking an edit whose record read is still pending", async () => {
        let releaseEditRead: (value: any) => void = () => { };
        let editReadDone = false;
        const editReadGate = new Promise<any>(resolve => {
            releaseEditRead = value => { editReadDone = true; resolve(value); };
        });
        const { order } = trackWrites();

        vi.mocked(idb.getMessageIDB).mockImplementationOnce(() => editReadGate);
        messageHandlers.setGetMessage(() => editReadDone
            ? makeMessage("1", { editHistory: [{ content: "content-1", timestamp: "2026-01-02T00:00:00.000Z" }] })
            : null);

        messageHandlers.messageCreateHandler({ channelId: "100", message: makeMessage("1") } as any);

        const editPromise = messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "1", content: "content-1 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);
        await tick();

        expect(idb.getMessageIDB).toHaveBeenCalledTimes(1);

        const deletePromise = messageHandlers.messageDeleteHandler({ type: "MESSAGE_DELETE", channelId: "100", id: "1" } as any);
        await tick();

        expect(idb.addMessageIDB).not.toHaveBeenCalled();

        releaseEditRead(undefined);
        await Promise.all([editPromise, deletePromise]);
        await flushWrites();

        expect(order).toHaveLength(2);
        expect(order[0].status).toBe(DBMessageStatus.EDITED);
        expect(order[1].status).toBe(DBMessageStatus.DELETED);

        const final = order[1].message;
        expect(final.deleted).toBe(true);
        expect(final.editHistory).toEqual([{ content: "content-1", timestamp: "2026-01-02T00:00:00.000Z" }]);
    });

    it("serializes consecutive edits of the same message", async () => {
        const { order } = trackWrites();

        messageHandlers.setGetMessage(() => makeMessage("2", {
            editHistory: [{ content: "content-2", timestamp: "2026-01-02T00:00:00.000Z" }]
        }));

        await messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "2", content: "content-2 a", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);

        messageHandlers.setGetMessage(() => makeMessage("2", {
            editHistory: [
                { content: "content-2", timestamp: "2026-01-02T00:00:00.000Z" },
                { content: "content-2 a", timestamp: "2026-01-03T00:00:00.000Z" }
            ]
        }));

        await messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "2", content: "content-2 b", edited_timestamp: "2026-01-03T00:00:00.000Z" }
        } as any);
        await flushWrites();

        expect(order.map(write => write.status)).toEqual([DBMessageStatus.EDITED, DBMessageStatus.EDITED]);
        expect(order[1].message.editHistory).toHaveLength(2);
    });

    it("does not let a bulk delete overtake a paused edit", async () => {
        let releaseEditRead: (value: any) => void = () => { };
        let editReadDone = false;
        const editReadGate = new Promise<any>(resolve => {
            releaseEditRead = value => { editReadDone = true; resolve(value); };
        });
        const { writtenById, order } = trackWrites();

        vi.mocked(idb.getMessageIDB).mockImplementationOnce(() => editReadGate);
        messageHandlers.setGetMessage((_channelId: string, messageId: string) => editReadDone && messageId === "3"
            ? makeMessage("3", { editHistory: [{ content: "content-3", timestamp: "2026-01-02T00:00:00.000Z" }] })
            : null);

        messageHandlers.messageCreateHandler({ channelId: "100", message: makeMessage("3") } as any);
        messageHandlers.messageCreateHandler({ channelId: "100", message: makeMessage("4") } as any);

        const editPromise = messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "3", content: "content-3 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);
        await tick();

        const bulkPromise = messageHandlers.messageDeleteBulkHandler({ channelId: "100", guildId: undefined, ids: ["3", "4"] } as any);
        await tick();

        expect(writtenById.get("3")).toBeUndefined();

        releaseEditRead(undefined);
        await Promise.all([editPromise, bulkPromise]);
        await flushWrites();

        const statusesById = new Map(order.map(write => [write.id, write.status]));
        expect(statusesById.get("3")).toBe(DBMessageStatus.DELETED);
        expect(statusesById.get("4")).toBe(DBMessageStatus.DELETED);
    });

    it("reconciles the deleted flag with the status on commit", async () => {
        const { order } = trackWrites();

        messageHandlers.setGetMessage(() => makeMessage("6", {
            deleted: true,
            editHistory: [{ content: "content-6", timestamp: "2026-01-02T00:00:00.000Z" }]
        }));

        await messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "6", content: "content-6 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);
        await flushWrites();

        expect(order).toHaveLength(1);
        expect(order[0].status).toBe(DBMessageStatus.EDITED);
        expect(order[0].message.deleted).toBe(false);
    });

    it("schedules the attachment backfill only when the edit was persisted", async () => {
        settings.store.saveImages = true;
        settings.store.messageLimit = 100;
        const { order } = trackWrites();

        messageHandlers.setGetMessage(() => null);

        await messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "5", content: "content-5", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);
        await flushWrites();

        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(cacheMessageImages).not.toHaveBeenCalled();
        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
        expect(idb.getMessageIDB).toHaveBeenCalledTimes(1);
        expect(order).toHaveLength(0);
        settings.store.saveImages = false;
        settings.store.messageLimit = 0;
    });

    it("enforces the message limit after a persisted edit", async () => {
        settings.store.messageLimit = 100;
        const { order } = trackWrites();

        messageHandlers.setGetMessage(() => makeMessage("7", {
            editHistory: [{ content: "content-7", timestamp: "2026-01-02T00:00:00.000Z" }]
        }));

        await messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "7", content: "content-7 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any);

        expect(order).toHaveLength(1);
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledTimes(1);
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
        settings.store.messageLimit = 0;
    });

    it("waits for the message limit enforcement before the edit handler settles", async () => {
        settings.store.messageLimit = 100;
        trackWrites();

        let releaseTrim: (value: number) => void = () => { };
        const trimGate = new Promise<number>(resolve => { releaseTrim = value => resolve(value); });
        vi.mocked(idb.enforceMessageLimitIDB).mockImplementationOnce(() => trimGate);

        messageHandlers.setGetMessage(() => makeMessage("8", {
            editHistory: [{ content: "content-8", timestamp: "2026-01-02T00:00:00.000Z" }]
        }));

        let settled = false;
        const tracked = messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "8", content: "content-8 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any).then(() => { settled = true; });

        await tick();
        await tick();

        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
        expect(settled).toBe(false);

        releaseTrim(0);
        await tracked;

        expect(settled).toBe(true);
        settings.store.messageLimit = 0;
    });

    it("propagates a message limit failure instead of reporting a completed edit", async () => {
        settings.store.messageLimit = 100;
        const { order } = trackWrites();
        vi.mocked(idb.enforceMessageLimitIDB).mockRejectedValueOnce(new Error("trim failed"));

        messageHandlers.setGetMessage(() => makeMessage("9", {
            editHistory: [{ content: "content-9", timestamp: "2026-01-02T00:00:00.000Z" }]
        }));

        await expect(messageHandlers.messageUpdateHandler({
            message: { channel_id: "100", id: "9", content: "content-9 edited", edited_timestamp: "2026-01-02T00:00:00.000Z" }
        } as any)).rejects.toThrow("trim failed");

        expect(order).toHaveLength(1);
        settings.store.messageLimit = 0;
    });
});

describe("setCacheLimit", () => {
    it("trims the sent message cache in insertion order when the limit is lowered", () => {
        for (let i = 0; i < 150; i++) cacheSentMessages.set(`c${i}`, makeMessage(`c${i}`));

        messageHandlers.setCacheLimit(100);

        expect(cacheSentMessages.size).toBe(100);
        expect(cacheSentMessages.has("c0")).toBe(false);
        expect(cacheSentMessages.has("c49")).toBe(false);
        expect(cacheSentMessages.has("c50")).toBe(true);
        expect(cacheSentMessages.has("c149")).toBe(true);
    });

    it("keeps messages beyond the old fixed 1000 boundary when a larger limit is configured", () => {
        messageHandlers.setCacheLimit(5000);

        for (let i = 0; i < 1500; i++) cacheSentMessages.set(`c${i}`, makeMessage(`c${i}`));

        expect(cacheSentMessages.size).toBe(1500);
        expect(cacheSentMessages.has("c0")).toBe(true);
        expect(cacheSentMessages.has("c1499")).toBe(true);
    });

    it("treats zero as unlimited", () => {
        messageHandlers.setCacheLimit(0);

        for (let i = 0; i < 1500; i++) cacheSentMessages.set(`c${i}`, makeMessage(`c${i}`));

        expect(cacheSentMessages.size).toBe(1500);
    });

    it("evicts while inserting once a small limit is active", () => {
        messageHandlers.setCacheLimit(100);

        for (let i = 0; i < 150; i++) cacheSentMessages.set(`c${i}`, makeMessage(`c${i}`));

        expect(cacheSentMessages.size).toBe(100);
        expect(cacheSentMessages.has("c0")).toBe(false);
        expect(cacheSentMessages.has("c149")).toBe(true);
    });
});
