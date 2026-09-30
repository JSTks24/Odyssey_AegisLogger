/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { logger, settings } from ".";
import idb, { DBMessageRecord, DBMessageStatus } from "./db";
import { LoggedAttachment, LoggedMessage, LoggedMessageJSON } from "./types";
import { cleanupMessage, contentExcluded } from "./utils";
import { applyAttachmentMetadata, mergeEventIntoRecord } from "./utils/recordMerge";
import { cacheMessageImages } from "./utils/saveImage";

const perMessageQueues = new Map<string, Promise<unknown>>();
const pendingWrites = new Set<Promise<unknown>>();

export function enqueueMessageTask<T>(messageId: string, task: () => Promise<T>): Promise<T> {
    const previous = perMessageQueues.get(messageId) ?? Promise.resolve();
    const run = previous.then(task, task);
    const settled = run.then(() => undefined, () => undefined);

    perMessageQueues.set(messageId, settled);
    settled.finally(() => {
        if (perMessageQueues.get(messageId) === settled) perMessageQueues.delete(messageId);
    });

    return run;
}

const cacheFilterForStatus = (status: DBMessageStatus): ((attachment: LoggedAttachment) => boolean) | undefined | null => {
    if (status === DBMessageStatus.DELETED) return undefined;
    if (status === DBMessageStatus.EDITED) return attachment => attachment.deleted === true;
    return null;
};

interface attachmentBackfillWork {
    messageId: string;
    version: number | undefined;
    targets: LoggedAttachment[];
    base: LoggedMessageJSON;
}

export function scheduleAttachmentBackfill(messageId: string) {
    if (!settings.store.saveImages) return;

    const write = enqueueMessageTask(messageId, async () => {
        const record = await idb.getMessageIDB(messageId) as DBMessageRecord | null | undefined;
        if (record == null) return null;

        const filter = cacheFilterForStatus(record.status);
        if (filter === null) return null;

        const attachments = Array.isArray(record.message.attachments) ? record.message.attachments : [];
        const targets = attachments.filter(attachment =>
            attachment != null
            && attachment.path == null
            && (filter === undefined || filter(attachment))
        );
        if (targets.length === 0) return null;

        return {
            messageId,
            version: record.version,
            targets: targets.map(attachment => ({ ...attachment })),
            base: { ...record.message }
        } satisfies attachmentBackfillWork;
    }).then(async work => {
        if (work == null) return;

        await cacheMessageImages({ ...work.base, attachments: work.targets }, undefined);

        await enqueueMessageTask(work.messageId, () =>
            idb.updateMessageIfCurrentIDB(work.messageId, work.version, message => applyAttachmentMetadata(message, work.targets))
        );
    });

    pendingWrites.add(write);
    write
        .catch(error => logger.error("Failed to persist attachment metadata", error))
        .finally(() => pendingWrites.delete(write));
}

export const finalizeMessageWrite = async (messageId: string) => {
    scheduleAttachmentBackfill(messageId);

    if (settings.store.messageLimit > 0) {
        await idb.enforceMessageLimitIDB(settings.store.messageLimit);
    }
};

export const writeMessageRecord = async (message: LoggedMessage | LoggedMessageJSON, status: DBMessageStatus): Promise<boolean> => {
    const finalMessage = cleanupMessage(message);

    if (status !== DBMessageStatus.GHOST_PINGED && contentExcluded(finalMessage.content, finalMessage.guildId, finalMessage.channel_id, finalMessage.author?.id)) return false;

    const existing = await idb.getMessageIDB(finalMessage.id);
    const merged = mergeEventIntoRecord(existing, finalMessage, status);

    if (status === DBMessageStatus.EDITED) {
        if (merged.message.deleted === true) merged.message.deleted = false;
    } else {
        merged.message.deleted = true;
    }

    await idb.addMessageIDB(merged.message, merged.status);
    return true;
};

export const addMessage = async (message: LoggedMessage | LoggedMessageJSON, status: DBMessageStatus) => {
    const finalMessage = cleanupMessage(message);

    if (status !== DBMessageStatus.GHOST_PINGED && contentExcluded(finalMessage.content, finalMessage.guildId, finalMessage.channel_id, finalMessage.author?.id)) return;

    const wrote = await enqueueMessageTask(finalMessage.id, () => writeMessageRecord(message, status));
    if (!wrote) return;

    await finalizeMessageWrite(finalMessage.id);
};

export const flushWrites = async () => {
    await Promise.allSettled([...pendingWrites]);
};
