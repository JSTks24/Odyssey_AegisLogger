/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/index", () => ({
    getGuildIdByChannel: () => null
}));

import { parseQuery } from "../utils/parseQuery";
import searchBox from "../utils/searchBox";

beforeEach(() => {
    parseQuery.clear();
});

describe("splitActiveToken", () => {
    it("returns null when the marker is absent", () => {
        expect(searchBox.splitActiveToken("", "user")).toBeNull();
        expect(searchBox.splitActiveToken("has:image", "user")).toBeNull();
    });

    it("splits at the marker when it leads the query", () => {
        expect(searchBox.splitActiveToken("user:", "user")).toEqual({ head: "", rest: "", prefix: "user:" });
        expect(searchBox.splitActiveToken("user:123", "user")).toEqual({ head: "", rest: "123", prefix: "user:" });
    });

    it("keeps spaces inside the picked value", () => {
        expect(searchBox.splitActiveToken("user:ali smith", "user")).toEqual({ head: "", rest: "ali smith", prefix: "user:" });
    });

    it("keeps everything before the marker in head", () => {
        expect(searchBox.splitActiveToken("has:image user:ali", "user")).toEqual({ head: "has:image ", rest: "ali", prefix: "user:" });
        expect(searchBox.splitActiveToken("user:1 server:2 user:ali", "user")).toEqual({ head: "user:1 server:2 ", rest: "ali", prefix: "user:" });
    });

    it("ignores markers that are not on a token boundary", () => {
        expect(searchBox.splitActiveToken("xuser:1", "user")).toBeNull();
        expect(searchBox.splitActiveToken("user_1:2", "user")).toBeNull();
    });

    it("takes the last boundary marker of the same kind", () => {
        expect(searchBox.splitActiveToken("user:1 user:2 smith", "user")).toEqual({ head: "user:1 ", rest: "2 smith", prefix: "user:" });
    });

    it("handles CJK and mixed content in the rest", () => {
        expect(searchBox.splitActiveToken("user:下载 测试", "user")).toEqual({ head: "", rest: "下载 测试", prefix: "user:" });
    });

    it("recognizes a negated marker on a token boundary", () => {
        expect(searchBox.splitActiveToken("!user:123", "user")).toEqual({ head: "", rest: "123", prefix: "!user:" });
        expect(searchBox.splitActiveToken("has:image !user:ali", "user")).toEqual({ head: "has:image ", rest: "ali", prefix: "!user:" });
    });

    it("ignores negated markers that are not on a token boundary", () => {
        expect(searchBox.splitActiveToken("x!user:1", "user")).toBeNull();
    });
});

describe("splitLeadingTokens", () => {
    it("keeps free text whole", () => {
        expect(searchBox.splitLeadingTokens("abc def")).toEqual({ tokens: [], rest: "abc def" });
        expect(searchBox.splitLeadingTokens("")).toEqual({ tokens: [], rest: "" });
    });

    it("lifts the leading token run out of the rest", () => {
        expect(searchBox.splitLeadingTokens("user:123 hello world")).toEqual({ tokens: ["user:123"], rest: "hello world" });
        expect(searchBox.splitLeadingTokens("user:123 has:image")).toEqual({ tokens: ["user:123", "has:image"], rest: "" });
    });

    it("stops at the first non token segment", () => {
        expect(searchBox.splitLeadingTokens("hello user:123")).toEqual({ tokens: [], rest: "hello user:123" });
    });

    it("does not treat an empty value as a token", () => {
        expect(searchBox.splitLeadingTokens("user:")).toEqual({ tokens: [], rest: "user:" });
    });

    it("preserves inner and trailing spaces", () => {
        expect(searchBox.splitLeadingTokens("hello  world ")).toEqual({ tokens: [], rest: "hello  world " });
        expect(searchBox.splitLeadingTokens("user:1 hello  world ")).toEqual({ tokens: ["user:1"], rest: "hello  world " });
    });
});

describe("removeTokens", () => {
    it("drops every token of the given keys", () => {
        expect(searchBox.removeTokens("before:2026-01-01 hello after:2026-02-02", ["before", "after"])).toBe("hello");
        expect(searchBox.removeTokens("!before:2026-01-01", ["before", "after"])).toBe("");
        expect(searchBox.removeTokens("", ["before", "after"])).toBe("");
    });

    it("keeps other tokens and free text", () => {
        expect(searchBox.removeTokens("has:image before:2026-01-01 abc", ["before", "after"])).toBe("has:image abc");
        expect(searchBox.removeTokens("has:image", ["before", "after"])).toBe("has:image");
    });
});

describe("cancelPick", () => {
    it("returns the query untouched when the marker is absent", () => {
        expect(searchBox.cancelPick("has:image", "user", null)).toBe("has:image");
        expect(searchBox.cancelPick("has:image", "user", "user:100")).toBe("has:image");
    });

    it("drops the whole fragment for a fresh pick", () => {
        expect(searchBox.cancelPick("user:", "user", null)).toBe("");
        expect(searchBox.cancelPick("has:image user:", "user", null)).toBe("has:image");
        expect(searchBox.cancelPick("has:image user:zzz", "user", null)).toBe("has:image");
    });

    it("restores the original token for an edited pick", () => {
        expect(searchBox.cancelPick("user:5", "user", "user:100")).toBe("user:100");
        expect(searchBox.cancelPick("has:image user:5", "user", "user:100")).toBe("has:image user:100");
        expect(searchBox.cancelPick("user:", "user", "user:100")).toBe("user:100");
    });

    it("keeps negated fragments intact when restoring", () => {
        expect(searchBox.cancelPick("!user:5", "user", "!user:100")).toBe("!user:100");
    });

    it("returns the query as-is when an edit did not change anything", () => {
        expect(searchBox.cancelPick("user:100", "user", "user:100")).toBe("user:100");
    });
});

describe("composeSearchBox round trip", () => {
    const cases: [string[], string][] = [
        [[], ""],
        [[], "abc"],
        [[], "abc def"],
        [[], "下载 测试"],
        [[], "hello  world "],
        [["user:123"], ""],
        [["user:123"], "hello"],
        [["user:123"], "ali smith"],
        [["user:123", "has:image"], ""],
        [["user:123", "has:image"], "下载 测试"],
        [["user:123"], "123abc"]
    ];

    it.each(cases)("split(compose(%j, %j)) is identity", (tokens, rest) => {
        expect(searchBox.splitLeadingTokens(searchBox.composeSearchBox(tokens, rest))).toEqual({ tokens, rest });
    });

    it("drops the trailing token on backspace-from-empty", () => {
        const { tokens } = searchBox.splitLeadingTokens("user:123 has:image");

        expect(searchBox.splitLeadingTokens(searchBox.composeSearchBox(tokens.slice(0, -1), "")).tokens).toEqual(["user:123"]);
    });
});
