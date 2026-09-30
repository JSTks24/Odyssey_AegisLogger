/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../components/LogsModal", () => ({
    LogTabs: { DELETED: "Deleted", EDITED: "Edited", GHOST_PING: "Ghost Pinged" }
}));

vi.mock("../db", () => ({
    default: {
        getDateStortedMessagesByStatusIDB: vi.fn(async () => []),
        countMessagesByStatusIDB: vi.fn(async () => 0),
        countMessagesIDB: vi.fn(async () => 0),
        hydrateRecords: vi.fn(async (records: any) => ({ records, scope: null }) as any),
        iterateRawMessagesIDB: vi.fn(),
        getMessagesByIDsIDB: vi.fn(async () => []),
        iterateRawMessagesByStatusIDB: vi.fn()
    },
    DBMessageStatus: {
        DELETED: "DELETED",
        EDITED: "EDITED",
        GHOST_PINGED: "GHOST_PINGED"
    }
}));

import hooks, { createPageLeases, type messagePageCursor,planNextPage, planPageRecords, resolveLoadPhase } from "../components/hooks";
import idb, { DBMessageStatus } from "../db";
import searchIndex from "../utils/searchIndex";

const { loadMessagesPage } = hooks;

function makeRecord(id: string, status = DBMessageStatus.DELETED, content = "hello"): any {
    return {
        message_id: id,
        channel_id: "100",
        status,
        message: {
            id,
            channel_id: "100",
            timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + Number(id.replace(/\D/g, ""))).toISOString(),
            author: { id: "u1", username: "alice" },
            content,
            attachments: [{ id: `att-${id}`, url: `https://cdn/${id}.png`, proxy_url: `https://proxy/${id}.png`, filename: `${id}.png` }],
            embeds: [],
            mentions: []
        }
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    searchIndex.clear();
    vi.mocked(idb.hydrateRecords).mockImplementation(async (records: any) => ({ records, scope: null }) as any);
});

describe("loadMessagesPage without query", () => {
    it("hydrates the page exactly once and reports hasMore from the total", async () => {
        const records = [makeRecord("1"), makeRecord("2")];
        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue(records);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(5);

        const result = await loadMessagesPage("", DBMessageStatus.DELETED, true, 0, 100);

        expect(result.records).toBe(records);
        expect(result.hasMore).toBe(true);
        expect(idb.getDateStortedMessagesByStatusIDB).toHaveBeenCalledTimes(1);
        expect(idb.hydrateRecords).toHaveBeenCalledTimes(1);
        expect(vi.mocked(idb.hydrateRecords).mock.calls[0][0]).toBe(records);
    });

    it("reports hasMore false when the offset consumed the remaining rows", async () => {
        const records = [makeRecord("4"), makeRecord("5")];
        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue(records);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(5);

        const result = await loadMessagesPage("", DBMessageStatus.DELETED, true, 3, 100);

        expect(result.hasMore).toBe(false);
    });

    it("returns an empty result when the request was cancelled", async () => {
        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue([makeRecord("1")]);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(1);

        const result = await loadMessagesPage("", DBMessageStatus.DELETED, true, 0, 100, () => true);

        expect(result).toEqual({ records: [], statusTotal: 0, hasMore: false, nextOffset: 0, scope: null });
        expect(idb.hydrateRecords).not.toHaveBeenCalled();
    });
});

describe("loadMessagesPage with the search index ready", () => {
    beforeEach(() => {
        const indexed = [makeRecord("10"), makeRecord("11"), makeRecord("12", DBMessageStatus.DELETED, "hello world")];
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield indexed; })());
        vi.mocked(idb.getMessagesByIDsIDB).mockImplementation(async (ids: string[]) =>
            ids.map(id => indexed.find(record => record.message_id === id)).filter(Boolean)
        );
    });

    it("paginates via the index with hasMore until the last page", async () => {
        const first = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 0, 2);

        expect(first.records.map(record => record.message_id)).toEqual(["12", "11"]);
        expect(first.hasMore).toBe(true);
        expect(idb.hydrateRecords).toHaveBeenCalledTimes(1);

        const second = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 2, 2);

        expect(second.records.map(record => record.message_id)).toEqual(["10"]);
        expect(second.hasMore).toBe(false);
    });
});

