/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { MouseEvent } from "react";

import type { LoggedMessageJSON } from "../types";

const interactiveSelector = 'a, button, input, textarea, select, label, img, video, audio, details, summary, [role="button"], [role="link"], [role="menuitem"], [contenteditable="true"]';

const messageNavigation = {
    getMessagePath(record: Pick<LoggedMessageJSON, "id" | "channel_id" | "guildId">, guildId?: string) {
        return `/channels/${record.guildId ?? guildId ?? "@me"}/${record.channel_id}${record.id ? "/" + record.id : ""}`;
    },

    shouldJump(event: Pick<MouseEvent<HTMLElement>, "button" | "defaultPrevented" | "target" | "currentTarget">) {
        if (event.button !== 0 || event.defaultPrevented) return false;

        const node = event.target as Node | null;
        const element = node?.nodeType === 1 ? node as Element : node?.parentElement;
        const interactive = element?.closest(interactiveSelector);
        if (interactive != null && event.currentTarget.contains(interactive)) return false;
        if (event.currentTarget.ownerDocument.getSelection()?.toString()) return false;

        return true;
    }
};

export default messageNavigation;
