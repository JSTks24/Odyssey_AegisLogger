/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { type DBMessageRecord, DBMessageStatus } from "../db";
import { LoggedAttachment, LoggedEdit, LoggedMessageJSON } from "../types";

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

        const key = editKey(edit);
        const current = merged.get(key);
        if (current == null || (current.attachments == null && edit.attachments != null)) {
            merged.set(key, edit);
        }
    }

    return [...merged.values()].sort((a, b) => editTime(a) - editTime(b) || (editKey(a) < editKey(b) ? -1 : 1));
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
            if (prior.url != null) attachment.url = prior.url;
            if (prior.proxy_url != null) attachment.proxy_url = prior.proxy_url;
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