describe("loadMessagesPage fallback scan", () => {
    it("keeps loading every page when the index build fails", async () => {
        const all = Array.from({ length: 301 }, (_, i) => makeRecord(`f${i}`, DBMessageStatus.DELETED, `hello ${i}`));
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { throw new Error("index source failed"); })());
        vi.mocked(idb.iterateRawMessagesByStatusIDB).mockImplementation(() => (async function* () {
            for (let i = 0; i < all.length; i += 100) yield all.slice(i, i + 100);
        })());

        const page1 = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 0, 100);
        const page2 = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 100, 100);
        const page3 = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 200, 100);
        const page4 = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 300, 100);

        expect(page1.records).toHaveLength(100);
        expect(page1.hasMore).toBe(true);
        expect(page1.statusTotal).toBe(101);
        expect(page2.hasMore).toBe(true);
        expect(page3.hasMore).toBe(true);
        expect(page4.records).toHaveLength(1);
        expect(page4.hasMore).toBe(false);
    });

    it("handles a zero hit search", async () => {
        const all = [makeRecord("z1", DBMessageStatus.DELETED, "unrelated")];
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { throw new Error("index source failed"); })());
        vi.mocked(idb.iterateRawMessagesByStatusIDB).mockImplementation(() => (async function* () { yield all; })());

        const result = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 0, 100);

        expect(result.records).toHaveLength(0);
        expect(result.hasMore).toBe(false);
        expect(result.statusTotal).toBe(0);
    });
});

function makeScope(size = 1) {
    const released: string[] = [];
    const releasedRecords: string[][] = [];
    const scope = {
        hold: vi.fn(),
        take: vi.fn(() => new Map()),
        releaseRecords: vi.fn((messageIds: Iterable<string>) => { releasedRecords.push([...messageIds]); }),
        release: () => { released.push("released"); },
        size: () => size
    };

    return { scope, released, releasedRecords };
}

describe("loadMessagesPage with already displayed records", () => {
    it("never hydrates a record that is already displayed", async () => {
        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue([makeRecord("1"), makeRecord("2"), makeRecord("3")]);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(10);

        const result = await loadMessagesPage("", DBMessageStatus.DELETED, true, 0, 3, undefined, new Set(["1", "2"]));

        expect(result.records.map(record => record.message_id)).toEqual(["3"]);
        expect(vi.mocked(idb.hydrateRecords).mock.calls[0][0].map((record: any) => record.message_id)).toEqual(["3"]);
        expect(result.hasMore).toBe(true);
    });

    it("keeps hasMore based on the raw page instead of the deduplicated count", async () => {
        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue([makeRecord("1")]);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(1);

        const result = await loadMessagesPage("", DBMessageStatus.DELETED, true, 0, 1, undefined, new Set(["1"]));

        expect(result.records).toEqual([]);
        expect(result.hasMore).toBe(false);
    });

    it("filters already displayed records on the index path", async () => {
        const indexed = [makeRecord("10"), makeRecord("11"), makeRecord("12", DBMessageStatus.DELETED, "hello world")];
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield indexed; })());
        vi.mocked(idb.getMessagesByIDsIDB).mockImplementation(async (ids: string[]) => ids.map(id => makeRecord(id)));

        const result = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 0, 3, undefined, new Set(["12"]));

        expect(vi.mocked(idb.hydrateRecords).mock.calls[0][0].map((record: any) => record.message_id)).toEqual(["11", "10"]);
        expect(result.records.map(record => record.message_id)).toEqual(["11", "10"]);
    });

    it("filters already displayed records during the fallback scan", async () => {
        const all = [makeRecord("f0", DBMessageStatus.DELETED, "hello 0"), makeRecord("f1", DBMessageStatus.DELETED, "hello 1")];
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { throw new Error("index source failed"); })());
        vi.mocked(idb.iterateRawMessagesByStatusIDB).mockImplementation(() => (async function* () { yield all; })());

        const result = await loadMessagesPage("hello", DBMessageStatus.DELETED, true, 0, 10, undefined, new Set(["f0"]));

        expect(result.records.map(record => record.message_id)).toEqual(["f1"]);
    });
});

