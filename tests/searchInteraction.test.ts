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
    ready: false,
    listeners: new Set<() => void>(),
    ensureReady: vi.fn(),
    entities: vi.fn()
}));

vi.mock("@webpack/common", () => ({
    React: {
        createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children } }),
        Fragment: "fragment"
    },
    ReactDOM: { createPortal: (element: any) => element },
    UserStore: { getUser: () => null },
    GuildStore: { getGuild: () => null },
    ChannelStore: { getChannel: () => null },
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
        if (previous != null && deps && previous.deps && deps.every((value, position) => value === previous.deps[position])) return;
        runtime.pending.push(() => {
            previous?.cleanup?.();
            runtime.effects[index] = { deps, cleanup: effect() };
        });
    }
}));
vi.mock("@components/Icons", () => ({ ClockIcon: "clock", ImageIcon: "image", LinkIcon: "link", PlusIcon: "plus" }));
vi.mock("@api/Styles", () => ({ classNameFactory: (prefix: string) => (...parts: string[]) => parts.map(part => prefix + part).join(" ") }));
vi.mock("../db", () => ({ default: { getDistinctLogEntities: runtime.entities } }));
vi.mock("../utils/misc", () => ({ getGuildIdByChannel: () => null }));
vi.mock("../utils/i18n", () => ({ getLocale: () => "en-US", t: (key: string) => key }));
vi.mock("../utils/entityPool", () => ({ default: {
    dmChannelLabel: () => null,
    buildEntityPool: () => [{ id: "123", name: "Alice", username: "alice", typeLabel: "user" }]
} }));
vi.mock("../utils/searchIndex", () => ({ default: {
    isReady: () => runtime.ready,
    ensureReady: runtime.ensureReady,
    subscribeReady: (listener: () => void) => {
        runtime.listeners.add(listener);
        return () => runtime.listeners.delete(listener);
    }
} }));
vi.mock("../components/DateCalendar", () => ({ default: "calendar" }));
vi.mock("../components/settings/resolveId", () => ({ resolveId: () => ({}) }));

import FilterBar from "../components/LogsFilterBar";

function nodes(tree: any): any[] {
    if (Array.isArray(tree)) return tree.flatMap(nodes);
    if (tree == null || typeof tree !== "object") return [];
    return [tree, ...nodes(tree.props?.children)];
}

