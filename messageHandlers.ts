/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { findByPropsLazy } from "@webpack";
import { FluxDispatcher } from "@webpack/common";

import idb, { DBMessageStatus } from "./db";
import { addMessage, enqueueMessageTask, finalizeMessageWrite, writeMessageRecord } from "./LoggedMessageManager";
import { LoggedMessage, LoggedMessageJSON, MessageCreatePayload, MessageDeleteBulkPayload, MessageDeletePayload, MessageUpdatePayload } from "./types";
import { cleanUpCachedMessage, contentExcluded, hasPingged, isGhostPinged, shouldIgnore } from "./utils";
import { mergeRemovedAttachments } from "./utils/attachmentDiff";
import { LimitedMap } from "./utils/LimitedMap";
import loggingScope from "./utils/loggingScope";

export const cacheSentMessages = new LimitedMap<string, LoggedMessageJSON>(1000);

export function setCacheLimit(limit: number) {
    cacheSentMessages.limit = limit;
    cacheSentMessages.trim();
}

const cacheThing = findByPropsLazy("commit", "getOrCreate");

let oldGetMessage: ((channelId: string, messageId: string) => LoggedMessage | LoggedMessageJSON | null) | null = null;

export function setGetMessage(getMessage: typeof oldGetMessage) {
    oldGetMessage = getMessage;
}

const handledMessageIds = new Set<string>();

export async function messageDeleteHandler(payload: MessageDeletePayload) {
    if (payload.mlDeleted) return;

    if (handledMessageIds.has(payload.id)) {
        return;
    }

    try {
        handledMessageIds.add(payload.id);

        let message: LoggedMessage | LoggedMessageJSON | null =
            oldGetMessage?.(payload.channelId, payload.id) ?? null;
        if (message == null) {
            const cachedMessage = cacheSentMessages.get(`${payload.channelId},${payload.id}`);
            if (!cachedMessage) return;

            message = { ...cachedMessage, deleted: true } as LoggedMessageJSON;
        }

        const ghostPinged = isGhostPinged(message as any);
        const context = loggingScope.context(message);
        context.guildId = payload.guildId || (payload as any).guild_id || context.guildId;

        if (
            shouldIgnore({
                channelId: message?.channel_id ?? payload.channelId,
                guildId: loggingScope.guildId(context),
                authorId: message?.author?.id,
                bot: message?.bot || message?.author?.bot,
                flags: message?.flags,
                ghostPinged,
                content: (message as LoggedMessageJSON).content
            })
        ) {
            return FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId: payload.channelId,
                id: payload.id,
                mlDeleted: true
            });
        }


        if (message == null || message.channel_id == null || !message.deleted) return;

        const snapshot = typeof (message as any).toJS === "function" ? (message as any).toJS() : { ...message };
        snapshot.guildId = loggingScope.guildId(context);
        await addMessage(snapshot, ghostPinged ? DBMessageStatus.GHOST_PINGED : DBMessageStatus.DELETED);
    }
    finally {
        handledMessageIds.delete(payload.id);
    }
}

export async function messageDeleteBulkHandler({ channelId, guildId, ids }: MessageDeleteBulkPayload) {
    for (const id of ids) {
        await messageDeleteHandler({ type: "MESSAGE_DELETE", channelId, guildId, id });
    }
}

export async function messageUpdateHandler(payload: MessageUpdatePayload) {
    const { channel_id, id } = payload.message;

    const wrote = await enqueueMessageTask(id, async () => {
        const cachedMessage = cacheSentMessages.get(`${channel_id},${id}`);
        const previousRecord = await idb.getMessageIDB(id);
        const previous = previousRecord?.message ?? cachedMessage ?? null;

        let message = oldGetMessage?.(channel_id, id) as LoggedMessage | LoggedMessageJSON | null;
        const fallback = {
            ...previous,
            ...message,
            author: message?.author ?? previous?.author,
            guildId: (message as any)?.guild_id || (message as any)?.guildId || previous?.guild_id || previous?.guildId
        };
        const context = loggingScope.context(payload.message, fallback);
        context.guildId = payload.guildId || (payload as any).guild_id || context.guildId;

        if (shouldIgnore({
            channelId: channel_id,
            guildId: loggingScope.guildId(context),
            authorId: context.authorId,
            bot: (payload.message.author as any)?.bot ?? fallback.author?.bot,
            flags: payload.message.flags ?? fallback.flags,
            ghostPinged: isGhostPinged({ ...fallback, ...payload.message } as any),
            content: payload.message.content ?? fallback.content
        })) {
            const cache = cacheThing.getOrCreate(channel_id);
            const current = cache.get(id);
            if (current) {
                current.editHistory = [];
                cacheThing.commit(cache);
            }
            return false;
        }

        let hasEdits = false;
        if (message == null) {
            if (cachedMessage != null && payload.message.content != null && cachedMessage.content !== payload.message.content) {
                message = {
                    ...cachedMessage,
                    content: payload.message.content,
                    editHistory: [
                        ...(cachedMessage.editHistory ?? []),
                        {
                            content: cachedMessage.content,
                            timestamp: payload.message.edited_timestamp ?? (new Date()).toISOString()
                        }
                    ]
                };

                cacheSentMessages.set(`${channel_id},${id}`, message);
                hasEdits = true;
            }
        } else {
            hasEdits = message.editHistory != null && message.editHistory.length > 0;
        }

        if (previous?.attachments != null) {
            const base: LoggedMessageJSON = message == null
                ? { ...previous }
                : typeof (message as any).toJS === "function"
                    ? (message as any).toJS()
                    : { ...(message as any) };

            const merged = mergeRemovedAttachments(previous, base, payload.message);

            if (merged != null) {
                base.attachments = merged.attachments;
                base.editHistory = merged.editHistory;
                message = base;
                hasEdits = true;
            }
        }

        if (message == null || message.channel_id == null || !hasEdits) return false;

        const snapshot = typeof (message as any).toJS === "function" ? (message as any).toJS() : { ...message };
        snapshot.guildId = loggingScope.guildId(context);
        snapshot.author ??= fallback.author;
        return writeMessageRecord(snapshot, DBMessageStatus.EDITED);
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
    messageCreateHandler,
    messageDeleteHandler,
    messageDeleteBulkHandler,
    messageUpdateHandler
};

export default messageHandlers;
