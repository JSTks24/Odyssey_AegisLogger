/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { MessageStore, UserStore } from "@webpack/common";

import { logger, settings } from "..";
import idb, { type DBMessageRecord, DBMessageStatus } from "../db";
import { FetchMessagesResponse, LoggedMessageJSON } from "../types";
import { shouldIgnoreMessage } from ".";
import chatAttachments from "./chatAttachments";
import { cleanupUserObject } from "./cleanUp";
import loggingScope from "./loggingScope";
import messageChanges from "./messageChanges";
import { messageJsonToMessageClass } from "./misc";
import pluginRuntime from "./pluginRuntime";
import { leaseScope, normalizeAttachmentUrl } from "./saveImage";

const chatMessages = chatAttachments.createMessageLeaseStore();
const chatAttachmentHolders = chatAttachments.createChatAttachmentHolders();

let originalGetMessage: typeof MessageStore.getMessage | null = null;
let unsubscribeChanges: (() => void) | null = null;
let leaseSweep: MutationObserver | null = null;

function projectMessage(message: LoggedMessageJSON): LoggedMessageJSON {
    const logAttachments = settings.store.logDeletedAttachments !== false;

    return {
        ...message,
        author: Object.assign(Object.create(Object.getPrototypeOf(message.author)), message.author),
        mentions: [...(message.mentions ?? [])],
        attachments: message.attachments?.filter(attachment => message.deleted || logAttachments || !attachment.deleted).map(attachment => ({ ...attachment })),
        editHistory: loggingScope.records(true) ? message.editHistory?.map(edit => {
            const { attachments, ...textEdit } = edit;
            return logAttachments ? { ...textEdit, attachments: attachments?.map(attachment => ({ ...attachment })) } : textEdit;
        }) : []
    };
}

function adoptChatRecords(scope: leaseScope, records: DBMessageRecord[]) {
    chatMessages.setLimit(settings.store.cacheLimit);
    chatMessages.adopt(scope, records.map(record => ({ messageId: record.message_id, message: record.message })));
}

function holdAttachment(instance: any) {
    chatAttachmentHolders.hold(instance, instance?.props?.src);
}

function releaseAttachment(instance: any) {
    chatAttachmentHolders.release(instance);
}

function refreshAttachment(instance: any, previousProps: any) {
    chatAttachmentHolders.refresh(instance, previousProps?.src, instance?.props?.src);
}

function renderedAttachmentUrls() {
    const urls = new Set<string>();
    if (typeof document === "undefined") return urls;

    const elements = document.querySelectorAll("img, video, audio, source");

    for (let index = 0; index < elements.length; index++) {
        const element = elements[index];
        const src = element.getAttribute("src");
        if (src != null) urls.add(normalizeAttachmentUrl(src));

        const current = (element as HTMLImageElement).currentSrc;
        if (typeof current === "string" && current !== "") urls.add(normalizeAttachmentUrl(current));
    }

    return urls;
}

function sweepDetachedLeases() {
    const rendered = renderedAttachmentUrls();
    chatAttachmentHolders.sweep(url => rendered.has(normalizeAttachmentUrl(url)));

    if (chatAttachmentHolders.size() > 0 || leaseSweep == null) return;

    leaseSweep.disconnect();
    leaseSweep = null;
}

function stopLeaseSweep() {
    leaseSweep?.disconnect();
    leaseSweep = null;
}

