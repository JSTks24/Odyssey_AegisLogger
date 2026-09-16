/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, IconUtils, UserStore } from "@webpack/common";

export type ResolvedIdType = "user" | "channel" | "server" | "unknown";

export interface ResolvedId {
    type: ResolvedIdType;
    name: string;
    iconUrl?: string;
}

export function resolveId(id: string): ResolvedId {
    const user = UserStore.getUsers()[id];
    if (user)
        return {
            type: "user",
            name: user.globalName ?? user.username,
            iconUrl: user.getAvatarURL?.(null, 32, false)
        };

    const channel = ChannelStore.getBasicChannel(id);
    if (channel)
        return {
            type: "channel",
            name: channel.name || id,
            iconUrl: IconUtils.getChannelIconURL({ id: channel.id, icon: (channel as any).icon, size: 32 })
        };

    const guild = GuildStore.getGuilds()[id];
    if (guild)
        return {
            type: "server",
            name: guild.name,
            iconUrl: IconUtils.getGuildIconURL({ id: guild.id, icon: guild.icon, size: 32 })
        };

    return { type: "unknown", name: id };
}
