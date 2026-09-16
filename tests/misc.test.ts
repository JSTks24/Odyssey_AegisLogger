/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@webpack", () => ({
    findLazy: () => undefined,
    findByCodeLazy: () => () => undefined
}));

vi.mock("../utils/index", () => ({
    DISCORD_EPOCH: 14200704e5
}));

vi.mock("../db", () => ({
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));

import { UserStore } from "@webpack/common";

import { DBMessageStatus } from "../db";
import {
    discordIdToDate,
    findLastIndex,
    getMessageStatus,
    hasPingged,
    isGhostPinged,
    parseJSON,
    sortMessagesByDate
} from "../utils/misc";

beforeEach(() => {
    UserStore.getCurrentUser = () => ({ id: "self" });
});

describe("getMessageStatus", () => {
    it("reports ghost pinged messages", () => {
        expect(getMessageStatus({ ghostPinged: true } as any)).toBe(DBMessageStatus.GHOST_PINGED);
    });

    it("reports deleted messages", () => {
        expect(getMessageStatus({ deleted: true } as any)).toBe(DBMessageStatus.DELETED);
    });

    it("prefers GHOST_PINGED over DELETED when both flags are set", () => {
        expect(getMessageStatus({ deleted: true, ghostPinged: true } as any)).toBe(DBMessageStatus.GHOST_PINGED);
    });

    it("reports edited messages via their edit history", () => {
        expect(getMessageStatus({ editHistory: [{ content: "old", timestamp: "2026-01-01T00:00:00.000Z" }] } as any))
            .toBe(DBMessageStatus.EDITED);
    });

    it("throws for messages without a derivable status", () => {
        expect(() => getMessageStatus({} as any)).toThrow("Unknown message status");
    });
});

describe("hasPingged", () => {
    it("is true when everyone is mentioned", () => {
        expect(hasPingged({ mention_everyone: true, mentions: [] } as any)).toBe(true);
    });

    it("is true when the current user appears as an object mention", () => {
        expect(hasPingged({ mention_everyone: false, mentions: [{ id: "other" }, { id: "self" }] } as any)).toBe(true);
    });

    it("is true when the current user appears as a raw id string", () => {
        expect(hasPingged({ mention_everyone: false, mentions: ["other", "self"] } as any)).toBe(true);
    });

    it("is false when nobody pinged the current user", () => {
        expect(hasPingged({ mention_everyone: false, mentions: [{ id: "other" }, "42"] } as any)).toBe(false);
    });

    it("compares against the current user provided by UserStore", () => {
        UserStore.getCurrentUser = () => ({ id: "someone-else" });

        expect(hasPingged({ mention_everyone: false, mentions: ["self"] } as any)).toBe(false);
        expect(hasPingged({ mention_everyone: false, mentions: ["someone-else"] } as any)).toBe(true);
    });

    it("is falsy without a message", () => {
        expect(hasPingged(undefined)).toBeFalsy();
    });
});

describe("isGhostPinged", () => {
    it("is true when the ghostPinged flag is set", () => {
        expect(isGhostPinged({ ghostPinged: true } as any)).toBe(true);
    });

    it("is true for deleted messages that pinged the current user", () => {
        expect(isGhostPinged({ deleted: true, mention_everyone: false, mentions: ["self"] } as any)).toBe(true);
        expect(isGhostPinged({ deleted: true, mention_everyone: true } as any)).toBe(true);
    });

    it("is false for deleted messages without pings", () => {
        expect(isGhostPinged({ deleted: true, mention_everyone: false, mentions: [] } as any)).toBe(false);
    });

    it("is falsy without a message", () => {
        expect(isGhostPinged()).toBeFalsy();
    });
});

describe("discordIdToDate", () => {
    it("converts a snowflake into its exact creation date", () => {
        const snowflake = String((Date.UTC(2020, 0, 1) - 14200704e5) * 4194304);

        expect(discordIdToDate(snowflake).getTime()).toBe(Date.UTC(2020, 0, 1));
        expect(discordIdToDate(snowflake).toISOString()).toBe("2020-01-01T00:00:00.000Z");
    });

    it("maps the Discord epoch snowflake right after the epoch", () => {
        const date = discordIdToDate("1420070400000");

        expect(date.getTime()).toBeGreaterThan(Date.UTC(2015, 0, 1));
        expect(date.getTime()).toBeLessThan(Date.UTC(2015, 0, 2));
    });
});

describe("sortMessagesByDate", () => {
    it("sorts newest first", () => {
        expect(sortMessagesByDate("2026-01-01T00:00:00.000Z", "2027-01-01T00:00:00.000Z")).toBe(1);
        expect(sortMessagesByDate("2027-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(-1);
        expect(sortMessagesByDate("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z")).toBe(0);
    });
});

describe("findLastIndex", () => {
    it("returns the index of the last match", () => {
        expect(findLastIndex([1, 2, 3, 2], e => e === 2)).toBe(3);
    });

    it("feeds element, index and array to the predicate", () => {
        const calls: any[] = [];

        findLastIndex(["a", "b"], (e, i, arr) => {
            calls.push([e, i, arr]);
            return false;
        });

        expect(calls).toEqual([["b", 1, ["a", "b"]], ["a", 0, ["a", "b"]]]);
    });

    it("returns -1 when nothing matches", () => {
        expect(findLastIndex([1, 2, 3], e => e === 99)).toBe(-1);
        expect(findLastIndex([], () => true)).toBe(-1);
    });
});

describe("parseJSON", () => {
    it("returns null even for valid JSON because the finally clause discards the result", () => {
        expect(parseJSON("{\"a\":1}")).toBeNull();
    });

    it("returns null for invalid JSON instead of throwing", () => {
        expect(parseJSON("not json")).toBeNull();
    });

    it("returns null for missing input", () => {
        expect(parseJSON(undefined)).toBeNull();
        expect(parseJSON(null)).toBeNull();
    });
});
