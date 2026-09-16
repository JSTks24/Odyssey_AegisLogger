/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    settings: {
        store: {
            whitelistedIds: "",
            blacklistedIds: "",
            exclusionRules: "",
            ignoreBots: false,
            ignoreSelf: false,
            ignoreMutedGuilds: false,
            ignoreMutedCategories: false,
            ignoreMutedChannels: false,
            alwaysLogDirectMessages: false,
            alwaysLogCurrentChannel: false
        }
    }
}));

vi.mock("@webpack", () => ({
    findStoreLazy: () => ({ isMuted: () => false, isCategoryMuted: () => false, isChannelMuted: () => false })
}));

vi.mock("../utils/misc", () => ({
    findLastIndex: (arr: any[], predicate: (e: any, i: number, a: any[]) => boolean) => {
        for (let i = arr.length - 1; i >= 0; i--) {
            if (predicate(arr[i], i, arr)) return i;
        }
        return -1;
    },
    getGuildIdByChannel: vi.fn(() => undefined)
}));

vi.mock("../utils/cleanUp", () => ({}));

import { Settings } from "@api/Settings";
import { ChannelStore, SelectedChannelStore } from "@webpack/common";

import { settings } from "../index";
import {
    addToX,
    addToXAndRemoveFromOpposite,
    contentExcluded,
    getGuildIdByChannel,
    getIdList,
    getListMenuState,
    removeFromX,
    shouldIgnore
} from "../utils/index";

beforeEach(() => {
    Object.assign(settings.store, {
        whitelistedIds: "",
        blacklistedIds: "",
        exclusionRules: "",
        ignoreBots: false,
        ignoreSelf: false,
        ignoreMutedGuilds: false,
        ignoreMutedCategories: false,
        ignoreMutedChannels: false,
        alwaysLogDirectMessages: false,
        alwaysLogCurrentChannel: false
    });
    Settings.plugins.MessageLogger.ignoreUsers = "";
    Settings.plugins.MessageLogger.ignoreChannels = "";
    Settings.plugins.MessageLogger.ignoreGuilds = "";
    ChannelStore.getChannel = () => null;
    SelectedChannelStore.getChannelId = () => "";
    vi.mocked(getGuildIdByChannel).mockClear();
});

describe("getIdList", () => {
    it("returns an empty list for an empty setting", () => {
        settings.store.whitelistedIds = "";
        expect(getIdList("whitelistedIds")).toEqual([]);
    });

    it("splits comma separated ids", () => {
        settings.store.blacklistedIds = "a,b,c";
        expect(getIdList("blacklistedIds")).toEqual(["a", "b", "c"]);
    });

    it("trims whitespace around ids", () => {
        settings.store.whitelistedIds = " a , b ";
        expect(getIdList("whitelistedIds")).toEqual(["a", "b"]);
    });

    it("filters empty segments", () => {
        settings.store.whitelistedIds = ",,a,,b,";
        expect(getIdList("whitelistedIds")).toEqual(["a", "b"]);
    });
});

describe("addToX and removeFromX", () => {
    it("appends new ids and writes back joined by commas", () => {
        settings.store.whitelistedIds = "a";
        addToX("whitelistedIds", "b");
        expect(settings.store.whitelistedIds).toBe("a,b");
    });

    it("does not duplicate an id already in the list", () => {
        settings.store.whitelistedIds = "a,b";
        addToX("whitelistedIds", "b");
        expect(settings.store.whitelistedIds).toBe("a,b");
    });

    it("appends to an empty list", () => {
        settings.store.blacklistedIds = "";
        addToX("blacklistedIds", "x");
        expect(settings.store.blacklistedIds).toBe("x");
    });

    it("removes only ids present in the list", () => {
        settings.store.blacklistedIds = "a,b";
        removeFromX("blacklistedIds", "a");
        expect(settings.store.blacklistedIds).toBe("b");

        removeFromX("blacklistedIds", "zzz");
        expect(settings.store.blacklistedIds).toBe("b");
    });
});

