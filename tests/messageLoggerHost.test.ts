/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";

import ts from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({ settings: { store: {} } }));
vi.mock("@webpack", () => ({
    findLazy: () => undefined, findByCodeLazy: () => () => undefined,
    findStoreLazy: () => ({ isMuted: () => false, isCategoryMuted: () => false, isChannelMuted: () => false })
}));
vi.mock("../db", () => ({ DBMessageStatus: { DELETED: "DELETED", EDITED: "EDITED", GHOST_PINGED: "GHOST_PINGED" } }));

import { ChannelStore, MessageStore, React, ReferencedMessageStore, UserStore } from "@webpack/common";

import { settings } from "../index";
import scope from "../utils/messageLoggerScope";

const root = fileURLToPath(new URL("..", import.meta.url));
const configPath = resolve(root, "tsconfig.host.json");
const config = existsSync(configPath) ? ts.readConfigFile(configPath, ts.sys.readFile).config : {};
const hostFile = resolve(root, config.compilerOptions?.paths?.["@plugins/*"]?.[0]?.replace("*", "messageLogger") ?? "Vencord/src/plugins/messageLogger", "index.tsx");
const messages = new Map<string, any>();
const clear = vi.fn(async (_message: any) => {});
const dispatch = vi.fn();
let active = true;

function hostModule(file: string, requires: Record<string, any>) {
    const module = { exports: {} as any };
    const compiled = ts.transpileModule(readFileSync(file, "utf8"), {
        fileName: file, compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.React }
    }).outputText;
    runInNewContext(compiled, { module, exports: module.exports, React, console, require: (name: string) => {
        if (name.includes(".css")) return {};
        if (name in requires) return requires[name];
        throw new Error(`Missing host dependency: ${name}`);
    } });
    return module.exports;
}

function nativeLogger(ignoreBots = false) {
    return hostModule(hostFile, {
        "@api/ContextMenu": { findGroupChildrenByChildId: () => null },
        "@api/MessageUpdater": { updateMessage: vi.fn() },
        "@api/Settings": { definePluginSettings: (def: any) => ({ def, store: { ignoreBots, ignoreSelf: false, ignoreUsers: "", ignoreChannels: "", ignoreGuilds: "", logEdits: true, logDeletes: true } }) },
        "@api/Styles": {}, "@components/ErrorBoundary": { default: { wrap: (component: any) => component } },
        "@components/Icons": {}, "@utils/constants": { Devs: {} }, "@utils/discord": {},
        "@utils/Logger": { Logger: class {} }, "@utils/misc": {},
        "@utils/types": { default: (plugin: any) => plugin, OptionType: {} },
        "@webpack": { findCssClassesLazy: () => ({}) },
        "@webpack/common": { MessageStore, React, UserStore, ChannelStore, Menu: { MenuItem: "menu-item" }, FluxDispatcher: { dispatch } },
        "./HistoryModal": {}
    }).default;
}

function install() {
    const target = nativeLogger();
    expect(scope.install(target, { active: () => active, clearHistory: clear, renderEdits: vi.fn(), editMarker: vi.fn() })).toBe(true);
    return target;
}

beforeEach(() => {
    scope.stop();
    vi.clearAllMocks();
    messages.clear();
    active = true;
    Object.assign(settings.store, { ignoreBots: false, ignoreSelf: false, whitelistedIds: "", blacklistedIds: "", exclusionRules: "", logDeletes: true, logEdits: true, permanentlyRemoveLogByDefault: true });
    ChannelStore.getChannel = () => ({ guild_id: "guild" });
    UserStore.getCurrentUser = () => ({ id: "self" });
    UserStore.getUser = () => null;
    MessageStore.getMessage = (_channel: string, id: string) => messages.get(id);
    MessageStore.getMessages = () => [...messages.values()];
    ReferencedMessageStore.getMessage = (_channel: string, id: string) => ({ message: messages.get(id) });
    messages.set("bot", { id: "bot", channel_id: "channel", author: { id: "bot", bot: true }, deleted: true, attachments: [] });
    messages.set("human", { id: "human", channel_id: "channel", author: { id: "human", bot: false }, deleted: true, attachments: [] });
});