function mockFallbackScan(all: any[]) {
    vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { throw new Error("index source failed"); })());
    vi.mocked(idb.iterateRawMessagesByStatusIDB).mockImplementation(() => (async function* () {
        for (let index = 0; index < all.length; index += 100) yield all.slice(index, index + 100);
    })());
}

function makeContext(query: string, overrides: Record<string, any> = {}) {
    return { query, tab: "DELETED", sortNewest: false, reload: 0, ...overrides } as any;
}

async function walkFallbackPages(query: string, pageSize: number, pages: number) {
    const context = makeContext(query);
    const loaded: any[] = [];
    const results: any[] = [];
    let cursor: messagePageCursor | null = null;

    for (let index = 0; index < pages; index++) {
        const target: number = cursor == null ? pageSize : cursor.numDisplayed + pageSize;
        const request = planNextPage(cursor, context, target);
        const result = await loadMessagesPage(query, DBMessageStatus.DELETED, false, request.offset, request.limit, undefined, request.knownIds);
        const planned: { records: any[]; dropped: string[]; } = cursor == null ? { records: result.records, dropped: [] } : planPageRecords(cursor.records, result.records);

        results.push(result);
        loaded.push(...planned.records.map((record: any) => record.message_id));
        cursor = { context, numDisplayed: target, records: planned.records, rawOffset: result.nextOffset };

        if (!result.hasMore) break;
    }

    return { loaded, results, cursor };
}

describe("loadMessagesPage fallback pagination", () => {
    it("keeps the second page reachable while filtering already displayed records", async () => {
        const all = Array.from({ length: 150 }, (_, index) => makeRecord(`p${index}`, DBMessageStatus.DELETED, `hello ${index}`));
        mockFallbackScan(all);

        const first = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 0, 100);

        expect(first.records).toHaveLength(100);
        expect(first.hasMore).toBe(true);
        expect(first.nextOffset).toBe(100);

        const knownIds = new Set(first.records.map(record => record.message_id));
        const second = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, first.nextOffset, 100, undefined, knownIds);

        expect(second.records).toHaveLength(50);
        expect(second.hasMore).toBe(false);
        expect(second.nextOffset).toBe(150);
        expect(new Set([...first.records, ...second.records].map(record => record.message_id)).size).toBe(150);
    });

    it("walks every page with the offsets and known ids the hook would produce", async () => {
        const all = Array.from({ length: 301 }, (_, index) => makeRecord(`q${index}`, DBMessageStatus.DELETED, `hello ${index}`));
        mockFallbackScan(all);

        const { results, cursor } = await walkFallbackPages("hello", 100, 6);

        expect(results.map(result => result.records.length)).toEqual([100, 100, 100, 1]);
        expect(results.map(result => result.hasMore)).toEqual([true, true, true, false]);
        expect(results.map(result => result.nextOffset)).toEqual([100, 200, 300, 301]);
        expect(cursor!.records.map(record => record.message_id)).toEqual(all.map(record => record.message_id));
        expect(cursor!.rawOffset).toBe(301);
    });

    it("advances past a page that is entirely displayed and still finds later records", async () => {
        const all = Array.from({ length: 400 }, (_, index) => makeRecord(`r${index}`, DBMessageStatus.DELETED, `hello ${index}`));
        mockFallbackScan(all);

        const displayed = all.slice(200, 300).map(record => record.message_id);
        const page = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 200, 100, undefined, new Set(displayed));

        expect(page.records).toEqual([]);
        expect(page.hasMore).toBe(true);
        expect(page.nextOffset).toBe(300);
        expect(vi.mocked(idb.hydrateRecords).mock.calls[0][0]).toEqual([]);

        const next = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, page.nextOffset, 100, undefined, new Set(displayed));

        expect(next.records.map(record => record.message_id)).toEqual(all.slice(300, 400).map(record => record.message_id));
        expect(next.nextOffset).toBe(400);
        expect(next.hasMore).toBe(false);
    });

    it("skips hydrated duplicates that overlap the previous page", async () => {
        const all = Array.from({ length: 120 }, (_, index) => makeRecord(`s${index}`, DBMessageStatus.DELETED, `hello ${index}`));
        mockFallbackScan(all);

        const knownIds = new Set(all.slice(90, 110).map(record => record.message_id));
        const overlapping = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 95, 100, undefined, knownIds);

        expect(overlapping.records.map(record => record.message_id)).toEqual(all.slice(110, 120).map(record => record.message_id));
        expect(vi.mocked(idb.hydrateRecords).mock.calls[0][0].map((record: any) => record.message_id)).toEqual(all.slice(110, 120).map(record => record.message_id));
        expect(overlapping.nextOffset).toBe(120);
        expect(overlapping.hasMore).toBe(false);
    });

    it("reports hasMore false when the matches fill the page exactly", async () => {
        const all = Array.from({ length: 100 }, (_, index) => makeRecord(`t${index}`, DBMessageStatus.DELETED, `hello ${index}`));
        mockFallbackScan(all);

        const result = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 0, 100);

        expect(result.records).toHaveLength(100);
        expect(result.hasMore).toBe(false);
        expect(result.nextOffset).toBe(100);
    });

    it("returns the same records through the index and the fallback scan", async () => {
        const all = Array.from({ length: 40 }, (_, index) => makeRecord(`u${index}`, DBMessageStatus.DELETED, `hello ${index}`));

        mockFallbackScan(all);
        const fallback = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 0, 40);

        searchIndex.clear();
        vi.mocked(idb.iterateRawMessagesIDB).mockImplementation(() => (async function* () { yield all; })());
        vi.mocked(idb.getMessagesByIDsIDB).mockImplementation(async (ids: string[]) =>
            ids.map(id => all.find(record => record.message_id === id)).filter(Boolean) as any
        );
        await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 0, 1);
        const indexed = await loadMessagesPage("hello", DBMessageStatus.DELETED, false, 0, 40);

        vi.mocked(idb.getDateStortedMessagesByStatusIDB).mockResolvedValue(all);
        vi.mocked(idb.countMessagesByStatusIDB).mockResolvedValue(all.length);
        const plain = await loadMessagesPage("", DBMessageStatus.DELETED, false, 0, 40);

        expect(searchIndex.isReady()).toBe(true);
        expect(indexed.records.map(record => record.message_id)).toEqual(fallback.records.map(record => record.message_id));
        expect(plain.records.map(record => record.message_id)).toEqual(fallback.records.map(record => record.message_id));
    });
});

