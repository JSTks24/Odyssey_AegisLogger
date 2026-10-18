/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/web", () => ({ chooseFile: vi.fn() }));
vi.mock("../index", () => ({ logger: {}, settings: { store: {} }, Native: {} }));
vi.mock("../utils/misc", () => ({ getGuildIdByChannel: () => undefined }));
vi.mock("../utils/saveImage", () => ({ clearAttachmentBlobCache: vi.fn() }));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key }));
vi.mock("../components/LogsModal", () => ({
    LogTabs: { DELETED: "Deleted", EDITED: "Edited", GHOST_PING: "Ghost Pinged" }
}));

import hooks from "../components/hooks";
import idb, { DBMessageStatus } from "../db";
import { doesMatch, tokenizeQuery } from "../utils/parseQuery";
import searchIndex from "../utils/searchIndex";
import { normalizeLogItem } from "../utils/settingsUtils";
import * as common from "./mocks/webpackCommon";

function record(id: string, overrides: Record<string, any> = {}) {
    return normalizeLogItem({
        status: DBMessageStatus.EDITED,
        message: {
            id,
            channel_id: "200",
            timestamp: new Date(Date.UTC(2026, 9, 18, 12) + Number(id)).toISOString(),
            author: { id: "100", username: "Alice" },
            content: "current body",
            attachments: [],
            embeds: [],
            editHistory: [],
            ...overrides
        }
    })!;
}

async function ids(query: string, newest = true, offset = 0, limit = 100) {
    return (await hooks.loadMessagesPage(query, DBMessageStatus.EDITED, newest, offset, limit)).records.map(value => value.message_id);
}

beforeAll(() => idb.dbReady);
afterAll(() => idb.connection.close());
beforeEach(async () => {
    await idb.clearMessagesIDB();
    common.ChannelStore.getChannel = () => null;
    common.GuildStore.getGuild = () => null;
});

describe.each([false, true])("saved log search with index ready=%s", ready => {
    async function save(records: ReturnType<typeof record>[]) {
        await idb.addMessageRecordsIDB(records);
        if (ready) await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB());
    }

    it("finds current and historical bodies without mixing versions or duplicating a message", async () => {
        await save([record("1", {
            content: "current 世界",
            editHistory: [
                { content: "Original 开会 Secret", timestamp: "2026-10-18T13:00:00Z" },
                { content: "previous 开会 text", timestamp: "2026-10-18T14:00:00Z" }
            ]
        })]);
        expect(await ids("")).toEqual(["1"]);
        expect(await ids("current 世界")).toEqual(["1"]);
        expect(await ids("ORIGINAL 开会 secret")).toEqual(["1"]);
        expect(await ids("开会")).toEqual(["1"]);
        expect(await ids("current Secret")).toEqual([]);
        expect(await ids("Original previous")).toEqual([]);
    });

    it("finds links retained only in edit history", async () => {
        const value = record("1", { editHistory: [{ content: "see https://example.com/old" }] });
        await save([value]);
        expect(await ids("has:link")).toEqual(["1"]);
        expect(await ids("!has:link")).toEqual([]);
        expect(doesMatch("has", "link", value.message)).toBeTruthy();
    });

    it("uses valid aliases for author and server fields, including candidate lists", async () => {
        await save([record("1", {
            guildId: "",
            guild_id: "300",
            author: { id: "100", username: 123, globalName: false, global_name: "Moonlight" }
        })]);
        expect(await ids("server:300 user:moonlight")).toEqual(["1"]);
        expect(await idb.getDistinctLogEntities()).toMatchObject({
            authors: [{ id: "100", globalName: expect.stringMatching(/^moonlight$/i) }],
            guildIds: ["300"],
            channelIds: ["200"]
        });
    });

    it("prefers valid canonical fields over their aliases", async () => {
        await save([record("1", { guildId: "300", guild_id: "400", author: { id: "100", globalName: "Canonical", global_name: "Alias" } })]);
        expect(await ids("server:300 user:canonical")).toEqual(["1"]);
        expect(await ids("server:400")).toEqual([]);
        expect(await ids("user:alias")).toEqual([]);
    });

    it("does not discard a record because optional fields have unexpected types", async () => {
        await save([record("1", {
            author: { id: "100", username: 123, globalName: [] },
            attachments: [null, false, { id: "a1", content_type: 123, filename: false }],
            embeds: [null, false, { image: "invalid", video: 123 }],
            editHistory: [null, { content: 42 }, { content: "Historical keyword" }]
        })]);
        expect(await ids("")).toEqual(["1"]);
        expect(await ids("message:1")).toEqual(["1"]);
        expect(await ids("user:100 current")).toEqual(["1"]);
        expect(await ids("historical keyword")).toEqual(["1"]);
        expect(await ids("has:image")).toEqual([]);
        expect(await ids("has:video")).toEqual([]);
    });

    it.each([undefined, 123, "", "video-broken", "audio-invalid"])("finds image filenames when MIME is %s", async contentType => {
        const value = record("1", { attachments: [{ id: "a1", filename: "photo.PNG", content_type: contentType }] });
        await save([value]);
        expect(await ids("has:image")).toEqual(["1"]);
        expect(await ids("has:file")).toEqual([]);
        expect(await ids("has:video")).toEqual([]);
        expect(await ids("has:sound")).toEqual([]);
        expect(doesMatch("has", "image", value.message)).toBe(true);
        expect(doesMatch("has", "file", value.message)).toBe(false);
    });

    it.each(["\n", "\t", "\u3000", " \t\n "])("separates filters and text with %j", async space => {
        await save([record("1")]);
        expect(await ids(`user:100${space}channel:200${space}current`)).toEqual(["1"]);
    });

    it.each([true, false])("returns the same complete historical match sequence with newest=%s", async newest => {
        await save(Array.from({ length: 7 }, (_, index) => record(String(index + 1), { editHistory: [{ content: "matching history" }] })));
        const found: string[] = [];
        let offset = 0;
        for (let page = 0; page < 5; page++) {
            const result = await hooks.loadMessagesPage("matching history", DBMessageStatus.EDITED, newest, offset, 2, undefined, new Set(found));
            found.push(...result.records.map(value => value.message_id));
            offset = result.nextOffset;
            if (!result.hasMore) break;
        }
        expect(found).toEqual(newest ? ["7", "6", "5", "4", "3", "2", "1"] : ["1", "2", "3", "4", "5", "6", "7"]);
        expect(new Set(found).size).toBe(7);
    });
});

