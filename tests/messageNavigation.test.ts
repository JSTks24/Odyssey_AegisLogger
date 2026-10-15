/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import messageNavigation from "../utils/messageNavigation";

function clickEvent(overrides: Record<string, unknown> = {}) {
    return {
        button: 0,
        defaultPrevented: false,
        target: { nodeType: 1, closest: vi.fn(() => null) },
        currentTarget: {
            contains: vi.fn(() => true),
            ownerDocument: { getSelection: vi.fn(() => null) }
        },
        ...overrides
    } as unknown as Parameters<typeof messageNavigation.shouldJump>[0];
}

describe("log message navigation", () => {
    it("prefers the archived guild when the channel cache is absent or inconsistent", () => {
        const record = { id: "message", channel_id: "channel", guildId: "archived-guild" };
        expect(messageNavigation.getMessagePath(record)).toBe("/channels/archived-guild/channel/message");
        expect(messageNavigation.getMessagePath(record, "cached-guild")).toBe("/channels/archived-guild/channel/message");
    });

    it("uses the resolved channel guild for ordinary channels and forum posts", () => {
        expect(messageNavigation.getMessagePath({ id: "message", channel_id: "channel" }, "guild"))
            .toBe("/channels/guild/channel/message");
        expect(messageNavigation.getMessagePath({ id: "message", channel_id: "thread" }, "parent-guild"))
            .toBe("/channels/parent-guild/thread/message");
    });

    it("uses the direct-message route without a guild and retains channel-only navigation", () => {
        expect(messageNavigation.getMessagePath({ id: "message", channel_id: "dm" }))
            .toBe("/channels/@me/dm/message");
        expect(messageNavigation.getMessagePath({ id: "", channel_id: "dm" }))
            .toBe("/channels/@me/dm");
    });

    it("accepts an ordinary message-body click", () => {
        expect(messageNavigation.shouldJump(clickEvent())).toBe(true);
    });

    it("preserves prevented and non-primary clicks", () => {
        expect(messageNavigation.shouldJump(clickEvent({ defaultPrevented: true }))).toBe(false);
        expect(messageNavigation.shouldJump(clickEvent({ button: 1 }))).toBe(false);
        expect(messageNavigation.shouldJump(clickEvent({ button: 2 }))).toBe(false);
    });

    it("preserves an interactive ancestor such as a native media wrapper", () => {
        const wrapper = {};
        const closest = vi.fn(() => wrapper);
        const event = clickEvent({ target: { nodeType: 1, closest } });
        expect(messageNavigation.shouldJump(event)).toBe(false);
        expect(event.currentTarget.contains).toHaveBeenCalledWith(wrapper);
    });

    it("does not treat an interactive ancestor outside the message as its control", () => {
        const event = clickEvent({ target: { nodeType: 1, closest: () => ({}) } });
        vi.mocked(event.currentTarget.contains).mockReturnValue(false);
        expect(messageNavigation.shouldJump(event)).toBe(true);
    });

    it("checks text-node targets through their parent element", () => {
        const event = clickEvent({ target: { nodeType: 3, parentElement: { closest: () => ({}) } } });
        expect(messageNavigation.shouldJump(event)).toBe(false);
    });

    it("preserves a text selection instead of closing the logs", () => {
        const event = clickEvent();
        vi.mocked(event.currentTarget.ownerDocument.getSelection).mockReturnValue({ toString: () => "selected text" } as Selection);
        expect(messageNavigation.shouldJump(event)).toBe(false);
    });
});
