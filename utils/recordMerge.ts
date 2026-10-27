/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type DBMessageRecord, DBMessageStatus } from "../db";
import { LoggedAttachment, LoggedEdit, LoggedMessageJSON } from "../types";
import messageEmbeds from "./messageEmbeds";

const editTime = (edit: LoggedEdit): number => {
    const value = (edit as any)?.timestamp;
    if (value instanceof Date) return value.getTime();
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? 0 : parsed;
};

const editKey = (edit: LoggedEdit): string => `${editTime(edit)}|${edit?.content ?? ""}`;

export function mergeEditHistory(existing: LoggedEdit[] | undefined | null, incoming: LoggedEdit[] | undefined | null): LoggedEdit[] {
    const merged = new Map<string, LoggedEdit>();

    for (const edit of [...(existing ?? []), ...(incoming ?? [])]) {
        if (edit == null || typeof edit !== "object") continue;

        const prefix = editKey(edit);
        const key = `${prefix}|${edit.embeds == null ? "" : messageEmbeds.key(edit.embeds)}`;
        const incompleteKey = `${prefix}|`;
        const incomplete = merged.get(incompleteKey);
        const matching = edit.embeds == null ? [...merged].find(([, value]) => editKey(value) === prefix)?.[0] : undefined;
        const targetKey = matching ?? key;
        const current = merged.get(targetKey) ?? incomplete;
        if (edit.embeds != null) merged.delete(incompleteKey);
        merged.set(targetKey, current == null ? edit : {
            ...current, ...edit,
            ...(edit.embeds == null && current.embeds != null ? { embeds: current.embeds } : {}),
            ...(edit.attachments == null && current.attachments != null ? { attachments: current.attachments } : {})
        });
    }

    return [...merged.values()].sort((a, b) => editTime(a) - editTime(b) || (editKey(a) === editKey(b) ? 0 : editKey(a) < editKey(b) ? -1 : 1));
}

export function adoptAttachmentMetadata(target: LoggedAttachment[] | undefined | null, sources: LoggedAttachment[] | undefined | null): void {
    if (target == null || sources == null) return;

    for (const attachment of target) {
        if (attachment == null) continue;

        const prior = sources.find(a => a?.id === attachment.id);
        if (prior == null) continue;

        if (attachment.path == null && prior.path != null) attachment.path = prior.path;
        if (attachment.fileExtension == null && prior.fileExtension != null) attachment.fileExtension = prior.fileExtension;

        if (prior.oldUrl != null && attachment.oldUrl == null) {
            attachment.oldUrl = prior.oldUrl;
            if (attachment.oldProxyUrl == null && prior.oldProxyUrl != null) attachment.oldProxyUrl = prior.oldProxyUrl;
        }
    }
}

export function mergeEventIntoRecord(
    existing: DBMessageRecord | null | undefined,
    incoming: LoggedMessageJSON,
    status: DBMessageStatus
): { message: LoggedMessageJSON; status: DBMessageStatus; } {
    const message: LoggedMessageJSON = { ...incoming };

    if (existing?.message != null) {
        message.editHistory = mergeEditHistory(existing.message.editHistory, incoming.editHistory);
        adoptAttachmentMetadata(message.attachments, existing.message.attachments);
    } else {
        message.editHistory = mergeEditHistory(null, incoming.editHistory);
    }

    return { message, status };
}

export function applyAttachmentMetadata(message: LoggedMessageJSON, downloaded: LoggedAttachment[]): void {
    adoptAttachmentMetadata(message.attachments, downloaded);
}

const recordMerge = {
    mergeEditHistory,
    adoptAttachmentMetadata,
    mergeEventIntoRecord,
    applyAttachmentMetadata
};

export default recordMerge;
