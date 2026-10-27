/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ records: new Map<string, any>(), native: new Map<string, any>(), downloads: vi.fn() }));

vi.mock("../index", () => ({ settings: { store: {} }, logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));
vi.mock("@webpack", () => ({
    findByPropsLazy: () => ({ getOrCreate: () => state.native, commit: vi.fn() }),
    findStoreLazy: () => ({ isMuted: () => false, isCategoryMuted: () => false, isChannelMuted: () => false }),
    findLazy: () => undefined,
    findByCodeLazy: () => () => undefined
}));
vi.mock("../utils/saveImage", () => ({ cacheMessageImages: state.downloads }));
vi.mock("../components/LogsModal", () => ({ default: { openLogModal: vi.fn() } }));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key }));
vi.mock("@api/ContextMenu", () => ({ addContextMenuPatch: vi.fn(), removeContextMenuPatch: vi.fn() }));
vi.mock("@api/MessageUpdater", () => ({ updateMessage: (_channel: string, id: string, fields: any) => Object.assign(state.native.get(id), fields) }));
vi.mock("../db", () => ({
    default: {
        getMessageIDB: vi.fn(async (id: string) => state.records.get(id)),
        addMessageIDB: vi.fn(async (message: any, status: string) => state.records.set(message.id, { message: structuredClone(message), status })),
        deleteMessageIDB: vi.fn(async (id: string) => state.records.delete(id)),
        updateMessageIfCurrentIDB: vi.fn(async () => false),
        enforceMessageLimitIDB: vi.fn(async () => 0)
    },
    DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" }
}));

import { ChannelStore, FluxDispatcher, MessageStore, UserStore } from "@webpack/common";

import idb, { DBMessageStatus } from "../db";
import { settings } from "../index";
import { addMessage, enqueueMessageTask, flushWrites } from "../LoggedMessageManager";
import handlers from "../messageHandlers";
import contextMenu from "../utils/contextMenu";
import loggingScope from "../utils/loggingScope";

function message(id = "1", extra: Record<string, any> = {}): any {
    return {
        id, channel_id: "channel", guild_id: "guild", content: "old", author: { id: "bot", bot: true, username: "bot" },
        timestamp: "2026-10-26T00:00:00.000Z", attachments: [], embeds: [], mentions: [], editHistory: [], ...extra
    };
}

const update = (extra: Record<string, any> = {}) => ({
    message: { id: "1", channel_id: "channel", edited_timestamp: "2026-10-26T00:01:00.000Z", ...extra }
}) as any;

beforeEach(() => {
    vi.clearAllMocks();
    state.records.clear();
    state.native.clear();
    handlers.cacheSentMessages.clear();
    handlers.setCacheLimit(1000);
    handlers.setGetMessage((_channel, id) => state.native.get(id));
    MessageStore.getMessage = (_channel: string, id: string) => state.native.get(id);
    Object.assign(settings.store, {
        ignoreBots: false, ignoreSelf: false, whitelistedIds: "", blacklistedIds: "", exclusionRules: "",
        alwaysLogDirectMessages: false, alwaysLogCurrentChannel: false,
        logDeletes: true, logEdits: true, logDeletedAttachments: true, saveImages: false, messageLimit: 0
    });
    ChannelStore.getChannel = () => ({ guild_id: "guild" });
    UserStore.getUser = () => null;
    vi.mocked(idb.getMessageIDB).mockImplementation(async id => state.records.get(id));
});