describe("addToXAndRemoveFromOpposite", () => {
    it("whitelisting removes the id from the blacklist", () => {
        settings.store.whitelistedIds = "";
        settings.store.blacklistedIds = "x,y";
        addToXAndRemoveFromOpposite("whitelistedIds", "x");

        expect(settings.store.whitelistedIds).toBe("x");
        expect(settings.store.blacklistedIds).toBe("y");
    });

    it("blacklisting removes the id from the whitelist", () => {
        settings.store.whitelistedIds = "x,y";
        settings.store.blacklistedIds = "";
        addToXAndRemoveFromOpposite("blacklistedIds", "y");

        expect(settings.store.blacklistedIds).toBe("y");
        expect(settings.store.whitelistedIds).toBe("x");
    });
});

describe("contentExcluded", () => {
    it("excludes content matching an exclusion rule", () => {
        settings.store.exclusionRules = "^secret";
        expect(contentExcluded("secret plans", "g1", "c1", "a1")).toBe(true);
    });

    it("keeps content not matching any rule", () => {
        settings.store.exclusionRules = "^secret";
        expect(contentExcluded("hello world", "g1", "c1", "a1")).toBe(false);
    });

    it("keeps null and undefined content", () => {
        settings.store.exclusionRules = "^secret";
        expect(contentExcluded(null)).toBe(false);
        expect(contentExcluded(undefined)).toBe(false);
    });
});

describe("shouldIgnore", () => {
    it("ignores ephemeral messages", () => {
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", flags: 64 })).toBe(true);
    });

    it("ignores blacklisted authors", () => {
        settings.store.blacklistedIds = "bad-author";
        expect(shouldIgnore({ channelId: "c1", authorId: "bad-author" })).toBe(true);
    });

    it("keeps whitelisted authors even when the guild is blacklisted", () => {
        settings.store.whitelistedIds = "good-author";
        settings.store.blacklistedIds = "bad-guild";
        expect(shouldIgnore({ channelId: "c1", authorId: "good-author", guildId: "bad-guild" })).toBe(false);
    });

    it("ignores bots when ignoreBots is on", () => {
        settings.store.ignoreBots = true;
        expect(shouldIgnore({ channelId: "c1", authorId: "bot-1", bot: true })).toBe(true);
    });

    it("keeps whitelisted bots when ignoreBots is on", () => {
        settings.store.ignoreBots = true;
        settings.store.whitelistedIds = "bot-1";
        expect(shouldIgnore({ channelId: "c1", authorId: "bot-1", bot: true })).toBe(false);
    });

    it("keeps ghost pinged messages even when content matches an exclusion rule", () => {
        settings.store.exclusionRules = "^secret";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", content: "secret stuff", ghostPinged: true })).toBe(false);
    });

    it("ignores content matching exclusion rules", () => {
        settings.store.exclusionRules = "^secret";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", content: "secret stuff" })).toBe(true);
    });

    it("keeps content not matching exclusion rules", () => {
        settings.store.exclusionRules = "^secret";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", content: "hello" })).toBe(false);
    });

    it("honors the built-in MessageLogger ignoreUsers list as a merged blacklist", () => {
        Settings.plugins.MessageLogger.ignoreUsers = "spammer";
        expect(shouldIgnore({ channelId: "c1", authorId: "spammer" })).toBe(true);
    });

    it("always keeps direct messages when alwaysLogDirectMessages is on", () => {
        settings.store.alwaysLogDirectMessages = true;
        settings.store.blacklistedIds = "bad-author";
        ChannelStore.getChannel = () => ({ isDM: () => true });
        expect(shouldIgnore({ channelId: "dm-chan", authorId: "bad-author" })).toBe(false);
    });

    it("still ignores blacklisted authors in non-DM channels with alwaysLogDirectMessages on", () => {
        settings.store.alwaysLogDirectMessages = true;
        settings.store.blacklistedIds = "bad-author";
        ChannelStore.getChannel = () => ({ isDM: () => false });
        expect(shouldIgnore({ channelId: "c1", authorId: "bad-author" })).toBe(true);
    });

    it("always keeps the currently selected channel when alwaysLogCurrentChannel is on", () => {
        settings.store.alwaysLogCurrentChannel = true;
        settings.store.blacklistedIds = "bad-guild";
        SelectedChannelStore.getChannelId = () => "current-chan";
        expect(shouldIgnore({ channelId: "current-chan", authorId: "a1", guildId: "bad-guild" })).toBe(false);
    });

    it("ignores blacklisted channels", () => {
        settings.store.blacklistedIds = "bad-chan";
        expect(shouldIgnore({ channelId: "bad-chan", authorId: "a1" })).toBe(true);
    });

    it("ignores blacklisted guilds", () => {
        settings.store.blacklistedIds = "bad-guild";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", guildId: "bad-guild" })).toBe(true);
    });

    it("keeps guild messages when the whitelist is empty", () => {
        settings.store.whitelistedIds = "";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", guildId: "g1" })).toBe(false);
    });

    it("ignores non-whitelisted guild messages when the whitelist is set", () => {
        settings.store.whitelistedIds = "g1";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", guildId: "g2" })).toBe(true);
    });

    it("keeps whitelisted guild messages when the whitelist is set", () => {
        settings.store.whitelistedIds = "g1";
        expect(shouldIgnore({ channelId: "c1", authorId: "a1", guildId: "g1" })).toBe(false);
    });

    it("keeps whitelisted channel messages when the whitelist is set", () => {
        settings.store.whitelistedIds = "good-chan";
        expect(shouldIgnore({ channelId: "good-chan", authorId: "a1", guildId: "g2" })).toBe(false);
    });

    it("keeps whitelisted author messages in non-whitelisted guilds when the whitelist is set", () => {
        settings.store.whitelistedIds = "good-author";
        expect(shouldIgnore({ channelId: "c1", authorId: "good-author", guildId: "g2" })).toBe(false);
    });

    it("keeps direct messages when the whitelist is set and alwaysLogDirectMessages is on", () => {
        settings.store.whitelistedIds = "g1";
        settings.store.alwaysLogDirectMessages = true;
        ChannelStore.getChannel = () => ({ isDM: () => true });
        expect(shouldIgnore({ channelId: "dm-chan", authorId: "a1" })).toBe(false);
    });

    it("keeps the current channel when the whitelist is set and alwaysLogCurrentChannel is on", () => {
        settings.store.whitelistedIds = "g1";
        settings.store.alwaysLogCurrentChannel = true;
        SelectedChannelStore.getChannelId = () => "current-chan";
        expect(shouldIgnore({ channelId: "current-chan", authorId: "a1", guildId: "g2" })).toBe(false);
    });
});

