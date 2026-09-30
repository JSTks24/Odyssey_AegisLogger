/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { beforeEach, describe, expect, it, vi } from "vitest";

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

import idb, { DBMessageStatus } from "../db";
import chatAttachments from "../utils/chatAttachments";
import {
    acquireAttachmentBlobUrl,
    acquireAttachmentLease,
    clearAttachmentBlobCache,
    createLeaseScope,
    displayAttachmentUrl,
    getAttachmentBlobStats,
    registerBlobUrlReleaser,
    resetAttachmentBlobCacheForTests,
    setAttachmentBlobCacheBudget,
    settleAttachmentCache
} from "../utils/saveImage";
import { getImage } from "../utils/saveImage/ImageManager";

const revoked: string[] = [];
let urlCounter = 0;

function stubUrl() {
    (URL as any).createObjectURL = vi.fn(() => `blob:aegis-url-${++urlCounter}`);
    registerBlobUrlReleaser(url => { revoked.push(url); });
}

function makeAttachment(id: string) {
    return { id, fileExtension: ".png", url: `https://cdn/${id}.png`, proxy_url: `https://proxy/${id}.png`, filename: `${id}.png` } as any;
}

function makeDisplayMessage(messageId: string, attachment: any, url: string) {
    return {
        id: messageId,
        channel_id: "100",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "alice" },
        content: messageId,
        attachments: [{ ...attachment, url: `${url}#`, proxy_url: `${url}#` }]
    } as any;
}

function makeLogRecord(messageId: string, attachmentId: string) {
    const message = makeDisplayMessage(messageId, makeAttachment(attachmentId), "https://cdn/stored.png");
    return { message_id: messageId, channel_id: "100", status: DBMessageStatus.DELETED, message } as any;
}

async function holdInScope(messageId: string, attachmentId: string) {
    const scope = createLeaseScope();
    const lease = await acquireAttachmentBlobUrl(makeAttachment(attachmentId));

    scope.hold(messageId, lease!);

    return { scope, lease: lease! };
}

function expectLeasable(url: string) {
    const lease = acquireAttachmentLease(url);

    expect(lease).not.toBeNull();
    lease!.release();
}

