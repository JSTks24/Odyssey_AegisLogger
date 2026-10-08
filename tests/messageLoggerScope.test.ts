/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({ settings: { store: {} } }));
vi.mock("@webpack", () => ({ findLazy: () => undefined, findByCodeLazy: () => () => undefined }));
vi.mock("../db", () => ({ DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" } }));

import { ChannelStore, MessageStore } from "@webpack/common";

import { settings } from "../index";
import messageLoggerScope from "../utils/messageLoggerScope";

beforeEach(() => {
    messageLoggerScope.stop();
    settings.store.whitelistedIds = "allowed-one,allowed-two";
    ChannelStore.getChannel = () => null;
    MessageStore.getMessage = () => null;
});

afterEach(() => messageLoggerScope.stop());

describe("native MessageLogger scope integration", () => {
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

    it("lets native edit, attachment and delete guards retain allowed messages", () => {
        const original = vi.fn(function(this: any, _message: any, _isEdit?: boolean) { return this.blocked; });
        const target = { blocked: false, shouldIgnore: original };
        messageLoggerScope.start(target);
        const item = { id: "1", channel_id: "current", guild_id: "allowed-one", author: { id: "self" } };
        expect(target.shouldIgnore(item, true)).toBe(false);
        expect(target.shouldIgnore(item, false)).toBe(false);
        target.blocked = true;
        expect(target.shouldIgnore(item, true)).toBe(true);
        expect(original.mock.calls).toHaveLength(3);
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
        expect(original).toHaveBeenCalledTimes(1);
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
