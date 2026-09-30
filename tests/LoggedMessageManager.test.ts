/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { store: { saveImages: false, messageLimit: 0, exclusionRules: "" } }
}));

vi.mock("../utils", () => ({
    cleanupMessage: (message: any) => message,
    contentExcluded: vi.fn(() => false)
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

import idb, { type DBMessageRecord, DBMessageStatus } from "../db";
import { settings } from "../index";
import { addMessage, finalizeMessageWrite, flushWrites } from "../LoggedMessageManager";
import { contentExcluded } from "../utils";
import { cacheMessageImages } from "../utils/saveImage";

function makeMessage(overrides: Record<string, any> = {}) {
    return {
        id: "1",
        channel_id: "100",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "alice" },
        content: "hello",
        attachments: [],
        embeds: [],
        ...overrides
    } as any;
}

function makeRecord(overrides: Record<string, any> = {}): DBMessageRecord {
    return {
        message_id: "1",
        channel_id: "100",
        status: DBMessageStatus.DELETED,
        timestamp: "2026-01-01T00:00:00.000Z",
        timestampMs: Date.parse("2026-01-01T00:00:00.000Z"),
        message: makeMessage(overrides),
        ...overrides
    } as DBMessageRecord;
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

const persisted = () => vi.mocked(idb.addMessageIDB).mock.calls;
const lastSnapshot = () => vi.mocked(cacheMessageImages).mock.calls.at(-1) as [any, any];

beforeEach(() => {
    vi.clearAllMocks();
    settings.store.saveImages = false;
    settings.store.messageLimit = 0;
    vi.mocked(idb.getMessageIDB).mockResolvedValue(undefined);
});

describe("addMessage", () => {
    it("stores the message with the given status", async () => {
        const message = makeMessage({ deleted: true });

        await addMessage(message, DBMessageStatus.DELETED);

        expect(persisted()[0][0]).toEqual({ ...message, editHistory: [] });
        expect(persisted()[0][1]).toBe(DBMessageStatus.DELETED);
        expect(contentExcluded).toHaveBeenCalledWith("hello", undefined, "100", "u1");
    });

    it("skips storage and image caching entirely when the content is excluded", async () => {
        settings.store.saveImages = true;
        settings.store.messageLimit = 100;
        vi.mocked(contentExcluded).mockReturnValueOnce(true);

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(cacheMessageImages).not.toHaveBeenCalled();
        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
    });

    it("does not run the post-write processing when the inner exclusion check filters the message", async () => {
        settings.store.saveImages = true;
        settings.store.messageLimit = 100;
        vi.mocked(contentExcluded).mockReturnValueOnce(false).mockReturnValueOnce(true);

        await addMessage(makeMessage({ attachments: [{ id: "a1" }] }), DBMessageStatus.DELETED);
        await flushWrites();

        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(cacheMessageImages).not.toHaveBeenCalled();
        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
    });

    it("merges the stored edit history when the same message is logged again", async () => {
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({
            editHistory: [{ content: "older", timestamp: "2026-01-01T00:00:00.000Z" }]
        }));

        await addMessage(makeMessage({
            editHistory: [{ content: "newer", timestamp: "2026-01-02T00:00:00.000Z" }]
        }), DBMessageStatus.EDITED);

        expect(persisted()[0][0].editHistory).toEqual([
            { content: "older", timestamp: "2026-01-01T00:00:00.000Z" },
            { content: "newer", timestamp: "2026-01-02T00:00:00.000Z" }
        ]);
    });

    it("keeps the attachment metadata that is already stored", async () => {
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({
            attachments: [{ id: "a1", filename: "a.png", path: "/cache/a1.png" }]
        }));

        await addMessage(makeMessage({ attachments: [{ id: "a1", filename: "a.png" }] }), DBMessageStatus.DELETED);

        expect(persisted()[0][0].attachments[0].path).toBe("/cache/a1.png");
    });

    it("caches images for deleted messages while saveImages is enabled", async () => {
        settings.store.saveImages = true;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({ attachments: [{ id: "a1" }] }));

        await addMessage(makeMessage({ attachments: [{ id: "a1" }] }), DBMessageStatus.DELETED);
        await flushWrites();

        expect(cacheMessageImages).toHaveBeenCalledTimes(1);
        expect(lastSnapshot()[1]).toBeUndefined();
    });

    it("does not cache anything while saveImages is disabled", async () => {
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({ attachments: [{ id: "a1", deleted: true }] }));

        await addMessage(makeMessage({ attachments: [{ id: "a1", deleted: true }] }), DBMessageStatus.EDITED);
        await flushWrites();

        expect(cacheMessageImages).not.toHaveBeenCalled();
    });

    it("caches only the removed attachments for edited messages", async () => {
        settings.store.saveImages = true;
        const kept = { id: "a1", filename: "kept.png" } as any;
        const removed = { id: "a2", filename: "removed.png", deleted: true } as any;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({ status: DBMessageStatus.EDITED, attachments: [kept, removed] }));

        await addMessage(makeMessage({ attachments: [kept, removed] }), DBMessageStatus.EDITED);
        await flushWrites();

        expect(cacheMessageImages).toHaveBeenCalledTimes(1);

        const [snapshot, filter] = lastSnapshot();
        expect(snapshot.attachments).toEqual([{ ...removed }]);
        expect(filter).toBeUndefined();
    });

    it("never caches images for ghost pings", async () => {
        settings.store.saveImages = true;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({
            status: DBMessageStatus.GHOST_PINGED,
            attachments: [{ id: "a1" }]
        }));

        await addMessage(makeMessage({ attachments: [{ id: "a1" }] }), DBMessageStatus.GHOST_PINGED);
        await flushWrites();

        expect(cacheMessageImages).not.toHaveBeenCalled();
    });

    it("applies downloaded attachment metadata through a version guarded update", async () => {
        settings.store.saveImages = true;
        const stored = makeRecord({ attachments: [{ id: "a1", filename: "a.png" }] });
        stored.version = 7;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(stored);
        vi.mocked(cacheMessageImages).mockImplementationOnce(async (message: any) => {
            message.attachments[0].path = "/cache/a1.png";
            message.attachments[0].fileExtension = ".png";
        });
        vi.mocked(idb.updateMessageIfCurrentIDB).mockImplementation(async (_id, _version, mutate) => {
            mutate(stored.message);
            return true;
        });

        await addMessage(makeMessage({ attachments: [{ id: "a1", filename: "a.png" }] }), DBMessageStatus.DELETED);
        await flushWrites();

        expect(idb.updateMessageIfCurrentIDB).toHaveBeenCalledWith("1", 7, expect.any(Function));
        expect(stored.message.attachments[0].path).toBe("/cache/a1.png");
        expect(persisted()).toHaveLength(1);
    });

    it("captures the record version before the download and only backfills through the conditional update", async () => {
        settings.store.saveImages = true;
        const stored = makeRecord({ attachments: [{ id: "a1" }] });
        stored.version = 42;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(stored);

        await addMessage(makeMessage({ attachments: [{ id: "a1" }] }), DBMessageStatus.DELETED);
        await flushWrites();

        expect(cacheMessageImages).toHaveBeenCalledTimes(1);
        expect(idb.updateMessageIfCurrentIDB).toHaveBeenCalledTimes(1);
        expect(idb.updateMessageIfCurrentIDB).toHaveBeenCalledWith("1", 42, expect.any(Function));
        expect(persisted()).toHaveLength(1);
    });

    it("does not schedule a backfill when no attachment needs downloading", async () => {
        settings.store.saveImages = true;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({ attachments: [{ id: "a1", path: "/cache/a1.png" }] }));

        await addMessage(makeMessage({ attachments: [{ id: "a1", path: "/cache/a1.png" }] }), DBMessageStatus.DELETED);
        await flushWrites();

        expect(cacheMessageImages).not.toHaveBeenCalled();
        expect(idb.updateMessageIfCurrentIDB).not.toHaveBeenCalled();
    });

    it("leaves the message limit untouched when it is disabled", async () => {
        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
    });

    it("enforces the configured message limit after every write", async () => {
        settings.store.messageLimit = 100;

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledTimes(1);
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
    });

    it("propagates storage failures", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(idb.addMessageIDB).mockRejectedValueOnce(new Error("quota exceeded"));

        await expect(addMessage(makeMessage(), DBMessageStatus.DELETED)).rejects.toThrow("quota exceeded");

        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
        expect(cacheMessageImages).not.toHaveBeenCalled();
    });

    it("waits for the message limit enforcement before the write is reported as complete", async () => {
        settings.store.messageLimit = 100;

        let releaseTrim: (value: number) => void = () => { };
        const trimGate = new Promise<number>(resolve => { releaseTrim = value => resolve(value); });
        vi.mocked(idb.enforceMessageLimitIDB).mockImplementationOnce(() => trimGate);

        let settled = false;
        const tracked = addMessage(makeMessage(), DBMessageStatus.DELETED).then(() => { settled = true; });

        await tick();
        await tick();

        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
        expect(settled).toBe(false);

        releaseTrim(0);
        await tracked;

        expect(settled).toBe(true);
    });
});