beforeEach(() => {
    vi.clearAllMocks();
    stubUrl();
    resetAttachmentBlobCacheForTests();
    setAttachmentBlobCacheBudget(2000);
    vi.mocked(getImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    urlCounter = 0;
    revoked.length = 0;
});

describe("chat message lease store", () => {
    it("moves the leases of a fetch result into the store and empties the request scope", async () => {
        const store = chatAttachments.createMessageLeaseStore(1000);
        const { scope, lease } = await holdInScope("m1", "a1");

        store.adopt(scope, [{ messageId: "m1", message: makeDisplayMessage("m1", makeAttachment("a1"), lease.url) }]);

        expect(scope.size()).toBe(0);
        expect(store.size()).toBe(1);
        expect(store.get("m1")?.message.id).toBe("m1");
        expect(getAttachmentBlobStats().held).toBe(1);

        store.invalidateAll();

        expect(revoked).toEqual([]);
        expectLeasable(lease.url);
    });

    it("drops the display copy and its lease when a message leaves the store", async () => {
        const store = chatAttachments.createMessageLeaseStore(1);
        const first = await holdInScope("m1", "a1");
        const second = await holdInScope("m2", "a2");

        store.adopt(first.scope, [{ messageId: "m1", message: makeDisplayMessage("m1", makeAttachment("a1"), first.lease.url) }]);
        store.adopt(second.scope, [{ messageId: "m2", message: makeDisplayMessage("m2", makeAttachment("a2"), second.lease.url) }]);

        expect(store.get("m1")).toBeUndefined();
        expect(store.get("m2")).not.toBeUndefined();
        expect(getAttachmentBlobStats().held).toBe(1);

        clearAttachmentBlobCache();

        expect(revoked).toEqual([first.lease.url]);

        store.invalidateAll();
    });

    it("replaces the leases of a message that is fetched again", async () => {
        const store = chatAttachments.createMessageLeaseStore(1000);
        const first = await holdInScope("m1", "a1");
        const second = await holdInScope("m1", "a2");

        store.adopt(first.scope, [{ messageId: "m1", message: makeDisplayMessage("m1", makeAttachment("a1"), first.lease.url) }]);
        store.adopt(second.scope, [{ messageId: "m1", message: makeDisplayMessage("m1", makeAttachment("a2"), second.lease.url) }]);

        expect(store.size()).toBe(1);
        expect(getAttachmentBlobStats().held).toBe(1);
        expect(store.get("m1")?.message.attachments[0].id).toBe("a2");

        store.invalidateAll();
        clearAttachmentBlobCache();

        expect(revoked).toHaveLength(2);
    });
});

describe("chat attachment holders", () => {
    it("holds a lease for a rendered blob url and releases it on unmount", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const { scope, lease } = await holdInScope("m1", "a1");

        holders.hold(row, lease.url);

        expect(holders.size()).toBe(1);
        expect(getAttachmentBlobStats().held).toBe(2);

        scope.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);
        expectLeasable(lease.url);

        holders.release(row);

        expect(holders.size()).toBe(0);
        expect(revoked).toEqual([lease.url]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("ignores urls that are not served by the manager", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};

        holders.hold(row, "https://cdn/a.png");
        holders.hold(row, undefined);
        holders.hold(row, "blob:aegis-unknown");

        expect(holders.size()).toBe(0);

        const { scope, lease } = await holdInScope("m1", "a1");
        const other = {};

        holders.hold(other, lease.url);
        scope.release();
        lease.release();

        expect(holders.size()).toBe(1);

        holders.release(other);
        clearAttachmentBlobCache();

        holders.hold(row, lease.url);

        expect(holders.size()).toBe(0);
        expect(revoked).toEqual([lease.url]);
    });

    it("sweeps the leases whose url is no longer referenced", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const preview = {};
        const first = await holdInScope("m1", "a1");
        const second = await holdInScope("m2", "a2");

        holders.hold(row, first.lease.url);
        holders.hold(preview, second.lease.url);

        const released = holders.sweep(url => url === second.lease.url);

        expect(released).toBe(1);
        expect(holders.size()).toBe(1);
        expect(revoked).toEqual([]);
        expectLeasable(first.lease.url);

        expect(holders.sweep(() => false)).toBe(1);
        expect(holders.size()).toBe(0);

        first.scope.release();
        first.lease.release();
        second.scope.release();
        second.lease.release();
        clearAttachmentBlobCache();

        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps every lease that is still referenced", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const first = await holdInScope("m1", "a1");
        const second = await holdInScope("m2", "a2");

        holders.hold({}, first.lease.url);
        holders.hold({}, second.lease.url);

        expect(holders.sweep(() => true)).toBe(0);
        expect(holders.size()).toBe(2);

        holders.sweep(() => false);
        first.scope.release();
        first.lease.release();
        second.scope.release();
        second.lease.release();
    });

    it("swaps the lease when the rendered url changes and keeps the old holder untouched", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const first = await holdInScope("m1", "a1");
        const second = await holdInScope("m2", "a2");

        holders.hold(row, first.lease.url);
        holders.refresh(row, first.lease.url, second.lease.url);

        expect(holders.size()).toBe(1);
        expect(getAttachmentBlobStats().held).toBe(3);

        first.scope.release();
        first.lease.release();
        clearAttachmentBlobCache();

        expect(revoked).toContain(first.lease.url);
        expectLeasable(second.lease.url);

        holders.release(row);
        second.scope.release();
        second.lease.release();
    });
});

describe("display urls coming from hydration", () => {
    it("leases the hydrated display url so a chat row keeps it alive", async () => {
        const hydrated = await idb.hydrateRecords([makeLogRecord("m-display", "a-display")]);
        const displayUrl = hydrated.records[0].message.attachments[0].url;

        expect(displayUrl.slice(0, -1)).toBe("blob:aegis-url-1");

        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const preview = {};

        holders.hold(row, displayUrl);

        expect(holders.size()).toBe(1);

        hydrated.scope.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);

        holders.hold(preview, displayUrl);

        expect(holders.size()).toBe(2);

        holders.release(row);

        expect(revoked).toEqual([]);

        holders.release(preview);

        expect(revoked).toEqual(["blob:aegis-url-1"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps the resource when one holder uses the raw url and another the display url", async () => {
        const hydrated = await idb.hydrateRecords([makeLogRecord("m-mixed", "a-mixed")]);
        const displayUrl = hydrated.records[0].message.attachments[0].url;
        const holders = chatAttachments.createChatAttachmentHolders();
        const raw = {};
        const display = {};

        holders.hold(raw, displayUrl.slice(0, -1));
        holders.hold(display, displayUrl);

        expect(holders.size()).toBe(2);

        hydrated.scope.release();
        clearAttachmentBlobCache();

        holders.release(raw);

        expect(revoked).toEqual([]);
        expectLeasable(displayUrl);

        holders.release(display);

        expect(revoked).toEqual(["blob:aegis-url-1"]);
    });

    it("ignores addresses that are not served by the manager", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};

        holders.hold(row, "blob:not-ours");
        holders.hold(row, "https://cdn/a.png");

        expect(holders.size()).toBe(0);
    });

    it("holds the same resource when a downstream component mangles the display url", async () => {
        const hydrated = await idb.hydrateRecords([makeLogRecord("m-mangled", "a-mangled")]);
        const displayUrl = hydrated.records[0].message.attachments[0].url;
        const holders = chatAttachments.createChatAttachmentHolders();
        const directAppend = {};
        const reSerialized = {};

        holders.hold(directAppend, `${displayUrl}?format=webp`);
        holders.hold(reSerialized, `${displayUrl.slice(0, -1)}?format=webp#`);

        expect(holders.size()).toBe(2);
        expect(getAttachmentBlobStats().held).toBe(3);

        hydrated.scope.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);

        holders.release(directAppend);
        expectLeasable(displayUrl);

        holders.release(reSerialized);

        expect(revoked).toEqual(["blob:aegis-url-1"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });
});

