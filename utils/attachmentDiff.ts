/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageJSON } from "@vencord/discord-types";

import { LoggedAttachment, LoggedEdit, LoggedMessageJSON } from "../types";

export interface AttachmentDiff {
    changed: boolean;
    added: LoggedAttachment[];
    removed: LoggedAttachment[];
    merged: LoggedAttachment[];
}

export interface RemovedAttachmentMerge {
    attachments: LoggedAttachment[];
    editHistory: LoggedEdit[];
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

export function mergeRemovedAttachments(
    previousAttachments: LoggedAttachment[] | undefined | null,
    base: LoggedMessageJSON,
    payloadMessage: MessageJSON
): RemovedAttachmentMerge | null {
    const payloadAttachments = payloadMessage.attachments as LoggedAttachment[] | undefined;

    if (payloadAttachments == null || previousAttachments == null) return null;

    const diff = diffAttachments(previousAttachments, payloadAttachments);

    if (!diff.changed) return null;

    const editHistory = base.editHistory ?? [];
    const last = editHistory[editHistory.length - 1];

    return {
        attachments: diff.merged,
        editHistory: last != null
            ? [...editHistory.slice(0, -1), { ...last, attachments: diff.merged }]
            : [
                ...editHistory,
                {
                    content: base.content ?? "",
                    timestamp: payloadMessage.edited_timestamp ?? (new Date()).toISOString(),
                    attachments: diff.merged
                }
            ]
    };
}
