/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

vi.mock("../utils/misc", async importOriginal => ({
    ...(await importOriginal<typeof import("../utils/misc")>()),
    messageJsonToMessageClass: (log: any) => log.message
}));

import { ChannelStore, MessageStore } from "@webpack/common";

import idb, { DBMessageStatus } from "../db";
import { settings } from "../index";
import chatBridge from "../utils/chatBridge";
import messageChanges from "../utils/messageChanges";
import pluginRuntime from "../utils/pluginRuntime";
import {
    acquireAttachmentLease,
    clearAttachmentBlobCache,
    getAttachmentBlobStats,
    registerBlobUrlReleaser,
    resetAttachmentBlobCacheForTests,
    settleAttachmentCache
} from "../utils/saveImage";
import { getImage } from "../utils/saveImage/ImageManager";

const BASE_TIME = Date.UTC(2026, 0, 1, 0, 0, 0);
const revoked: string[] = [];
let urlCounter = 0;
let fallbackGetMessage: any;

function makeAttachment(id: string) {
    return { id, fileExtension: ".png", url: `https://cdn/${id}.png`, proxy_url: `https://proxy/${id}.png`, filename: `${id}.png` };
}

function makeMessage(id: string, overrides: Record<string, any> = {}) {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(BASE_TIME + Number(id)).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: [],
        embeds: [],
        mentions: [],
        mention_everyone: false,
        deleted: true,
        ...overrides
    } as any;
}

function makeRecord(id: string, overrides: Record<string, any> = {}) {
    const message = makeMessage(id, overrides);

    return {
        message_id: message.id,
        channel_id: message.channel_id,
        status: DBMessageStatus.DELETED,
        message,
        timestamp: message.timestamp,
        timestampMs: Date.parse(message.timestamp)
    };
}

function makeResponse(ids: string[]) {
    return {
        ok: true,
        body: ids.map(id => ({ id, channel_id: "100", timestamp: new Date(BASE_TIME + Number(id)).toISOString(), author: { id: "u1" }, mentions: [], attachments: [] }))
    } as any;
}

function readMessage(id: string) {
    return (MessageStore.getMessage as any)("100", id);
}

function stubDocument(elements: any[]) {
    vi.stubGlobal("document", {
        body: {},
        querySelectorAll: () => elements
    });
}

function stubEnvironment() {
    (URL as any).createObjectURL = vi.fn(() => `blob:aegis-url-${++urlCounter}`);
    registerBlobUrlReleaser(url => { revoked.push(url); });

    vi.stubGlobal("MutationObserver", class {
        observe() { }
        disconnect() { }
    });

    stubDocument([]);
}

function pauseImageRead() {
    let release = () => { };

    vi.mocked(getImage).mockImplementation(() => new Promise<Uint8Array>(resolve => {
        release = () => resolve(new Uint8Array([1]));
    }));

    return () => release();
}

function pauseChatRead() {
    let release = () => { };
    const original = idb.getMessagesByChannelAndAfterTimestampIDB;

    const spy = vi.spyOn(idb, "getMessagesByChannelAndAfterTimestampIDB").mockImplementation(async (channelId: string, start: string, isCancelled?: () => boolean) => {
        await new Promise<void>(resolve => { release = resolve; });

        return original.call(idb, channelId, start, isCancelled);
    });

    return { release: () => release(), restore: () => spy.mockRestore() };
}

const tick = () => new Promise(resolve => setTimeout(resolve, 0));

