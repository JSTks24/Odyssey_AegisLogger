import { beforeEach, describe, expect, it, vi } from "vitest";
import * as webpackCommon from "./mocks/webpackCommon";

vi.mock("../utils/index", () => ({
    getGuildIdByChannel: (channelId: string) => (channelId === "chan-with-guild" ? "guild-1" : null)
}));

import { doesMatch, parseQuery, removeQueryToken, tokenizeQuery, upsertQueryToken } from "../utils/parseQuery";

const msg = {
    id: "m1",
    channel_id: "chan-1",
    guildId: "guild-1",
    author: { id: "u1", username: "alice", globalName: "Alice" },
    content: "hello world",
    attachments: [{ id: "a1" }],
    embeds: []
} as any;

beforeEach(() => {
    parseQuery.clear();
    webpackCommon.GuildStore.getGuild = (id: string) => (id === "guild-1" ? { id: "guild-1", name: "Test Guild" } : null);
    webpackCommon.ChannelStore.getChannel = (id: string) => (id === "chan-1" ? { id: "chan-1", name: "general" } : null);
});

describe("tokenizeQuery", () => {
    it("splits keyed queries from free text", () => {
        const { queries, rest } = tokenizeQuery("server:123 hello user:456 world");
        expect(queries).toHaveLength(2);
        expect(queries[0]).toMatchObject({ key: "server", value: "123", negate: false, raw: "server:123" });
        expect(queries[1]).toMatchObject({ key: "user", value: "456", negate: false, raw: "user:456" });
        expect(rest).toEqual(["hello", "world"]);
    });

    it("parses negated tokens", () => {
        const { queries } = tokenizeQuery("!user:42");
        expect(queries[0]).toMatchObject({ key: "user", value: "42", negate: true, raw: "!user:42" });
    });

    it("falls back to free text for unknown keys", () => {
        const { queries, rest } = tokenizeQuery("foo:bar");
        expect(queries).toHaveLength(0);
        expect(rest).toEqual(["foo:bar"]);
    });
});

describe("doesMatch", () => {
    it("matches server by id and name", () => {
        expect(doesMatch("server", "guild-1", msg)).toBe(true);
        expect(doesMatch("server", "test guild", msg)).toBe(true);
        expect(doesMatch("server", "guild-2", msg)).toBe(false);
    });

    it("resolves guild from channel when message has no guildId", () => {
        const dmLess = { ...msg, guildId: undefined, channel_id: "chan-with-guild" };
        expect(doesMatch("server", "guild-1", dmLess)).toBe(true);
    });

    it("matches user by id, username and global name", () => {
        expect(doesMatch("user", "u1", msg)).toBe(true);
        expect(doesMatch("user", "alice", msg)).toBe(true);
        expect(doesMatch("user", "Alice", msg)).toBe(true);
        expect(doesMatch("user", "bob", msg)).toBe(false);
    });

    it("matches channel by id and name", () => {
        expect(doesMatch("channel", "chan-1", msg)).toBe(true);
        expect(doesMatch("channel", "general", msg)).toBe(true);
        expect(doesMatch("channel", "other", msg)).toBe(false);
    });

    it("matches has selectors", () => {
        expect(doesMatch("has", "attachment", msg)).toBe(true);
        expect(doesMatch("has", "image", msg)).toBe(false);
        expect(doesMatch("has", "link", msg)).toBeFalsy();
        expect(doesMatch("has", "link", { ...msg, content: "see https://example.com/x" })).toBeTruthy();
    });
});

describe("removeQueryToken", () => {
    it("removes the exact token and trims leftovers", () => {
        expect(removeQueryToken("server:1 hello", "server:1")).toBe("hello");
        expect(removeQueryToken("!user:2 rest", "!user:2")).toBe("rest");
        expect(removeQueryToken("server:1", "server:1")).toBe("");
    });

    it("leaves other tokens untouched", () => {
        expect(removeQueryToken("server:1 user:2", "server:1")).toBe("user:2");
    });
});

describe("date tokens", () => {
    const beforeMsg = { ...msg, timestamp: "2025-12-31T00:00:00.000Z" } as any;
    const afterMsg = { ...msg, timestamp: "2026-06-15T12:00:00.000Z" } as any;

    it("before matches messages older than the date", () => {
        expect(doesMatch("before", "2026-01-01", beforeMsg)).toBe(true);
        expect(doesMatch("before", "2026-01-01", afterMsg)).toBe(false);
    });

    it("after matches messages newer than the date", () => {
        expect(doesMatch("after", "2026-01-01", afterMsg)).toBe(true);
        expect(doesMatch("after", "2026-01-01", beforeMsg)).toBe(false);
    });

    it("excludes messages exactly at the boundary date", () => {
        const exact = { ...msg, timestamp: "2026-01-01T00:00:00.000Z" } as any;
        expect(doesMatch("before", "2026-01-01", exact)).toBe(false);
        expect(doesMatch("after", "2026-01-01", exact)).toBe(false);
    });

    it("treats invalid dates as never matching", () => {
        expect(doesMatch("before", "not-a-date", afterMsg)).toBe(false);
        expect(doesMatch("after", "not-a-date", beforeMsg)).toBe(false);
        expect(doesMatch("around", "not-a-date", afterMsg)).toBe(false);
    });
});

