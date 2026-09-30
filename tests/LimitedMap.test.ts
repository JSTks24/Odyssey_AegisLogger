/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

import { LimitedMap } from "../utils/LimitedMap";

describe("LimitedMap", () => {
    it("evicts the oldest entry when exceeding capacity", () => {
        const cache = new LimitedMap<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);

        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBe(3);
        expect(cache.size).toBe(2);
        expect(Array.from(cache.map.keys())).toEqual(["b", "c"]);
    });

    it("stores and retrieves entries below capacity", () => {
        const cache = new LimitedMap<string, number>(2);
        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.get("a")).toBe(1);
        expect(cache.get("b")).toBe(2);
        expect(cache.size).toBe(2);
    });

    it("never evicts when the limit is 0", () => {
        const cache = new LimitedMap<string, number>(0);
        for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);

        expect(cache.size).toBe(5);
        expect(cache.get("k0")).toBe(0);
        expect(cache.get("k4")).toBe(4);
    });

    it("reports every evicted entry through the callback", () => {
        const onEvict = vi.fn();
        const cache = new LimitedMap<string, number>(1, onEvict);

        cache.set("a", 1);
        cache.set("b", 2);

        expect(onEvict).toHaveBeenCalledTimes(1);
        expect(onEvict).toHaveBeenCalledWith("a", 1);
    });

    it("does not evict while the same key is being overwritten", () => {
        const onEvict = vi.fn();
        const cache = new LimitedMap<string, number>(1, onEvict);

        cache.set("a", 1);
        cache.set("a", 2);

        expect(onEvict).not.toHaveBeenCalled();
        expect(cache.size).toBe(1);
        expect(cache.get("a")).toBe(2);
    });

    it("exposes has, delete, clear and size", () => {
        const cache = new LimitedMap<string, string>(0);
        cache.set("a", "1");

        expect(cache.has("a")).toBe(true);
        expect(cache.has("b")).toBe(false);

        expect(cache.delete("a")).toBe(true);
        expect(cache.delete("a")).toBe(false);
        expect(cache.has("a")).toBe(false);

        cache.set("b", "2");
        cache.clear();
        expect(cache.size).toBe(0);
        expect(cache.get("b")).toBeUndefined();
    });
});
