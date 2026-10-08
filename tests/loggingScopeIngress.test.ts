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

import { ChannelStore, SelectedChannelStore } from "@webpack/common";

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