describe("around/near/during tokens", () => {
    const center = "2026-01-01T12:00:00.000Z";
    const build = (timestamp: string) => ({ ...msg, timestamp }) as any;

    it("matches timestamps within 24h of the value", () => {
        const later = build("2026-01-01T18:30:00.000Z");
        const earlier = build("2025-12-31T20:00:00.000Z");

        expect(doesMatch("around", center, later)).toBe(true);
        expect(doesMatch("near", center, earlier)).toBe(true);
        expect(doesMatch("during", center, later)).toBe(true);
    });

    it("rejects timestamps 24h or more away", () => {
        const exactDay = build("2026-01-02T12:00:00.000Z");
        const far = build("2026-01-05T12:00:00.000Z");

        expect(doesMatch("around", center, exactDay)).toBe(false);
        expect(doesMatch("around", center, far)).toBe(false);
        expect(doesMatch("near", center, far)).toBe(false);
        expect(doesMatch("during", center, far)).toBe(false);
    });
});

describe("message token", () => {
    it("matches by message id", () => {
        expect(doesMatch("message", "m1", msg)).toBe(true);
        expect(doesMatch("message", "m999", msg)).toBe(false);
    });
});

describe("negation tokens", () => {
    it("flags negation on tokenizeQuery results only", () => {
        const { queries, rest } = tokenizeQuery("!user:123 hello user:456");

        expect(queries).toHaveLength(2);
        expect(queries[0]).toMatchObject({ key: "user", value: "123", negate: true, raw: "!user:123" });
        expect(queries[1]).toMatchObject({ key: "user", value: "456", negate: false });
        expect(rest).toEqual(["hello"]);
    });
});

describe("has selectors", () => {
    const build = (attachments: any[], embeds: any[] = [], content = "hello world") =>
        ({ ...msg, attachments, embeds, content }) as any;

    it("has:file matches only non media attachments", () => {
        expect(doesMatch("has", "file", build([{ content_type: "application/pdf" }]))).toBe(true);
        expect(doesMatch("has", "file", build([{ id: "a1" }]))).toBe(true);
        expect(doesMatch("has", "file", build([{ content_type: "image/png" }]))).toBe(false);
        expect(doesMatch("has", "file", build([{ content_type: "video/mp4" }]))).toBe(false);
        expect(doesMatch("has", "file", build([{ content_type: "audio/ogg" }]))).toBe(false);
    });

    it("has:sound matches audio attachments", () => {
        expect(doesMatch("has", "sound", build([{ content_type: "audio/mpeg" }]))).toBe(true);
        expect(doesMatch("has", "sound", build([{ content_type: "image/png" }]))).toBe(false);
        expect(doesMatch("has", "sound", build([]))).toBe(false);
    });

    it("has:attachment matches any attachment", () => {
        expect(doesMatch("has", "attachment", build([{ content_type: "application/pdf" }]))).toBe(true);
        expect(doesMatch("has", "attachment", build([]))).toBe(false);
    });

    it("has:image matches image attachments and embed images or thumbnails", () => {
        expect(doesMatch("has", "image", build([{ content_type: "image/webp" }]))).toBe(true);
        expect(doesMatch("has", "image", build([], [{ image: { url: "x" } }]))).toBe(true);
        expect(doesMatch("has", "image", build([], [{ thumbnail: { url: "x" } }]))).toBe(true);
        expect(doesMatch("has", "image", build([{ content_type: "application/pdf" }]))).toBe(false);
        expect(doesMatch("has", "image", build([], [{ title: "plain" }]))).toBe(false);
    });

    it("has:video matches video attachments and embed videos", () => {
        expect(doesMatch("has", "video", build([{ content_type: "video/webm" }]))).toBe(true);
        expect(doesMatch("has", "video", build([], [{ video: { url: "x" } }]))).toBe(true);
        expect(doesMatch("has", "video", build([{ content_type: "image/png" }]))).toBe(false);
    });

    it("has:embed matches messages with embeds", () => {
        expect(doesMatch("has", "embed", build([], [{ title: "x" }]))).toBe(true);
        expect(doesMatch("has", "embed", build([]))).toBe(false);
    });

    it("has:link matches bare domains too", () => {
        expect(doesMatch("has", "link", build([], [], "visit example.com now"))).toBeTruthy();
    });
});

describe("upsertQueryToken", () => {
    it("replaces an existing single-value token and keeps other parts", () => {
        expect(upsertQueryToken("user:1 hello", "user", "user:2")).toBe("hello user:2");
        expect(upsertQueryToken("foo:bar user:1", "user", "user:2")).toBe("foo:bar user:2");
    });

    it("keeps negated tokens of the same key", () => {
        expect(upsertQueryToken("user:1 !user:9", "user", "user:2")).toBe("!user:9 user:2");
    });

    it("replaces only the token sharing key and negation", () => {
        expect(upsertQueryToken("!user:9 user:1", "user", "!user:8", true)).toBe("user:1 !user:8");
        expect(upsertQueryToken("!user:9 user:1", "user", "user:2")).toBe("!user:9 user:2");
    });

    it("keeps existing tokens of the same key when multi is set", () => {
        expect(upsertQueryToken("has:image", "has", "has:link", false, true)).toBe("has:image has:link");
        expect(upsertQueryToken("user:1 hello", "user", "user:2", false, true)).toBe("user:1 hello user:2");
    });

    it("upserts into an empty query", () => {
        expect(upsertQueryToken("", "user", "user:2")).toBe("user:2");
    });
});
