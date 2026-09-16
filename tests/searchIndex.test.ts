/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import * as webpackCommon from "./mocks/webpackCommon";

vi.mock("../utils/index", () => ({
    getGuildIdByChannel: (channelId: string) => (channelId === "chan-1" ? "g1" : undefined)
}));

import type { DBMessageRecord } from "../db";
import { tokenizeQuery } from "../utils/parseQuery";
import searchIndex from "../utils/searchIndex";

function makeRecord(id: string, overrides: Record<string, any> = {}, status = "DELETED"): DBMessageRecord {
    return {
        message_id: id,
        channel_id: overrides.channel_id ?? "chan-1",
        status,
        message: {
            id,
            channel_id: "chan-1",
            timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + Number(id) * 1000).toISOString(),
            author: { id: "u1", username: "Alice", globalName: "Ali" },
            content: "hello world",
            attachments: [],
            embeds: [],
            guildId: "g1",
            ...overrides
        }
    } as any;
}

const FIXTURES: DBMessageRecord[] = [
    makeRecord("1"),
    makeRecord("2", { content: "世界和平 下载 测试" }),
    makeRecord("3", { content: "see https://example.com/x for details" }),
    makeRecord("4", { attachments: [{ id: "a1", content_type: "image/png", filename: "a.png" }] }),
    makeRecord("5", { attachments: [{ id: "a2", content_type: "video/mp4", filename: "b.mp4" }] }),
    makeRecord("6", { attachments: [{ id: "a3", content_type: "audio/mpeg", filename: "c.mp3" }] }),
    makeRecord("7", { attachments: [{ id: "a4", content_type: "application/pdf", filename: "d.pdf" }] }),
    makeRecord("8", { attachments: [{ id: "a5", filename: "e.bin" }] }),
    makeRecord("9", { embeds: [{ image: { url: "u" } }] }),
    makeRecord("10", { embeds: [{ video: { url: "v" } }] }),
    makeRecord("11", { embeds: [{ description: "plain" }] }),
    makeRecord("12", { author: { id: "u2", username: "Bob", globalName: "" } }),
    makeRecord("13", { channel_id: "chan-2" }),
    makeRecord("14", { guildId: undefined, channel_id: "chan-1" }),
    makeRecord("15", { content: "ALICE uppercase" }, "EDITED")
];

const QUERIES = [
    "server:g1",
    "guild:g1",
    "channel:chan-1",
    "in:chan-2",
    "channel:general",
    "user:u1",
    "user:alice",
    "user:ali",
    "from:u2",
    "user:bob",
    "message:5",
    "has:attachment",
    "has:image",
    "has:video",
    "has:file",
    "has:sound",
    "has:embed",
    "has:link",
    "before:2025-01-01",
    "after:2025-01-01",
    "around:2026-01-01",
    "!user:u1",
    "!has:image",
    "hello",
    "hello world",
    "world",
    "下载",
    "ALICE",
    "example",
    "nomatch",
    "server:g9"
];

beforeEach(() => {
    webpackCommon.ChannelStore.getChannel = (id: string) => (id === "chan-1" ? { id: "chan-1", name: "general", guild_id: "g1" } : null);
    webpackCommon.GuildStore.getGuild = (id: string) => (id === "g1" ? { id: "g1", name: "Test Guild" } : null);
});

describe("index matcher parity with the scan matcher", () => {
    it.each(QUERIES)("agrees for query %s", query => {
        const { queries, rest } = tokenizeQuery(query);

        for (const record of FIXTURES) {
            expect(
                searchIndex.matchesIndex(searchIndex.buildEntry(record), queries, rest),
                `${query} on record ${record.message_id}`
            ).toBe(searchIndex.matchesRecord(record, queries, rest));
        }
    });

    it("agrees on a multi token query", () => {
        const { queries, rest } = tokenizeQuery("has:image hello server:g1");

        for (const record of FIXTURES) {
            expect(searchIndex.matchesIndex(searchIndex.buildEntry(record), queries, rest)).toBe(searchIndex.matchesRecord(record, queries, rest));
        }
    });
});

