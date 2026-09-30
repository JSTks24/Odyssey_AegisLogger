/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { setImmediate } from "node:timers";
import vm from "node:vm";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import acceptanceV01 from "../scripts/accept-v01.mjs";
import acceptance from "../scripts/acceptanceLib.mjs";

function fixture({ initial = ["a", "b"], expected = ["a", "b", "c", "d", "e", "f"], scrolls = [] as (() => void)[] } = {}) {
    const state = { ids: initial as (string | null)[], expected, loading: false, visible: "visible", query: "", tab: 0, scrolls: 0, pendingRead: null as Promise<unknown[]> | null, resolveRead: null as ((value: unknown[]) => void) | null, onFrame: null as (() => void) | null, modalOpen: true };
    const input = { get value() { return state.query; } };
    const tabs = ["已删除", "已编辑", "幽灵消息"].map((textContent, index) => ({
        textContent,
        get className() { return state.tab === index ? "aegis-modal-tab-bar-item selected" : "aegis-modal-tab-bar-item"; },
        getAttribute(name: string) { return name === "aria-selected" ? String(state.tab === index) : null; },
        click() { state.tab = index; void window.Vencord.Plugins.plugins.AegisLogger.idb.getDateStortedMessagesByStatusIDB(true, 2, index === 0 ? "DELETED" : index === 1 ? "EDITED" : "GHOST_PINGED", 0); }
    }));
    const scroller = {
        scrollHeight: 1000,
        clientHeight: 400,
        get parentElement() { return this; },
        set scrollTop(_value: number) {
            const action = scrolls[state.scrolls++];
            action?.();
        }
    };
    const document = {
        get visibilityState() { return state.visible; },
        querySelectorAll(selector: string) {
            if (!state.modalOpen) return [];
            if (selector === ".aegis-modal-msg-context") {
                return state.ids.map(id => ({ __reactFiber$fixture: { memoizedProps: id == null ? {} : { message: { message_id: id } }, return: null } }));
            }
            if (selector === ".aegis-modal-tab-bar-item") return tabs;
            return [];
        },
        querySelector(selector: string) {
            if (selector === ".aegis-modal-header input") return state.modalOpen ? input : null;
            if (selector === ".aegis-modal-content-inner") return scroller;
            if (selector.includes("load-more-text") || selector.includes("loading-state") || selector.includes("search-status")) return state.loading ? {} : null;
            return null;
        }
    };
    const window = {
        Vencord: {
            Plugins: {
                plugins: {
                    AegisLogger: {
                        settings: { store: { messagesToDisplayAtOnceInLogs: 2, sortNewest: true } },
                        idb: {
                            async *iterateRawMessagesByStatusIDB(..._args: unknown[]) {
                                yield state.expected.map(message_id => ({ message_id, channel_id: "channel" }));
                            },
                            getDateStortedMessagesByStatusIDB(...args: unknown[]) { return args[2] === "DELETED" ? state.pendingRead ?? Promise.resolve([] as unknown[]) : Promise.resolve([] as unknown[]); },
                            countMessagesByStatusIDB(..._args: unknown[]) { return Promise.resolve(0); },
                            getMessagesByIDsIDB(..._args: unknown[]) { return Promise.resolve([] as unknown[]); },
                            hydrateRecords(..._args: unknown[]) { return Promise.resolve({ records: [] as unknown[] }); }
                        }
                    }
                }
            }
        }
    };
    const client = { async evalJson(expression: string) { return vm.runInNewContext(expression, { document, window, setTimeout, clearTimeout, requestAnimationFrame: (callback: () => void) => { state.onFrame?.(); callback(); return 1; } }); } };
    const waitFor = async (_client: unknown, expression: string, options: { label: string }) => {
        await new Promise<void>(resolve => setImmediate(resolve));
        const value = await client.evalJson(expression);
        if (value == null || value === false || value === "") throw new acceptance.WaitTimeoutError(options.label, value);
        return value;
    };
    const results: any[] = [];
    const windowOp = vi.fn(async (op: string) => { state.visible = op === "minimize" ? "hidden" : "visible"; });
    const session = acceptanceV01.createPagingSession({ client, results, windowOp, waitFor, delay: async () => { state.loading = false; state.resolveRead?.([]); } });
    const context = { status: "DELETED", query: "", sortNewest: true };
    const startRead = () => {
        state.pendingRead = new Promise(resolve => { state.resolveRead = resolve; });
        void window.Vencord.Plugins.plugins.AegisLogger.idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 2);
    };
    return { state, client, document, tabs, window, session, context, results, windowOp, waitFor, startRead };
}

