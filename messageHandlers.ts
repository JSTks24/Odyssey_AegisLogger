/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import { settings } from ".";
import idb, { DBMessageStatus } from "./db";
import { enqueueMessageTask, finalizeMessageWrite, writeMessageRecord } from "./LoggedMessageManager";
import { LoggedAttachment, LoggedMessage, LoggedMessageJSON, MessageCreatePayload, MessageDeleteBulkPayload, MessageDeletePayload, MessageUpdatePayload } from "./types";
import { cleanUpCachedMessage, contentExcluded, hasPingged, isGhostPinged, shouldIgnoreMessage } from "./utils";
import { mergeRemovedAttachments } from "./utils/attachmentDiff";
import { LimitedMap } from "./utils/LimitedMap";
import loggingScope from "./utils/loggingScope";
import messageEmbeds from "./utils/messageEmbeds";
import { mergeEditHistory } from "./utils/recordMerge";

export const cacheSentMessages = new LimitedMap<string, LoggedMessageJSON>(1000);

export function setCacheLimit(limit: number) {
    cacheSentMessages.limit = limit;
    cacheSentMessages.trim();
}

const cacheThing = findByPropsLazy("commit", "getOrCreate");

let oldGetMessage: ((channelId: string, messageId: string) => LoggedMessage | LoggedMessageJSON | null) | null = null;
let publishHistory: ((message: LoggedMessageJSON) => void) | undefined;

export function setGetMessage(getMessage: typeof oldGetMessage, onHistory?: typeof publishHistory) {
    oldGetMessage = getMessage;
    publishHistory = onHistory;
}

const handledMessageIds = new Set<string>();

function mergeMessage(previous: any, update: any): LoggedMessageJSON {
    const fields = Object.fromEntries(Object.entries(update ?? {}).filter(([, value]) => value !== undefined));
    const authorFields = Object.fromEntries(Object.entries(update?.author ?? {}).filter(([, value]) => value !== undefined));
    const author = update?.author == null ? previous?.author
        : update.author.id == null || previous?.author?.id === update.author.id ? { ...previous?.author, ...authorFields } : authorFields;
    return cleanUpCachedMessage({ ...previous, ...fields, author, bot: loggingScope.context(update, previous).bot });
}

export function rememberMessage(message: any) {
    if (!message?.id || !message.channel_id || !loggingScope.allowsMessage(message)) return;
    const key = `${message.channel_id},${message.id}`;
    if (!cacheSentMessages.has(key)) cacheSentMessages.set(key, cleanUpCachedMessage(message));
}

export async function messageDeleteHandler(payload: MessageDeletePayload) {
    if (payload.mlDeleted || !loggingScope.records() || handledMessageIds.has(payload.id)) return;
    handledMessageIds.add(payload.id);

    try {
        const native = oldGetMessage?.(payload.channelId, payload.id);
        const snapshot = cacheSentMessages.get(`${payload.channelId},${payload.id}`);
        const wrote = await enqueueMessageTask(payload.id, async () => {
            if (!loggingScope.records()) return false;
            const current = native == null ? null : oldGetMessage?.(payload.channelId, payload.id) ?? native;
            const nativeMessage = current == null ? null : cleanUpCachedMessage(current);
            const cached = cacheSentMessages.get(`${payload.channelId},${payload.id}`);
            const archived = nativeMessage == null && cached == null ? await idb.getMessageIDB(payload.id) : null;
            if (!loggingScope.records()) return false;
            const source = nativeMessage ?? cached ?? archived?.message ?? snapshot;
            if (source == null || source.channel_id !== payload.channelId) return false;
            const message = mergeMessage(cached ?? archived?.message, source);
            message.guildId = payload.guildId || (payload as any).guild_id || message.guildId;
            message.deleted = true;

            if (shouldIgnoreMessage(message)) {
                cacheSentMessages.delete(`${payload.channelId},${payload.id}`);
                FluxDispatcher.dispatch({ type: "MESSAGE_DELETE", channelId: payload.channelId, id: payload.id, mlDeleted: true });
                return false;
            }
            const wrote = await writeMessageRecord(message, isGhostPinged(message) ? DBMessageStatus.GHOST_PINGED : DBMessageStatus.DELETED);
            if (wrote) cacheSentMessages.delete(`${payload.channelId},${payload.id}`);
            return wrote;
        });
        if (wrote) await finalizeMessageWrite(payload.id);
    } finally {
        handledMessageIds.delete(payload.id);
    }
}