function createEditor(initialQuery = "") {
    let query = initialQuery;
    let tree: any;
    const listeners = new Map<string, (event?: any) => void>();
    const areaListeners = new Map<string, (event?: any) => void>();
    const panelListeners = new Map<string, (event?: any) => void>();
    const submit = vi.fn();
    const change = vi.fn((value: string) => { query = value; });
    const documentMock: any = {
        body: {},
        activeElement: null,
        querySelector: () => null,
        addEventListener: (name: string, callback: any) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name)
    };
    let inputs: any[] = [];
    let input: any;
    const area = {
        contains: (target: any) => inputs.includes(target) || target?.token === true,
        querySelector: () => input,
        addEventListener: (name: string, callback: any) => areaListeners.set(name, callback),
        removeEventListener: (name: string) => areaListeners.delete(name)
    };
    const box = { querySelector: () => input, querySelectorAll: () => inputs, getBoundingClientRect: () => ({ bottom: 20, left: 0, width: 500 }) };
    const panel = { contains: () => false, addEventListener: (name: string, callback: any) => panelListeners.set(name, callback), removeEventListener: (name: string) => panelListeners.delete(name) };
    vi.stubGlobal("document", documentMock);

    const render = () => {
        runtime.stateIndex = 0;
        runtime.refIndex = 0;
        runtime.effectIndex = 0;
        tree = FilterBar({ query, onChange: change, onSubmit: submit, placeholder: "Search", active: true });
        const oldInputs = inputs;
        inputs = [];
        for (const node of nodes(tree)) {
            const { className } = node.props;
            if (node.props.ref != null) {
                node.props.ref.current = className === "aegis-modal-filter-area" ? area
                    : className === "aegis-modal-search-box" ? box : panel;
            }
            if (node.type === "input") {
                const element: any = oldInputs[inputs.length] ?? {
                    tagName: "INPUT", selectionStart: 0, selectionEnd: 0, closest: () => null,
                    focus: () => {
                        input = element;
                        documentMock.activeElement = element;
                        areaListeners.get("focusin")?.();
                    },
                    blur: () => { documentMock.activeElement = null; },
                    setSelectionRange: (start: number, end: number) => { element.selectionStart = start; element.selectionEnd = end; },
                    select: () => { element.selectionStart = 0; element.selectionEnd = element.value.length; }
                };
                element.value = node.props.value;
                element.dataset = { textStart: String(node.props["data-text-start"]), textEnd: String(node.props["data-text-end"]), pickInput: node.props["data-pick-input"] };
                element.node = node;
                inputs.push(element);
            }
        }
        if (!inputs.includes(input)) input = inputs[inputs.length - 1];
        for (const effect of runtime.pending.splice(0)) effect();
    };
    const key = (value: string, overrides: any = {}) => {
        const event = { key: value, target: input, isComposing: false, keyCode: 0, preventDefault: vi.fn(), stopPropagation: vi.fn(), ...overrides };
        listeners.get("keydown")?.(event);
        render();
        return event;
    };
    const inputNode = () => input.node;
    render();

    return {
        submit,
        change,
        key,
        query: () => query,
        externalQuery: (value: string) => { query = value; render(); render(); },
        nodes: () => nodes(tree),
        focus: () => { input.focus(); render(); },
        blur: () => { input.blur(); areaListeners.get("focusout")?.(); render(); },
        type: (value: string) => { input.value = value; input.setSelectionRange(value.length, value.length); inputNode().props.onChange({ currentTarget: input }); render(); },
        composition: (active: boolean) => { inputNode().props[active ? "onCompositionStart" : "onCompositionEnd"]({ currentTarget: input }); },
        focusText: (index: number, position?: number) => {
            input = inputs[index];
            input.focus();
            input.setSelectionRange(position ?? input.value.length, position ?? input.value.length);
            inputNode().props.onSelect({ currentTarget: input });
            render();
        },
        paste: (text: string) => {
            nodes(tree).find(node => node.props.className?.startsWith("aegis-modal-search-box")).props.onPaste({ target: input, preventDefault: vi.fn(), clipboardData: { getData: () => text } });
            render();
        },
        copy: () => {
            const setData = vi.fn();
            nodes(tree).find(node => node.props.className?.startsWith("aegis-modal-search-box")).props.onCopy({ preventDefault: vi.fn(), clipboardData: { setData } });
            return setData;
        },
        changeDateType: (index: number) => {
            nodes(tree).find(node => node.props.className === "aegis-modal-date-type").props.onClick();
            render();
            panelListeners.get("click")?.({ target: { closest: () => ({ getAttribute: () => String(index) }) } });
            render();
        },
        selectToken: (index: number) => {
            nodes(tree).find(node => node.props["data-token-index"] === index).props.onClick();
            render();
        },
        focusToken: (index: number) => {
            const node = nodes(tree).find(node => node.props["data-token-index"] === index);
            node.props.onFocus();
            render();
            const target: any = { token: true, dataset: { tokenIndex: String(index) }, click: node.props.onClick };
            target.closest = () => target;
            return target;
        }
    };
}

beforeEach(() => {
    runtime.states = [];
    runtime.refs = [];
    runtime.effects = [];
    runtime.pending = [];
    runtime.listeners.clear();
    runtime.ready = false;
    runtime.ensureReady.mockReset();
    runtime.entities.mockReset().mockResolvedValue({ authors: [], guildIds: [], channelIds: [] });
});