describe("finalizeMessageWrite", () => {
    it("schedules the attachment backfill and enforces the limit in one pass", async () => {
        settings.store.saveImages = true;
        settings.store.messageLimit = 100;
        vi.mocked(idb.getMessageIDB).mockResolvedValue(makeRecord({ attachments: [{ id: "a1" }] }));

        await finalizeMessageWrite("1");
        await flushWrites();

        expect(cacheMessageImages).toHaveBeenCalledTimes(1);
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledTimes(1);
        expect(idb.enforceMessageLimitIDB).toHaveBeenCalledWith(100);
    });

    it("skips the trim while the limit is disabled", async () => {
        await finalizeMessageWrite("1");

        expect(idb.enforceMessageLimitIDB).not.toHaveBeenCalled();
    });

    it("does not resolve before the trim completes", async () => {
        settings.store.messageLimit = 100;

        let releaseTrim: (value: number) => void = () => { };
        const trimGate = new Promise<number>(resolve => { releaseTrim = value => resolve(value); });
        vi.mocked(idb.enforceMessageLimitIDB).mockImplementationOnce(() => trimGate);

        let settled = false;
        const tracked = finalizeMessageWrite("1").then(() => { settled = true; });

        await tick();
        await tick();

        expect(settled).toBe(false);

        releaseTrim(0);
        await tracked;

        expect(settled).toBe(true);
    });

    it("propagates a trim failure instead of swallowing it", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(idb.enforceMessageLimitIDB).mockRejectedValueOnce(new Error("trim failed"));

        await expect(finalizeMessageWrite("1")).rejects.toThrow("trim failed");
    });
});
