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
export const Toasts: any = { genId: () => "id", Type: { SUCCESS: "SUCCESS", FAILURE: "FAILURE", MESSAGE: "MESSAGE" }, show: vi.fn() };
export const Alerts: any = { show: vi.fn() };
export const FluxDispatcher: any = { dispatch: vi.fn() };

export const React: any = {
    createElement: (type: any, props: any, ...children: any[]) => ({
        type,
        props: {
            ...props,
            children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children
        }
    })
};

export const useState: any = vi.fn();
export const useEffect: any = vi.fn();
export const useRef: any = vi.fn();
export const useCallback: any = vi.fn();
