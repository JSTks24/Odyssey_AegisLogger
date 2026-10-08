/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore } from "@webpack/common";

import { settings } from "..";
import { getGuildIdByChannel } from "./misc";

interface logScopeContext {
    channelId?: string;
    authorId?: string;
    guildId?: string | null;
}

function guildId(context: logScopeContext): string | undefined {
    return context.guildId || (context.channelId ? getGuildIdByChannel(context.channelId) : undefined);
}

function context(message: any, fallback?: any): logScopeContext {
    return {
        channelId: message?.channel_id ?? message?.channelId ?? fallback?.channel_id ?? fallback?.channelId,
        authorId: message?.author?.id ?? fallback?.author?.id,
        guildId: message?.guild_id || message?.guildId || fallback?.guild_id || fallback?.guildId
    };
}

function allows(value: logScopeContext): boolean {
    const whitelist = ((settings.store.whitelistedIds as string) ?? "").split(",").map(id => id.trim()).filter(Boolean);
    if (whitelist.length === 0) return true;

    const serverId = guildId(value);
    if (whitelist.some(id => id === value.authorId || id === value.channelId || id === serverId)) return true;
    if (serverId != null) return false;

    const channel = value.channelId ? ChannelStore.getChannel(value.channelId) : undefined;
    return !!(channel?.isDM?.() || channel?.isGroupDM?.() || channel?.type === 1 || channel?.type === 3);
}

function allowsMessage(message: any, fallback?: any): boolean {
    return allows(context(message, fallback));
}

const loggingScope = { allows, allowsMessage, context, guildId };

export default loggingScope;