describe.skipIf(!existsSync(hostFile))("current native MessageLogger integration", () => {
    it.each([[false, false], [false, true], [true, false], [true, true]])("uses Odyssey=%s over native=%s in actual mixed bulk deletion", (localIgnore, nativeIgnore) => {
        const native = nativeLogger(nativeIgnore);
        settings.store.ignoreBots = localIgnore;
        scope.start(native);
        messages.set("hook", { id: "hook", channel_id: "channel", author: { id: "hook", bot: false }, webhook_id: "hook", attachments: [] });
        for (const message of messages.values()) {
            message.deleted = false;
            message.set = function(key: string, value: any) { this[key] = value; return this; };
        }
        const cache = {
            has: (id: string) => messages.has(id),
            get: (id: string) => messages.get(id),
            remove: (id: string) => { messages.delete(id); return cache; },
            update: (id: string, callback: (message: any) => any) => { messages.set(id, callback(messages.get(id))); return cache; }
        };
        native.handleDelete(cache, { ids: ["bot", "hook", "human"] }, true);
        expect(messages.has("bot")).toBe(!localIgnore);
        expect(messages.has("hook")).toBe(!localIgnore);
        expect(messages.get("human").deleted).toBe(true);
        if (!localIgnore) {
            expect(messages.get("bot").deleted).toBe(true);
            expect(messages.get("hook").deleted).toBe(true);
        }
    });

    it("routes the actual popover and message context menu through permanent removal", async () => {
        const native = install();
        await native.messagePopoverButton.render(messages.get("bot")).onClick();
        const children: any[] = [];
        native.contextMenus.message(children, { message: { ...messages.get("human"), deleted: false, editHistory: [{}] } });
        await children.find(child => child.props.id === "ml-remove-history").props.action();
        expect(clear.mock.calls.map(call => call[0].id)).toEqual(["bot", "human"]);
    });

    it.each(["channel-context", "thread-context", "user-context", "gdm-context"])("clears only the messages loaded by the %s entry", async entry => {
        const native = install();
        const children: any[] = [];
        native.contextMenus[entry](children, { channel: { id: "channel" } });
        await children.find(child => child.props.id === "vc-ml-clear-channel").props.action();
        expect(clear.mock.calls.map(call => call[0].id)).toEqual(["bot", "human"]);
    });

    it.each(["disabled", "temporary"])("keeps native temporary behavior when %s", async mode => {
        const native = install();
        if (mode === "disabled") active = false;
        else settings.store.permanentlyRemoveLogByDefault = false;
        await native.messagePopoverButton.render(messages.get("bot")).onClick();
        expect(clear).not.toHaveBeenCalled();
        expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ id: "bot", mlDeleted: true }));
    });

    it("applies actual host regex canonicalization to selective reference deletion", () => {
        const native = install();
        const canonical = hostModule(resolve(dirname(hostFile), "../../utils/patches.ts"), { "./intlHash": {} });
        let source = "({MESSAGE_DELETE:function(e){removed.push(e.id)},MESSAGE_DELETE_BULK:function(e){removed.push(...e.ids)}})";
        for (const replacement of native.patches.find((patch: any) => patch.find === '"ReferencedMessageStore"').replacement) {
            canonical.canonicalizeReplacement(replacement, "native");
            expect(source.match(replacement.match)).not.toBeNull();
            source = source.replace(replacement.match, replacement.replace);
        }
        const removed: string[] = [];
        const handlers = runInNewContext(source, { native, removed });
        settings.store.ignoreBots = true;
        const payload = { channelId: "channel", ids: ["bot", "human"] };
        handlers.MESSAGE_DELETE_BULK(payload);
        expect(removed).toEqual(["bot"]);
        expect(payload.ids).toEqual(["bot", "human"]);
        handlers.MESSAGE_DELETE({ channelId: "channel", id: "human", mlDeleted: true });
        expect(removed).toEqual(["bot", "human"]);
        settings.store.logDeletes = false;
        handlers.MESSAGE_DELETE({ channelId: "channel", id: "human" });
        expect(removed).toHaveLength(3);
        active = false;
        handlers.MESSAGE_DELETE_BULK(payload);
        expect(removed).toHaveLength(3);
    });
});
