import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({ settings: { store: { cacheLimit: 2 } } }));

import { settings } from "../index";
import { LimitedMap } from "../utils/LimitedMap";

beforeEach(() => {
    settings.store.cacheLimit = 2;
});

describe("LimitedMap", () => {
    it("evicts the oldest entry when exceeding capacity", () => {
        const cache = new LimitedMap<string, number>();
        cache.set("a", 1);
        cache.set("b", 2);
        cache.set("c", 3);

        expect(cache.get("a")).toBeUndefined();
        expect(cache.get("b")).toBe(2);
        expect(cache.get("c")).toBe(3);
        expect(cache.map.size).toBe(2);
        expect(Array.from(cache.map.keys())).toEqual(["b", "c"]);
    });

    it("stores and retrieves entries below capacity", () => {
        const cache = new LimitedMap<string, number>();
        cache.set("a", 1);
        cache.set("b", 2);

        expect(cache.get("a")).toBe(1);
        expect(cache.get("b")).toBe(2);
        expect(cache.map.size).toBe(2);
    });

    it("never evicts when cacheLimit is 0", () => {
        settings.store.cacheLimit = 0;
        const cache = new LimitedMap<string, number>();
        for (let i = 0; i < 5; i++) cache.set(`k${i}`, i);

        expect(cache.map.size).toBe(5);
        expect(cache.get("k0")).toBe(0);
        expect(cache.get("k4")).toBe(4);
    });

    it("keeps Map semantics for has, delete and clear through the exposed map", () => {
        const cache = new LimitedMap<string, string>();
        cache.set("a", "1");

        expect(cache.map.has("a")).toBe(true);
        expect(cache.map.has("b")).toBe(false);

        expect(cache.map.delete("a")).toBe(true);
        expect(cache.map.delete("a")).toBe(false);
        expect(cache.map.has("a")).toBe(false);

        cache.set("b", "2");
        cache.map.clear();
        expect(cache.map.size).toBe(0);
        expect(cache.get("b")).toBeUndefined();
    });

    it("setting the same key twice does not grow occupancy", () => {
        const cache = new LimitedMap<string, number>();
        cache.set("a", 1);
        cache.set("a", 2);
        expect(cache.map.size).toBe(1);
        expect(cache.get("a")).toBe(2);

        cache.set("b", 3);
        cache.set("a", 4);
        expect(cache.map.size).toBe(2);
        expect(cache.get("a")).toBe(4);
        expect(cache.get("b")).toBe(3);
    });
});
