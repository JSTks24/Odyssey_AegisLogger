/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const nativeCache = vi.hoisted(() => new Map<string, any>());

vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { store: {} }
}));

vi.mock("@webpack", () => ({
    findByPropsLazy: () => ({ getOrCreate: () => nativeCache, commit: vi.fn() }),
    findStoreLazy: () => ({ isMuted: () => false, isCategoryMuted: () => false, isChannelMuted: () => false }),
    findLazy: () => undefined,
    findByCodeLazy: () => () => undefined
}));

vi.mock("../utils/saveImage", () => ({ cacheMessageImages: vi.fn(async () => { }) }));

vi.mock("../db", () => ({
    default: {
        getMessageIDB: vi.fn(async () => undefined),
        addMessageIDB: vi.fn(async () => { }),
        updateMessageIfCurrentIDB: vi.fn(async () => false),
        enforceMessageLimitIDB: vi.fn(async () => 0)
    },
    DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" }
}));

import { ChannelStore, FluxDispatcher, SelectedChannelStore, UserStore } from "@webpack/common";

import idb, { DBMessageStatus } from "../db";
import { settings } from "../index";
import { addMessage, writeMessageRecord } from "../LoggedMessageManager";
import messageHandlers from "../messageHandlers";
import { cleanupMessage } from "../utils/cleanUp";
import loggingScope from "../utils/loggingScope";
import { getGuildIdByChannel } from "../utils/misc";

const channels = new Map<string, any>();

function message(id: string, extra: Record<string, any> = {}) {
    return {
        id, channel_id: "channel", author: { id: "self", username: "tester" },
        content: "edited", timestamp: "2026-10-08T00:00:00.000Z", attachments: [], embeds: [],
        mentions: [], mention_everyone: false,
        editHistory: [{ content: "original", timestamp: "2026-10-08T00:01:00.000Z" }],
        ...extra
    } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    nativeCache.clear();
    channels.clear();
    messageHandlers.cacheSentMessages.clear();
    messageHandlers.setGetMessage(null);
    settings.store.whitelistedIds = "allowed-one,allowed-two";
    settings.store.blacklistedIds = "";
    settings.store.exclusionRules = "";
    settings.store.ignoreSelf = false;
    settings.store.ignoreBots = false;
    settings.store.alwaysLogCurrentChannel = true;
    settings.store.alwaysLogDirectMessages = true;
    settings.store.saveImages = false;
    settings.store.messageLimit = 0;
    ChannelStore.getChannel = (id: string) => channels.get(id) ?? null;
    SelectedChannelStore.getChannelId = () => "channel";
    UserStore.getUser = () => null;
    vi.mocked(idb.getMessageIDB).mockResolvedValue(undefined);
});

describe("whitelist scope context", () => {
    it.each(["allowed-one", "allowed-two"])("keeps an explicitly whitelisted server %s", guildId => {
        expect(loggingScope.allowsMessage(message("1", { guild_id: guildId }))).toBe(true);
    });

    it("preserves an existing guildId when the channel is unavailable", () => {
        const cleaned = cleanupMessage(message("1", { guildId: "outside" }));
        expect(cleaned.guildId).toBe("outside");
        expect(loggingScope.allowsMessage(cleaned)).toBe(false);
    });

    it("derives a thread server from its parent", () => {
        channels.set("channel", { parent_id: "parent" });
        channels.set("parent", { guild_id: "allowed-one" });
        expect(getGuildIdByChannel("channel")).toBe("allowed-one");
        expect(loggingScope.allowsMessage(message("1"))).toBe(true);
        channels.set("parent", { guild_id: "outside" });
        expect(loggingScope.allowsMessage(message("1"))).toBe(false);
    });

    it("rejects missing or cyclic channel context rather than treating it as a DM", () => {
        expect(loggingScope.allowsMessage(message("1"))).toBe(false);
        channels.set("channel", { parent_id: "parent" });
        channels.set("parent", { parent_id: "channel" });
        expect(getGuildIdByChannel("channel")).toBeUndefined();
        expect(loggingScope.allowsMessage(message("1"))).toBe(false);
    });

    it.each([{ type: 1 }, { type: 3 }, { isDM: () => true }, { isGroupDM: () => true }])("keeps known direct message context %#", channel => {
        channels.set("channel", channel);
        expect(loggingScope.allowsMessage(message("1"))).toBe(true);
        expect(loggingScope.allowsMessage(message("1", { guild_id: "outside" }))).toBe(false);
    });

    it("preserves explicit author and channel whitelist OR semantics", () => {
        settings.store.whitelistedIds = "self";
        expect(loggingScope.allowsMessage(message("1", { guild_id: "outside" }))).toBe(true);
        settings.store.whitelistedIds = "channel";
        expect(loggingScope.allowsMessage(message("1", { guild_id: "outside" }))).toBe(true);
        settings.store.whitelistedIds = "allowed-one";
        expect(loggingScope.allowsMessage(message("1", { guild_id: "outside" }))).toBe(false);
    });

    it("preserves empty whitelist behavior and reads setting changes immediately", () => {
        const item = message("1", { guild_id: "outside" });
        expect(loggingScope.allowsMessage(item)).toBe(false);
        settings.store.whitelistedIds = " , , ";
        expect(loggingScope.allowsMessage(item)).toBe(true);
        settings.store.whitelistedIds = "allowed-two";
        expect(loggingScope.allowsMessage(item)).toBe(false);
    });
});

