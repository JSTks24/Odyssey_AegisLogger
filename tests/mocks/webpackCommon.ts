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

export type ToastType = "message" | "success" | "failure" | "custom" | "clip" | "link" | "forward" | "bookmark" | "clock";
export type NewToastVariant = "default" | "success" | "critical";

export interface StubToastData {
    message: string;
    type?: ToastType;
    options?: { duration?: number };
}

export interface StubNewToastData {
    text: string;
    variant: NewToastVariant;
    duration?: number;
}

const VARIANT_OF_TYPE: Record<ToastType, NewToastVariant> = {
    message: "default",
    success: "success",
    failure: "critical",
    custom: "default",
    clip: "default",
    link: "default",
    forward: "default",
    bookmark: "default",
    clock: "default"
};

export const Toasts: { show: ReturnType<typeof vi.fn>; pop: ReturnType<typeof vi.fn> } = {
    show: vi.fn(),
    pop: vi.fn()
};

export function createToast(data: StubToastData): StubNewToastData {
    return { text: data.message, variant: VARIANT_OF_TYPE[data.type ?? "message"], duration: data.options?.duration };
}

export function showToast(message: string, type: ToastType = "message", options?: { duration?: number }) {
    Toasts.show(createToast({ message, type, options }));
}

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
