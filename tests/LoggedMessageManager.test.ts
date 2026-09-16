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

vi.mock("../db", () => ({
    default: {
        addMessageIDB: vi.fn(async () => { }),
        deleteMessagesBulkIDB: vi.fn(async () => { }),
        getOldestMessagesIDB: vi.fn(async () => []),
        connection: { count: vi.fn(async () => 0) }
    },
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));

vi.mock("../utils", () => ({
    cleanupMessage: (m: any) => m,
    contentExcluded: vi.fn(() => false)
}));

vi.mock("../utils/saveImage", () => ({
    cacheMessageImages: vi.fn(async () => { })
}));

import idb, { DBMessageStatus } from "../db";
import { logger, settings } from "../index";
import { addMessage } from "../LoggedMessageManager";
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

beforeEach(() => {
    vi.clearAllMocks();
    settings.store.saveImages = false;
    settings.store.messageLimit = 0;
    settings.store.exclusionRules = "";
});

describe("addMessage", () => {
    it("stores the message with the given status", async () => {
        const message = makeMessage({ deleted: true });

        await addMessage(message, DBMessageStatus.DELETED);

        expect(vi.mocked(idb.addMessageIDB).mock.calls[0][0]).toBe(message);
        expect(vi.mocked(idb.addMessageIDB).mock.calls[0][1]).toBe(DBMessageStatus.DELETED);
        expect(contentExcluded).toHaveBeenCalledWith("hello", undefined, "100", "u1");
        expect(vi.mocked(cacheMessageImages)).not.toHaveBeenCalled();
    });

    it("skips storage and image caching entirely when the content is excluded", async () => {
        vi.mocked(contentExcluded).mockReturnValueOnce(true);

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(vi.mocked(idb.addMessageIDB)).not.toHaveBeenCalled();
        expect(vi.mocked(cacheMessageImages)).not.toHaveBeenCalled();
        expect(vi.mocked(idb.connection.count)).not.toHaveBeenCalled();
    });

    it("caches images only for deleted messages while saveImages is enabled", async () => {
        settings.store.saveImages = true;
        const message = makeMessage();

        await addMessage(message, DBMessageStatus.DELETED);

        expect(vi.mocked(cacheMessageImages)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(cacheMessageImages)).toHaveBeenCalledWith(message);

        settings.store.saveImages = false;
        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        settings.store.saveImages = true;
        await addMessage(makeMessage(), DBMessageStatus.EDITED);

        expect(vi.mocked(cacheMessageImages)).toHaveBeenCalledTimes(1);
    });

    it("never trims the database when messageLimit is 0", async () => {
        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(vi.mocked(idb.connection.count)).not.toHaveBeenCalled();
        expect(vi.mocked(idb.getOldestMessagesIDB)).not.toHaveBeenCalled();
        expect(vi.mocked(idb.deleteMessagesBulkIDB)).not.toHaveBeenCalled();
    });

    it("deletes exactly the surplus of oldest messages beyond the limit", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(idb.connection.count).mockResolvedValueOnce(150);
        vi.mocked(idb.getOldestMessagesIDB).mockResolvedValueOnce([
            { message_id: "a" },
            { message_id: "b" }
        ] as any);

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(vi.mocked(idb.getOldestMessagesIDB)).toHaveBeenCalledWith(50);
        expect(vi.mocked(idb.deleteMessagesBulkIDB)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(idb.deleteMessagesBulkIDB)).toHaveBeenCalledWith(["a", "b"]);
        expect(vi.mocked(logger.info)).toHaveBeenCalledWith("Deleting 50 oldest messages");
    });

    it("keeps everything when the count does not exceed the limit", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(idb.connection.count).mockResolvedValueOnce(100);

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(vi.mocked(idb.getOldestMessagesIDB)).not.toHaveBeenCalled();
        expect(vi.mocked(idb.deleteMessagesBulkIDB)).not.toHaveBeenCalled();
    });

    it("refuses to delete as many messages as the limit in one sweep", async () => {
        settings.store.messageLimit = 100;
        vi.mocked(idb.connection.count).mockResolvedValueOnce(200);

        await addMessage(makeMessage(), DBMessageStatus.DELETED);

        expect(vi.mocked(idb.getOldestMessagesIDB)).not.toHaveBeenCalled();
        expect(vi.mocked(idb.deleteMessagesBulkIDB)).not.toHaveBeenCalled();
    });

    it("propagates storage failures", async () => {
        vi.mocked(idb.addMessageIDB).mockRejectedValueOnce(new Error("quota exceeded"));

        await expect(addMessage(makeMessage(), DBMessageStatus.DELETED)).rejects.toThrow("quota exceeded");
    });
});