afterEach(() => {
    for (const effect of runtime.effects) effect?.cleanup?.();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe("search editor keyboard interactions", () => {
    it("keeps typing in the draft until Enter submits it once", () => {
        const editor = createEditor();
        editor.focus();
        editor.type("hello world");
        expect(editor.submit).not.toHaveBeenCalled();
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("hello world");
    });

    it("uses Enter to complete a visible candidate before submitting", () => {
        const editor = createEditor();
        editor.focus();
        editor.key("ArrowDown");
        editor.key("Enter");
        expect(editor.query()).toBe("user:");
        editor.key("ArrowDown");
        editor.key("Enter");
        expect(editor.query()).toBe("user:123");
        expect(editor.submit).not.toHaveBeenCalled();
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("user:123");
    });

    it("does not navigate or select hidden candidates", () => {
        const editor = createEditor("hello");
        editor.focus();
        editor.key("ArrowDown");
        editor.key("Escape");
        expect(editor.key("ArrowDown").preventDefault).not.toHaveBeenCalled();
        editor.key("Enter");
        expect(editor.query()).toBe("hello");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("submits on the next Enter after choosing a content filter", () => {
        const editor = createEditor();
        editor.focus();
        for (let i = 0; i < 4; i++) editor.key("ArrowDown");
        editor.key("Enter");
        editor.key("ArrowDown");
        editor.key("Enter");
        const completed = editor.query();
        expect(completed).toMatch(/^has:/);
        expect(editor.submit).not.toHaveBeenCalled();
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith(completed);
        expect(editor.query()).toBe(completed);
    });

    it("clears the previous candidate highlight after the search field loses focus", () => {
        vi.useFakeTimers();
        const editor = createEditor("hello");
        editor.focus();
        editor.key("ArrowDown");
        editor.key("ArrowDown");
        editor.blur();
        vi.advanceTimersByTime(150);
        editor.focus();
        editor.key("Enter");
        expect(editor.query()).toBe("hello");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("hello");
    });

    it("leaves IME confirmation and composition keys alone", () => {
        const editor = createEditor("中文");
        editor.focus();
        expect(editor.key("Enter", { isComposing: true }).preventDefault).not.toHaveBeenCalled();
        expect(editor.key("Enter", { keyCode: 229 }).preventDefault).not.toHaveBeenCalled();
        editor.composition(true);
        editor.key("Enter");
        editor.key("ArrowDown");
        expect(editor.submit).not.toHaveBeenCalled();
        editor.composition(false);
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("中文");
    });

    it("removes selected noneditable tokens without a remove button", () => {
        const editor = createEditor("has:image message:456 hello");
        expect(editor.nodes().filter(node => node.props.className?.includes("search-token-remove"))).toEqual([]);
        editor.selectToken(0);
        editor.key("Delete");
        expect(editor.query()).toBe("message:456 hello");
        const target = editor.focusToken(0);
        editor.key("Backspace", { target });
        expect(editor.query()).toBe("hello");
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("keeps clicking editable tokens in the existing editor", () => {
        const editor = createEditor("user:123 has:image");
        editor.focus();
        editor.selectToken(0);
        expect(editor.query()).toBe("user:123 has:image");
        expect(editor.nodes().some(node => node.props.className?.includes("search-token-active"))).toBe(true);
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("deletes the trailing token from an empty input and discards empty pick prefixes on submit", () => {
        const editor = createEditor("has:image message:456");
        editor.key("Backspace");
        expect(editor.query()).toBe("has:image");
        editor.focus();
        editor.key("ArrowDown");
        editor.key("Enter");
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("has:image");
    });

    it("loads logged candidates only after the shared index becomes ready", async () => {
        createEditor();
        expect(runtime.ensureReady).not.toHaveBeenCalled();
        expect(runtime.entities).not.toHaveBeenCalled();
        runtime.ready = true;
        for (const listener of runtime.listeners) listener();
        await Promise.resolve();
        expect(runtime.entities).toHaveBeenCalledTimes(1);
    });

    it("renders conditions between text segments without reordering the query", () => {
        const editor = createEditor("aaa user:1111 bbb has:image ccc");
        expect(editor.nodes().filter(node => node.type === "input").map(node => node.props.value)).toEqual(["aaa ", " bbb ", " ccc"]);
        expect(editor.nodes().filter(node => node.props["data-token-index"] != null)).toHaveLength(2);
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("aaa user:1111 bbb has:image ccc");
    });

    it("keeps a typed condition editable until it is confirmed", () => {
        const editor = createEditor();
        editor.focus();
        editor.type("aaa user:1111");
        expect(editor.nodes().filter(node => node.props["data-token-index"] != null)).toHaveLength(0);
        editor.key("Enter");
        expect(editor.nodes().filter(node => node.props["data-token-index"] != null)).toHaveLength(1);
        expect(editor.query()).toBe("aaa user:1111");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("aaa user:1111");
    });

    it("edits and cancels a middle condition without losing its suffix", () => {
        const editor = createEditor("aaa !user:1111 bbb has:image ccc");
        editor.selectToken(0);
        editor.focusText(1);
        editor.type("456");
        expect(editor.query()).toBe("aaa !user:456 bbb has:image ccc");
        editor.key("Escape");
        expect(editor.query()).toBe("aaa !user:1111 bbb has:image ccc");
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("keeps the picker aligned while editing surrounding text", () => {
        const editor = createEditor("aaa user:1111 bbb has:image ccc");
        editor.focus();
        editor.selectToken(0);
        editor.focusText(0);
        editor.type("before ");
        editor.focusText(2);
        editor.type(" after ");
        editor.focusText(1);
        editor.type("");
        editor.key("ArrowDown");
        editor.key("Enter");
        expect(editor.query()).toBe("before user:123 after has:image ccc");
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("restores the previous token before switching to another middle token", () => {
        const editor = createEditor("aaa user:1111 bbb channel:2222 ccc");
        editor.selectToken(0);
        editor.focusText(1);
        editor.type("longer-name");
        editor.selectToken(1);
        editor.key("Escape");
        expect(editor.query()).toBe("aaa user:1111 bbb channel:2222 ccc");
    });

    it("cancels a picker safely before deleting an earlier chip", () => {
        const editor = createEditor("aaa has:image bbb user:1111 ccc");
        editor.selectToken(1);
        editor.focusText(1, 0);
        editor.key("Backspace");
        expect(editor.query()).toBe("aaa bbb user:1111 ccc");
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("aaa bbb user:1111 ccc");
    });

    it("pastes ordered filters into the current text selection", () => {
        const editor = createEditor("aaa bbb");
        editor.focusText(0, 4);
        editor.paste("user:1111 has:image ");
        expect(editor.query()).toBe("aaa user:1111 has:image bbb");
        expect(editor.nodes().filter(node => node.props["data-token-index"] != null)).toHaveLength(2);
    });

    it("copies and replaces the whole query across chips", () => {
        const editor = createEditor("aaa user:1111 bbb has:image ccc");
        editor.focus();
        editor.key("a", { ctrlKey: true });
        expect(editor.copy()).toHaveBeenCalledWith("text/plain", "aaa user:1111 bbb has:image ccc");
        editor.type("replacement");
        expect(editor.query()).toBe("replacement");
    });

    it("clears stale edit ranges when the parent replaces the query", () => {
        const editor = createEditor("aaa user:1111 bbb");
        editor.selectToken(0);
        editor.focusText(1);
        editor.type("long-name");
        editor.externalQuery("other channel:2222 after");
        expect(editor.nodes().some(node => node.props.className?.includes("search-token-active"))).toBe(false);
        expect(editor.nodes().filter(node => node.props["data-token-index"] != null)).toHaveLength(1);
        editor.key("Enter");
        expect(editor.submit).toHaveBeenCalledExactlyOnceWith("other channel:2222 after");
    });

    it("keeps the edited date in place while replacing a conflicting date type", () => {
        const editor = createEditor("aaa before:2026-01-01 bbb after:2026-02-02 ccc");
        editor.focus();
        editor.selectToken(0);
        editor.changeDateType(1);
        expect(editor.query()).toBe("aaa after:2026-01-01 bbb ccc");
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("extends a fresh picker while typing and replaces the entire candidate text", () => {
        const editor = createEditor();
        editor.focus();
        editor.key("ArrowDown");
        editor.key("Enter");
        editor.type("Alice");
        expect(editor.nodes().find(node => node.props["data-pick-input"] === "true").props.value).toBe("Alice");
        editor.key("ArrowDown");
        editor.key("Enter");
        expect(editor.query()).toBe("user:123");
        expect(editor.submit).not.toHaveBeenCalled();
    });

    it("includes text pasted at the end of an active picker", () => {
        const editor = createEditor("aaa user:1111 bbb");
        editor.selectToken(0);
        editor.focusText(1);
        editor.type("Ali");
        editor.paste("ce");
        expect(editor.query()).toBe("aaa user:Alice bbb");
        editor.key("ArrowDown");
        editor.key("Enter");
        expect(editor.query()).toBe("aaa user:123 bbb");
    });
});
