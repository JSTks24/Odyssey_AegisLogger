/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageStore } from "@webpack/common";

import loggingScope from "./loggingScope";

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

function stop() {
    const previous = binding;
    binding = null;
    if (previous == null) return;
    previous.active = false;
    if (previous.target.shouldIgnore === previous.guarded) previous.target.shouldIgnore = previous.original;
}

function start(target: messageLoggerTarget | null | undefined) {
    if (binding && binding.target === target && target?.shouldIgnore === binding.guarded) return;
    stop();
    if (typeof target?.shouldIgnore !== "function") return;

    const next: scopeBinding = { target, original: target.shouldIgnore, guarded: target.shouldIgnore, active: true };
    next.guarded = function(message: any, isEdit?: boolean) {
        if (next.active) {
            const channelId = message?.channel_id ?? message?.channelId;
            const cached = channelId && message?.id ? MessageStore.getMessage(channelId, message.id) : undefined;
            if (!loggingScope.allowsMessage(message, cached)) return true;
        }
        return next.original.call(this, message, isEdit);
    };
    target.shouldIgnore = next.guarded;
    binding = next;
}

const messageLoggerScope = { start, stop };

export default messageLoggerScope;