describe("planNextPage", () => {
    const context = makeContext("hello");

    it("starts a fresh context at the first page", () => {
        expect(planNextPage(null, context, 100)).toEqual({ isLoadMore: false, offset: 0, limit: 100, knownIds: undefined });
    });

    it("continues from the consumed raw offset instead of the displayed count", () => {
        const cursor: messagePageCursor = { context, numDisplayed: 100, records: [makeRecord("1"), makeRecord("2")], rawOffset: 150 };

        const request = planNextPage(cursor, context, 200);

        expect(request.isLoadMore).toBe(true);
        expect(request.offset).toBe(150);
        expect(request.limit).toBe(198);
        expect([...request.knownIds!]).toEqual(["1", "2"]);
    });

    it("resets when the query, tab, order or reload changed", () => {
        const cursor: messagePageCursor = { context, numDisplayed: 100, records: [makeRecord("1")], rawOffset: 150 };

        for (const changed of [makeContext("other"), makeContext("hello", { tab: "EDITED" }), makeContext("hello", { sortNewest: true }), makeContext("hello", { reload: 1 })]) {
            expect(planNextPage(cursor, changed, 200).isLoadMore).toBe(false);
            expect(planNextPage(cursor, changed, 200).offset).toBe(0);
        }
    });

    it("resets when the displayed target did not grow or nothing is displayed yet", () => {
        const cursor: messagePageCursor = { context, numDisplayed: 100, records: [makeRecord("1")], rawOffset: 150 };
        const empty: messagePageCursor = { context, numDisplayed: 100, records: [], rawOffset: 150 };

        expect(planNextPage(cursor, context, 100).isLoadMore).toBe(false);
        expect(planNextPage(empty, context, 200).isLoadMore).toBe(false);
    });
});

