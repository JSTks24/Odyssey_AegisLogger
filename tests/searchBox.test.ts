/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../utils/misc", () => ({
    getGuildIdByChannel: () => null
}));

import { parseQuery } from "../utils/parseQuery";
import searchBox from "../utils/searchBox";

beforeEach(() => {
    parseQuery.clear();
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

describe("submission", () => {
    it("drops empty filter prefixes while retaining completed filters and free text", () => {
        expect(searchBox.prepareSubmission("has:image user:")).toBe("has:image");
        expect(searchBox.prepareSubmission("!channel: user:alice hello  world ")).toBe("user:alice hello  world");
        expect(searchBox.prepareSubmission("url: custom:")).toBe("url: custom:");
        expect(searchBox.prepareSubmission(" user: ")).toBe("");
    });
});

describe("text replacement boundaries", () => {
    it.each([
        { name: "leading insertion", query: "user:123", range: { start: 0, end: 0 }, value: "xx", expected: { query: "xx user:123", caret: 2, length: 3 } },
        { name: "trailing insertion", query: "user:123", range: { start: 8, end: 8 }, value: "xx", expected: { query: "user:123 xx", caret: 11, length: 3 } },
        { name: "middle insertion", query: "user:123 has:image", range: { start: 8, end: 9 }, value: "中文", expected: { query: "user:123 中文 has:image", caret: 11, length: 4 } },
        { name: "middle text removal", query: "user:123 xx has:image", range: { start: 8, end: 12 }, value: "", expected: { query: "user:123 has:image", caret: 8, length: 1 } },
        { name: "leading text removal", query: "xx user:123", range: { start: 0, end: 3 }, value: "", expected: { query: "user:123", caret: 0, length: 0 } },
        { name: "leading separator removal", query: "x user:123", range: { start: 0, end: 2 }, value: " ", expected: { query: "user:123", caret: 0, length: 0 } },
        { name: "existing whitespace", query: "user:123 has:image", range: { start: 8, end: 9 }, value: "  xx  ", expected: { query: "user:123  xx  has:image", caret: 14, length: 6 } },
        { name: "first token replacement", query: "user:123 has:image", range: { start: 0, end: 8 }, value: "channel:456", expected: { query: "channel:456 has:image", caret: 11, length: 11 } },
        { name: "last token replacement", query: "user:123 has:image", range: { start: 9, end: 18 }, value: "message:456", expected: { query: "user:123 message:456", caret: 20, length: 11 } },
        { name: "whole query replacement", query: "user:123 has:image", range: { start: 0, end: 18 }, value: "xxuser:123", expected: { query: "xxuser:123", caret: 10, length: 10 } }
    ])("protects $name without altering unrelated text", ({ query, range, value, expected }) => {
        expect(searchBox.replaceText(query, range, value)).toEqual(expected);
    });

    it("maps a middle caret past only the inserted leading separator", () => {
        expect(searchBox.replaceText("user:123 has:image", { start: 8, end: 9 }, "中文", 1)).toEqual({ query: "user:123 中文 has:image", caret: 10, length: 4 });
    });

    it("protects unfinished picker boundaries supplied by the editor", () => {
        const query = "user: has:image";
        const boundaries = [{ start: 0, end: 5 }, { start: 6, end: 15 }];
        expect(searchBox.replaceText(query, { start: 0, end: 0 }, "xx", 2, boundaries)).toEqual({ query: "xx user: has:image", caret: 2, length: 3 });
        expect(searchBox.replaceText(query, { start: 5, end: 6 }, "yy", 2, boundaries)).toEqual({ query: "user: yy has:image", caret: 8, length: 4 });
    });

    it("does not treat actively edited condition text as a completed boundary", () => {
        expect(searchBox.replaceText("user:Ali bbb", { start: 8, end: 8 }, "ce", 2, [])).toEqual({ query: "user:Alice bbb", caret: 10, length: 2 });
        expect(searchBox.replaceText("user: has:image", { start: 5, end: 5 }, "123", 3, [{ start: 6, end: 15 }])).toEqual({ query: "user:123 has:image", caret: 8, length: 3 });
    });
});

describe("ordered search segments", () => {
    it.each([
        ["", []],
        ["hello world", []],
        [" hello  world ", []],
        ["user:", []],
        ["!user:", []],
        ["xuser:1", []],
        ["x!user:1", []],
        ["xxuser:123", []],
        ["中文user:123", []],
        ["user:123has:image", ["user:123has:image"]],
        ["user_1:2", []],
        ["user:123 hello world", ["user:123"]],
        ["hello user:123", ["user:123"]],
        ["user:1 user:2 smith", ["user:1", "user:2"]],
        ["下载 !user:123 测试", ["!user:123"]],
        ["aaa from:123 bbb in:456 ccc guild:789", ["from:123", "in:456", "guild:789"]],
        ["has:image has:unknown", ["has:image"]],
        ["before:2026-01-01 hello after:2026-02-02", ["before:2026-01-01", "after:2026-02-02"]],
        ["before:invalid after:2026-02-30", []],
        ["hello message:456", ["message:456"]],
        ["hello message:invalid", []],
        ["hello  user:123  world ", ["user:123"]],
        ["!has:image !channel:123", ["!has:image", "!channel:123"]]
    ])("preserves %s and identifies completed filters", (query, expected) => {
        const parts = searchBox.segments(query as string);
        expect(parts.map(part => part.raw).join("")).toBe(query);
        expect(parts.filter(part => part.token).map(part => part.raw)).toEqual(expected);
        for (const part of parts) expect((query as string).slice(part.start, part.end)).toBe(part.raw);
    });

    it("preserves text and tokens in their original positions", () => {
        const query = "aaa user:1111 bbb has:image ccc";
        const segments = searchBox.segments(query);
        expect(segments.map(segment => segment.raw).join("")).toBe(query);
        expect(segments.map(segment => segment.token?.key ?? "text")).toEqual(["text", "user", "text", "has", "text"]);
        expect(searchBox.removeRange(query, segments.filter(segment => segment.token)[0])).toBe("aaa bbb has:image ccc");
        expect(searchBox.removeRange(query, segments.filter(segment => segment.token)[1])).toBe("aaa user:1111 bbb ccc");
    });

    it("keeps unfinished, invalid and actively edited conditions as text", () => {
        const query = "aaa user:1111 has:unknown before:invalid channel: bbb";
        expect(searchBox.segments(query).filter(segment => segment.token)).toHaveLength(1);
        expect(searchBox.segments(query, { start: 4, end: 13 }).filter(segment => segment.token)).toHaveLength(0);
    });

    it("keeps empty edge segments available beside completed conditions", () => {
        expect(searchBox.segments("user:123")).toMatchObject([
            { start: 0, end: 0, raw: "" },
            { start: 0, end: 8, raw: "user:123", token: { key: "user", value: "123" } },
            { start: 8, end: 8, raw: "" }
        ]);
    });

    it("retains surrounding completed conditions when a middle condition is edited", () => {
        const query = "has:image user:123 channel:456";
        const parts = searchBox.segments(query, { start: 10, end: 18 });
        expect(parts.map(part => part.raw).join("")).toBe(query);
        expect(parts.filter(part => part.token).map(part => part.raw)).toEqual(["has:image", "channel:456"]);
        expect(parts.find(part => !part.token && part.raw.includes("user:"))).toMatchObject({ start: 9, end: 19, raw: " user:123 " });
    });

    it("replaces only the edited token and preserves its suffix", () => {
        const query = "aaa !user:1111 bbb has:image";
        const token = searchBox.segments(query).find(segment => segment.token)!;
        expect(searchBox.replaceRange(query, token, "!user:2222")).toBe("aaa !user:2222 bbb has:image");
        expect(searchBox.wordAt("aaa user:1111 bbb", 10)).toEqual({ start: 4, end: 13 });
    });
});
