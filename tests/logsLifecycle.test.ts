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
    countMessages: vi.fn(),
    fetchMessages: vi.fn(),
    fetchByStatus: vi.fn(),
    search: vi.fn(),
    records: [] as any[],
    observers: [] as any[],
    frames: new Map<number, FrameRequestCallback>(),
    frameId: 0
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
    default: {
        hydrateRecords: runtime.hydrate,
        countMessagesIDB: runtime.countMessages,
        getMessagesByIDsIDB: runtime.fetchMessages,
        getDateStortedMessagesByStatusIDB: runtime.fetchByStatus
    }
}));
vi.mock("../index", async () => import("./mocks/pluginIndex"));
vi.mock("../utils", () => ({ getGuildIdByChannel: () => null, isImageAttachment: () => true }));
vi.mock("../utils/parseQuery", () => ({ tokenizeQuery: () => ({ queries: [], rest: [] }) }));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key, tabDisplayName: (value: string) => value }));
vi.mock("../utils/logMessageModules", () => ({ default: { getSnapshot: () => ({}), subscribe: () => () => { } } }));
vi.mock("../utils/searchIndex", () => ({ default: { isReady: () => true, search: runtime.search } }));
vi.mock("../utils/settingsUtils", () => ({ importLogs: vi.fn() }));
vi.mock("../components/ClearLogsButton", () => ({ ClearLogsButton: "clear-logs" }));
vi.mock("../components/LogsErrorState", () => ({ default: "error-state" }));
vi.mock("../components/LogsFilterBar", () => ({ default: "filter-bar" }));
vi.mock("../components/LogsMessageContent", () => ({ default: {} }));

import hooks from "../components/hooks";
import logsModal from "../components/LogsModal";
import type { DBMessageRecord } from "../db";
import { settings } from "./mocks/pluginIndex";