describe("chat attachment holders swapping addresses", () => {
    it("releases the old lease when the component switches to a plain url", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const held = await holdInScope("m-swap", "a-swap");

        holders.hold(row, held.lease.url);
        held.scope.release();
        clearAttachmentBlobCache();

        holders.refresh(row, held.lease.url, "https://cdn/a.png");

        expect(holders.size()).toBe(0);
        expect(revoked).toEqual([held.lease.url]);
    });

    it("releases the old lease for undefined, null and unknown blob addresses", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();

        for (const next of [undefined, null, "blob:not-ours"]) {
            const row = {};
            const held = await holdInScope("m-drop", "a-drop");

            holders.hold(row, held.lease.url);
            held.scope.release();
            clearAttachmentBlobCache();

            holders.refresh(row, held.lease.url, next);

            expect(holders.size()).toBe(0);
            expect(revoked).toEqual([held.lease.url]);

            revoked.length = 0;
        }
    });

    it("protects the new resource before dropping the old one", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const first = await holdInScope("m-first", "a-first");
        const second = await holdInScope("m-second", "a-second");

        holders.hold(row, first.lease.url);

        first.scope.release();
        first.lease.release();
        clearAttachmentBlobCache();

        holders.refresh(row, first.lease.url, second.lease.url);

        expect(holders.size()).toBe(1);
        expect(revoked).toEqual([first.lease.url]);
        expect(acquireAttachmentLease(second.lease.url)).not.toBeNull();

        holders.release(row);
        second.scope.release();
        second.lease.release();
    });

    it("keeps the resource when only the display form changes", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const held = await holdInScope("m-form", "a-form");

        holders.hold(row, held.lease.url);
        held.scope.release();
        clearAttachmentBlobCache();

        holders.refresh(row, held.lease.url, displayAttachmentUrl(held.lease.url));

        expect(holders.size()).toBe(1);
        expect(revoked).toEqual([]);
        expect(acquireAttachmentLease(held.lease.url)).not.toBeNull();

        holders.release(row);
        held.lease.release();
    });

    it("keeps the reference count stable on repeated refresh and unmount", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const row = {};
        const held = await holdInScope("m-stable", "a-stable");

        holders.hold(row, held.lease.url);
        holders.refresh(row, held.lease.url, held.lease.url);
        holders.refresh(row, "blob:other", held.lease.url);

        expect(holders.size()).toBe(1);
        expect(getAttachmentBlobStats().held).toBe(2);

        held.scope.release();
        clearAttachmentBlobCache();

        holders.release(row);
        holders.release(row);

        expect(revoked).toEqual([held.lease.url]);
        held.lease.release();
    });
});

