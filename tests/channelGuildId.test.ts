/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore } from "@webpack/common";
import { afterEach, describe, expect, it, vi } from "vitest";

import channelGuildId from "../utils/channelGuildId";

afterEach(() => vi.restoreAllMocks());

describe("channel guild lookup", () => {
    it.each([
        { guild_id: "300", guildId: "400" },
        { guild_id: false, guildId: "400" }
    ])("uses a valid stored guild field without invoking the fallback method: %j", fields => {
        const getGuildId = vi.fn(() => "500");
        vi.spyOn(ChannelStore, "getChannel").mockReturnValue({ ...fields, getGuildId });
        expect(channelGuildId("200")).toBe(typeof fields.guild_id === "string" ? fields.guild_id : fields.guildId);
        expect(getGuildId).not.toHaveBeenCalled();
    });

    it("calls the channel method when both stored fields are missing or invalid", () => {
        const getGuildId = vi.fn(function(this: { resolved: string; }) { return this.resolved; });
        vi.spyOn(ChannelStore, "getChannel").mockReturnValue({ guild_id: " ", guildId: 123, resolved: "500", getGuildId });
        expect(channelGuildId("200")).toBe("500");
        expect(getGuildId).toHaveBeenCalledTimes(1);
    });

    it("continues to the parent after an empty method result", () => {
        const getGuildId = vi.fn(() => "");
        vi.spyOn(ChannelStore, "getChannel").mockImplementation((id: string) => id === "200"
            ? { parent_id: "201", getGuildId }
            : { guild_id: "300" });
        expect(channelGuildId("200")).toBe("300");
        expect(getGuildId).toHaveBeenCalledTimes(1);
    });
});