describe("planPageRecords", () => {
    it("keeps the displayed record and marks the incoming duplicate as dropped", () => {
        const previous = [makeRecord("1"), makeRecord("2")];
        const incoming = [makeRecord("2"), makeRecord("3")];

        const planned = planPageRecords(previous, incoming);

        expect(planned.records.map(record => record.message_id)).toEqual(["1", "2", "3"]);
        expect(planned.records[1]).toBe(previous[1]);
        expect(planned.dropped).toEqual(["2"]);
    });

    it("drops every incoming duplicate without touching the loaded pages", () => {
        const previous = [makeRecord("1"), makeRecord("2")];
        const planned = planPageRecords(previous, [makeRecord("1"), makeRecord("2")]);

        expect(planned.records).toEqual(previous);
        expect(planned.dropped).toEqual(["1", "2"]);
    });

    it("hands the dropped records to the incoming page scope", () => {
        const leases = createPageLeases();
        const displayed = makeScope();
        const incoming = makeScope(2);
        const planned = planPageRecords([makeRecord("1"), makeRecord("2")], [makeRecord("2"), makeRecord("3")]);

        leases.adopt(displayed.scope);
        leases.adoptMore(incoming.scope, planned.dropped);

        expect(incoming.releasedRecords).toEqual([["2"]]);
        expect(leases.count()).toBe(2);
        expect(leases.retire()).toEqual([]);
    });
});

describe("createPageLeases", () => {
    it("retires the previous page when a new result is adopted", () => {
        const leases = createPageLeases();
        const first = makeScope();
        const second = makeScope();

        leases.adopt(first.scope);
        leases.adopt(second.scope);

        expect(leases.count()).toBe(1);
        expect(first.released).toEqual([]);

        const retired = leases.retire();

        expect(retired).toEqual([first.scope]);
        expect(leases.retire()).toEqual([]);

        for (const scope of retired) scope.release();

        expect(first.released).toEqual(["released"]);
        expect(second.released).toEqual([]);
    });

    it("keeps the loaded pages while loading more and releases only the dropped records", () => {
        const leases = createPageLeases();
        const first = makeScope();
        const second = makeScope(1);

        leases.adopt(first.scope);
        leases.adoptMore(second.scope, ["dropped-1", "dropped-2"]);

        expect(leases.count()).toBe(2);
        expect(second.releasedRecords).toEqual([["dropped-1", "dropped-2"]]);
        expect(leases.retire()).toEqual([]);
    });

    it("does not keep a scope that has nothing left to hold", () => {
        const leases = createPageLeases();
        const first = makeScope();

        leases.adopt(first.scope);
        leases.adoptMore(makeScope(0).scope, []);

        expect(leases.count()).toBe(1);
        expect(leases.retire()).toEqual([]);
    });

    it("ignores an empty load more result", () => {
        const leases = createPageLeases();
        const first = makeScope();

        leases.adopt(first.scope);
        leases.adoptMore(null, ["dropped"]);

        expect(leases.count()).toBe(1);
        expect(leases.retire()).toEqual([]);
    });

    it("retires the previous page when the new result carries no scope", () => {
        const leases = createPageLeases();
        const first = makeScope();

        leases.adopt(first.scope);
        leases.adopt(null);

        expect(leases.count()).toBe(0);
        expect(leases.retire()).toEqual([first.scope]);
    });

    it("releases every page and retired scope on unmount", () => {
        const leases = createPageLeases();
        const first = makeScope();
        const second = makeScope();

        leases.adopt(first.scope);
        leases.adopt(second.scope);
        leases.releaseAll();

        expect(first.released).toEqual(["released"]);
        expect(second.released).toEqual(["released"]);
        expect(leases.count()).toBe(0);
        expect(leases.retire()).toEqual([]);
    });
});

describe("resolveLoadPhase", () => {
    it("names the reason of a pending load", () => {
        expect(resolveLoadPhase(true, "", false)).toBe("more");
        expect(resolveLoadPhase(false, "", true)).toBe("initial");
        expect(resolveLoadPhase(false, "hello", false)).toBe("indexing");
        expect(resolveLoadPhase(false, "hello", true)).toBe("searching");
    });
});