function record(id = "1", attachments = true, status = "DELETED"): DBMessageRecord {
    return {
        message_id: id,
        channel_id: "channel",
        status,
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

function flushFrame() {
    const callbacks = [...runtime.frames.values()];
    runtime.frames.clear();
    for (const callback of callbacks) callback(0);
}

function startQuery() {
    flushFrame();
    flushFrame();
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
    let reject!: (reason: unknown) => void;
    const promise = new Promise<any>((done, fail) => { resolve = done; reject = fail; });
    return { promise, resolve, reject };
}

function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (tree == null || typeof tree !== "object") return [];
    return [tree, ...nodes(tree.props?.children)];
}

function createModal(initalQuery = "body") {
    const scrollTo = vi.fn();
    const render = (commit = true) => {
        beginRender();
        const tree = nodes(logsModal.LogsModal({ modalProps: { transitionState: 1 } as any, initalQuery }));
        const container = tree.find(node => node.props.className === "aegis-modal-content-container");
        container.props.ref.current = { firstElementChild: { scrollTo } };
        if (commit) flushEffects();
        return tree;
    };
    const settle = async () => {
        startQuery();
        for (let i = 0; i < 5; i++) await Promise.resolve();
        return render();
    };
    render();
    return { render, settle, scrollTo };
}

function visibleIds(tree: any[]) {
    return tree.find(node => node.props.visibleMessages != null)?.props.visibleMessages.map((item: DBMessageRecord) => item.message_id) ?? [];
}

beforeEach(() => {
    runtime.states = [];
    runtime.refs = [];
    runtime.effects = [];
    runtime.pending = [];
    runtime.observers = [];
    runtime.frames.clear();
    runtime.frameId = 0;
    runtime.records = [];
    runtime.hydrate.mockReset();
    runtime.countMessages.mockReset().mockImplementation(async () => runtime.records.length);
    runtime.fetchMessages.mockReset().mockImplementation(async (ids: string[]) => ids.map(id => runtime.records.find(item => item.message_id === id)).filter(Boolean));
    runtime.fetchByStatus.mockReset().mockImplementation(async (newest: boolean, limit: number, status: string, offset: number) => {
        const matching = runtime.records.filter(item => item.status === status);
        return (newest ? matching.reverse() : matching).slice(offset, offset + limit);
    });
    runtime.search.mockReset().mockImplementation((_queries: any, _rest: any, status: string, limit: number, newest: boolean, offset: number) => {
        const matching = runtime.records.filter(item => item.status === status);
        const records = newest ? matching.reverse() : matching;
        return { page: records.slice(offset, offset + limit).map(item => ({ id: item.message_id })), hasMore: offset + limit < records.length };
    });
    vi.stubGlobal("requestAnimationFrame", vi.fn((callback: FrameRequestCallback) => {
        const id = ++runtime.frameId;
        runtime.frames.set(id, callback);
        return id;
    }));
    vi.stubGlobal("cancelAnimationFrame", vi.fn((id: number) => runtime.frames.delete(id)));
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
    it("waits for visibility when attachments exist only in edit history", async () => {
        const source = record("1", false);
        source.message.editHistory = [{ content: "old body", timestamp: "2026-10-15T02:00:00Z", attachments: [{ id: "old", path: "old.png" } as any] }];
        const scope = { release: vi.fn() };
        runtime.hydrate.mockResolvedValue({ records: [source], scope });
        const row = createRow(source);
        expect(row.current().record).toBe(source);
        expect(row.current().attachmentsPending).toBe(true);
        expect(runtime.hydrate).not.toHaveBeenCalled();
        runtime.observers[0].callback([{ isIntersecting: false }]);
        expect(runtime.hydrate).not.toHaveBeenCalled();
        runtime.observers[0].callback([{ isIntersecting: true }]);
        await Promise.resolve();
        expect(row.render().attachmentsPending).toBe(false);
        expect(runtime.hydrate).toHaveBeenCalledOnce();
        row.unmount();
        expect(scope.release).toHaveBeenCalledOnce();
    });

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

describe("log modal explicit search submission", () => {
    beforeEach(() => {
        settings.store.messagesToDisplayAtOnceInLogs = 2;
        settings.store.sortNewest = true;
    });

    it("refreshes the first page and total after new records arrive for the same query", async () => {
        const modal = createModal();
        let tree = await modal.settle();
        expect(visibleIds(tree)).toEqual([]);
        expect(runtime.search).toHaveBeenCalledTimes(1);

        runtime.records.push(record("1", false));
        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["1"]);
        expect(runtime.search).toHaveBeenCalledTimes(2);
        expect(runtime.countMessages).toHaveBeenCalledTimes(2);

        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        modal.render();
        await modal.settle();
        expect(runtime.search).toHaveBeenCalledTimes(3);
        expect(modal.scrollTo).toHaveBeenNthCalledWith(1, 0, 0);
        expect(modal.scrollTo).toHaveBeenNthCalledWith(2, 0, 0);
    });

    it("restarts a repeated query at the first page after loading more", async () => {
        runtime.records = ["1", "2", "3", "4"].map(id => record(id, false));
        const modal = createModal();
        let tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["4", "3"]);
        tree.find(node => node.props.visibleMessages != null).props.handleLoadMore();
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["4", "3", "2", "1"]);

        runtime.records.push(record("5", false));
        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["5", "4"]);
        expect(runtime.search.mock.lastCall?.slice(3)).toEqual([2, true, 0]);
        expect(modal.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
    });

    it("keeps late results out after consecutive submissions of the same query", async () => {
        runtime.records.push(record("1", false));
        const first = deferred();
        const second = deferred();
        runtime.fetchMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const modal = createModal();
        startQuery();
        let tree = modal.render();
        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        tree = modal.render();
        startQuery();
        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        modal.render();
        tree = await modal.settle();
        expect(runtime.fetchMessages).toHaveBeenCalledTimes(3);
        expect(visibleIds(tree)).toEqual(["1"]);

        second.resolve([record("stale-second", false)]);
        first.resolve([record("stale-first", false)]);
        await first.promise;
        await second.promise;
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["1"]);
        expect(tree.find(node => node.props.visibleMessages != null).props.pending).toBe(false);
    });
});