describe("repeated hydration of the same records", () => {
    it("keeps one lease per hydration and releases each independently", async () => {
        const records = [makeLogRecord("m-duplicate", "a-duplicate")];
        const first = await idb.hydrateRecords(records);

        expect(getAttachmentBlobStats().held).toBe(1);

        const second = await idb.hydrateRecords(records);

        expect(getAttachmentBlobStats().held).toBe(2);
        expect(revoked).toEqual([]);

        second.scope.release();

        expect(getAttachmentBlobStats().held).toBe(1);
        expect(revoked).toEqual([]);

        first.scope.release();
        clearAttachmentBlobCache();
        await settleAttachmentCache();

        expect(revoked).toEqual(["blob:aegis-url-1"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps the older page resource alive when a later generation is hydrated", async () => {
        const records = [makeLogRecord("m-generation", "a-generation")];
        const first = await idb.hydrateRecords(records);
        const oldUrl = first.records[0].message.attachments[0].url;

        clearAttachmentBlobCache();

        const second = await idb.hydrateRecords(records);
        const newUrl = second.records[0].message.attachments[0].url;

        expect(newUrl).not.toBe(oldUrl);
        expect(getAttachmentBlobStats().held).toBe(2);
        expect(revoked).toEqual([]);

        second.scope.release();
        clearAttachmentBlobCache();
        await settleAttachmentCache();

        expect(revoked).toEqual([newUrl.slice(0, -1)]);
        expectLeasable(oldUrl);

        first.scope.release();
        clearAttachmentBlobCache();
        await settleAttachmentCache();

        expect(revoked).toEqual([newUrl.slice(0, -1), oldUrl.slice(0, -1)]);
    });
});

describe("attachment lifecycle across consumers", () => {
    it("keeps a chat attachment alive while the log loads thousands of other attachments", async () => {
        const store = chatAttachments.createMessageLeaseStore(1000);
        const { scope, lease } = await holdInScope("m-chat", "chat");

        store.adopt(scope, [{ messageId: "m-chat", message: makeDisplayMessage("m-chat", makeAttachment("chat"), lease.url) }]);

        for (let index = 0; index < 2500; index++) {
            const page = await idb.hydrateRecords([makeLogRecord(`log-${index}`, `bulk-${index}`)]);

            page.scope.release();
        }

        expect(revoked).not.toContain(lease.url);
        expect(store.get("m-chat")?.message.attachments[0].url).toBe(`${lease.url}#`);
        expectLeasable(lease.url);
        expect(getAttachmentBlobStats().held).toBe(1);

        store.invalidateAll();
        clearAttachmentBlobCache();

        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("survives closing either the log page or the chat store while the other still needs the attachment", async () => {
        const store = chatAttachments.createMessageLeaseStore(1000);
        const holders = chatAttachments.createChatAttachmentHolders();
        const preview = {};
        const chat = await holdInScope("m1", "shared");
        const log = await holdInScope("m2", "shared");

        expect(log.lease.url).toBe(chat.lease.url);

        store.adopt(chat.scope, [{ messageId: "m1", message: makeDisplayMessage("m1", makeAttachment("shared"), chat.lease.url) }]);

        log.scope.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);
        expect(store.get("m1")?.message.attachments[0].url).toBe(`${chat.lease.url}#`);

        holders.hold(preview, chat.lease.url);
        store.invalidateAll();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);
        expectLeasable(chat.lease.url);

        holders.release(preview);
        clearAttachmentBlobCache();

        expect(revoked).toEqual([chat.lease.url]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("hands a switched image directory a new resource while old consumers stay valid", async () => {
        const holders = chatAttachments.createChatAttachmentHolders();
        const preview = {};
        const before = await holdInScope("m1", "same");

        holders.hold(preview, before.lease.url);
        clearAttachmentBlobCache();

        const after = await holdInScope("m2", "same");

        expect(after.lease.url).not.toBe(before.lease.url);
        expectLeasable(before.lease.url);
        expectLeasable(after.lease.url);

        holders.release(preview);
        before.scope.release();
        before.lease.release();
        after.scope.release();
        after.lease.release();
        clearAttachmentBlobCache();

        expect(revoked).toHaveLength(2);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps the live resource count tied to the real consumers over many rounds", async () => {
        const store = chatAttachments.createMessageLeaseStore(1000);
        const holders = chatAttachments.createChatAttachmentHolders();

        for (let round = 0; round < 5; round++) {
            const preview = {};
            const { scope, lease } = await holdInScope(`m-${round}`, `round-${round}`);

            store.adopt(scope, [{ messageId: `m-${round}`, message: makeDisplayMessage(`m-${round}`, makeAttachment(`round-${round}`), lease.url) }]);

            holders.hold(preview, store.get(`m-${round}`)!.message.attachments[0].url);
            holders.release(preview);
        }

        expect(holders.size()).toBe(0);
        expect(store.size()).toBe(5);
        expect(getAttachmentBlobStats().held).toBe(5);

        store.invalidateAll();

        expect(getAttachmentBlobStats().held).toBe(0);

        clearAttachmentBlobCache();

        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("treats switching pages as a lease handover without revoking the displayed page", async () => {
        const first = await holdInScope("m1", "page-a");
        const second = await holdInScope("m2", "page-b");

        second.scope.release();
        second.lease.release();

        expectLeasable(first.lease.url);
        expect(revoked).toEqual([]);

        first.scope.release();
        first.lease.release();
        clearAttachmentBlobCache();

        expect(revoked).toHaveLength(2);
    });
});