beforeEach(async () => {
    settings.store.whitelistedIds = "";
    ChannelStore.getChannel = () => null;
    await idb.clearMessagesIDB();

    messageChanges.resetForTests();
    stubEnvironment();
    resetAttachmentBlobCacheForTests();
    vi.mocked(getImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
    urlCounter = 0;
    revoked.length = 0;

    fallbackGetMessage = vi.fn(() => null);
    MessageStore.getMessage = fallbackGetMessage;
});

afterEach(() => {
    chatBridge.stop();
    pluginRuntime.stop();
    MessageStore.getMessage = fallbackGetMessage;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe("chat cache invalidation", () => {
    it("stops serving the cached copy once the record changed", async () => {
        await idb.addMessageIDB(makeMessage("901", { content: "old" }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse(["901"]));

        expect(chatBridge.stats().messages).toBe(1);
        expect(readMessage("901")?.content).toBe("old");

        await idb.addMessageIDB(makeMessage("901", { content: "updated" }), DBMessageStatus.DELETED);

        expect(chatBridge.stats().messages).toBe(0);
        expect(readMessage("901")?.content).toBe("updated");
    });

    it("stops serving a deleted record", async () => {
        await idb.addMessageIDB(makeMessage("902"), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse(["902"]));

        expect(chatBridge.stats().messages).toBe(1);

        await idb.deleteMessageIDB("902");

        expect(chatBridge.stats().messages).toBe(0);
        expect(readMessage("902")).toBeNull();
        expect(fallbackGetMessage).toHaveBeenCalledWith("100", "902");
    });

    it("invalidates on bulk delete, limit trim and clear", async () => {
        await idb.addMessageRecordsIDB([makeRecord("903"), makeRecord("904"), makeRecord("905")]);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse(["900"]));

        expect(chatBridge.stats().messages).toBe(3);

        await idb.deleteMessagesBulkIDB(["903"]);
        expect(chatBridge.stats().messages).toBe(2);

        await idb.enforceMessageLimitIDB(1);
        expect(chatBridge.stats().messages).toBe(1);

        await idb.clearMessagesIDB();
        expect(chatBridge.stats().messages).toBe(0);
        expect(readMessage("905")).toBeNull();
    });

    it("keeps a rendered preview alive while the cached copy is invalidated", async () => {
        await idb.addMessageIDB(makeMessage("906", { attachments: [makeAttachment("a906")] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse(["906"]));

        const displayUrl = readMessage("906").attachments[0].url;
        const row = { props: { src: displayUrl } };

        chatBridge.holdAttachment(row);

        await idb.deleteMessageIDB("906");
        clearAttachmentBlobCache();

        expect(chatBridge.stats().messages).toBe(0);
        expect(chatBridge.stats().holders).toBe(1);
        expect(revoked).toEqual([]);

        chatBridge.releaseAttachment(row);

        expect(revoked).toEqual([displayUrl.slice(0, -1)]);
    });

    it("does not publish a read that finished after the database was cleared", async () => {
        await idb.addMessageIDB(makeMessage("907", { attachments: [makeAttachment("a907")] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        let releaseImage = () => { };
        vi.mocked(getImage).mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { releaseImage = () => resolve(new Uint8Array([1])); }));

        const response = makeResponse(["907"]);
        const pending = chatBridge.processMessageFetch(response);

        await tick();

        await idb.clearMessagesIDB();

        releaseImage();
        await pending;

        expect(response.body.extra).toBeUndefined();
        expect(chatBridge.stats()).toEqual({ messages: 0, holders: 0 });

        clearAttachmentBlobCache();
        await settleAttachmentCache();
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });
});

describe("plugin runtime generations", () => {
    it("drops a request that was still reading when the plugin stopped", async () => {
        await idb.addMessageIDB(makeMessage("908", { attachments: [makeAttachment("a908")] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        const paused = pauseChatRead();
        const response = makeResponse(["908"]);
        const pending = chatBridge.processMessageFetch(response);

        await tick();

        chatBridge.stop();
        pluginRuntime.stop();
        clearAttachmentBlobCache();

        paused.release();
        await pending;

        paused.restore();

        expect(response.body.extra).toBeUndefined();
        expect(chatBridge.stats()).toEqual({ messages: 0, holders: 0 });
        await settleAttachmentCache();
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps the old result out of the new run", async () => {
        await idb.addMessageIDB(makeMessage("909"), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        const paused = pauseChatRead();
        const staleResponse = makeResponse(["909"]);
        const stale = chatBridge.processMessageFetch(staleResponse);

        await tick();

        chatBridge.stop();
        pluginRuntime.stop();

        pluginRuntime.start();
        chatBridge.start();

        paused.release();

        await stale;
        paused.restore();

        expect(staleResponse.body.extra).toBeUndefined();

        const freshResponse = makeResponse(["909"]);
        await chatBridge.processMessageFetch(freshResponse);

        expect(chatBridge.stats().messages).toBe(1);
        expect((freshResponse.body as any).extra).toHaveLength(1);
    });

    it("keeps a valid request working while another one is invalidated", async () => {
        await idb.addMessageRecordsIDB([makeRecord("910"), makeRecord("911")]);
        pluginRuntime.start();
        chatBridge.start();

        const paused = pauseChatRead();
        const staleResponse = makeResponse(["910"]);
        const stale = chatBridge.processMessageFetch(staleResponse);

        await tick();

        await idb.clearMessagesIDB();

        paused.release();
        await stale;
        paused.restore();

        expect(staleResponse.body.extra).toBeUndefined();

        await idb.addMessageIDB(makeMessage("912"), DBMessageStatus.DELETED);

        const freshResponse = makeResponse(["912"]);
        await chatBridge.processMessageFetch(freshResponse);

        expect(chatBridge.stats().messages).toBe(1);
    });
});

describe("change history truncation", () => {
    it("drops a stale result once its change evidence was evicted", async () => {
        await idb.addMessageIDB(makeMessage("930", { attachments: [makeAttachment("a930")] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        messageChanges.setHistoryLimit(2);

        const releaseImage = pauseImageRead();
        const response = makeResponse(["930"]);
        const pending = chatBridge.processMessageFetch(response);

        await tick();

        await idb.deleteMessageIDB("930");
        await idb.addMessageRecordsIDB([makeRecord("931"), makeRecord("932")]);
        await idb.deleteMessagesBulkIDB(["931", "932"]);

        releaseImage();
        await pending;

        expect(await idb.countMessagesIDB()).toBe(0);
        expect(chatBridge.stats()).toEqual({ messages: 0, holders: 0 });
        expect(response.body.extra).toBeUndefined();
        expect(readMessage("930")).toBeNull();

        clearAttachmentBlobCache();
        await settleAttachmentCache();
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("rejects a stale result after a 5001 record batch delete", async () => {
        const total = 5001;
        const ids = ["940"];

        for (let index = 1; index < total; index++) ids.push(String(4000 + index));

        await idb.addMessageRecordsIDB([makeRecord("940", { attachments: [makeAttachment("a940")] })]);
        pluginRuntime.start();
        chatBridge.start();

        const releaseImage = pauseImageRead();
        const response = makeResponse(["900"]);
        const pending = chatBridge.processMessageFetch(response);

        await tick();

        await idb.deleteMessagesBulkIDB(ids);

        releaseImage();
        await pending;

        expect(await idb.countMessagesIDB()).toBe(0);
        expect(chatBridge.stats()).toEqual({ messages: 0, holders: 0 });
        expect(response.body.extra).toBeUndefined();
        expect(readMessage("940")).toBeNull();

        clearAttachmentBlobCache();
        await settleAttachmentCache();
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps an independent consumer while the stale request is dropped", async () => {
        await idb.addMessageIDB(makeMessage("950", { attachments: [makeAttachment("a950")] }), DBMessageStatus.DELETED);
        await idb.addMessageIDB(makeMessage("951", { attachments: [makeAttachment("a951")] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse(["950"]));

        const displayUrl = readMessage("950").attachments[0].url;
        const row = { props: { src: displayUrl } };
        chatBridge.holdAttachment(row);

        messageChanges.setHistoryLimit(2);

        clearAttachmentBlobCache();

        const releaseImage = pauseImageRead();
        const response = makeResponse(["951"]);
        const pending = chatBridge.processMessageFetch(response);

        await tick();

        await idb.deleteMessageIDB("951");
        await idb.addMessageRecordsIDB([makeRecord("952"), makeRecord("953")]);
        await idb.deleteMessagesBulkIDB(["952", "953"]);

        releaseImage();
        await pending;

        expect(response.body.extra).toBeUndefined();
        expect(chatBridge.stats()).toEqual({ messages: 1, holders: 1 });
        expect(readMessage("951")).toBeNull();
        expect(readMessage("950")?.content).toBe("content-950");
        expect(revoked).not.toContain(displayUrl.slice(0, -1));

        const probe = acquireAttachmentLease(displayUrl);
        expect(probe).not.toBeNull();
        probe!.release();

        chatBridge.releaseAttachment(row);

        expect(revoked).not.toContain(displayUrl.slice(0, -1));

        await idb.deleteMessageIDB("950");

        expect(revoked).toContain(displayUrl.slice(0, -1));
        expect(revoked).toHaveLength(2);
    });

    it("rejects an old request but lets a new one read the rewritten record", async () => {
        await idb.addMessageIDB(makeMessage("960", { content: "first" }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        const paused = pauseChatRead();
        const staleResponse = makeResponse(["960"]);
        const stale = chatBridge.processMessageFetch(staleResponse);

        await tick();

        await idb.clearMessagesIDB();
        await idb.addMessageIDB(makeMessage("960", { content: "rewritten" }), DBMessageStatus.DELETED);

        paused.release();
        await stale;
        paused.restore();

        expect(staleResponse.body.extra).toBeUndefined();
        expect(chatBridge.stats().messages).toBe(0);

        const freshResponse = makeResponse(["960"]);
        await chatBridge.processMessageFetch(freshResponse);

        expect(readMessage("960")?.content).toBe("rewritten");
        expect(chatBridge.stats().messages).toBe(1);
    });
});

describe("lease sweeping against the document", () => {
    async function holdRenderedAttachment(id: string) {
        await idb.addMessageIDB(makeMessage(id, { attachments: [makeAttachment(`a${id}`)] }), DBMessageStatus.DELETED);
        pluginRuntime.start();
        chatBridge.start();

        await chatBridge.processMessageFetch(makeResponse([id]));

        const displayUrl = readMessage(id).attachments[0].url;
        const row = { props: { src: displayUrl } };

        chatBridge.holdAttachment(row);

        return { row, displayUrl };
    }

    it("keeps the lease of a display url that is still rendered", async () => {
        const { displayUrl } = await holdRenderedAttachment("913");

        stubDocument([{ getAttribute: () => displayUrl, currentSrc: "" }]);

        pluginRuntime.stop();
        chatBridge.stop();

        expect(chatBridge.stats().holders).toBe(1);
        expect(revoked).toEqual([]);
    });

    it("drops the lease once nothing renders the address anymore", async () => {
        const { displayUrl } = await holdRenderedAttachment("914");

        stubDocument([]);

        pluginRuntime.stop();
        chatBridge.stop();

        expect(chatBridge.stats().holders).toBe(0);
        expect(revoked).toEqual([]);

        clearAttachmentBlobCache();
        await settleAttachmentCache();

        expect(revoked).toEqual([displayUrl.slice(0, -1)]);
    });

    it("keeps the lease when the document only renders a mangled form of the url", async () => {
        const { displayUrl } = await holdRenderedAttachment("915");
        const raw = displayUrl.slice(0, -1);

        stubDocument([
            { getAttribute: () => `${raw}?format=webp#`, currentSrc: "" },
            { getAttribute: () => "https://cdn/other.png", currentSrc: "https://cdn/other.png" }
        ]);

        pluginRuntime.stop();
        chatBridge.stop();

        expect(chatBridge.stats().holders).toBe(1);
        expect(revoked).toEqual([]);

        stubDocument([]);
        chatBridge.stop();

        expect(chatBridge.stats().holders).toBe(0);

        clearAttachmentBlobCache();
        await settleAttachmentCache();

        expect(revoked).toEqual([raw]);
    });
});


describe("whitelist replay boundaries", () => {
    it("keeps old outside records in storage without projecting them into chat", async () => {
        await idb.addMessageIDB(makeMessage("970", { guildId: "outside", attachments: [makeAttachment("outside-image")] }), DBMessageStatus.GHOST_PINGED);
        settings.store.whitelistedIds = "allowed-one,allowed-two";
        pluginRuntime.start();
        chatBridge.start();
        const response = makeResponse(["970"]);
        await chatBridge.processMessageFetch(response);
        expect(response.body.extra).toBeUndefined();
        expect(readMessage("970")).toBeNull();
        expect(chatBridge.stats().messages).toBe(0);
        expect((await idb.getMessageIDB("970"))?.message.guildId).toBe("outside");
    });

    it("recovers legacy allowed context from the same channel response without rewriting the record", async () => {
        await idb.addMessageIDB(makeMessage("971"), DBMessageStatus.DELETED);
        settings.store.whitelistedIds = "allowed-one,allowed-two";
        pluginRuntime.start();
        chatBridge.start();
        const response = makeResponse(["971"]);
        response.body[0].guild_id = "allowed-one";
        await chatBridge.processMessageFetch(response);
        expect(response.body.extra).toHaveLength(1);
        expect(readMessage("971")?.content).toBe("content-971");
        expect((await idb.getMessageIDB("971"))?.message.guildId).toBeUndefined();
    });

    it("stops serving an adopted record after the whitelist changes", async () => {
        await idb.addMessageIDB(makeMessage("972", { guildId: "allowed-one" }), DBMessageStatus.DELETED);
        settings.store.whitelistedIds = "allowed-one,allowed-two";
        pluginRuntime.start();
        chatBridge.start();
        await chatBridge.processMessageFetch(makeResponse(["972"]));
        expect(readMessage("972")?.content).toBe("content-972");
        settings.store.whitelistedIds = "allowed-two";
        expect(readMessage("972")).toBeNull();
        expect(await idb.getMessageIDB("972")).toBeDefined();
    });
});