describe("buildIndexEntry flags", () => {
    const flag = (overrides: Record<string, any>) => searchIndex.buildEntry(makeRecord("1", overrides));

    it("detects attachment kinds", () => {
        expect(flag({})).toMatchObject({ attachment: false, image: false, video: false, file: false, sound: false });
        expect(flag({ attachments: [{ content_type: "image/png" }] })).toMatchObject({ attachment: true, image: true, file: false });
        expect(flag({ attachments: [{ content_type: "video/mp4" }] })).toMatchObject({ video: true, file: false });
        expect(flag({ attachments: [{ content_type: "audio/mpeg" }] })).toMatchObject({ sound: true, file: false });
        expect(flag({ attachments: [{ content_type: "application/pdf" }] })).toMatchObject({ file: true });
        expect(flag({ attachments: [{ filename: "x.bin" }] })).toMatchObject({ file: true });
    });

    it("detects embeds and links", () => {
        expect(flag({ embeds: [{ description: "d" }] })).toMatchObject({ embed: true, link: false, image: false, video: false });
        expect(flag({ embeds: [{ image: { url: "u" } }] })).toMatchObject({ embed: true, image: true });
        expect(flag({ embeds: [{ video: { url: "v" } }] })).toMatchObject({ embed: true, video: true });
        expect(flag({ content: "https://a.example.com" })).toMatchObject({ link: true });
    });

    it("lowercases content and author names and resolves the guild from the channel", () => {
        const entry = searchIndex.buildEntry(makeRecord("1", { guildId: undefined, author: { id: "u1", username: "MiXeD", globalName: "CaSe" } }));

        expect(entry.guildId).toBe("g1");
        expect(entry.username).toBe("mixed");
        expect(entry.globalName).toBe("case");
        expect(entry.content).toBe("hello world");
    });
});

describe("index container", () => {
    it("builds from a source and reports ready", async () => {
        const source = async function* () {
            yield FIXTURES.slice(0, 8);
            yield FIXTURES.slice(8);
        };

        await searchIndex.build(source as any);

        expect(searchIndex.isReady()).toBe(true);

        let count = 0;
        searchIndex.forEach(() => count++);
        expect(count).toBe(FIXTURES.length);
    });

    it("returns matches newest first or oldest first by id", () => {
        const { queries, rest } = tokenizeQuery("user:u1");

        const newest = searchIndex.search(queries, rest, "DELETED", 3, true);
        const oldest = searchIndex.search(queries, rest, "DELETED", 3, false);

        expect(newest.page.map(entry => entry.id)).toEqual(["9", "8", "7"]);
        expect(oldest.page.map(entry => entry.id)).toEqual(["1", "10", "11"]);
        expect(newest.total).toBe(oldest.total);
        expect(newest.total).toBeGreaterThan(3);
    });

    it("filters by status", () => {
        const attachments = tokenizeQuery("has:attachment");
        const text = tokenizeQuery("alice");

        expect(searchIndex.search(attachments.queries, attachments.rest, "DELETED", 100, true).total).toBe(5);
        expect(searchIndex.search(attachments.queries, attachments.rest, "EDITED", 10, true).page).toEqual([]);
        expect(searchIndex.search(text.queries, text.rest, "EDITED", 10, true).page.map(entry => entry.id)).toEqual(["15"]);
    });

    it("syncs adds and removes after the build", () => {
        const { queries, rest } = tokenizeQuery("freshly");

        searchIndex.addRecords([makeRecord("99", { content: "freshly added" })]);
        expect(searchIndex.search(queries, rest, "DELETED", 10, true).page.map(e => e.id)).toEqual(["99"]);

        searchIndex.removeIds(["99"]);
        expect(searchIndex.search(queries, rest, "DELETED", 10, true).page).toEqual([]);
    });

    it("reports the exact total so pagination keeps working", () => {
        const { queries, rest } = tokenizeQuery("hello");
        const { page, total } = searchIndex.search(queries, rest, "DELETED", 2, true);

        expect(page).toHaveLength(2);
        expect(total).toBeGreaterThan(2);
    });
});
