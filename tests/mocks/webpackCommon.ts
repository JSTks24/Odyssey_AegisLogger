/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { vi } from "vitest";

export const ChannelStore: any = {
    getChannel: () => null,
    getChannelIds: () => [],
    getBasicChannel: () => null,
    getDMUserIds: () => [],
    getDMFromUserId: () => null
};
export const GuildStore: any = {
    getGuild: () => null,
    getGuilds: () => ({})
};
export const UserStore: any = {
    getCurrentUser: () => ({ id: "self" }),
    getUser: () => null,
    getUsers: () => ({})
};
export const RelationshipStore: any = {
    getFriendIDs: () => []
};
export const GuildMemberStore: any = { getMember: () => null };
export const SelectedChannelStore: any = { getChannelId: () => "" };
export const MessageStore: any = { getMessage: () => null };
export const Toasts: any = { genId: () => "id", Type: { SUCCESS: "SUCCESS", FAILURE: "FAILURE" }, show: vi.fn() };
