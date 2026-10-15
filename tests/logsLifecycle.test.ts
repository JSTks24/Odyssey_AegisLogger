/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
    states: [] as any[],
    refs: [] as any[],
    effects: [] as any[],
    pending: [] as (() => void)[],
    stateIndex: 0,
    refIndex: 0,
    effectIndex: 0,
    hydrate: vi.fn(),
    observers: [] as any[]
}));

vi.mock("@webpack/common", () => {
    const useCallback = (callback: any) => callback;
    return {
        React: {
            Fragment: "fragment",
            createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
            memo: (component: any) => component,
            useCallback
        },
        useCallback,
        useMemo: (factory: () => any) => factory(),
        useState: (initial: any) => {
            const index = runtime.stateIndex++;
            if (runtime.states.length <= index) runtime.states.push(typeof initial === "function" ? initial() : initial);
            return [runtime.states[index], (next: any) => {
                runtime.states[index] = typeof next === "function" ? next(runtime.states[index]) : next;
            }];
        },
        useRef: (initial: any) => {
            const index = runtime.refIndex++;
            return runtime.refs[index] ??= { current: initial };
        },
        useEffect: (effect: () => any, deps: any[]) => {
            const index = runtime.effectIndex++;
            const previous = runtime.effects[index];
            if (previous != null && deps.length === previous.deps.length && deps.every((value, position) => value === previous.deps[position])) return;
            runtime.pending.push(() => {
                previous?.cleanup?.();
                runtime.effects[index] = { deps, cleanup: effect() };
            });
        },
        TabBar: Object.assign(() => null, { Item: "tab-item" }),
        ChannelStore: { getChannel: () => null },
        GuildStore: { getGuild: () => null },
        GuildMemberStore: { getMember: () => null },
        Alerts: {}, ContextMenuApi: {}, FluxDispatcher: {}, Menu: {}, NavigationRouter: {}, Tooltip: "tooltip"
    };
});
vi.mock("@api/Styles", () => ({ classNameFactory: (prefix: string) => (...parts: any[]) => parts.filter(part => typeof part === "string").map(part => prefix + part).join(" ") }));
vi.mock("@components/BaseText", () => ({ BaseText: "base-text" }));
vi.mock("@components/Flex", () => ({ Flex: "flex" }));
vi.mock("@components/Icons", () => ({ InfoIcon: "info-icon" }));
vi.mock("@utils/react", () => ({ LazyComponent: (factory: () => any) => factory() }));
vi.mock("@utils/discord", () => ({ copyWithToast: vi.fn(), openUserProfile: vi.fn() }));
vi.mock("../db", () => ({
    DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" },
    default: { hydrateRecords: runtime.hydrate }
}));
vi.mock("../index", async () => import("./mocks/pluginIndex"));
vi.mock("../utils", () => ({ getGuildIdByChannel: () => null, isImageAttachment: () => true }));
vi.mock("../utils/parseQuery", () => ({ tokenizeQuery: () => ({ queries: [], rest: [] }) }));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key, tabDisplayName: (value: string) => value }));
vi.mock("../utils/logMessageModules", () => ({ default: { getSnapshot: () => ({}), subscribe: () => () => { } } }));
vi.mock("../utils/searchIndex", () => ({ default: { isReady: () => true } }));
vi.mock("../utils/settingsUtils", () => ({ importLogs: vi.fn() }));
vi.mock("../components/ClearLogsButton", () => ({ ClearLogsButton: "clear-logs" }));
vi.mock("../components/LogsErrorState", () => ({ default: "error-state" }));
vi.mock("../components/LogsFilterBar", () => ({ default: "filter-bar" }));
vi.mock("../components/LogsMessageContent", () => ({ default: {} }));

import hooks from "../components/hooks";
import logsModal from "../components/LogsModal";
import type { DBMessageRecord } from "../db";
import { settings } from "./mocks/pluginIndex";

