/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../settings", () => ({
    settings: { store: { language: "en" } }
}));

import entityPool from "../utils/entityPool";
import * as webpackCommon from "./mocks/webpackCommon";

const emptyLogged = { authors: [], guildIds: [], channelIds: [] };

beforeEach(() => {
    vi.stubGlobal("navigator", { language: "en-US" });
    webpackCommon.UserStore.getUser = () => null;
    webpackCommon.UserStore.getUsers = () => ({});
    webpackCommon.RelationshipStore.getFriendIDs = () => [];
    webpackCommon.ChannelStore.getChannel = () => null;
    webpackCommon.ChannelStore.getChannelIds = () => [];
    webpackCommon.ChannelStore.getDMUserIds = () => [];
    webpackCommon.ChannelStore.getDMFromUserId = () => null;
    webpackCommon.GuildStore.getGuild = () => null;
    webpackCommon.GuildStore.getGuilds = () => ({});
});

describe("user pool", () => {
    it("prefers store users over lowercased log data for authors", () => {
        webpackCommon.UserStore.getUser = (id: string) => (id === "u1" ? { id: "u1", username: "Alice", globalName: "Alice Display" } : null);

        const pool = entityPool.buildEntityPool("user", { authors: [{ id: "u1", username: "alice", globalName: "alice display" }], guildIds: [], channelIds: [] });

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "u1", name: "Alice Display", username: "Alice", typeLabel: "user" });
    });

    it("falls back to log data when the store has no user", () => {
        const pool = entityPool.buildEntityPool("user", { authors: [{ id: "u2", username: "bob", globalName: "bob" }], guildIds: [], channelIds: [] });

        expect(pool[0]).toMatchObject({ id: "u2", name: "bob", username: "bob" });
    });

    it("merges friends, dm users and the full user cache after logged authors", () => {
        webpackCommon.UserStore.getUsers = () => ({
            u1: { id: "u1", username: "alice" },
            u5: { id: "u5", username: "friend", globalName: "Friend" },
            u6: { id: "u6", username: "dmpal" },
            u9: { id: "u9", username: "cached", globalName: "Cached User" }
        });
        webpackCommon.RelationshipStore.getFriendIDs = () => ["u5"];
        webpackCommon.ChannelStore.getDMUserIds = () => ["u6"];

        const pool = entityPool.buildEntityPool("user", { authors: [{ id: "u1", username: "alice" }], guildIds: [], channelIds: [] });

        expect(pool.map(user => user.id)).toEqual(["u1", "u5", "u6", "u9"]);
    });
});

describe("server pool", () => {
    it("builds from logged guilds and the guild store with id fallback", () => {
        webpackCommon.GuildStore.getGuild = (id: string) => (id === "g1" ? { id: "g1", name: "Test Guild" } : null);
        webpackCommon.GuildStore.getGuilds = () => ({ g2: { id: "g2", name: "Other Guild" } });

        const pool = entityPool.buildEntityPool("server", { authors: [], guildIds: ["g1", "g-gone"], channelIds: [] });

        expect(pool.map(guild => guild.name)).toEqual(["Test Guild", "g-gone", "Other Guild"]);
        expect(pool[0]).toMatchObject({ id: "g1", typeLabel: "server" });
    });
});

describe("channel pool", () => {
    it("labels guild channels with their server name", () => {
        webpackCommon.ChannelStore.getChannel = (id: string) => (id === "c1" ? { id: "c1", name: "general", guild_id: "g1" } : null);
        webpackCommon.ChannelStore.getChannelIds = () => ["c1"];
        webpackCommon.GuildStore.getGuild = (id: string) => (id === "g1" ? { id: "g1", name: "Test Guild" } : null);

        const pool = entityPool.buildEntityPool("channel", emptyLogged);

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "c1", name: "general", sub: "Test Guild", typeLabel: "channel" });
    });

    it("derives dm channel labels from recipients", () => {
        webpackCommon.ChannelStore.getChannel = (id: string) => (id === "dm1" ? { id: "dm1", recipients: ["u1"] } : null);
        webpackCommon.ChannelStore.getChannelIds = () => ["dm1"];
        webpackCommon.UserStore.getUser = (id: string) => (id === "u1" ? { id: "u1", username: "alice", globalName: "Alice" } : null);

        const pool = entityPool.buildEntityPool("channel", emptyLogged);

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "dm1", name: "Alice", sub: "Direct Messages" });
    });

    it("joins recipient names for unnamed group dms", () => {
        webpackCommon.ChannelStore.getChannel = (id: string) => (id === "dm2" ? { id: "dm2", name: null, recipients: ["u1", "u2"] } : null);
        webpackCommon.ChannelStore.getChannelIds = () => ["dm2"];
        webpackCommon.UserStore.getUser = (id: string) => (id === "u1"
            ? { id: "u1", username: "alice", globalName: "Alice" }
            : id === "u2" ? { id: "u2", username: "bob" } : null);

        const pool = entityPool.buildEntityPool("channel", emptyLogged);

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "dm2", name: "Alice, bob", sub: "Direct Messages" });
    });

    it("pulls dm channels missing from the id list via getDMFromUserId", () => {
        webpackCommon.ChannelStore.getDMUserIds = () => ["u1"];
        webpackCommon.ChannelStore.getDMFromUserId = (userId: string) => ({ id: "dm9", recipients: [userId] });
        webpackCommon.UserStore.getUser = (id: string) => (id === "u1" ? { id: "u1", username: "alice" } : null);

        const pool = entityPool.buildEntityPool("channel", emptyLogged);

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "dm9", name: "alice" });
    });

    it("falls back to the channel id for unknown logged channels", () => {
        const pool = entityPool.buildEntityPool("channel", { authors: [], guildIds: [], channelIds: ["c-gone"] });

        expect(pool).toHaveLength(1);
        expect(pool[0]).toMatchObject({ id: "c-gone", name: "c-gone" });
    });
});
