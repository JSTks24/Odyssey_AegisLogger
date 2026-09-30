/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageJSON } from "@vencord/discord-types";

import { LoggedAttachment, LoggedEdit, LoggedMessageJSON } from "../types";
import { mergeEditHistory } from "./recordMerge";

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

const timeOf = (value: any): number => {
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
};

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
    previousMessage: LoggedMessageJSON | null | undefined,
    base: LoggedMessageJSON,
    payloadMessage: MessageJSON
): RemovedAttachmentMerge | null {
    const previousAttachments = previousMessage?.attachments;
    const payloadAttachments = payloadMessage.attachments as LoggedAttachment[] | undefined;

    if (payloadAttachments == null || previousAttachments == null) return null;

    const diff = diffAttachments(previousAttachments, payloadAttachments);

    if (!diff.changed) return null;

    const attachments = diff.merged.map(attachment => ({ ...attachment }));
    const snapshot = attachments.map(attachment => ({ ...attachment }));
    const history = mergeEditHistory(previousMessage?.editHistory, base.editHistory);
    const editTime = payloadMessage.edited_timestamp ?? (new Date()).toISOString();
    const last = history[history.length - 1];

    const lastBelongsToThisEvent = last != null && timeOf(last.timestamp) === timeOf(editTime);

    return {
        attachments,
        editHistory: lastBelongsToThisEvent
            ? [...history.slice(0, -1), { ...last, attachments: snapshot }]
            : [
                ...history,
                {
                    content: base.content ?? "",
                    timestamp: editTime,
                    attachments: snapshot
                }
            ]
    };
}