beforeEach(() => { vi.spyOn(console, "log").mockImplementation(() => {}); });
afterEach(() => { vi.restoreAllMocks(); });

describe("V01 actual page collection and paging flow", () => {
    it("selects an accessible older channel with sufficient deleted and edited pages", async () => {
        const f = fixture();
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        const channels = [
            { id: "busy", deleted: 1200, edited: 200, timestamp: 500 },
            { id: "quiet", deleted: 1100, edited: 150, timestamp: 100 },
            { id: "too-small", deleted: 1200, edited: 1, timestamp: 1 },
            { id: "inaccessible", deleted: 1100, edited: 150, timestamp: 1 }
        ];
        (f.window.Vencord as any).Webpack = { findStore: (name: string) => name === "ChannelStore" ? { getChannel: (id: string) => id === "inaccessible" ? null : { id } } : {} };
        idb.iterateRawMessagesByStatusIDB = async function* (...args: unknown[]) {
            const status = args[0] === "DELETED" ? "deleted" : "edited";
            for (const channel of channels) yield Array.from({ length: channel[status] }, (_, index) => ({ message_id: `${channel.id}-${index}`, channel_id: channel.id, timestampMs: channel.timestamp }));
        };
        const candidates = await f.client.evalJson(acceptanceV01.stableChannelExpression(2));
        expect(candidates.map((item: any) => item.channel)).toEqual(["quiet", "busy"]);
        expect(candidates[0]).toMatchObject({ deleted: 1100, edited: 150, preferred: true, lastTimestamp: 100 });
    });

    it("keeps a selected channel baseline stable when another channel receives new logs", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        const records = [
            { message_id: "a", channel_id: "quiet" },
            { message_id: "b", channel_id: "quiet" },
            { message_id: "c", channel_id: "quiet" },
            { message_id: "x", channel_id: "busy" }
        ];
        f.window.Vencord.Plugins.plugins.AegisLogger.idb.iterateRawMessagesByStatusIDB = async function* () { yield records; };
        f.state.query = "channel:quiet";
        actions.push(() => { records.push({ message_id: "new", channel_id: "busy" }); f.state.ids = ["a", "b", "c"]; });
        const verdict = await f.session.foreground({ name: "stable selected channel", context: { ...f.context, channel: "quiet", query: "channel:quiet" } });
        expect(verdict.pass).toBe(true);
        expect(f.results[0].detail.expectedAllIds).toEqual(["a", "b", "c"]);
        expect(f.results[0].detail.baselineStable).toBe(true);
    });

    it("collects raw duplicate IDs and counts unidentified DOM rows", async () => {
        const f = fixture();
        f.state.ids = ["a", "a", "b", null];
        const snapshot = await f.session.readRows();
        expect(snapshot.ids).toEqual(["a", "a", "b"]);
        expect(snapshot.rowCount).toBe(4);
        expect(snapshot.unidentified).toBe(1);
        expect(snapshot.query).toBe("");
        expect(snapshot.selectedIndex).toBe(0);
        expect(snapshot.tabTexts).toEqual(["已删除", "已编辑", "幽灵消息"]);
        expect(snapshot.vis).toBe("visible");
    });

    it("reads the complete structured query from FilterBar props when its input contains only the empty rest", async () => {
        const f = fixture();
        const input = f.document.querySelector(".aegis-modal-header input") as any;
        input.__reactFiber$fixture = { memoizedProps: { value: "" }, return: { memoizedProps: { query: "channel:quiet" }, return: null } };
        const snapshot = await f.session.readRows();
        expect(snapshot.query).toBe("channel:quiet");
        expect(snapshot.inputValue).toBe("");
        expect(snapshot.querySource).toBe("react-props");
    });

    it("keeps input fallback when the React query owner is unavailable", async () => {
        const f = fixture();
        f.state.query = "plain search";
        const snapshot = await f.session.readRows();
        expect(snapshot.query).toBe("plain search");
        expect(snapshot.inputValue).toBe("plain search");
        expect(snapshot.querySource).toBe("input");
    });

    it("replaces an existing channel chip by reopening with the new complete query", async () => {
        const f = fixture();
        const input = f.document.querySelector(".aegis-modal-header input") as any;
        let completeQuery = "channel:old";
        input.__reactFiber$fixture = { memoizedProps: { value: "" }, return: { memoizedProps: { get query() { return completeQuery; } }, return: null } };
        expect((await f.session.readRows()).query).toBe("channel:old");
        const order: string[] = [];
        const open = vi.fn(async (query: string) => {
            order.push("open");
            completeQuery = query;
            f.state.modalOpen = true;
            f.state.ids = ["new-1", "new-2"];
            void f.window.Vencord.Plugins.plugins.AegisLogger.idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 0);
        });
        const prepared = await f.session.prepareFreshContext({
            name: "new channel", context: { ...f.context, channel: "new", query: "channel:new" },
            close: async () => { order.push("close"); f.state.modalOpen = false; },
            open
        });
        expect(prepared.ready).toBe(true);
        expect(order).toEqual(["close", "open"]);
        expect(open).toHaveBeenCalledWith("channel:new");
        expect(prepared.snapshot.query).toBe("channel:new");
        expect(prepared.snapshot.inputValue).toBe("");
        expect(prepared.snapshot.ids).toEqual(["new-1", "new-2"]);
        expect(prepared.newReadSettlement.targetCalls[0].settledAt).not.toBeNull();
    });

    it.each(["foreground", "recovery", "late", "last"])("fails a full-count duplicate prefix before the %s prerequisite guard", async scene => {
        const f = fixture({ initial: ["a", "a"], expected: ["a", "b"] });
        let verdict;
        if (scene === "foreground") verdict = await f.session.foreground({ name: scene, context: f.context });
        else if (scene === "recovery") verdict = await f.session.recoveryCycle({ name: scene, context: f.context, enter: vi.fn(), exit: vi.fn() });
        else if (scene === "late") verdict = await f.session.lateRequestCycle({ name: scene, context: f.context, hwnd: "test", reset: vi.fn() });
        else verdict = await f.session.lastPage({ name: scene, context: f.context, hwnd: "test" });
        expect(verdict.pass).toBe(false);
        expect(verdict.blocked).toBe(false);
        expect(f.results[0].status).toBe("fail");
        expect(f.windowOp).not.toHaveBeenCalled();
    });

    it("rejects a duplicate row through collection, baseline and report", async () => {
        const f = fixture();
        f.state.ids = ["a", "a", "b"];
        const verdict = await f.session.foreground({ name: "duplicate", context: f.context });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
        expect(f.results[0].detail.before.ids).toEqual(["a", "a", "b"]);
    });

    it("rejects unidentifiable rows rather than silently dropping them", async () => {
        const f = fixture();
        f.state.ids = ["a", "b", "c", null];
        const verdict = await f.session.foreground({ name: "unidentified", context: f.context });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
    });

    it("accepts automatic multiple pages only as a complete ordered prefix", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = ["a", "b", "c", "d", "e"]; });
        const verdict = await f.session.foreground({ name: "multiple pages", context: f.context });
        expect(verdict.pass).toBe(true);
        expect(f.results[0].status).toBe("pass");
    });

    it.each([
        ["partial hit and gap", ["a", "b", "c", "e"]],
        ["foreign record", ["a", "b", "c", "x"]],
        ["reordered prefix", ["a", "b", "d", "c"]],
        ["lost old row", ["a", "c", "d"]]
    ])("rejects %s after a real scroll", async (_name, ids) => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = ids as string[]; });
        const verdict = await f.session.foreground({ name: "invalid growth", context: f.context });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
    });

    it("blocks a changed database baseline instead of relaxing the expected page", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = ["a", "b", "c"]; f.state.expected = ["a", "b", "c", "x"]; });
        const verdict = await f.session.foreground({ name: "baseline changed", context: f.context });
        expect(verdict.blocked).toBe(true);
        expect(f.results[0].status).toBe("blocked");
    });

    it("does not pass growth while the request remains unsettled", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = ["a", "b", "c"]; f.state.loading = true; });
        const verdict = await f.session.foreground({ name: "unsettled", context: f.context });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].detail.loadSettled).toBe(false);
    });

    it("does not count transient automatic growth when final rows lose an old record", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = ["a", "c", "d"]; });
        const verdict = await f.session.recoveryCycle({
            name: "lost after restore", context: f.context,
            enter: async () => { f.state.visible = "hidden"; },
            exit: async () => { f.state.visible = "visible"; f.state.ids = ["a", "b", "c"]; }
        });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].detail.auto.ids).toEqual(["a", "b", "c"]);
        expect(f.results[0].detail.after.ids).toEqual(["a", "c", "d"]);
        expect(f.windowOp).not.toHaveBeenCalled();
    });

    it("rejects an empty final snapshot instead of falling back to earlier automatic rows", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.ids = []; });
        const verdict = await f.session.recoveryCycle({
            name: "empty final", context: f.context,
            enter: async () => { f.state.visible = "hidden"; },
            exit: async () => { f.state.visible = "visible"; f.state.ids = ["a", "b", "c"]; }
        });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
    });

    it("rejects identical first and second results after an observed in-flight request", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.loading = true; f.state.ids = ["a", "b", "c"]; f.startRead(); }, () => {});
        const verdict = await f.session.lateRequestCycle({ name: "flat second load", context: f.context, hwnd: "test", reset: vi.fn() });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
        expect(f.results[0].detail.first.ids).toEqual(["a", "b", "c"]);
        expect(f.results[0].detail.second.ids).toEqual(["a", "b", "c"]);
        expect(f.windowOp.mock.calls.map(call => call[0])).toEqual(["minimize", "restore"]);
    });

    it("accepts second growth relative to the settled first result", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.loading = true; f.state.ids = ["a", "b", "c"]; f.startRead(); }, () => { f.state.ids = ["a", "b", "c", "d"]; });
        const verdict = await f.session.lateRequestCycle({ name: "second growth", context: f.context, hwnd: "test", reset: vi.fn() });
        expect(verdict.pass).toBe(true);
        expect(f.results[0].status).toBe("pass");
    });

    it("retries the missing in-flight precondition once and then blocks", async () => {
        const f = fixture();
        const reset = vi.fn(async () => { f.state.ids = ["a", "b"]; });
        const verdict = await f.session.lateRequestCycle({ name: "unobserved request", context: f.context, hwnd: "test", reset });
        expect(verdict.blocked).toBe(true);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(f.windowOp).not.toHaveBeenCalled();
        expect(f.results[0].status).toBe("blocked");
    });

    it("blocks captured reads that finish before hidden is first observed", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        actions.push(() => { f.state.loading = true; f.startRead(); });
        f.windowOp.mockImplementation(async (op: string) => {
            f.state.visible = op === "minimize" ? "hidden" : "visible";
            if (op === "minimize") {
                f.state.resolveRead?.([]);
                await new Promise<void>(resolve => setImmediate(resolve));
                f.state.loading = false;
            }
        });
        const verdict = await f.session.lateRequestCycle({ name: "settled before hidden", context: f.context, hwnd: "test", reset: vi.fn() });
        expect(verdict.blocked).toBe(true);
        expect(f.results[0].status).toBe("blocked");
        expect(f.results[0].detail.observedReads.calls[0].settledAt).toBeNull();
        expect(f.results[0].detail.hiddenObservation.reads.calls[0].settledAt).not.toBeNull();
        expect(f.results[0].detail.hiddenObservation.sampledAt).toBeGreaterThanOrEqual(f.results[0].detail.observedReads.sampledAt);
    });

    it("rejects records lost from a fully reached last page", async () => {
        const f = fixture({ initial: ["a", "b"], expected: ["a", "b"] });
        f.windowOp.mockImplementation(async (op: string) => {
            f.state.visible = op === "minimize" ? "hidden" : "visible";
            if (op === "restore") f.state.ids = ["a"];
        });
        const verdict = await f.session.lastPage({ name: "lost last row", context: f.context, hwnd: "test" });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
    });

    it("checks the target tab again after delayed settling", async () => {
        const f = fixture({ initial: ["a", "b"], expected: ["a", "b"] });
        const session = acceptanceV01.createPagingSession({
            client: f.client, results: f.results, windowOp: f.windowOp, waitFor: f.waitFor,
            delay: async () => { f.state.tab = 0; }
        });
        const verdict = await session.tabSwitch({ name: "late old tab", context: { ...f.context, status: "EDITED" }, targetIndex: 1 });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).not.toBe("pass");
    });

    it("waits for the actual new tab read before capturing an initially idle old DOM", async () => {
        const f = fixture({ initial: ["deleted-old"], expected: ["a", "b"] });
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        let resolveTarget!: (value: unknown[]) => void;
        const pending = new Promise<unknown[]>(resolve => { resolveTarget = resolve; });
        idb.getDateStortedMessagesByStatusIDB = (..._args: unknown[]) => pending;
        const waitFor = async (client: unknown, expression: string, options: { label: string }) => {
            if (expression.includes("targetCalls")) { resolveTarget([]); await pending; f.state.onFrame = () => { f.state.ids = ["a", "b"]; }; }
            return f.waitFor(client, expression, options);
        };
        const session = acceptanceV01.createPagingSession({ client: f.client, results: f.results, windowOp: f.windowOp, waitFor, delay: async () => {} });
        const verdict = await session.tabSwitch({ name: "new tab commit", context: { ...f.context, status: "EDITED" }, targetIndex: 1 });
        expect(verdict.pass).toBe(true);
        expect(f.results[0].detail.before.ids).toEqual(["deleted-old"]);
        expect(f.results[0].detail.settled.ids).toEqual(["a", "b"]);
        expect(f.results[0].detail.newReadSettlement.targetCalls[0].settledAt).not.toBeNull();
    });

    it("blocks an idle-looking new tab whose actual read has not settled", async () => {
        const f = fixture();
        f.window.Vencord.Plugins.plugins.AegisLogger.idb.getDateStortedMessagesByStatusIDB = (..._args: unknown[]) => new Promise<unknown[]>(() => {});
        const verdict = await f.session.tabSwitch({ name: "new tab pending", context: { ...f.context, status: "EDITED" }, targetIndex: 1 });
        expect(verdict.pass).not.toBe(true);
        expect(verdict.blocked).toBe(true);
        expect(f.results[0].status).toBe("blocked");
    });

    it("does not declare a stale-request tab switch without observing the old request", async () => {
        const f = fixture();
        const reset = vi.fn();
        const verdict = await f.session.tabSwitch({ name: "unobserved old tab request", context: { ...f.context, status: "EDITED" }, targetIndex: 1, requireOldRequest: true, reset });
        expect(verdict.blocked).toBe(true);
        expect(reset).toHaveBeenCalledTimes(1);
        expect(f.state.tab).toBe(0);
        expect(f.results[0].status).toBe("blocked");
    });

    it("uses the actual read probe without changing promise identity and restores original methods", async () => {
        const f = fixture();
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        let resolveRead!: (value: unknown[]) => void;
        const pending = new Promise<unknown[]>(resolve => { resolveRead = resolve; });
        const original = (..._args: unknown[]) => pending;
        idb.getDateStortedMessagesByStatusIDB = original;
        expect((await f.client.evalJson(acceptanceV01.installReadProbeExpression)).installed).toBe(true);
        const returned = idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 2);
        expect(returned).toBe(pending);
        const active = await f.client.evalJson(acceptanceV01.readProbeSnapshotExpression);
        expect(active.calls[0]).toMatchObject({ id: 1, name: "getDateStortedMessagesByStatusIDB", statuses: ["DELETED"], settledAt: null });
        resolveRead([]);
        await pending;
        await new Promise<void>(resolve => setImmediate(resolve));
        const complete = await f.client.evalJson(acceptanceV01.readProbeSnapshotExpression);
        expect(complete.calls[0].settledAt).not.toBeNull();
        await f.client.evalJson(acceptanceV01.restoreReadProbeExpression);
        expect(idb.getDateStortedMessagesByStatusIDB).toBe(original);
        expect(await f.client.evalJson(acceptanceV01.readProbeSnapshotExpression)).toBeNull();
    });

    it("blocks a stale-tab check while the original promise remains pending despite correct visible rows", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        const pending = new Promise<unknown[]>(() => {});
        const original = (...args: unknown[]) => args[2] === "EDITED" ? Promise.resolve([] as unknown[]) : pending;
        idb.getDateStortedMessagesByStatusIDB = original;
        actions.push(() => { f.state.loading = true; void idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 2); });
        f.tabs[1].click = () => { f.state.tab = 1; f.state.loading = false; void idb.getDateStortedMessagesByStatusIDB(true, 2, "EDITED", 0); };
        const delay = vi.fn();
        const session = acceptanceV01.createPagingSession({ client: f.client, results: f.results, windowOp: f.windowOp, waitFor: f.waitFor, delay });
        const verdict = await session.tabSwitch({ name: "old promise still pending", context: { ...f.context, status: "EDITED" }, targetIndex: 1, requireOldRequest: true });
        expect(verdict.blocked).toBe(true);
        expect(verdict.pass).not.toBe(true);
        expect(f.results[0].status).toBe("blocked");
        expect(f.results[0].detail.oldRequestIds).toEqual([1]);
        expect(delay).not.toHaveBeenCalled();
        expect(idb.getDateStortedMessagesByStatusIDB).toBe(original);
    });

    it("reads the target again after the actual old promise settles and rejects a stale publication", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        let resolveRead!: (value: unknown[]) => void;
        const pending = new Promise<unknown[]>(resolve => { resolveRead = resolve; });
        idb.getDateStortedMessagesByStatusIDB = (...args: unknown[]) => args[2] === "EDITED" ? Promise.resolve([] as unknown[]) : pending;
        actions.push(() => {
            f.state.loading = true;
            void idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 2).then(() => { f.state.ids = ["old"]; });
        });
        f.tabs[1].click = () => { f.state.tab = 1; f.state.loading = false; void idb.getDateStortedMessagesByStatusIDB(true, 2, "EDITED", 0); };
        const waitFor = async (client: unknown, expression: string, options: { label: string }) => {
            if (expression.includes("oldCalls")) { resolveRead([]); await pending; await Promise.resolve(); }
            return f.waitFor(client, expression, options);
        };
        const session = acceptanceV01.createPagingSession({ client: f.client, results: f.results, windowOp: f.windowOp, waitFor, delay: vi.fn() });
        const verdict = await session.tabSwitch({ name: "actual old promise settled", context: { ...f.context, status: "EDITED" }, targetIndex: 1, requireOldRequest: true });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
        expect(f.results[0].detail.settled.ids).toEqual(["a", "b"]);
        expect(f.results[0].detail.after.ids).toEqual(["old"]);
        expect(f.results[0].detail.oldReadSettlement.oldCalls[0].settledAt).not.toBeNull();
    });

    it("passes a stale-tab check only after its captured old read IDs have settled", async () => {
        const actions: (() => void)[] = [];
        const f = fixture({ scrolls: actions });
        const { idb } = f.window.Vencord.Plugins.plugins.AegisLogger;
        let resolveRead!: (value: unknown[]) => void;
        const pending = new Promise<unknown[]>(resolve => { resolveRead = resolve; });
        idb.getDateStortedMessagesByStatusIDB = (...args: unknown[]) => args[2] === "EDITED" ? Promise.resolve([] as unknown[]) : pending;
        actions.push(() => { f.state.loading = true; void idb.getDateStortedMessagesByStatusIDB(true, 2, "DELETED", 2); });
        f.tabs[1].click = () => { f.state.tab = 1; f.state.loading = false; void idb.getDateStortedMessagesByStatusIDB(true, 2, "EDITED", 0); };
        const waitFor = async (client: unknown, expression: string, options: { label: string }) => {
            if (expression.includes("oldCalls")) { resolveRead([]); await pending; await new Promise<void>(resolve => setImmediate(resolve)); }
            return f.waitFor(client, expression, options);
        };
        const session = acceptanceV01.createPagingSession({ client: f.client, results: f.results, windowOp: f.windowOp, waitFor, delay: vi.fn() });
        const verdict = await session.tabSwitch({ name: "verified old settlement", context: { ...f.context, status: "EDITED" }, targetIndex: 1, requireOldRequest: true });
        expect(verdict.pass).toBe(true);
        expect(f.results[0].status).toBe("pass");
        expect(f.results[0].detail.oldRequestIds).toEqual([1]);
        expect(f.results[0].detail.oldReadSettlement.oldCalls[0].settledAt).not.toBeNull();
    });

    it("rejects target records lost after the first tab settlement", async () => {
        const f = fixture({ initial: ["a", "b"], expected: ["a", "b"] });
        const session = acceptanceV01.createPagingSession({
            client: f.client, results: f.results, windowOp: f.windowOp, waitFor: f.waitFor,
            delay: async () => { f.state.ids = ["a"]; }
        });
        const verdict = await session.tabSwitch({ name: "late target loss", context: { ...f.context, status: "EDITED" }, targetIndex: 1 });
        expect(verdict.pass).toBe(false);
        expect(f.results[0].status).toBe("fail");
        expect(f.results[0].detail.settled.ids).toEqual(["a", "b"]);
        expect(f.results[0].detail.after.ids).toEqual(["a"]);
    });
});