function record(id = "1", attachments = true): DBMessageRecord {
    return {
        message_id: id,
        channel_id: "channel",
        status: "DELETED",
        message: {
            id,
            channel_id: "channel",
            author: { id: "author", username: "Alice" },
            content: `body ${id}`,
            timestamp: "2026-10-15T01:00:00Z",
            attachments: attachments ? [{ id: `image-${id}`, path: `image-${id}.png`, url: "https://cdn.example/image.png" }] : []
        }
    } as any;
}

function beginRender() {
    runtime.stateIndex = 0;
    runtime.refIndex = 0;
    runtime.effectIndex = 0;
}

function flushEffects() {
    for (const effect of runtime.pending.splice(0)) effect();
}

function unmount() {
    for (const effect of runtime.effects) effect?.cleanup?.();
    runtime.effects = [];
}

function createRow(initial: DBMessageRecord) {
    let source = initial;
    let output: ReturnType<typeof hooks.useVisibleRecord>;
    const element = {} as HTMLDivElement;
    const render = (next = source) => {
        source = next;
        beginRender();
        output = hooks.useVisibleRecord(source);
        output.ref.current = element;
        flushEffects();
        return output;
    };
    render();
    return { render, current: () => output, unmount };
}

function deferred() {
    let resolve!: (value: any) => void;
    const promise = new Promise<any>(done => { resolve = done; });
    return { promise, resolve };
}

function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (tree == null || typeof tree !== "object") return [];
    return [tree, ...nodes(tree.props?.children)];
}

beforeEach(() => {
    runtime.states = [];
    runtime.refs = [];
    runtime.effects = [];
    runtime.pending = [];
    runtime.observers = [];
    runtime.hydrate.mockReset();
    vi.stubGlobal("IntersectionObserver", class {
        callback: (entries: any[]) => void;
        observe = vi.fn();
        disconnect = vi.fn();
        constructor(callback: (entries: any[]) => void) {
            this.callback = callback;
            runtime.observers.push(this);
        }
    });
});

afterEach(() => {
    unmount();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
});

describe("visible log row attachment lifecycle", () => {
    it("exposes the original body immediately and waits for visibility before reading attachments", async () => {
        const source = record();
        const pending = deferred();
        runtime.hydrate.mockReturnValue(pending.promise);
        const row = createRow(source);
        expect(row.current().record).toBe(source);
        expect(row.current().attachmentsPending).toBe(true);
        expect(runtime.hydrate).not.toHaveBeenCalled();
        runtime.observers[0].callback([{ isIntersecting: false }]);
        expect(runtime.hydrate).not.toHaveBeenCalled();
        runtime.observers[0].callback([{ isIntersecting: true }]);
        expect(runtime.hydrate).toHaveBeenCalledTimes(1);
        expect(row.render().record.message.content).toBe("body 1");
        const display = { ...source, message: { ...source.message, attachments: [{ ...source.message.attachments[0], url: "blob:saved#" }] } };
        const scope = { release: vi.fn() };
        pending.resolve({ records: [display], scope });
        await pending.promise;
        expect(row.render().record).toBe(display);
        expect(row.current().attachmentsPending).toBe(false);
        expect(scope.release).not.toHaveBeenCalled();
        row.unmount();
        expect(scope.release).toHaveBeenCalledTimes(1);
    });

    it("releases a late result after unmount instead of publishing it", async () => {
        const pending = deferred();
        runtime.hydrate.mockReturnValue(pending.promise);
        const row = createRow(record());
        runtime.observers[0].callback([{ isIntersecting: true }]);
        const cancelled = runtime.hydrate.mock.calls[0][1];
        row.unmount();
        expect(cancelled()).toBe(true);
        const scope = { release: vi.fn() };
        pending.resolve({ records: [record("late")], scope });
        await pending.promise;
        expect(scope.release).toHaveBeenCalledTimes(1);
        expect(row.current().record.message_id).toBe("1");
    });

    it("cancels the previous record and keeps late results out of its replacement", async () => {
        const first = deferred();
        const second = deferred();
        runtime.hydrate.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const row = createRow(record("1"));
        runtime.observers[0].callback([{ isIntersecting: true }]);
        const replacement = record("2");
        expect(row.render(replacement).record).toBe(replacement);
        runtime.observers[1].callback([{ isIntersecting: true }]);
        const oldScope = { release: vi.fn() };
        first.resolve({ records: [record("1")], scope: oldScope });
        await first.promise;
        expect(oldScope.release).toHaveBeenCalledTimes(1);
        expect(row.render().record).toBe(replacement);
        const newScope = { release: vi.fn() };
        second.resolve({ records: [replacement], scope: newScope });
        await second.promise;
        row.render(record("3", false));
        expect(newScope.release).toHaveBeenCalledTimes(1);
    });

    it("keeps an acquired scope while scrolling away and does not repeat reads", async () => {
        const source = record();
        const scope = { release: vi.fn() };
        runtime.hydrate.mockResolvedValue({ records: [source], scope });
        const row = createRow(source);
        const observer = runtime.observers[0];
        observer.callback([{ isIntersecting: true }]);
        await Promise.resolve();
        row.render();
        observer.callback([{ isIntersecting: false }]);
        observer.callback([{ isIntersecting: true }]);
        row.render();
        expect(runtime.hydrate).toHaveBeenCalledTimes(1);
        expect(scope.release).not.toHaveBeenCalled();
    });

    it("does not observe or hydrate records without attachments", () => {
        const source = record("1", false);
        const row = createRow(source);
        expect(row.current().record).toBe(source);
        expect(row.current().attachmentsPending).toBe(false);
        expect(runtime.hydrate).not.toHaveBeenCalled();
        expect(runtime.observers).toEqual([]);
    });
});

