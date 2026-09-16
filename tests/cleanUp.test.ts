/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@webpack", () => ({
    findLazy: () => undefined,
    findByCodeLazy: () => () => undefined,
    findStoreLazy: () => ({
        isMuted: () => false,
        isCategoryMuted: () => false,
        isChannelMuted: () => false
    })
}));

vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), log: vi.fn() },
    settings: { store: { exclusionRules: "" } }
}));

vi.mock("../db", () => ({
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));

import { ChannelStore, MessageStore, UserStore } from "@webpack/common";

import { cleanUpCachedMessage, cleanupEmbed, cleanupMessage, cleanupUserObject } from "../utils/cleanUp";

function makeMessage(overrides: Record<string, any> = {}) {
    return {
        id: "1",
        channel_id: "100",
        timestamp: "2026-01-01T00:00:00.000Z",
        author: { id: "u1", username: "alice", phone: "090", email: "a@b.c" },
        content: "hello",
        attachments: [],
        embeds: [],
        ...overrides
    };
}

beforeEach(() => {
    ChannelStore.getChannel = () => null;
    MessageStore.getMessage = () => null;
    UserStore.getCurrentUser = () => ({ id: "self" });
});

describe("cleanupMessage", () => {
    it("normalizes a plain message and strips private author fields", () => {
        const ret = cleanupMessage(makeMessage({ embeds: [{ id: "e", rawTitle: "T" }] }));

        expect(ret.author).toEqual({ id: "u1", username: "alice" });
        expect(ret.id).toBe("1");
        expect(ret.channel_id).toBe("100");
        expect(ret.content).toBe("hello");
        expect(ret.timestamp).toBe("2026-01-01T00:00:00.000Z");
        expect(ret.embeds).toEqual([{ title: "T" }]);
        expect(ret.deleted).toBe(false);
        expect(ret.deletedTimestamp).toBeUndefined();
        expect(ret.editHistory).toEqual([]);
        expect(ret.ghostPinged).toBeUndefined();
    });

    it("stamps the deletion time of deleted messages", () => {
        const ret = cleanupMessage(makeMessage({ deleted: true }));

        expect(ret.deleted).toBe(true);
        expect(ret.deletedTimestamp).toBeTruthy();
    });

    it("resolves guildId from guild_id or the channel store", () => {
        expect(cleanupMessage(makeMessage({ guild_id: "g-1" })).guildId).toBe("g-1");

        ChannelStore.getChannel = (id: string) => ({ id, guild_id: "g-2" });
        expect(cleanupMessage(makeMessage({ channel_id: "200" })).guildId).toBe("g-2");

        ChannelStore.getChannel = () => null;
        expect(cleanupMessage(makeMessage({ channel_id: "300" })).guildId).toBeUndefined();
    });

    it("derives ghostPinged from pings on deleted messages and keeps an explicit mentioned flag", () => {
        expect(cleanupMessage(makeMessage({ deleted: true, mention_everyone: false, mentions: ["self"] })).ghostPinged)
            .toBe(true);
        expect(cleanupMessage(makeMessage({ deleted: true, mention_everyone: true })).ghostPinged).toBe(true);

        const mentioned = cleanupMessage(makeMessage({ mentioned: true }));
        expect(mentioned.ghostPinged).toBe(true);
        expect(mentioned.mentioned).toBe(true);
    });

    it("serializes messages exposing toJS instead of spreading them", () => {
        const raw = {
            id: "9",
            channel_id: "100",
            timestamp: "2026-01-01T00:00:00.000Z",
            author: { id: "u1", username: "alice" },
            content: "raw"
        };
        const ret = cleanupMessage({ toJS: () => raw });

        expect(ret).not.toBe(raw);
        expect(ret.id).toBe("9");
        expect(ret.content).toBe("raw");
        expect(ret.deleted).toBe(false);
        expect(ret.embeds).toEqual([]);
        expect(ret.editHistory).toEqual([]);
    });

    it("cleans referenced messages of replies recursively", () => {
        const ret = cleanupMessage(makeMessage({
            type: 19,
            message_reference: { channel_id: "100", message_id: "0" },
            referenced_message: makeMessage({ id: "0", author: { id: "u2", username: "bob", phone: "111" }, content: "root" })
        }));

        expect(ret.message_reference).toEqual({ channel_id: "100", message_id: "0" });
        expect(ret.referenced_message.content).toBe("root");
        expect(ret.referenced_message.author.phone).toBeUndefined();
        expect(ret.referenced_message.deleted).toBe(false);
    });

    it("accepts messageReference as the reply reference", () => {
        const ret = cleanupMessage(makeMessage({
            type: 19,
            messageReference: { channel_id: "100", message_id: "0" },
            referenced_message: makeMessage({ id: "0", content: "root" })
        }));

        expect(ret.message_reference).toEqual({ channel_id: "100", message_id: "0" });
        expect(ret.referenced_message.content).toBe("root");
    });

    it("falls back to MessageStore for replies without an inline referenced message", () => {
        MessageStore.getMessage = () => makeMessage({ id: "0", author: { id: "u2", username: "bob", phone: "111" }, content: "stored" });

        const ret = cleanupMessage(makeMessage({
            type: 19,
            message_reference: { channel_id: "100", message_id: "0" }
        }));

        expect(ret.referenced_message.content).toBe("stored");
        expect(ret.referenced_message.author.phone).toBeUndefined();
    });

    it("leaves referenced_message unset when the store has nothing", () => {
        const ret = cleanupMessage(makeMessage({
            type: 19,
            message_reference: { channel_id: "100", message_id: "missing" }
        }));

        expect(ret.referenced_message).toBeUndefined();
    });

    it("throws when details should be removed but the author is missing", () => {
        expect(() => cleanupMessage({ id: "1", channel_id: "100", content: "c" })).toThrow();
    });

    it("tolerates missing embeds but rejects non-array embeds", () => {
        expect(cleanupMessage(makeMessage({ embeds: null as any })).embeds).toEqual([]);
        expect(() => cleanupMessage(makeMessage({ embeds: {} as any }))).toThrow();
    });
});

describe("cleanUpCachedMessage", () => {
    it("marks the message as our own cache entry without requiring an author", () => {
        const ret = cleanUpCachedMessage({ id: "1", channel_id: "100", content: "c", embeds: [] } as any);

        expect(ret.ourCache).toBe(true);
        expect(ret.deleted).toBe(false);
        expect(ret.editHistory).toEqual([]);
        expect(ret.embeds).toEqual([]);
    });

    it("keeps private author fields for cached messages", () => {
        const ret = cleanUpCachedMessage(makeMessage());

        expect(ret.ourCache).toBe(true);
        expect(ret.author.phone).toBe("090");
    });
});

describe("cleanupEmbed", () => {
    it("returns embeds without an id untouched", () => {
        const embed = { title: "t", description: "d" };

        expect(cleanupEmbed(embed)).toBe(embed);
    });

    it("maps raw discord embed fields onto their json counterparts", () => {
        const ret = cleanupEmbed({
            id: "e1",
            rawTitle: "Title",
            rawDescription: "Desc",
            referenceId: "ref",
            type: "rich",
            url: "https://x.y",
            provider: { name: "P", url: "https://p.y" },
            footer: { text: "F", iconURL: "fi", iconProxyURL: "fp" },
            author: { name: "A", url: "https://a.y", iconURL: "ai", iconProxyURL: "ap" },
            fields: [{ rawName: "N", rawValue: "V", inline: true }]
        });

        expect(ret).toEqual({
            title: "Title",
            description: "Desc",
            reference_id: "ref",
            type: "rich",
            url: "https://x.y",
            provider: { name: "P", url: "https://p.y" },
            footer: { text: "F", icon_url: "fi", proxy_icon_url: "fp" },
            author: { name: "A", url: "https://a.y", icon_url: "ai", proxy_icon_url: "ap" },
            fields: [{ name: "N", value: "V", inline: true }]
        });
    });

    it("maps thumbnails and drops jpeg-format urls that have no proxy", () => {
        const withProxy = cleanupEmbed({
            id: "1",
            thumbnail: { url: "https://x/y.png", proxyURL: "https://x/proxy.png?format=webp&quality=lossless", width: 10, height: 20 }
        });
        expect(withProxy.thumbnail).toEqual({ url: "https://x/y.png", proxy_url: "https://x/proxy.png", width: 10, height: 20 });

        const jpegOnly = cleanupEmbed({ id: "2", thumbnail: { url: "https://x/y.png?format=jpeg", width: 1, height: 1 } });
        expect(jpegOnly.thumbnail).toBeUndefined();
    });

    it("maps image and video media", () => {
        const ret = cleanupEmbed({
            id: "3",
            image: { url: "iu", proxyURL: "ip", width: 1, height: 2 },
            video: { url: "vu", proxyURL: "vp", width: 3, height: 4 }
        });

        expect(ret.image).toEqual({ url: "iu", proxy_url: "ip", width: 1, height: 2 });
        expect(ret.video).toEqual({ url: "vu", proxy_url: "vp", width: 3, height: 4 });
    });

    it("converts moment timestamps to epoch milliseconds", () => {
        const ret = cleanupEmbed({ id: "4", timestamp: { _isAMomentObject: true, milliseconds: () => 1234 } });

        expect(ret.timestamp).toBe(1234);
    });
});

describe("cleanupUserObject", () => {
    it("keeps only the safe subset of user fields", () => {
        expect(cleanupUserObject({
            id: "u1",
            username: "alice",
            discriminator: "1234",
            avatar: "a",
            bot: false,
            publicFlags: 64,
            email: "secret",
            phone: "x"
        } as any)).toEqual({
            discriminator: "1234",
            username: "alice",
            avatar: "a",
            id: "u1",
            bot: false,
            public_flags: 64
        });
    });

    it("falls back to public_flags when publicFlags is absent", () => {
        const ret = cleanupUserObject({ id: "u2", username: "bob", public_flags: 128 } as any);

        expect(ret.public_flags).toBe(128);
    });
});