describe("log tab result ownership", () => {
    beforeEach(() => {
        settings.store.messagesToDisplayAtOnceInLogs = 2;
        settings.store.sortNewest = true;
        runtime.records = [record("11", false), record("12", false), record("13", false), record("21", false, "EDITED"), record("31", false, "GHOST_PINGED")];
    });

    it.each(["", "body"])("hides previous tab rows before effects run for query %j", async query => {
        const modal = createModal(query);
        let tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["13", "12"]);
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        tree = modal.render(false);
        expect(tree.find(node => node.props.selectedItem != null).props.selectedItem).toBe("Edited");
        expect(visibleIds(tree)).toEqual([]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        expect(tree.find(node => node.props.className === "aegis-modal-content-results").props.inert).toBe(true);
        expect(tree.find(node => node.props.children?.includes("modal.clearVisible")).props.disabled).toBe(true);
        expect(tree.find(node => node.type?.name === "EmptyLogs")).toBeUndefined();
        flushEffects();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["21"]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        expect((query === "" ? runtime.fetchByStatus : runtime.search).mock.lastCall?.[2]).toBe("EDITED");
    });

    it("keeps a new empty-query tab in the search overlay until its data settles", async () => {
        const modal = createModal("");
        let tree = await modal.settle();
        const waiting = deferred();
        runtime.fetchByStatus.mockReturnValueOnce(waiting.promise);
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        modal.render();
        tree = modal.render();
        expect(visibleIds(tree)).toEqual([]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        startQuery();
        waiting.resolve([record("21", false, "EDITED")]);
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["21"]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
    });

    it("hides the previous tab error immediately and exposes a current tab failure for retry", async () => {
        runtime.fetchByStatus.mockRejectedValueOnce(new Error("deleted failed"));
        const modal = createModal("");
        let tree = await modal.settle();
        expect(tree.find(node => node.type === "error-state")).toBeDefined();
        const failed = deferred();
        runtime.fetchByStatus.mockReturnValueOnce(failed.promise);
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        tree = modal.render(false);
        expect(tree.find(node => node.type === "error-state")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        flushEffects();
        startQuery();
        failed.reject(new Error("edited failed"));
        tree = await modal.settle();
        expect(tree.find(node => node.type === "error-state")).toBeDefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        expect(visibleIds(tree)).toEqual([]);
        tree.find(node => node.type === "error-state").props.retry();
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["21"]);
    });

    it("keeps late results and errors from preceding tabs out of the current feedback", async () => {
        const deleted = deferred();
        const edited = deferred();
        const ghost = deferred();
        runtime.fetchMessages.mockReturnValueOnce(deleted.promise).mockReturnValueOnce(edited.promise).mockReturnValueOnce(ghost.promise);
        const modal = createModal();
        startQuery();
        let tree = modal.render();
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        modal.render();
        startQuery();
        tree = modal.render();
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Ghost Pinged");
        modal.render();
        startQuery();
        edited.resolve([record("21", false, "EDITED")]);
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual([]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        ghost.resolve([record("31", false, "GHOST_PINGED")]);
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["31"]);
        deleted.reject(new Error("old deleted failed"));
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["31"]);
        expect(tree.find(node => node.type === "error-state")).toBeUndefined();
        expect(tree.find(node => node.props.selectedItem != null).props.selectedItem).toBe("Ghost Pinged");
    });

    it("resets the page and scroll on switching and starts a reopened modal on deleted", async () => {
        const modal = createModal();
        let tree = await modal.settle();
        tree.find(node => node.props.visibleMessages != null).props.handleLoadMore();
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["13", "12", "11"]);
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        modal.render();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["21"]);
        expect(runtime.search.mock.lastCall?.slice(2)).toEqual(["EDITED", 2, true, 0]);
        expect(modal.scrollTo).toHaveBeenCalledExactlyOnceWith(0, 0);
        unmount();
        runtime.states = [];
        runtime.refs = [];
        runtime.pending = [];
        const reopened = createModal();
        tree = await reopened.settle();
        expect(tree.find(node => node.props.selectedItem != null).props.selectedItem).toBe("Deleted");
        expect(visibleIds(tree)).toEqual(["13", "12"]);
        expect(runtime.search.mock.lastCall?.slice(2)).toEqual(["DELETED", 2, true, 0]);
    });
});