describe("log modal content lifetime", () => {
    it("retains content and the current page through image overlay transitions", () => {
        settings.store.messagesToDisplayAtOnceInLogs = 100;
        settings.store.sortNewest = true;
        const first = record("1", false);
        const second = record("2", false);
        const messages = vi.spyOn(hooks, "useMessages").mockImplementation((_query, _tab, _newest, count) => ({
            messages: count === 100 ? [first] : [first, second],
            total: 2, hasMore: count === 100, pending: false, phase: null, error: null, reset: vi.fn(), retry: vi.fn()
        }));
        const scrollTo = vi.fn();
        const render = (transitionState: number) => {
            beginRender();
            const tree = logsModal.LogsModal({ modalProps: { transitionState } as any });
            const container = nodes(tree).find(node => node.props.className === "aegis-modal-content-container");
            container.props.ref.current = { firstElementChild: { scrollTo } };
            flushEffects();
            return nodes(tree);
        };
        let tree = render(1);
        const filter = tree.find(node => node.type === "filter-bar");
        filter.props.onChange("draft text");
        tree = render(1);
        expect(messages.mock.lastCall?.[0]).toBe("");
        tree.find(node => node.props.visibleMessages != null).props.handleLoadMore();
        tree = render(1);
        const content = tree.find(node => node.props.visibleMessages != null);
        expect(content.props.visibleMessages).toEqual([first, second]);
        for (const transition of [0, 2, 1]) {
            tree = render(transition);
            const retained = tree.find(node => node.props.visibleMessages != null);
            expect(retained.type).toBe(content.type);
            expect(retained.props.visibleMessages).toEqual([first, second]);
            expect(messages.mock.lastCall?.[3]).toBe(200);
            expect(tree.find(node => node.props.className === "aegis-modal-content")).toBeDefined();
        }
        expect(scrollTo).not.toHaveBeenCalled();
        tree.find(node => node.type === "filter-bar").props.onSubmit("draft text");
        render(1);
        expect(messages.mock.lastCall?.[0]).toBe("draft text");
        expect(messages.mock.lastCall?.[3]).toBe(100);
        expect(scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    });
});