describe("scope at message ingress", () => {
    it("does not cache a create with a message-level outside guild when payload guild is missing", () => {
        messageHandlers.messageCreateHandler({ message: message("1", { guild_id: "outside" }) } as any);
        expect(messageHandlers.cacheSentMessages.size).toBe(0);
    });

    it("keeps payload server context in the create cache", () => {
        messageHandlers.messageCreateHandler({ guildId: "allowed-one", message: message("1") } as any);
        expect(messageHandlers.cacheSentMessages.get("channel,1")?.guildId).toBe("allowed-one");
    });

    it.each([false, true])("rejects outside own edits even with current channel and ghost=%s", async ghost => {
        const original = message("1", { guild_id: "outside", ghostPinged: ghost });
        messageHandlers.setGetMessage(() => original);
        nativeCache.set("1", original);
        await messageHandlers.messageUpdateHandler({ message: { id: "1", channel_id: "channel", content: "edited" } } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(original.editHistory).toEqual([]);
    });

    it("recovers allowed update context from the previous record when native channel context is missing", async () => {
        const original = message("1", { guildId: "allowed-one", content: "original" });
        vi.mocked(idb.getMessageIDB).mockResolvedValue({ message: original } as any);
        messageHandlers.cacheSentMessages.set("channel,1", original);
        await messageHandlers.messageUpdateHandler({ message: { id: "1", channel_id: "channel", content: "edited" } } as any);
        expect(idb.addMessageIDB).toHaveBeenCalledTimes(1);
        expect(vi.mocked(idb.addMessageIDB).mock.calls[0][0].guildId).toBe("allowed-one");
    });

    it("keeps previous context when a native snapshot has undefined guild and author fields", async () => {
        const original = message("1", { guildId: "allowed-one", content: "original" });
        vi.mocked(idb.getMessageIDB).mockResolvedValue({ message: original } as any);
        messageHandlers.setGetMessage(() => message("1", { guildId: undefined, guild_id: undefined, author: undefined }));
        await messageHandlers.messageUpdateHandler({ message: { id: "1", channel_id: "channel", content: "edited" } } as any);
        expect(idb.addMessageIDB).toHaveBeenCalledTimes(1);
        expect(vi.mocked(idb.addMessageIDB).mock.calls[0][0].guildId).toBe("allowed-one");
    });

    it("rejects an outside update with only cached guild context", async () => {
        messageHandlers.cacheSentMessages.set("channel,1", message("1", { guildId: "outside", content: "original" }));
        await messageHandlers.messageUpdateHandler({ message: { id: "1", channel_id: "channel", content: "edited" } } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it.each([false, true])("rejects outside deletion and ghost ping=%s", async ghost => {
        messageHandlers.setGetMessage(() => message("1", { guild_id: "outside", deleted: true, ghostPinged: ghost }));
        await messageHandlers.messageDeleteHandler({ id: "1", channelId: "channel" } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it("rejects outside bulk deletes with payload server context", async () => {
        messageHandlers.setGetMessage((_channel, id) => message(id, { deleted: true }));
        await messageHandlers.messageDeleteBulkHandler({ channelId: "channel", guildId: "outside", ids: ["1", "2"] } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it.each([DBMessageStatus.EDITED, DBMessageStatus.DELETED, DBMessageStatus.GHOST_PINGED])("checks the final direct writer for %s", async status => {
        expect(await writeMessageRecord(message("1", { guildId: "outside" }), status)).toBe(false);
        await addMessage(message("2", { guild_id: "outside" }), status);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it("rechecks the whitelist after an asynchronous existing-record read", async () => {
        let release: (value: any) => void = () => { };
        vi.mocked(idb.getMessageIDB).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = writeMessageRecord(message("1", { guildId: "allowed-one" }), DBMessageStatus.EDITED);
        settings.store.whitelistedIds = "allowed-two";
        release(undefined);
        expect(await pending).toBe(false);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });
});

describe("strict bot scope at message ingress", () => {
    it.each(["", "bot", "channel", "allowed-one"])("rejects bot creation before whitelist and DM exceptions for %s", whitelist => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = whitelist;
        channels.set("channel", { type: 1, isDM: () => true });
        messageHandlers.messageCreateHandler({ message: message("1", { author: { id: "bot", bot: true } }) } as any);
        expect(messageHandlers.cacheSentMessages.size).toBe(0);
    });

    it.each([false, true])("does not store ignored bot deletions with ghost ping=%s", async ghostPinged => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "bot";
        channels.set("channel", { type: 1, isDM: () => true });
        messageHandlers.setGetMessage(() => message("1", { author: { id: "bot", bot: true }, deleted: true, ghostPinged }));
        await messageHandlers.messageDeleteHandler({ id: "1", channelId: "channel" } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(FluxDispatcher.dispatch).toHaveBeenCalledWith({ type: "MESSAGE_DELETE", channelId: "channel", id: "1", mlDeleted: true });
    });

    it("recovers a bot flag from the same create cache on deletion", async () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "";
        messageHandlers.cacheSentMessages.set("channel,1", message("1", { author: { id: "bot", bot: true } }));
        messageHandlers.setGetMessage(() => message("1", { author: { id: "bot" }, deleted: true }));
        await messageHandlers.messageDeleteHandler({ id: "1", channelId: "channel" } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it("excludes only bots from a mixed bulk deletion", async () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "allowed-one";
        messageHandlers.setGetMessage((_channel, id) => message(id, {
            guildId: "allowed-one", deleted: true, author: { id: `author-${id}`, bot: id === "1" }
        }));
        await messageHandlers.messageDeleteBulkHandler({ channelId: "channel", ids: ["1", "2"] } as any);
        expect(idb.addMessageIDB).toHaveBeenCalledTimes(1);
        expect(vi.mocked(idb.addMessageIDB).mock.calls[0][0].id).toBe("2");
    });

    it.each(["native", "archive", "create"])("rejects partial bot edits with %s fallback", async source => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "bot";
        const original = message("1", { author: { id: "bot", bot: true } });
        const partialNative = message("1", { author: { id: "bot" } });
        if (source === "native") messageHandlers.setGetMessage(() => original);
        else {
            messageHandlers.setGetMessage(() => partialNative);
            if (source === "archive") vi.mocked(idb.getMessageIDB).mockResolvedValue({ message: original } as any);
            else messageHandlers.cacheSentMessages.set("channel,1", original);
        }
        nativeCache.set("1", partialNative);
        await messageHandlers.messageUpdateHandler({ message: { id: "1", channel_id: "channel", content: "edited", attachments: [] } } as any);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
        expect(partialNative.editHistory).toEqual([]);
    });

    it.each([DBMessageStatus.EDITED, DBMessageStatus.DELETED, DBMessageStatus.GHOST_PINGED])("rejects bot writes at the final writer for %s", async status => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "bot";
        const bot = message("1", { author: { id: "bot", bot: true }, guildId: "allowed-one" });
        expect(await writeMessageRecord(bot, status)).toBe(false);
        await addMessage(bot, status);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it("rechecks bot settings after an asynchronous record read", async () => {
        settings.store.whitelistedIds = "bot";
        let release: (value: any) => void = () => { };
        vi.mocked(idb.getMessageIDB).mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
        const pending = writeMessageRecord(message("1", { author: { id: "bot", bot: true } }), DBMessageStatus.EDITED);
        settings.store.ignoreBots = true;
        release(undefined);
        expect(await pending).toBe(false);
        expect(idb.addMessageIDB).not.toHaveBeenCalled();
    });

    it("only borrows bot metadata from the same author or message", () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "";
        const bot = message("1", { author: { id: "bot", bot: true } });
        expect(loggingScope.allowsMessage({ id: "1", channel_id: "channel" }, bot)).toBe(false);
        expect(loggingScope.allowsMessage({ id: "2", author: { id: "bot" } }, bot)).toBe(false);
        expect(loggingScope.allowsMessage({ id: "2", author: { id: "human" } }, bot)).toBe(true);
        expect(loggingScope.allowsMessage({ id: "2" }, bot)).toBe(true);
        expect(loggingScope.allowsMessage({ id: "1", author: { id: "human", bot: false } }, bot)).toBe(true);
        expect(loggingScope.allowsMessage({ id: "1" }, { id: "1", bot: true })).toBe(false);
        expect(loggingScope.allowsMessage({}, bot)).toBe(false);
    });
});
