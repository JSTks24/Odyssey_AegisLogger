/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore } from "@webpack/common";

import logFields from "./logFields";

export default function channelGuildId(channelId: string): string | undefined {
    const visited = new Set<string>();
    let current: string | undefined = channelId;

    while (current && !visited.has(current) && visited.size < 32) {
        visited.add(current);
        const channel = ChannelStore.getChannel(current);
        if (channel == null) return;
        const guildId = logFields.firstString(channel.guild_id, (channel as any).guildId)
            || (typeof channel.getGuildId === "function" ? logFields.firstString(channel.getGuildId()) : "");
        if (guildId) return guildId;
        current = logFields.firstString(channel.parent_id, (channel as any).parentId);
    }
}
