/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageStore, React, ReferencedMessageStore } from "@webpack/common";

import { settings } from "..";
import { shouldIgnoreMessage } from ".";

interface messageLoggerTarget {
    shouldIgnore(message: any, isEdit?: boolean): boolean;
}

interface scopeBinding {
    target: messageLoggerTarget;
    original: messageLoggerTarget["shouldIgnore"];
    guarded: messageLoggerTarget["shouldIgnore"];
    active: boolean;
}

let binding: scopeBinding | null = null;
const installations = new WeakSet<object>();

interface loggerHooks {
    active(): boolean;
    clearHistory(message: any): Promise<void>;
    renderEdits(props: any, original: any): any;
    editMarker(props: any, original: any): any;
}

function install(target: any, hooks: loggerHooks): boolean {
    if (target == null || typeof target !== "object") return false;
    if (installations.has(target)) return true;
    const patch = target.patches?.find((patch: any) => patch.find === '"ReferencedMessageStore"');
    if (!Array.isArray(patch?.replacement) || patch.replacement.length !== 2
        || patch.replacement.some((replacement: any) => replacement.replace !== "return;")
        || typeof target.messagePopoverButton?.render !== "function" || target.contextMenus == null
        || typeof target.renderEdits !== "function" || typeof target.EditMarker !== "function") return false;

    target.aegisReferenceDelete = (payload: any, bulk = false) => {
        const retain = (id: string) => {
            if (!hooks.active()) return true;
            if (payload.mlDeleted) return false;
            const message = ReferencedMessageStore.getMessage(payload.channelId, id)?.message ?? MessageStore.getMessage(payload.channelId, id);
            return message != null && !shouldIgnoreMessage(message);
        };
        return bulk ? { ...payload, ids: payload.ids.filter((id: string) => !retain(id)) } : retain(payload.id);
    };
    patch.replacement = [
        { match: /(?<=MESSAGE_DELETE:function\((\i)\)\{)/, replace: "if($self.aegisReferenceDelete($1))return;" },
        { match: /(?<=MESSAGE_DELETE_BULK:function\((\i)\)\{)/, replace: "$1=$self.aegisReferenceDelete($1,true);if(!$1.ids.length)return;" }
    ];

    const permanent = () => hooks.active() && settings.store.permanentlyRemoveLogByDefault;
    const clearChannel = async (props: any) => {
        const messages: any[] = [];
        MessageStore.getMessages(props.channel?.id)?.forEach((message: any) => {
            if (message.deleted || message.editHistory?.length || message.attachments?.some((attachment: any) => attachment.deleted)) messages.push(message);
        });
        for (const message of messages) await hooks.clearHistory(message);
    };
    const patchActions = (children: any[], props: any) => {
        children.forEach((child, index) => {
            if (Array.isArray(child)) return patchActions(child, props);
            if (child?.props == null) return;
            const { id } = child.props;
            if (id === "ml-remove-history" || id === "vc-ml-clear-channel") {
                children[index] = React.cloneElement(child, { action: () => id === "ml-remove-history" ? hooks.clearHistory(props.message) : clearChannel(props) });
            } else if (child.props.children != null) {
                const nested = Array.isArray(child.props.children) ? [...child.props.children] : [child.props.children];
                patchActions(nested, props);
                children[index] = React.cloneElement(child, { children: nested });
            }
        });
    };
    for (const key of Object.keys(target.contextMenus)) {
        const original = target.contextMenus[key];
        target.contextMenus[key] = function(children: any[], props: any) {
            const result = original.call(this, children, props);
            if (permanent()) patchActions(children, props);
            return result;
        };
    }
    const { render } = target.messagePopoverButton;
    target.messagePopoverButton.render = function(message: any) {
        const button = render.call(this, message);
        return button && permanent() ? { ...button, onClick: () => {
            const latest = MessageStore.getMessage(message.channel_id, message.id);
            if (latest) return hooks.clearHistory(latest);
        } } : button;
    };
    const { renderEdits } = target;
    const editMarker = target.EditMarker;
    target.renderEdits = (props: any) => hooks.active() ? hooks.renderEdits(props, renderEdits) : React.createElement(renderEdits, props);
    target.EditMarker = (props: any) => hooks.active() ? hooks.editMarker(props, editMarker) : React.createElement(editMarker, props);
    installations.add(target);
    return true;
}

function stop() {
    const previous = binding;
    binding = null;
    if (previous == null) return;
    previous.active = false;
    if (previous.target.shouldIgnore === previous.guarded) previous.target.shouldIgnore = previous.original;
}

function start(target: messageLoggerTarget | null | undefined, rememberMessage?: (message: any) => void) {
    if (binding && binding.target === target && target?.shouldIgnore === binding.guarded) return;
    stop();
    if (typeof target?.shouldIgnore !== "function") return;

    const next: scopeBinding = { target, original: target.shouldIgnore, guarded: target.shouldIgnore, active: true };
    next.guarded = function(message: any, isEdit?: boolean) {
        if (!next.active) return next.original.call(this, message, isEdit);
        const channelId = message?.channel_id ?? message?.channelId;
        const cached = channelId && message?.id ? MessageStore.getMessage(channelId, message.id) : undefined;
        if (isEdit && cached) rememberMessage?.(cached);
        return shouldIgnoreMessage(message, cached, isEdit);
    };
    target.shouldIgnore = next.guarded;
    binding = next;
}

const messageLoggerScope = { start, stop, install };

export default messageLoggerScope;