describe("capture consistency", () => {
    it("records an unopened thread using the server identity on the event", async () => {
        ChannelStore.getChannel = () => undefined;
        settings.store.whitelistedIds = "guild";
        handlers.messageCreateHandler({ guildId: "guild", message: message("1", {
            guild_id: undefined, attachments: [{ id: "image", filename: "image.png", url: "https://example.test/image.png" }]
        }) } as any);
        expect(state.records.size).toBe(0);
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: {
            guildId: "guild", attachments: [{ id: "image", filename: "image.png" }]
        } });
    });

    it("retains a deletion snapshot evicted while its message queue is blocked", async () => {
        handlers.setCacheLimit(2);
        settings.store.saveImages = true;
        handlers.messageCreateHandler({ message: message("1", { attachments: [{ id: "image", filename: "image.png" }] }) } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocked = enqueueMessageTask("1", () => gate);
        const deleting = handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        for (const id of ["2", "3"]) handlers.messageCreateHandler({ message: message(id) } as any);
        const evicted = !handlers.cacheSentMessages.has("channel,1");
        release();
        await Promise.all([blocked, deleting]);
        await flushWrites();
        expect(evicted).toBe(true);
        expect(handlers.cacheSentMessages.size).toBe(2);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: {
            content: "old", attachments: [{ id: "image", filename: "image.png" }]
        } });
        expect(state.downloads).toHaveBeenCalledWith(expect.objectContaining({ attachments: [{ id: "image", filename: "image.png" }] }), undefined);
    });

    it("retains every bulk deletion before waiting for the first message", async () => {
        handlers.setCacheLimit(2);
        for (const id of ["1", "2"]) handlers.messageCreateHandler({ message: message(id, { attachments: [{ id: `image-${id}` }] }) } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocked = enqueueMessageTask("1", () => gate);
        const deleting = handlers.messageDeleteBulkHandler({ channelId: "channel", ids: ["1", "2"] } as any);
        for (const id of ["3", "4"]) handlers.messageCreateHandler({ message: message(id) } as any);
        release();
        await Promise.all([blocked, deleting]);
        for (const id of ["1", "2"]) expect(state.records.get(id)).toMatchObject({
            status: DBMessageStatus.DELETED, message: { attachments: [{ id: `image-${id}` }] }
        });
        expect(handlers.cacheSentMessages.size).toBe(2);
    });

    it("prefers the preceding edit persisted after the deletion snapshot was captured", async () => {
        handlers.setCacheLimit(1);
        handlers.messageCreateHandler({ message: message() } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(idb.getMessageIDB).mockImplementationOnce(async () => { await gate; return undefined; });
        vi.mocked(idb.addMessageIDB).mockImplementationOnce(async (current, status) => {
            state.records.set(current.id, { message: structuredClone(current), status });
            handlers.messageCreateHandler({ message: message("2") } as any);
        });
        const editing = handlers.messageUpdateHandler(update({ content: "new", attachments: [{ id: "new" }] }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const deleting = handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        release();
        await Promise.all([editing, deleting]);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: {
            content: "new", attachments: [{ id: "new" }], editHistory: [{ content: "old" }]
        } });
    });

    it.each([false, undefined])("records a deletion even before the native deleted flag is set (%s)", async deleted => {
        state.native.set("1", message("1", { deleted }));
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { deleted: true } });
    });

    it("does not archive live messages merely because their snapshots were evicted", async () => {
        handlers.setCacheLimit(1);
        for (const id of ["1", "2"]) handlers.messageCreateHandler({ message: message(id) } as any);
        await flushWrites();
        expect(state.records.size).toBe(0);
        await handlers.messageUpdateHandler({ message: { id: "2", channel_id: "channel", content: "edited" } } as any);
        expect(state.records.get("2")).toMatchObject({ status: DBMessageStatus.EDITED, message: { deleted: false } });
    });

    it.each(["local", "disabled", "ephemeral", "outside", "bot"])("does not record an excluded deletion (%s)", async reason => {
        const current = message("1", { deleted: false, flags: reason === "ephemeral" ? 64 : 0 });
        handlers.messageCreateHandler({ message: current } as any);
        state.native.set("1", current);
        if (reason === "disabled") settings.store.logDeletes = false;
        if (reason === "outside") settings.store.whitelistedIds = "other-guild";
        if (reason === "bot") settings.store.ignoreBots = true;
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1", mlDeleted: reason === "local" } as any);
        expect(state.records.size).toBe(0);
        expect(state.downloads).not.toHaveBeenCalled();
    });

    it("rechecks the current scope before using an evicted deletion snapshot", async () => {
        handlers.setCacheLimit(1);
        handlers.messageCreateHandler({ message: message() } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocked = enqueueMessageTask("1", () => gate);
        const deleting = handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        handlers.messageCreateHandler({ message: message("2") } as any);
        settings.store.whitelistedIds = "other-guild";
        release();
        await Promise.all([blocked, deleting]);
        expect(state.records.size).toBe(0);
    });

    it("queues every bulk deletion before a later permanent removal", async () => {
        for (const id of ["1", "2"]) handlers.messageCreateHandler({ message: message(id) } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        const blocked = enqueueMessageTask("1", () => gate);
        const deleting = handlers.messageDeleteBulkHandler({ channelId: "channel", ids: ["1", "2"] } as any);
        const clearing = contextMenu.removeMessageAction({ message: message("2", { deleted: true }) });
        release();
        await Promise.all([blocked, deleting, clearing]);
        const writes = vi.mocked(idb.addMessageIDB).mock;
        const writeIndex = writes.calls.findIndex(([current]) => current.id === "2");
        expect(writeIndex).toBeGreaterThanOrEqual(0);
        expect(writes.invocationCallOrder[writeIndex]).toBeLessThan(vi.mocked(idb.deleteMessageIDB).mock.invocationCallOrder[0]);
        expect(state.records.has("1")).toBe(true);
        expect(state.records.has("2")).toBe(false);
        expect(handlers.cacheSentMessages.has("channel,2")).toBe(false);
    });

    it("deduplicates overlapping single and bulk deletions", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        await Promise.all([
            handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any),
            handlers.messageDeleteBulkHandler({ channelId: "channel", ids: ["1", "1"] } as any)
        ]);
        expect(idb.addMessageIDB).toHaveBeenCalledTimes(1);
    });

    it.each([undefined, false])("records a card edit using the cached user identity when author.bot=%s", async bot => {
        UserStore.getUser = () => ({ id: "bot", bot: true });
        handlers.messageCreateHandler({ message: message("1", { author: { id: "bot", bot }, embeds: [{ title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ embeds: [{ title: "second" }] }));
        expect(state.records.get("1")).toMatchObject({ message: { embeds: [{ title: "second" }], editHistory: [{ embeds: [{ title: "first" }] }] } });
    });

    it("permanently removes a deleted message even when its backup cache still looks live", async () => {
        const live = message();
        const deleted = message("1", { deleted: true });
        handlers.cacheSentMessages.set("channel,1", live);
        state.native.set("1", deleted);
        state.records.set("1", { message: deleted, status: DBMessageStatus.DELETED });
        await contextMenu.removeMessageAction({ message: deleted });
        expect(state.records.has("1")).toBe(false);
        expect(handlers.cacheSentMessages.has("channel,1")).toBe(false);
        expect(FluxDispatcher.dispatch).toHaveBeenCalledWith({ type: "MESSAGE_DELETE", channelId: "channel", id: "1", mlDeleted: true });
    });

    it("keeps the edited body after native cache eviction", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        state.native.set("1", message("1", { content: "new", editHistory: [{ content: "old", timestamp: update().message.edited_timestamp }] }));
        await handlers.messageUpdateHandler(update({ content: "new" }));
        state.native.clear();
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { content: "new" } });
    });

    it("resolves deletion after the preceding queued edit completes", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(idb.getMessageIDB).mockImplementationOnce(async () => { await gate; return undefined; });
        const editing = handlers.messageUpdateHandler(update({ content: "new" }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const deleting = handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        release();
        await Promise.all([editing, deleting]);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { content: "new" } });
    });

    it("deletes an archived message even when both message caches are empty", async () => {
        state.records.set("1", { message: message("1", { content: "stored" }), status: DBMessageStatus.EDITED });
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { content: "stored", deleted: true } });
    });

    it("rechecks scope for archive-only deletes and does not invent missing messages", async () => {
        state.records.set("1", { message: message(), status: DBMessageStatus.EDITED });
        settings.store.ignoreBots = true;
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        await handlers.messageDeleteHandler({ channelId: "channel", id: "missing" } as any);
        expect(state.records.size).toBe(1);
        expect(state.records.get("1").status).toBe(DBMessageStatus.EDITED);
    });

    it("reads the final native snapshot after an edit waiting in the queue", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        state.native.set("1", message("1", { deleted: true }));
        let release = () => {};
        const gate = new Promise<void>(resolve => { release = resolve; });
        vi.mocked(idb.getMessageIDB).mockImplementationOnce(async () => { await gate; return undefined; });
        const editing = handlers.messageUpdateHandler(update({ content: "new", embeds: [{ title: "new card" }], attachments: [{ id: "new" }] }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const deleting = handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        state.native.set("1", message("1", { deleted: true, content: "new", embeds: [{ title: "new card" }], attachments: [{ id: "new" }] }));
        release();
        await Promise.all([editing, deleting]);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { content: "new", embeds: [{ title: "new card" }], attachments: [{ id: "new" }], deleted: true } });
    });

    it("preserves author metadata while updating an unrecorded snapshot", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        settings.store.logEdits = false;
        await handlers.messageUpdateHandler(update({ author: { id: "bot" }, content: "new", embeds: [{ type: "rich", title: "new" }] }));
        expect(handlers.cacheSentMessages.get("channel,1")).toMatchObject({ content: "new", author: { bot: true, username: "bot" }, embeds: [{ title: "new" }] });
        expect(state.records.size).toBe(0);
    });

    it("merges author updates that omit their identity and existing metadata", async () => {
        handlers.messageCreateHandler({ message: message() } as any);
        await handlers.messageUpdateHandler(update({ author: { bot: false, username: undefined }, content: "new" }));
        expect(state.records.get("1").message).toMatchObject({ content: "new", author: { id: "bot", username: "bot" }, bot: true });
    });

    it.each(["message", "user", "fallback"])("does not let a false author flag mask a true %s flag", source => {
        settings.store.ignoreBots = true;
        UserStore.getUser = () => source === "user" ? { id: "bot", bot: true } : null;
        const current = message("1", { author: { id: "bot", bot: false }, ...(source === "message" ? { bot: true } : {}) });
        expect(loggingScope.allowsMessage(current, source === "fallback" ? message() : undefined)).toBe(false);
    });

    it.each(["webhook_id", "webhookId"])("makes %s messages follow the local bot switch", field => {
        const item = message("1", { author: { id: "hook", bot: false }, [field]: "hook" });
        expect(loggingScope.allowsMessage(item)).toBe(true);
        settings.store.ignoreBots = true;
        expect(loggingScope.allowsMessage(item)).toBe(false);
        expect(loggingScope.allowsMessage({ id: "1" }, item)).toBe(false);
        expect(loggingScope.allowsMessage({ id: "2", author: { id: "hook", bot: false } }, item)).toBe(true);
    });

    it("records consecutive card edits and removal with their previous versions", async () => {
        handlers.messageCreateHandler({ message: message("1", { content: "", embeds: [{ type: "rich", title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ embeds: [{ type: "rich", title: "second" }] }));
        await handlers.messageUpdateHandler(update({ embeds: [], edited_timestamp: "2026-10-26T00:02:00.000Z" }));
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.EDITED, message: {
            embeds: [], editHistory: [{ content: "", embeds: [{ title: "first" }] }, { content: "", embeds: [{ title: "second" }] }]
        } });
    });

    it("records card addition and webhook card edits without an edited timestamp", async () => {
        handlers.messageCreateHandler({ message: message("1", { content: "", author: { id: "hook", bot: false }, webhook_id: "hook" }) } as any);
        await handlers.messageUpdateHandler(update({ edited_timestamp: undefined, embeds: [{ title: "first" }] }));
        await handlers.messageUpdateHandler(update({ edited_timestamp: undefined, embeds: [{ title: "second" }] }));
        expect(state.records.get("1").message).toMatchObject({ embeds: [{ title: "second" }], editHistory: [{ embeds: [] }, { embeds: [{ title: "first" }] }] });
    });

    it("combines text, attachment and card changes into one event", async () => {
        handlers.messageCreateHandler({ message: message("1", { attachments: [{ id: "old", filename: "old.png" }], embeds: [{ title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ content: "new", attachments: [], embeds: [{ title: "second" }] }));
        expect(state.records.get("1").message).toMatchObject({ content: "new", embeds: [{ title: "second" }], attachments: [{ id: "old", deleted: true }], editHistory: [{ content: "old", embeds: [{ title: "first" }], attachments: [{ id: "old", deleted: true }] }] });
        expect(state.records.get("1").message.editHistory).toHaveLength(1);
    });

    it("preserves the card shown during an attachment-only edit", async () => {
        handlers.messageCreateHandler({ message: message("1", { attachments: [{ id: "removed" }], embeds: [{ title: "unchanged card" }] }) } as any);
        await handlers.messageUpdateHandler(update({ attachments: [] }));
        expect(state.records.get("1").message.editHistory).toMatchObject([{ content: "old", embeds: [{ title: "unchanged card" }], attachments: [{ id: "removed", deleted: true }] }]);
    });

    it.each([false, true])("refreshes cards when logEdits=%s and preserves them in deletion", async logEdits => {
        settings.store.logEdits = logEdits;
        handlers.messageCreateHandler({ message: message("1", { embeds: [{ title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ embeds: [{ title: "second", fields: [{ name: "status", value: "ready" }] }] }));
        expect(state.records.size).toBe(logEdits ? 1 : 0);
        await handlers.messageDeleteHandler({ channelId: "channel", id: "1" } as any);
        expect(state.records.get("1")).toMatchObject({ status: DBMessageStatus.DELETED, message: { embeds: [{ title: "second", fields: [{ name: "status", value: "ready" }] }] } });
        expect(state.records.get("1").message.editHistory).toHaveLength(logEdits ? 1 : 0);
    });

    it("updates partial human messages while preserving absent fields", async () => {
        handlers.messageCreateHandler({ message: message("1", { author: { id: "human" }, attachments: [{ id: "live" }], embeds: [{ title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ content: "new", author: undefined, attachments: undefined, embeds: undefined }));
        expect(state.records.get("1").message).toMatchObject({ content: "new", attachments: [{ id: "live" }], embeds: [{ title: "first" }], author: { id: "human" } });
    });

    it("seeds fetched messages before a card edit without a create event", async () => {
        handlers.rememberMessage(message("1", { embeds: [{ title: "first" }] }));
        state.native.set("1", message("1", { embeds: [{ title: "second" }] }));
        await handlers.messageUpdateHandler(update({ embeds: [{ title: "second" }] }));
        expect(state.records.get("1").message.editHistory).toMatchObject([{ embeds: [{ title: "first" }] }]);
    });

    it("keeps card history when removed attachment history is disabled", async () => {
        settings.store.logDeletedAttachments = false;
        handlers.messageCreateHandler({ message: message("1", { embeds: [{ type: "rich", title: "first" }] }) } as any);
        await handlers.messageUpdateHandler(update({ content: "new", embeds: [{ type: "rich", title: "second" }] }));
        expect(state.records.get("1").message.editHistory).toHaveLength(1);
        expect(state.records.get("1").message.editHistory[0]).toMatchObject({ content: "old", embeds: [{ title: "first" }] });
    });

    it("refreshes automatic human link previews without recording an edit", async () => {
        handlers.messageCreateHandler({ message: message("1", { author: { id: "human", bot: false } }) } as any);
        await handlers.messageUpdateHandler(update({ edited_timestamp: undefined, embeds: [{ type: "article", title: "preview" }] }));
        expect(state.records.size).toBe(0);
        expect(handlers.cacheSentMessages.get("channel,1")?.embeds).toEqual([{ type: "article", title: "preview" }]);
    });

    it.each([false, true])("does not record automatic link completion with a full payload and bot=%s", bot => {
        handlers.messageCreateHandler({ message: message("1", { author: { id: "author", bot } }) } as any);
        return handlers.messageUpdateHandler(update({ content: "old", embeds: [{ type: "article", title: "preview" }] })).then(() => {
            expect(state.records.size).toBe(0);
            expect(handlers.cacheSentMessages.get("channel,1")?.embeds).toEqual([{ type: "article", title: "preview" }]);
        });
    });

    it("does not count native embed identifiers or proxy refreshes as card edits", async () => {
        handlers.messageCreateHandler({ message: message("1", { embeds: [{ type: "rich", title: "same", image: { url: "https://image", proxy_url: "https://old" } }] }) } as any);
        await handlers.messageUpdateHandler(update({ embeds: [{ id: "internal", type: "rich", rawTitle: "same", image: { url: "https://image", proxyURL: "https://new" } }] }));
        expect(state.records.size).toBe(0);
    });

    it("saves attachments of deleted ghost pings", async () => {
        settings.store.saveImages = true;
        await addMessage(message("1", { deleted: true, ghostPinged: true, attachments: [{ id: "image", filename: "image.png" }] }), DBMessageStatus.GHOST_PINGED);
        await flushWrites();
        expect(state.downloads).toHaveBeenCalledOnce();
    });

    it("permanently clears removed attachments and prevents replaying the old snapshot", async () => {
        const current = message("1", {
            content: "new", editHistory: [{ content: "old", timestamp: update().message.edited_timestamp }],
            attachments: [{ id: "old", deleted: true }, { id: "live" }]
        });
        state.native.set("1", current);
        state.records.set("1", { message: structuredClone(current), status: DBMessageStatus.EDITED });
        handlers.cacheSentMessages.set("channel,1", structuredClone(current));
        await contextMenu.removeMessageAction({ message: current });
        expect(state.records.has("1")).toBe(false);
        expect(current).toMatchObject({ editHistory: [], attachments: [{ id: "live" }] });
        expect(handlers.cacheSentMessages.get("channel,1")).toMatchObject({ content: "new", editHistory: [], attachments: [{ id: "live" }] });
        state.native.clear();
        await handlers.messageUpdateHandler(update({ content: "newer", attachments: [{ id: "live" }] }));
        expect(state.records.get("1").message.editHistory).toEqual([{ content: "new", timestamp: update().message.edited_timestamp }]);
    });

    it("clears a queued edit without restoring an older snapshot from menu props", async () => {
        const stale = message();
        state.native.set("1", stale);
        handlers.messageCreateHandler({ message: stale } as any);
        const editing = handlers.messageUpdateHandler(update({ content: "latest", attachments: [{ id: "live" }], embeds: [{ title: "latest" }] }));
        const clearing = contextMenu.removeMessageAction({ message: stale });
        await Promise.all([editing, clearing]);
        expect(state.records.size).toBe(0);
        expect(handlers.cacheSentMessages.get("channel,1")).toMatchObject({ content: "latest", embeds: [{ title: "latest" }], editHistory: [], attachments: [{ id: "live" }] });
    });
});
