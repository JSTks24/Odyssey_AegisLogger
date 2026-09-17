/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { matchCandidates, resolveInput } from "../utils/idMatch";

const pool = [
    { id: "100", name: "Alice", typeLabel: "user" },
    { id: "101", name: "Alina", typeLabel: "user" },
    { id: "102", name: "Bob", typeLabel: "user" },
    { id: "103", name: "类脑ΟΔΥΣΣΕΙΑ", typeLabel: "server" },
    { id: "104", name: "general-chat", typeLabel: "channel" }
];

describe("matchCandidates", () => {
    it("matches ids exactly with the highest priority", () => {
        const result = matchCandidates("100", [...pool, { id: "1000", name: "Alice Duplicate", typeLabel: "user" }]);

        expect(result[0].id).toBe("100");
    });

    it("ranks name prefix matches above substring matches", () => {
        const result = matchCandidates("al", pool);

        expect(result.map(entry => entry.id)).toEqual(["100", "101", "104"]);
    });

    it("matches names case-insensitively and by substring", () => {
        const result = matchCandidates("OB", pool);

        expect(result.map(entry => entry.id)).toEqual(["102"]);
    });

    it("matches unicode names by substring", () => {
        const result = matchCandidates("类脑", pool);

        expect(result.map(entry => entry.id)).toEqual(["103"]);
    });

    it("returns no more than the limit", () => {
        const bigPool = Array.from({ length: 30 }, (_, i) => ({ id: String(i), name: `user${i}`, typeLabel: "user" }));

        expect(matchCandidates("user", bigPool)).toHaveLength(8);
        expect(matchCandidates("user", bigPool, 3)).toHaveLength(3);
    });

    it("returns empty for blank input and for no matches", () => {
        expect(matchCandidates("   ", pool)).toEqual([]);
        expect(matchCandidates("zzz", pool)).toEqual([]);
    });

    it("keeps pool order for equal scores", () => {
        const dupPool = [
            { id: "a", name: "alpha", typeLabel: "user" },
            { id: "b", name: "alpha", typeLabel: "channel" }
        ];

        expect(matchCandidates("alpha", dupPool).map(entry => entry.id)).toEqual(["a", "b"]);
    });

    it("matches the username field by prefix and substring", () => {
        const userPool = [
            { id: "200", name: "Display A", username: "al_gamer", typeLabel: "user" },
            { id: "201", name: "Display B", username: "xal_y", typeLabel: "user" }
        ];

        expect(matchCandidates("al_g", userPool).map(entry => entry.id)).toEqual(["200"]);
        expect(matchCandidates("AL_", userPool).map(entry => entry.id)).toEqual(["200", "201"]);
    });

    it("matches username case-insensitively", () => {
        const userPool = [
            { id: "202", name: "展示名", username: "Tsukasa", typeLabel: "user" }
        ];

        expect(matchCandidates("TSUK", userPool).map(entry => entry.id)).toEqual(["202"]);
        expect(matchCandidates("kas", userPool).map(entry => entry.id)).toEqual(["202"]);
    });

    it("matches id prefixes for numeric input of three or more digits", () => {
        const snowflakePool = [
            { id: "1380075940285124724", name: "Alice", typeLabel: "user" },
            { id: "1380075940285124799", name: "Bob", typeLabel: "user" },
            { id: "1371111111111111111", name: "Carol", typeLabel: "user" }
        ];

        expect(matchCandidates("138007", snowflakePool).map(entry => entry.id)).toEqual(["1380075940285124724", "1380075940285124799"]);
        expect(matchCandidates("100", pool).map(entry => entry.id)).toEqual(["100"]);
    });

    it("does not match id prefixes for short numeric input", () => {
        expect(matchCandidates("10", pool)).toEqual([]);
        expect(matchCandidates("1", pool)).toEqual([]);
    });

    it("orders name tiers above username tiers", () => {
        const tierPool = [
            { id: "300", name: "abby", typeLabel: "user" },
            { id: "301", name: "zzz", username: "ab1", typeLabel: "user" },
            { id: "302", name: "xabby", typeLabel: "user" },
            { id: "303", name: "yyy", username: "xab", typeLabel: "user" }
        ];

        expect(matchCandidates("ab", tierPool).map(entry => entry.id)).toEqual(["300", "301", "302", "303"]);
    });

    it("ranks exact id above id prefix matches", () => {
        const idPool = [
            { id: "123", name: "name-a", typeLabel: "user" },
            { id: "1234", name: "name-b", typeLabel: "user" },
            { id: "12399", name: "name-c", typeLabel: "user" }
        ];

        expect(matchCandidates("123", idPool).map(entry => entry.id)).toEqual(["123", "1234", "12399"]);
    });
});

describe("resolveInput", () => {
    it("passes numeric ids through untouched", () => {
        expect(resolveInput("1380075940285124724", pool)).toBe("1380075940285124724");
    });

    it("resolves a name to the best matching entity id", () => {
        expect(resolveInput("Alice", pool)).toBe("100");
        expect(resolveInput("类脑", pool)).toBe("103");
    });

    it("resolves names case-insensitively and trims input", () => {
        expect(resolveInput("  BOB  ", pool)).toBe("102");
    });

    it("returns the raw input when nothing matches", () => {
        expect(resolveInput("zzz-unknown", pool)).toBe("zzz-unknown");
    });

    it("returns an empty string for blank input", () => {
        expect(resolveInput("   ", pool)).toBe("");
    });
});