export async function messageDeleteBulkHandler({ channelId, guildId, ids }: MessageDeleteBulkPayload) {
    await Promise.all(ids.map(id => messageDeleteHandler({ type: "MESSAGE_DELETE", channelId, guildId, id })));
}

export async function messageUpdateHandler(payload: MessageUpdatePayload) {
    const incoming = { ...payload.message };
    const { channel_id, id } = incoming;
    const eventTime = incoming.edited_timestamp ?? new Date().toISOString();
    const native = oldGetMessage?.(channel_id, id);
    const nativeMessage = native == null ? null : cleanUpCachedMessage(native);

    const wrote = await enqueueMessageTask(id, async () => {
        const key = `${channel_id},${id}`;
        const cached = cacheSentMessages.get(key);
        const previousRecord = loggingScope.records(true) ? await idb.getMessageIDB(id) : null;
        const previous = cached ?? previousRecord?.message;
        if (previous == null && nativeMessage == null) return false;
        const message = mergeMessage(mergeMessage(previous, nativeMessage), incoming);
        message.guildId = payload.guildId || (payload as any).guild_id || message.guildId;
        message.editHistory = mergeEditHistory(previous?.editHistory, nativeMessage?.editHistory);
        message.deleted = false;

        const allowed = loggingScope.allowsMessage(message);
        if (allowed) cacheSentMessages.set(key, message);
        else cacheSentMessages.delete(key);
        if (!loggingScope.records(true)) {
            message.editHistory = previous?.editHistory;
            return false;
        }
        if (!allowed || shouldIgnoreMessage(message, previous, true)) {
            const cache = cacheThing.getOrCreate(channel_id);
            const current = cache.get(id);
            if (current) {
                current.editHistory = [];
                cacheThing.commit(cache);
            }
            message.editHistory = [];
            return false;
        }

        const context = loggingScope.context(message);
        const textChanged = previous != null && incoming.content != null && incoming.content !== previous.content;
        const embedsChanged = previous != null && Array.isArray(incoming.embeds)
            && messageEmbeds.key(previous.embeds) !== messageEmbeds.key(message.embeds)
            && (textChanged || (context.bot || context.webhookId)
                && messageEmbeds.key(previous.embeds, true) !== messageEmbeds.key(message.embeds, true));
        if (textChanged || embedsChanged) {
            message.editHistory = mergeEditHistory(message.editHistory, [{
                content: previous!.content ?? "", timestamp: eventTime,
                ...(embedsChanged || previous!.embeds?.length ? { embeds: previous!.embeds ?? [] } : {})
            }]);
        }

        if (settings.store.logDeletedAttachments !== false) {
            const merged = mergeRemovedAttachments(previous, message, { ...incoming, edited_timestamp: eventTime });
            if (merged != null) {
                message.attachments = merged.attachments;
                message.editHistory = merged.editHistory.map(edit => edit.embeds == null && previous?.embeds?.length
                    && new Date(edit.timestamp).getTime() === new Date(eventTime).getTime() ? { ...edit, embeds: previous.embeds } : edit);
            }
        } else {
            message.attachments = message.attachments?.filter((attachment: LoggedAttachment) => !attachment.deleted).map(attachment => ({ ...attachment }));
            message.editHistory = message.editHistory?.map(({ attachments, ...edit }) => edit);
        }
        if (!message.editHistory?.length) return false;
        const wrote = await writeMessageRecord(message, DBMessageStatus.EDITED);
        if (wrote && message.editHistory.some(edit => edit.embeds != null)) publishHistory?.(message);
        return wrote;
    });

    if (wrote) await finalizeMessageWrite(id);
}

export function messageCreateHandler(payload: MessageCreatePayload) {
    const context = loggingScope.context(payload.message);
    context.channelId ??= payload.channelId;
    context.guildId = payload.guildId || (payload as any).guild_id || context.guildId;
    if (!loggingScope.allows(context)) return;

    const guildId = loggingScope.guildId(context);
    if (
        !hasPingged(payload.message as any) &&
        contentExcluded(payload.message?.content, guildId, context.channelId, context.authorId)
    ) return;

    cacheSentMessages.set(`${payload.message.channel_id},${payload.message.id}`, cleanUpCachedMessage({ ...payload.message, guildId }));
}

const messageHandlers = {
    cacheSentMessages,
    setGetMessage,
    setCacheLimit,
    rememberMessage,
    messageCreateHandler,
    messageDeleteHandler,
    messageDeleteBulkHandler,
    messageUpdateHandler
};

export default messageHandlers;