describe("search paint scheduling", () => {
    it("publishes the searching state and leaves one frame for painting before querying", async () => {
        runtime.records.push(record("1", false));
        const modal = createModal();
        let tree = modal.render();
        expect(runtime.search).not.toHaveBeenCalled();
        expect(tree.find(node => node.props.className === "aegis-modal-content-results").props["aria-busy"]).toBe(true);
        flushFrame();
        tree = modal.render();
        expect(runtime.search).not.toHaveBeenCalled();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        flushFrame();
        expect(runtime.search).toHaveBeenCalledTimes(1);
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["1"]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
    });

    it("cancels an unstarted query when another submission arrives", async () => {
        const modal = createModal();
        flushFrame();
        const tree = modal.render();
        tree.find(node => node.type === "filter-bar").props.onSubmit("replacement");
        modal.render();
        expect(cancelAnimationFrame).toHaveBeenCalled();
        expect(runtime.search).not.toHaveBeenCalled();
        await modal.settle();
        expect(runtime.search).toHaveBeenCalledTimes(1);
    });

    it("cancels an unstarted query on unmount", () => {
        createModal();
        flushFrame();
        unmount();
        expect(cancelAnimationFrame).toHaveBeenCalled();
        startQuery();
        expect(runtime.search).not.toHaveBeenCalled();
    });

    it("cancels an unstarted query when switching tabs", async () => {
        const modal = createModal();
        flushFrame();
        const tree = modal.render();
        tree.find(node => node.props.selectedItem != null).props.onItemSelect("Edited");
        modal.render();
        expect(cancelAnimationFrame).toHaveBeenCalled();
        await modal.settle();
        expect(runtime.search).toHaveBeenCalledTimes(1);
        expect(runtime.search.mock.lastCall?.[2]).toBe("EDITED");
    });

    it("does not let a completed old query dismiss the new query feedback", async () => {
        runtime.records.push(record("1", false));
        const first = deferred();
        const second = deferred();
        runtime.fetchMessages.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
        const modal = createModal();
        startQuery();
        let tree = modal.render();
        tree.find(node => node.type === "filter-bar").props.onSubmit("body");
        modal.render();
        startQuery();
        first.resolve([record("stale", false)]);
        tree = await modal.settle();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        expect(visibleIds(tree)).toEqual([]);
        second.resolve([record("new", false)]);
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["new"]);
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
    });

    it("clears feedback after failure and permits retrying the search", async () => {
        runtime.records.push(record("1", false));
        const failed = deferred();
        runtime.fetchMessages.mockReturnValueOnce(failed.promise);
        const modal = createModal();
        startQuery();
        failed.reject(new Error("query failed"));
        let tree = await modal.settle();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        tree.find(node => node.type === "error-state").props.retry();
        modal.render();
        tree = modal.render();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        tree = await modal.settle();
        expect(visibleIds(tree)).toEqual(["1"]);
        expect(tree.find(node => node.type === "error-state")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
    });
});

describe("searching result feedback", () => {
    it("blocks retained rows while searching and restores them for pagination, success and errors", () => {
        const state = {
            messages: [record("1", false)], total: 1, hasMore: true, pending: true,
            phase: "searching" as "searching" | "more" | null,
            error: null as unknown, reset: vi.fn(), retry: vi.fn()
        };
        vi.spyOn(hooks, "useMessages").mockImplementation(() => state);
        const modal = createModal();
        let tree = modal.render();
        const overlay = tree.find(node => node.props.className === "aegis-modal-search-overlay");
        expect(overlay).toBeDefined();
        expect(overlay.props.role).toBe("status");
        expect(overlay.props["aria-live"]).toBe("polite");
        const retained = tree.find(node => node.props.className === "aegis-modal-content-results");
        expect(retained.props["aria-busy"]).toBe(true);
        expect(tree.filter(node => node.props["aria-busy"] === true).every(node => !nodes(node).includes(overlay))).toBe(true);
        expect(retained.props.inert).toBe(true);
        expect(retained.props["aria-hidden"]).toBe(true);
        expect(visibleIds(tree)).toEqual(["1"]);
        expect(tree.find(node => node.props.children?.includes("modal.clearVisible")).props.disabled).toBe(true);

        state.phase = "more";
        tree = modal.render();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-content-results").props.inert).not.toBe(true);
        expect(tree.find(node => node.props.visibleMessages != null).props.phase).toBe("more");

        state.pending = false;
        state.phase = null;
        tree = modal.render();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-content-results").props["aria-hidden"]).not.toBe(true);
        expect(tree.find(node => node.props.children?.includes("modal.clearVisible")).props.disabled).toBe(false);

        state.error = new Error("query failed");
        tree = modal.render();
        expect(tree.find(node => node.type === "error-state")).toBeDefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-content-results").props.inert).not.toBe(true);
    });

    it("does not publish the empty state while a search is still pending", () => {
        const state = {
            messages: [], total: 0, hasMore: false, pending: true,
            phase: "searching" as "searching" | null, error: null, reset: vi.fn(), retry: vi.fn()
        };
        vi.spyOn(hooks, "useMessages").mockImplementation(() => state);
        const modal = createModal();
        let tree = modal.render();
        expect(tree.find(node => node.type?.name === "EmptyLogs")).toBeUndefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeDefined();
        state.pending = false;
        state.phase = null;
        tree = modal.render();
        expect(tree.find(node => node.type?.name === "EmptyLogs")).toBeDefined();
        expect(tree.find(node => node.props.className === "aegis-modal-search-overlay")).toBeUndefined();
    });
});
