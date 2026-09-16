/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LoggedAttachment } from "../types";

export interface AttachmentDiff {
    changed: boolean;
    added: LoggedAttachment[];
    removed: LoggedAttachment[];
    merged: LoggedAttachment[];
}

const hasId = (a: LoggedAttachment | undefined | null): a is LoggedAttachment & { id: string } =>
    a != null && a.id != null && a.id !== "";

export function diffAttachments(
    oldAttachments: LoggedAttachment[] | undefined | null,
    newAttachments: LoggedAttachment[] | undefined | null
): AttachmentDiff {
    const oldList = oldAttachments ?? [];
    const newList = newAttachments ?? [];

    const added = newList.filter(a => hasId(a) && !oldList.some(o => o.id === a.id));
    const removed = oldList.filter(o => hasId(o) && !o.deleted && !newList.some(a => a.id === o.id));

    const merged = oldList
        .map(o => newList.find(a => a.id === o.id) ?? { ...o, deleted: true })
        .concat(added);

    return {
        changed: added.length > 0 || removed.length > 0,
        added,
        removed,
        merged
    };
}
