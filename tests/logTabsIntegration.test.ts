/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({
    states: [] as any[],
    refs: [] as any[],
    effects: [] as any[],
    pending: [] as (() => void)[],
    stateIndex: 0,
    refIndex: 0,
    effectIndex: 0,
    frames: new Map<number, FrameRequestCallback>(),
    frameId: 0
}));

vi.mock("@webpack/common", async importOriginal => ({
    ...await importOriginal<typeof import("@webpack/common")>(),
    useCallback: (callback: any) => callback,
    useState: (initial: any) => {
        const index = runtime.stateIndex++;
        if (runtime.states.length <= index) runtime.states.push(initial);
        return [runtime.states[index], (next: any) => {
            runtime.states[index] = typeof next === "function" ? next(runtime.states[index]) : next;
        }];
    },
    useRef: (initial: any) => runtime.refs[runtime.refIndex++] ??= { current: initial },
    useEffect: (effect: () => any, deps: any[]) => {
        const index = runtime.effectIndex++;
        const previous = runtime.effects[index];
        if (previous != null && deps.every((value, position) => value === previous.deps[position])) return;
        runtime.pending.push(() => {
            previous?.cleanup?.();
            runtime.effects[index] = { deps, cleanup: effect() };
        });
    }
}));
vi.mock("@utils/web", () => ({ chooseFile: vi.fn() }));
vi.mock("../index", () => ({ logger: {}, settings: { store: {} }, Native: {} }));
vi.mock("../utils/misc", () => ({ getGuildIdByChannel: () => undefined }));
vi.mock("../utils/saveImage", () => ({ clearAttachmentBlobCache: vi.fn() }));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key }));
vi.mock("../components/LogsModal", () => ({
    LogTabs: { DELETED: "Deleted", EDITED: "Edited", GHOST_PING: "Ghost Pinged" }
}));

import hooks from "../components/hooks";
import { LogTabs } from "../components/LogsModal";
import idb, { DBMessageStatus } from "../db";
import searchIndex from "../utils/searchIndex";
import { normalizeLogItem } from "../utils/settingsUtils";

function message(id: string) {
    return {
        id,
        channel_id: "200",
        author: { id: "100", username: "Alice" },
        timestamp: new Date(Date.UTC(2026, 9, 18, 12) + Number(id)).toISOString(),
        content: `matching ${id}`,
        attachments: [],
        embeds: [],
        editHistory: []
    } as any;
}

function unmount() {
    for (const effect of runtime.effects) effect?.cleanup?.();
    runtime.effects = [];
}

function flushFrames() {
    for (let i = 0; i < 2; i++) {
        const callbacks = [...runtime.frames.values()];
        runtime.frames.clear();
        for (const callback of callbacks) callback(0);
    }
}

function createQuery(query: string, newest: boolean) {
    let tab = LogTabs.DELETED;
    let count = 1;
    const render = (commit = true) => {
        runtime.stateIndex = 0;
        runtime.refIndex = 0;
        runtime.effectIndex = 0;
        const output = hooks.useMessages(query, tab, newest, count);
        if (commit) for (const effect of runtime.pending.splice(0)) effect();
        return output;
    };
    const settle = async () => {
        let output = render();
        await vi.waitFor(() => {
            flushFrames();
            output = render();
            expect(output.pending).toBe(false);
        });
        return output;
    };
    render();
    return {
        render,
        settle,
        select(value: LogTabs) {
            tab = value;
            count = 1;
            return render(false);
        },
        loadMore() {
            count++;
            render();
        }
    };
}

beforeAll(() => idb.dbReady);
afterAll(() => idb.connection.close());
beforeEach(async () => {
    runtime.states = [];
    runtime.refs = [];
    runtime.effects = [];
    runtime.pending = [];
    runtime.frames.clear();
    runtime.frameId = 0;
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
        const id = ++runtime.frameId;
        runtime.frames.set(id, callback);
        return id;
    });
    vi.stubGlobal("cancelAnimationFrame", (id: number) => runtime.frames.delete(id));
    await idb.clearMessagesIDB();
    for (const [status, ids] of [
        [DBMessageStatus.DELETED, ["1", "2"]],
        [DBMessageStatus.EDITED, ["11", "12"]],
        [DBMessageStatus.GHOST_PINGED, ["21", "22"]]
    ] as const) {
        await idb.addMessageIDB(message(ids[0]), status);
        await idb.addMessageRecordsIDB([normalizeLogItem({ status, message: message(ids[1]) })!]);
    }
});
afterEach(() => {
    unmount();
    vi.unstubAllGlobals();
});

describe.each([false, true])("stored log tab ownership with ready index=%s", ready => {
    it.each([
        ["", true],
        ["", false],
        ["matching", true],
        ["matching", false]
    ] as const)("keeps exact status IDs through switching and pagination for query=%j newest=%s", async (query, newest) => {
        if (ready) await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB());
        expect(searchIndex.isReady()).toBe(ready);
        const reader = createQuery(query, newest);
        const tabs = [
            [LogTabs.DELETED, DBMessageStatus.DELETED, ["1", "2"]],
            [LogTabs.EDITED, DBMessageStatus.EDITED, ["11", "12"]],
            [LogTabs.GHOST_PING, DBMessageStatus.GHOST_PINGED, ["21", "22"]],
            [LogTabs.DELETED, DBMessageStatus.DELETED, ["1", "2"]]
        ] as const;
        for (const [index, [tab, status, ids]] of tabs.entries()) {
            if (index > 0) {
                const switching = reader.select(tab);
                expect(switching.messages).toEqual([]);
                expect(switching.pending).toBe(true);
                expect(switching.phase).toBe("searching");
                reader.render();
            }
            const expected = newest ? [...ids].reverse() : [...ids];
            let output = await reader.settle();
            expect(output.messages.map(record => record.message_id)).toEqual(expected.slice(0, 1));
            expect(output.messages.map(record => record.status)).toEqual([status]);
            expect(output.hasMore).toBe(true);
            reader.loadMore();
            output = await reader.settle();
            expect(output.messages.map(record => record.message_id)).toEqual(expected);
            expect(output.hasMore).toBe(false);
        }
    });
});