async function processMessageFetch(response: FetchMessagesResponse) {
    const generation = pluginRuntime.generation();
    let scope: leaseScope | null = null;

    try {
        if (!response.ok || response.body.length === 0) {
            logger.error("Failed to fetch messages", response);
            return;
        }

        const firstMessage = response.body[response.body.length - 1];
        const epoch = messageChanges.epoch();
        const hydrated = await idb.getMessagesByChannelAndAfterTimestampIDB(
            firstMessage.channel_id,
            firstMessage.timestamp,
            () => !pluginRuntime.isCurrent(generation)
        );

        scope = hydrated.scope;

        if (!pluginRuntime.isCurrent(generation) || messageChanges.clearedSince(epoch)) return;

        if (!messageChanges.historyCovers(epoch)) return;

        const usable: DBMessageRecord[] = [];
        const stale: string[] = [];
        const responseContext = response.body.find(message => message.channel_id === firstMessage.channel_id && (message.guild_id || message.guildId));
        const responseAuthors = new Map(response.body.map(message => [message.author.id, message.author]));

        for (const record of hydrated.records) {
            const fallback = {
                guildId: responseContext?.channel_id === record.channel_id ? responseContext.guild_id || responseContext.guildId : undefined,
                author: responseAuthors.get(record.message.author.id)
            };
            if (messageChanges.changedSince(record.message_id, epoch)) {
                stale.push(record.message_id);
                continue;
            }
            if (shouldIgnoreMessage(record.message, fallback, record.status === DBMessageStatus.EDITED)) {
                stale.push(record.message_id);
                chatMessages.invalidate([record.message_id]);
                idb.cachedMessages.delete(record.message_id);
                continue;
            }
            usable.push({
                ...record,
                message: projectMessage({ ...record.message, guildId: loggingScope.guildId(loggingScope.context(record.message, fallback)) })
            });
        }

        scope.releaseRecords(stale);

        if (usable.length === 0) return;

        adoptChatRecords(scope, usable);
        scope = null;

        const deletedMessages = usable.filter(m =>
            m.status === DBMessageStatus.DELETED ||
            m.status === DBMessageStatus.GHOST_PINGED
        );

        for (const recivedMessage of response.body) {
            const record = usable.find(m => m.message_id === recivedMessage.id);

            if (record == null) continue;

            if (record.message.editHistory && record.message.editHistory.length > 0) {
                recivedMessage.editHistory = record.message.editHistory;

                if (settings.store.logDeletedAttachments !== false && record.message.attachments?.length) {
                    recivedMessage.attachments = record.message.attachments;
                }
            }
        }

        if (!pluginRuntime.isCurrent(generation)) return;

        const fetchUser = (id: string) => UserStore.getUser(id) || responseAuthors.get(id);

        for (let i = 0, len = usable.length; i < len; i++) {
            const record = usable[i];
            if (!record) continue;

            const { message } = record;

            for (let j = 0, len2 = message.mentions.length; j < len2; j++) {
                const user = message.mentions[j];
                const cachedUser = fetchUser((user as any).id || user);
                if (cachedUser) (message.mentions[j] as any) = cleanupUserObject(cachedUser);
            }

            const author = fetchUser(message.author.id);
            if (!author) continue;
            (message.author as any) = cleanupUserObject(author);
        }

        response.body.extra = deletedMessages.map(m => m.message);
    } catch (e) {
        logger.error("Failed to fetch messages", e);
    } finally {
        scope?.release();
    }
}

function start() {
    stopLeaseSweep();
    unsubscribeChanges?.();

    if (originalGetMessage == null) originalGetMessage = MessageStore.getMessage;
    MessageStore.getMessage = (channelId: string, messageId: string) => {
        const latestMessage = originalGetMessage!(channelId, messageId);
        const cached = chatMessages.get(messageId)?.message ?? idb.cachedMessages.get(messageId);
        if (!cached || shouldIgnoreMessage(cached, latestMessage, !cached.deleted))
            return latestMessage;

        if (cached.deleted)
            return messageJsonToMessageClass({ message: projectMessage(cached) });

        return messageJsonToMessageClass({
            message: projectMessage({
                ...cached,
                ...(latestMessage ?? {}),
                timestamp: cached.timestamp,
            })
        });
    };

    unsubscribeChanges = messageChanges.subscribe(event => {
        if (event.cleared) chatMessages.invalidateAll();
        else chatMessages.invalidate(event.ids);
    });

    return originalGetMessage;
}

function stop() {
    unsubscribeChanges?.();
    unsubscribeChanges = null;

    if (originalGetMessage != null) {
        MessageStore.getMessage = originalGetMessage;
        originalGetMessage = null;
    }

    chatMessages.invalidateAll();

    sweepDetachedLeases();

    if (chatAttachmentHolders.size() > 0 && leaseSweep == null) {
        leaseSweep = new MutationObserver(() => sweepDetachedLeases());
        leaseSweep.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
    }
}

function stats() {
    return { messages: chatMessages.size(), holders: chatAttachmentHolders.size() };
}

const chatBridge = {
    start,
    stop,
    processMessageFetch,
    holdAttachment,
    releaseAttachment,
    refreshAttachment,
    stats
};

export default chatBridge;
