/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({ settings: { store: {} } }));
vi.mock("@webpack", () => ({
    findLazy: () => undefined,
    findByCodeLazy: () => () => undefined,
    findStoreLazy: () => ({ isMuted: () => false, isCategoryMuted: () => false, isChannelMuted: () => false })
}));
vi.mock("../db", () => ({ DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" } }));

import { ChannelStore, MessageStore, UserStore } from "@webpack/common";

import { settings } from "../index";
import messageLoggerScope from "../utils/messageLoggerScope";

beforeEach(() => {
    messageLoggerScope.stop();
    settings.store.whitelistedIds = "allowed-one,allowed-two";
    settings.store.ignoreBots = false;
    settings.store.ignoreSelf = false;
    settings.store.blacklistedIds = "";
    settings.store.exclusionRules = "";
    settings.store.alwaysLogDirectMessages = false;
    settings.store.alwaysLogCurrentChannel = false;
    settings.store.logDeletes = true;
    settings.store.logEdits = true;
    ChannelStore.getChannel = () => null;
    MessageStore.getMessage = () => null;
    UserStore.getUser = () => null;
    UserStore.getCurrentUser = () => ({ id: "self" });
});

afterEach(() => messageLoggerScope.stop());

describe("native MessageLogger scope integration", () => {
    it.each([
        [false, false, false],
        [false, true, false],
        [true, false, true],
        [true, true, true]
    ])("uses only local bot settings with local=%s and native=%s", (localIgnore, nativeIgnore, expected) => {
        settings.store.ignoreBots = localIgnore;
        settings.store.whitelistedIds = "bot";
        const original = vi.fn((message: any, _isEdit?: boolean) => nativeIgnore && message.author?.bot === true);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        const message = { id: "1", channel_id: "current", author: { id: "bot", bot: true } };
        expect(target.shouldIgnore(message, false)).toBe(expected);
        expect(target.shouldIgnore(message, true)).toBe(expected);
        expect(original).not.toHaveBeenCalled();
    });

    it("blocks partial bot updates from the same native message before attachment and edit side effects", () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "";
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        MessageStore.getMessage = (channelId: string, id: string) => ({ id, channel_id: channelId, author: { id: "bot", bot: true } });
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current" }, true)).toBe(true);
        expect(original).not.toHaveBeenCalled();
    });

    it("recovers the bot flag from the matching user without borrowing a different cached author", () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "";
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        MessageStore.getMessage = () => ({ id: "different", author: { id: "other", bot: true } });
        UserStore.getUser = (id: string) => id === "bot" ? { id, bot: true } : null;
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current", author: { id: "human" } }, true)).toBe(false);
        expect(target.shouldIgnore({ id: "2", channel_id: "current", author: { id: "bot" } }, true)).toBe(true);
    });

    it("handles an unavailable native target without installing a guard", () => {
        expect(() => messageLoggerScope.start(undefined)).not.toThrow();
        expect(() => messageLoggerScope.start(null)).not.toThrow();
        expect(() => messageLoggerScope.start({} as any)).not.toThrow();
    });
    it.each([false, true])("blocks outside deletes and edits before native side effects with edit=%s", isEdit => {
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current", guild_id: "outside", author: { id: "self" }, ghostPinged: true }, isEdit)).toBe(true);
        expect(original).not.toHaveBeenCalled();
    });

    it("uses local filtering even when the native filter disagrees", () => {
        const original = vi.fn(function(this: any, _message: any, _isEdit?: boolean) { return this.blocked; });
        const target = { blocked: false, shouldIgnore: original };
        messageLoggerScope.start(target);
        const item = { id: "1", channel_id: "current", guild_id: "allowed-one", author: { id: "self" } };
        expect(target.shouldIgnore(item, true)).toBe(false);
        expect(target.shouldIgnore(item, false)).toBe(false);
        target.blocked = true;
        expect(target.shouldIgnore(item, true)).toBe(false);
        expect(original).not.toHaveBeenCalled();
    });

    it("recovers native partial update context from the same message cache", () => {
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        MessageStore.getMessage = (channelId: string, id: string) => channelId === "current" && id === "1"
            ? { id, channel_id: channelId, guild_id: "allowed-one", author: { id: "self" } }
            : null;
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current" }, true)).toBe(false);
        expect(target.shouldIgnore({ id: "2", channel_id: "current" }, true)).toBe(true);
        expect(original).not.toHaveBeenCalled();
    });

    it("keeps known DMs and the empty whitelist behavior", () => {
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        ChannelStore.getChannel = () => ({ type: 3 });
        expect(target.shouldIgnore({ id: "1", channel_id: "dm" })).toBe(false);
        settings.store.whitelistedIds = "";
        ChannelStore.getChannel = () => null;
        expect(target.shouldIgnore({ id: "2", channel_id: "unknown" })).toBe(false);
    });

    it.each([false, true])("checks the record switch before whitelist and ghost ping exceptions with edit=%s", isEdit => {
        settings.store[isEdit ? "logEdits" : "logDeletes"] = false;
        settings.store.whitelistedIds = "self";
        const original = vi.fn(() => false);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current", author: { id: "self" }, ghostPinged: true }, isEdit)).toBe(true);
        expect(original).not.toHaveBeenCalled();
    });

    it("uses the same local blacklist for native edits and deletes", () => {
        settings.store.whitelistedIds = "";
        settings.store.blacklistedIds = "blocked";
        const target = { shouldIgnore: vi.fn(() => false) };
        messageLoggerScope.start(target);
        const message = { id: "1", channel_id: "current", author: { id: "blocked" } };
        expect(target.shouldIgnore(message, false)).toBe(true);
        expect(target.shouldIgnore(message, true)).toBe(true);
    });

    it("keeps synchronous native filtering usable during account transitions", () => {
        settings.store.whitelistedIds = "";
        UserStore.getCurrentUser = () => null;
        const target = { shouldIgnore: vi.fn(() => false) };
        messageLoggerScope.start(target);
        expect(target.shouldIgnore({ id: "1", channel_id: "current", mentions: ["other"] }, false)).toBe(false);
    });

    it("starts and stops idempotently and restores the exact original function", () => {
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        const guarded = target.shouldIgnore;
        messageLoggerScope.start(target);
        expect(target.shouldIgnore).toBe(guarded);
        messageLoggerScope.stop();
        messageLoggerScope.stop();
        expect(target.shouldIgnore).toBe(original);
        expect(guarded({ guild_id: "outside" })).toBe(false);
    });

    it("does not undo another replacement and disables its retained wrapper", () => {
        const original = vi.fn((_message: any, _isEdit?: boolean) => false);
        const target = { shouldIgnore: original };
        messageLoggerScope.start(target);
        const guarded = target.shouldIgnore;
        const replacement = vi.fn((message: any, isEdit?: boolean) => guarded(message, isEdit));
        target.shouldIgnore = replacement;
        messageLoggerScope.stop();
        expect(target.shouldIgnore).toBe(replacement);
        expect(target.shouldIgnore({ guild_id: "outside" }, true)).toBe(false);
        expect(original).toHaveBeenCalledTimes(1);
    });

    it("moves a binding without leaving the old target active", () => {
        const firstOriginal = vi.fn((_message: any, _isEdit?: boolean) => false);
        const first = { shouldIgnore: firstOriginal };
        const secondOriginal = vi.fn((_message: any, _isEdit?: boolean) => false);
        const second = { shouldIgnore: secondOriginal };
        messageLoggerScope.start(first);
        messageLoggerScope.start(second);
        expect(first.shouldIgnore).toBe(firstOriginal);
        expect(second.shouldIgnore({ guild_id: "outside" })).toBe(true);
        messageLoggerScope.stop();
        expect(second.shouldIgnore).toBe(secondOriginal);
    });
});
