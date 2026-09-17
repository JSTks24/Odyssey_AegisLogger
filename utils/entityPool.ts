/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore, RelationshipStore, UserStore } from "@webpack/common";

import type { LogEntities } from "../db";
import { t } from "./i18n";
import { MatchCandidate } from "./idMatch";

type PoolKind = "user" | "server" | "channel";

function dmChannelLabel(channel: any): string | undefined {
    const recipients = channel?.recipients;
    if (!Array.isArray(recipients) || recipients.length === 0) return undefined;
    const names = recipients
        .map(id => UserStore.getUser?.(id))
        .filter(Boolean)
        .map(user => user.globalName ?? user.username)
        .filter(Boolean);
    if (names.length === 0) return undefined;
    return names.join(", ");
}

function channelSub(channel: any): string | undefined {
    if (channel?.recipients != null) return t("modal.dm");
    if (channel?.guild_id) return GuildStore.getGuild?.(channel.guild_id)?.name;
    return undefined;
}

function buildEntityPool(kind: PoolKind, logged: LogEntities | null): MatchCandidate[] {
    const entries = new Map<string, MatchCandidate>();
    const push = (id: string, name: string | undefined, type: PoolKind, username?: string, sub?: string) => {
        if (!id || entries.has(id)) return;
        entries.set(id, {
            id,
            name: name ?? id,
            username,
            sub,
            typeLabel: t(`settings.type${type === "server" ? "Server" : type === "channel" ? "Channel" : "User"}`)
        });
    };

    if (kind === "user") {
        for (const author of logged?.authors ?? []) {
            const user = UserStore.getUser?.(author.id);
            push(author.id, user?.globalName ?? user?.username ?? author.globalName ?? author.username, "user", user?.username ?? author.username);
        }

        for (const friendId of (RelationshipStore.getFriendIDs?.() ?? [])) {
            const user = UserStore.getUsers?.()[friendId];
            if (user) push(friendId, user.globalName ?? user.username, "user", user.username);
        }

        for (const dmUserId of (ChannelStore.getDMUserIds?.() ?? [])) {
            const user = UserStore.getUsers?.()[dmUserId];
            if (user) push(dmUserId, user.globalName ?? user.username, "user", user.username);
        }

        for (const user of Object.values(UserStore.getUsers?.() ?? {}))
            push(user.id, user.globalName ?? user.username, "user", user.username);
    }

    if (kind === "server") {
        for (const guildId of logged?.guildIds ?? [])
            push(guildId, GuildStore.getGuild?.(guildId)?.name ?? guildId, "server");

        for (const guild of Object.values(GuildStore.getGuilds?.() ?? {}))
            push(guild.id, guild.name, "server");
    }

    if (kind === "channel") {
        for (const channelId of logged?.channelIds ?? []) {
            const channel: any = ChannelStore.getChannel?.(channelId);
            push(channelId, channel?.name ?? dmChannelLabel(channel), "channel", undefined, channelSub(channel));
        }

        for (const channelId of (ChannelStore.getChannelIds?.() ?? [])) {
            const channel: any = ChannelStore.getChannel(channelId);
            const name = channel?.name ?? dmChannelLabel(channel);
            if (name) push(channelId, name, "channel", undefined, channelSub(channel));
        }

        for (const dmUserId of (ChannelStore.getDMUserIds?.() ?? [])) {
            const channel: any = ChannelStore.getDMFromUserId?.(dmUserId);
            const name = channel?.name ?? dmChannelLabel(channel);
            if (name) push(channel.id, name, "channel", undefined, channelSub(channel));
        }
    }

    return [...entries.values()];
}

const entityPool = {
    buildEntityPool,
    dmChannelLabel
};

export default entityPool;
