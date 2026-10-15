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

describe("ordered search segments", () => {
    it.each([
        ["", []],
        ["hello world", []],
        [" hello  world ", []],
        ["user:", []],
        ["!user:", []],
        ["xuser:1", []],
        ["x!user:1", []],
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

    it("replaces only the edited token and preserves its suffix", () => {
        const query = "aaa !user:1111 bbb has:image";
        const token = searchBox.segments(query).find(segment => segment.token)!;
        expect(searchBox.replaceRange(query, token, "!user:2222")).toBe("aaa !user:2222 bbb has:image");
        expect(searchBox.wordAt("aaa user:1111 bbb", 10)).toEqual({ start: 4, end: 13 });
    });
});