describe("guild id derivation", () => {
    it("derives the guild id from the channel when guildId is absent", () => {
        shouldIgnore({ channelId: "chan-1", authorId: "a1" });
        expect(getGuildIdByChannel).toHaveBeenCalledWith("chan-1");
    });

    it("does not derive the guild id when guildId is provided", () => {
        shouldIgnore({ channelId: "chan-1", authorId: "a1", guildId: "g1" });
        expect(getGuildIdByChannel).not.toHaveBeenCalled();
    });

    it("treats channels without a guild as non-guild messages", () => {
        expect(shouldIgnore({ channelId: "dm-chan", authorId: "a1" })).toBe(false);
    });
});

describe("getListMenuState", () => {
    it("returns remove when every id is already in the list", () => {
        settings.store.blacklistedIds = "a,b";
        expect(getListMenuState("blacklistedIds", ["a", "b"])).toBe("remove");
    });

    it("returns add when no id is in either list", () => {
        settings.store.whitelistedIds = "";
        settings.store.blacklistedIds = "";
        expect(getListMenuState("blacklistedIds", ["a"])).toBe("add");
        expect(getListMenuState("whitelistedIds", ["a"])).toBe("add");
    });

    it("returns move when an id is in the opposite list", () => {
        settings.store.whitelistedIds = "a";
        settings.store.blacklistedIds = "";
        expect(getListMenuState("blacklistedIds", ["a"])).toBe("move");
        expect(getListMenuState("whitelistedIds", ["a"])).toBe("remove");
    });

    it("returns add for a mixed folder when only part is listed", () => {
        settings.store.blacklistedIds = "a";
        expect(getListMenuState("blacklistedIds", ["a", "b"])).toBe("add");
    });

    it("returns move for a mixed folder when part is in the opposite list", () => {
        settings.store.whitelistedIds = "b";
        settings.store.blacklistedIds = "";
        expect(getListMenuState("blacklistedIds", ["a", "b"])).toBe("move");
    });
});