it("resolves server ownership after the channel cache becomes available", async () => {
    await idb.addMessageRecordsIDB([record("1")]);
    await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB());
    expect(await ids("server:300")).toEqual([]);
    common.ChannelStore.getChannel = (id: string) => ({ id, guild_id: "300", name: "general" });
    expect(await ids("server:300")).toEqual(["1"]);
    expect((await idb.getDistinctLogEntities()).guildIds).toEqual(["300"]);
    searchIndex.clear();
    expect(await ids("server:300")).toEqual(["1"]);
});

it.each([
    { guild_id: "300" },
    { guildId: "300" },
    { getGuildId: () => "300" }
])("resolves thread ownership through late parent channel metadata %j", async parent => {
    await idb.addMessageRecordsIDB([record("1")]);
    common.ChannelStore.getChannel = (id: string) => id === "200" ? { id, parent_id: "201" } : null;
    await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB());
    expect(await ids("server:300")).toEqual([]);
    common.ChannelStore.getChannel = (id: string) => id === "200" ? { id, parent_id: "201" } : { id, ...parent };
    expect(await ids("server:300")).toEqual(["1"]);
    expect((await idb.getDistinctLogEntities()).guildIds).toEqual(["300"]);
    expect(doesMatch("server", "300", record("1").message)).toBe(true);
    searchIndex.clear();
    expect(await ids("server:300")).toEqual(["1"]);
});

it("bounds cyclic parent channel metadata without hiding a valid stored guild", async () => {
    common.ChannelStore.getChannel = (id: string) => ({ id, parent_id: id === "200" ? "201" : "200" });
    await idb.addMessageRecordsIDB([record("1"), record("2", { guild_id: "300" })]);
    await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB());
    expect(await ids("server:300")).toEqual(["2"]);
    expect(await ids("message:1")).toEqual(["1"]);
});

it("keeps malformed message structures out of the matcher", () => {
    const { queries, rest } = tokenizeQuery("message:1");
    expect(searchIndex.matchesRecord({ message: null } as any, queries, rest)).toBe(false);
});
