import { describe, expect, it } from "vitest";
import { messageMatchesRules, parseExclusionRule, parseExclusionRules } from "../utils/exclusionRules";

describe("parseExclusionRule", () => {
    it("parses a global pattern", () => {
        const rule = parseExclusionRule("^[/!]");
        expect(rule).not.toBeNull();
        expect(rule!.serverIds).toHaveLength(0);
        expect(rule!.pattern.test("/play")).toBe(true);
        expect(rule!.pattern.test("hello")).toBe(false);
    });

    it("parses scoped patterns", () => {
        const rule = parseExclusionRule("server:123 user:456 ^[/!]");
        expect(rule!.serverIds).toEqual(["123"]);
        expect(rule!.userIds).toEqual(["456"]);
        expect(rule!.channelIds).toHaveLength(0);
    });

    it("accepts guild/channel/from aliases", () => {
        const rule = parseExclusionRule("guild:1 channel:2 from:3 abc");
        expect(rule!.serverIds).toEqual(["1"]);
        expect(rule!.channelIds).toEqual(["2"]);
        expect(rule!.userIds).toEqual(["3"]);
    });

    it("keeps regex source verbatim after scope tokens", () => {
        const rule = parseExclusionRule("server:1 a\\s+b");
        expect(rule!.source).toBe("a\\s+b");
        expect(rule!.pattern.test("a b")).toBe(true);
    });

    it("returns null for empty, scope-only or invalid rules", () => {
        expect(parseExclusionRule("")).toBeNull();
        expect(parseExclusionRule("   ")).toBeNull();
        expect(parseExclusionRule("server:123")).toBeNull();
        expect(parseExclusionRule("[invalid(")).toBeNull();
        expect(parseExclusionRule("server:1 [invalid(")).toBeNull();
    });
});

describe("parseExclusionRules", () => {
    it("skips blank lines and invalid lines, keeps valid ones", () => {
        const rules = parseExclusionRules("abc\n\n  \n[invalid(\nserver:1 ^x");
        expect(rules).toHaveLength(2);
        expect(rules[0].source).toBe("abc");
        expect(rules[1].serverIds).toEqual(["1"]);
    });

    it("treats null/undefined as no rules", () => {
        expect(parseExclusionRules(null)).toEqual([]);
        expect(parseExclusionRules(undefined)).toEqual([]);
    });
});

describe("messageMatchesRules", () => {
    const rules = parseExclusionRules("global-pattern\nserver:1 ^[/!]\nuser:42 secret");

    it("matches global rules regardless of scope", () => {
        expect(messageMatchesRules(rules, { content: "hello global-pattern world" })).toBe(true);
        expect(messageMatchesRules(rules, { content: "x global-pattern", guildId: "9" })).toBe(true);
    });

    it("applies scoped rules only within their scope", () => {
        expect(messageMatchesRules(rules, { content: "/play", guildId: "1" })).toBe(true);
        expect(messageMatchesRules(rules, { content: "/play", guildId: "2" })).toBe(false);
        expect(messageMatchesRules(rules, { content: "/play" })).toBe(false);
    });

    it("supports user scoping", () => {
        expect(messageMatchesRules(rules, { content: "my secret", authorId: "42" })).toBe(true);
        expect(messageMatchesRules(rules, { content: "my secret", authorId: "7" })).toBe(false);
    });

    it("never matches empty or missing content", () => {
        expect(messageMatchesRules(rules, { content: "" })).toBe(false);
        expect(messageMatchesRules(rules, { content: null })).toBe(false);
        expect(messageMatchesRules(rules, {})).toBe(false);
    });
});
