/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { Channel, User } from "@vencord/discord-types";
import { filters, find, waitFor } from "@webpack";
import type { React } from "@webpack/common";

import type { LoggedMessage } from "../types";

export interface MessagePreviewProps {
    className: string;
    author: User;
    message: LoggedMessage;
    channel: Channel;
    compact: boolean;
    isGroupStart: boolean;
    hideSimpleEmbedContent: boolean;
}

interface logModuleState {
    messagePreview: React.ComponentType<MessagePreviewProps> | null;
    privateChannelRecord: (new (props: { id: string }) => Channel) | null;
    version: number;
}

const messagePreviewFilter = (module: any) =>
    module?.type?.toString().includes("previewLinkTarget:") && !module?.type?.toString().includes("HAS_THREAD");
let privateChannelFilter: ((module: any) => boolean) | null = null;
let snapshot: logModuleState = { messagePreview: null, privateChannelRecord: null, version: 0 };
let initialized = false;
const listeners = new Set<() => void>();

function getPrivateChannelFilter() {
    privateChannelFilter ??= filters.byCode(".is_message_request_timestamp,");
    return privateChannelFilter;
}

function pickFromModule(found: unknown, filter: (module: any) => boolean) {
    if (found == null) return null;
    if (filter(found)) return found;
    if (typeof found !== "object") return null;

    for (const value of Object.values(found)) {
        if (value != null && filter(value)) return value;
    }

    return null;
}

function adopt(found: unknown, kind: "messagePreview" | "privateChannelRecord") {
    if (snapshot[kind] != null) return;
    const filter = kind === "messagePreview" ? messagePreviewFilter : getPrivateChannelFilter();
    const value = pickFromModule(found, filter);
    if (value == null) return;

    snapshot = { ...snapshot, [kind]: value, version: snapshot.version + 1 };
    listeners.forEach(listener => listener());
}

function initialize() {
    if (initialized) return;
    initialized = true;

    for (const kind of ["messagePreview", "privateChannelRecord"] as const) {
        const filter = kind === "messagePreview" ? messagePreviewFilter : getPrivateChannelFilter();
        try {
            adopt(find(filter, { isIndirect: true }), kind);
        } catch { }
        if (snapshot[kind] != null) continue;
        waitFor(filter, found => adopt(found, kind), { isIndirect: true });
    }
}

function subscribe(listener: () => void) {
    listeners.add(listener);
    initialize();
    listener();
    return () => { listeners.delete(listener); };
}

const logMessageModules = {
    getSnapshot: () => snapshot,
    subscribe
};

export default logMessageModules;
