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
