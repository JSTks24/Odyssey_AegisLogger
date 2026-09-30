/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it } from "vitest";

import messageChanges, { type messageChangeEvent } from "../utils/messageChanges";

beforeEach(() => {
    messageChanges.resetForTests();
});

describe("change history coverage", () => {
    it("covers a request as long as every recorded change still has room", () => {
        messageChanges.setHistoryLimit(3);

        const requestEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["a"]);
        messageChanges.notifyChanged(["b"]);
        messageChanges.notifyChanged(["c"]);

        expect(messageChanges.historyCovers(requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("a", requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("b", requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("c", requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("d", requestEpoch)).toBe(false);
    });

    it("covers a request when the history is filled exactly to its capacity", () => {
        messageChanges.setHistoryLimit(2);

        const requestEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["a"]);
        messageChanges.notifyChanged(["b"]);

        expect(messageChanges.lostThrough()).toBeLessThan(requestEpoch + 1);
        expect(messageChanges.historyCovers(requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("a", requestEpoch)).toBe(true);
    });

    it("stops covering requests captured before the evicted change", () => {
        messageChanges.setHistoryLimit(2);

        const requestEpoch = messageChanges.epoch();
        messageChanges.notifyChanged(["a", "b"]);

        const coveredEpoch = messageChanges.epoch();
        messageChanges.notifyChanged(["c"]);

        expect(messageChanges.lostThrough()).toBe(coveredEpoch);
        expect(messageChanges.historyCovers(requestEpoch)).toBe(false);
        expect(messageChanges.historyCovers(coveredEpoch)).toBe(true);
        expect(messageChanges.historyCovers(messageChanges.epoch())).toBe(true);
    });

    it("uses the latest change epoch of an entry that is evicted", () => {
        messageChanges.setHistoryLimit(2);

        messageChanges.notifyChanged(["a"]);
        const firstEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["b"]);
        const middleEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["a"]);
        const latestEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["c"]);

        expect(messageChanges.lostThrough()).toBe(latestEpoch);
        expect(messageChanges.historyCovers(firstEpoch)).toBe(false);
        expect(messageChanges.historyCovers(middleEpoch)).toBe(false);
        expect(messageChanges.historyCovers(latestEpoch)).toBe(true);
    });

    it("raises the coverage floor inside one oversized batch", () => {
        messageChanges.setHistoryLimit(3);

        const requestEpoch = messageChanges.epoch();

        messageChanges.notifyChanged(["a", "b", "c", "d", "e"]);

        expect(messageChanges.historyCovers(requestEpoch)).toBe(false);
        expect(messageChanges.historyCovers(messageChanges.epoch())).toBe(true);
        expect(messageChanges.changedSince("e", requestEpoch)).toBe(true);
        expect(messageChanges.changedSince("a", requestEpoch)).toBe(false);
    });

    it("keeps the clearing guard independent from the coverage floor", () => {
        const requestEpoch = messageChanges.epoch();

        messageChanges.notifyCleared();

        expect(messageChanges.clearedSince(requestEpoch)).toBe(true);
        expect(messageChanges.historyCovers(requestEpoch)).toBe(true);

        messageChanges.notifyChanged(["fresh"]);

        const freshEpoch = messageChanges.epoch();

        expect(messageChanges.clearedSince(freshEpoch)).toBe(false);
        expect(messageChanges.historyCovers(freshEpoch)).toBe(true);
        expect(messageChanges.changedSince("fresh", freshEpoch - 1)).toBe(true);
    });

    it("reports only real changes to its listeners", () => {
        const events: messageChangeEvent[] = [];
        const unsubscribe = messageChanges.subscribe(event => { events.push(event); });

        try {
            messageChanges.notifyChanged([]);
            messageChanges.notifyChanged(["x"]);
            messageChanges.notifyCleared();

            expect(events).toEqual([
                { ids: ["x"], cleared: false },
                { ids: [], cleared: true }
            ]);
        } finally {
            unsubscribe();
        }
    });
});
