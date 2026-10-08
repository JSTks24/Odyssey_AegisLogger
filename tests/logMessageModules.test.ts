/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registry = vi.hoisted(() => ({
    modules: [] as any[],
    waiting: new Map<(module: any) => boolean, (module: any) => void>(),
    synchronous: [] as any[],
    find: vi.fn(),
    waitFor: vi.fn()
}));

vi.mock("@webpack", () => ({
    filters: { byCode: () => (module: any) => module?.privateChannel === true },
    find: registry.find,
    waitFor: registry.waitFor
}));

function preview() {
    return { type: function MessagePreview() { return "previewLinkTarget:"; } };
}

function register(module: any) {
    for (const [filter, callback] of registry.waiting) {
        if (!filter(module)) continue;
        registry.waiting.delete(filter);
        callback(module);
    }
}

async function load() {
    return (await import("../utils/logMessageModules")).default;
}

beforeEach(() => {
    vi.resetModules();
    registry.modules = [];
    registry.synchronous = [];
    registry.waiting.clear();
    registry.find.mockReset().mockImplementation(filter => registry.modules.find(filter));
    registry.waitFor.mockReset().mockImplementation((filter, callback) => {
        const found = registry.synchronous.find(filter);
        if (found != null) callback(found);
        else registry.waiting.set(filter, callback);
    });
});

describe("shared log message modules", () => {
    it("notifies after subscribing when the first render saw empty state but modules are already loaded", async () => {
        const modules = await load();
        const initial = modules.getSnapshot();
        expect(initial.messagePreview).toBeNull();
        const component = preview();
        registry.modules.push(component);
        const states: unknown[] = [];
        const unsubscribe = modules.subscribe(() => states.push(modules.getSnapshot().messagePreview));

        expect(states).toContain(component);
        expect(modules.getSnapshot().messagePreview).toBe(component);
        unsubscribe();
    });

    it("adopts synchronous waitFor results even when the cache find still returns nothing", async () => {
        const component = preview();
        registry.synchronous.push(component);
        const modules = await load();
        const listener = vi.fn();
        modules.subscribe(listener);

        expect(modules.getSnapshot().messagePreview).toBe(component);
        expect(listener).toHaveBeenCalled();
        expect(registry.find).toHaveBeenCalledTimes(2);
    });

    it("notifies all rows when a module loads later and never rescans an unready cache", async () => {
        const modules = await load();
        const listeners = Array.from({ length: 100 }, () => vi.fn());
        const cleanups = listeners.map(listener => modules.subscribe(listener));
        const component = preview();
        listeners.forEach(listener => listener.mockClear());
        register(component);

        expect(modules.getSnapshot().messagePreview).toBe(component);
        expect(listeners.every(listener => listener.mock.calls.length === 1)).toBe(true);
        expect(registry.find).toHaveBeenCalledTimes(2);
        expect(registry.waitFor).toHaveBeenCalledTimes(2);
        cleanups.forEach(cleanup => cleanup());
    });

    it("removes closed rows and reopens with the cached component without new webpack subscriptions", async () => {
        const modules = await load();
        const closed = vi.fn();
        const unsubscribe = modules.subscribe(closed);
        unsubscribe();
        closed.mockClear();
        const component = preview();
        register(component);
        expect(closed).not.toHaveBeenCalled();

        const reopened = vi.fn();
        modules.subscribe(reopened);
        expect(reopened).toHaveBeenCalledOnce();
        expect(modules.getSnapshot().messagePreview).toBe(component);
        expect(registry.waitFor).toHaveBeenCalledTimes(2);
    });

    it("keeps a stable empty snapshot and event subscriptions while the component remains absent", async () => {
        vi.useFakeTimers();
        try {
            const modules = await load();
            modules.subscribe(vi.fn());
            const snapshot = modules.getSnapshot();
            vi.advanceTimersByTime(3600000);
            expect(modules.getSnapshot()).toBe(snapshot);
            expect(registry.find).toHaveBeenCalledTimes(2);
            expect(registry.waitFor).toHaveBeenCalledTimes(2);
            expect(vi.getTimerCount()).toBe(0);
        } finally {
            vi.useRealTimers();
        }
    });

    it("recovers from a failed initial cache search through a later module event", async () => {
        registry.find.mockImplementation(() => { throw new Error("cache unavailable"); });
        const modules = await load();
        modules.subscribe(vi.fn());
        const component = preview();
        register(component);
        expect(modules.getSnapshot().messagePreview).toBe(component);
    });
});
