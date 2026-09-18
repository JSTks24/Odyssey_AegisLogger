/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export const Native = getNative();

import "./styles.css";

import ErrorBoundary from "@components/ErrorBoundary";
import { Logger } from "@utils/Logger";
import definePlugin from "@utils/types";
import { findByPropsLazy } from "@webpack";
import { FluxDispatcher, MessageStore, React, UserStore } from "@webpack/common";

import { OpenLogsButton } from "./components/LogsButton";
import logsModal from "./components/LogsModal";
import idb, { DBMessageStatus } from "./db";
import * as LoggedMessageManager from "./LoggedMessageManager";
import { addMessage } from "./LoggedMessageManager";
import { settings } from "./settings";
import { FetchMessagesResponse, LoadMessagePayload, LoggedMessage, LoggedMessageJSON, MessageCreatePayload, MessageDeleteBulkPayload, MessageDeletePayload, MessageUpdatePayload } from "./types";
import { cleanUpCachedMessage, cleanupUserObject, contentExcluded, getIdList, getNative, isGhostPinged, mapTimestamp, messageJsonToMessageClass, reAddDeletedMessages } from "./utils";
import { mergeRemovedAttachments } from "./utils/attachmentDiff";
import { removeContextMenuBindings, setupContextMenuPatches } from "./utils/contextMenu";
import { removedAttachmentLabelCss, t } from "./utils/i18n";
import { shouldIgnore } from "./utils/index";
import { applyLegacyPluginSettings } from "./utils/legacySettings";
import { LimitedMap } from "./utils/LimitedMap";
import { doesMatch } from "./utils/parseQuery";
import * as imageUtils from "./utils/saveImage";
import * as ImageManager from "./utils/saveImage/ImageManager";
export { settings };

export const logger = new Logger("AegisLogger", "#f26c6c");

export const cacheSentMessages = new LimitedMap<string, LoggedMessageJSON>();

const cacheThing = findByPropsLazy("commit", "getOrCreate");

let oldGetMessage: typeof MessageStore.getMessage;

const handledMessageIds = new Set();
async function messageDeleteHandler(payload: MessageDeletePayload & { isBulk: boolean; }) {
    if (payload.mlDeleted) return;

    if (handledMessageIds.has(payload.id)) {
        return;
    }

    try {
        handledMessageIds.add(payload.id);

        let message: LoggedMessage | LoggedMessageJSON | null =
            oldGetMessage?.(payload.channelId, payload.id);
        if (message == null) {
            const cachedMessage = cacheSentMessages.get(`${payload.channelId},${payload.id}`);
            if (!cachedMessage) return;

            message = { ...cacheSentMessages.get(`${payload.channelId},${payload.id}`), deleted: true } as LoggedMessageJSON;
        }

        const ghostPinged = isGhostPinged(message as any);

        if (
            shouldIgnore({
                channelId: message?.channel_id ?? payload.channelId,
                guildId: payload.guildId ?? (message as any).guildId ?? (message as any).guild_id,
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
        if (payload.isBulk)
            return message;

        await addMessage(message, ghostPinged ? DBMessageStatus.GHOST_PINGED : DBMessageStatus.DELETED);
    }
    finally {
        handledMessageIds.delete(payload.id);
    }
}

async function messageDeleteBulkHandler({ channelId, guildId, ids }: MessageDeleteBulkPayload) {
    const messages = [] as LoggedMessageJSON[];
    for (const id of ids) {
        const msg = await messageDeleteHandler({ type: "MESSAGE_DELETE", channelId, guildId, id, isBulk: true });
        if (msg) messages.push(msg as LoggedMessageJSON);
    }

    await idb.addMessagesBulkIDB(messages);
}

async function messageUpdateHandler(payload: MessageUpdatePayload) {
    const cachedMessage = cacheSentMessages.get(`${payload.message.channel_id},${payload.message.id}`);
    if (
        shouldIgnore({
            channelId: payload.message?.channel_id,
            guildId: payload.guildId ?? (payload as any).guild_id,
            authorId: payload.message?.author?.id,
            bot: (payload.message?.author as any)?.bot,
            flags: payload.message?.flags,
            ghostPinged: isGhostPinged(payload.message as any),
            content: payload.message?.content ?? undefined
        })
    ) {
        const cache = cacheThing.getOrCreate(payload.message.channel_id);
        const message = cache.get(payload.message.id);
        if (message) {
            message.editHistory = [];
            cacheThing.commit(cache);
        }
        return;
    }

    const previousRecord = await idb.getMessageIDB(payload.message.id);
    const previous = previousRecord?.message ?? cachedMessage ?? null;

    let message = oldGetMessage?.(payload.message.channel_id, payload.message.id) as LoggedMessage | LoggedMessageJSON | null;

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
                        timestamp: (new Date()).toISOString()
                    }
                ]
            };

            cacheSentMessages.set(`${payload.message.channel_id},${payload.message.id}`, message);
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

        const merged = mergeRemovedAttachments(previous.attachments, base, payload.message);

        if (merged != null) {
            base.attachments = merged.attachments;
            base.editHistory = merged.editHistory;
            message = base;
            hasEdits = true;
        }
    }

    if (message == null || message.channel_id == null || !hasEdits) return;

    await addMessage(message, DBMessageStatus.EDITED);
}

function messageCreateHandler(payload: MessageCreatePayload) {
    const whitelistedIds = getIdList("whitelistedIds");
    if (whitelistedIds.length > 0 && payload.guildId != null) {
        const ids = [payload.channelId, payload.message?.author?.id, payload.guildId];
        if (!whitelistedIds.some(e => ids.includes(e))) return;
    }

    if (contentExcluded(payload.message?.content, payload.guildId, payload.message?.channel_id ?? payload.channelId, payload.message?.author?.id)) return;

    cacheSentMessages.set(`${payload.message.channel_id},${payload.message.id}`, cleanUpCachedMessage(payload.message));
}

async function processMessageFetch(response: FetchMessagesResponse) {
    try {
        if (!response.ok || response.body.length === 0) {
            logger.error("Failed to fetch messages", response);
            return;
        }

        const firstMessage = response.body[response.body.length - 1];
        const messages = await idb.getMessagesByChannelAndAfterTimestampIDB(firstMessage.channel_id, firstMessage.timestamp);

        if (!messages.length) return;

        const deletedMessages = messages.filter(m =>
            m.status === DBMessageStatus.DELETED ||
            m.status === DBMessageStatus.GHOST_PINGED
        );

        for (const recivedMessage of response.body) {
            const record = messages.find(m => m.message_id === recivedMessage.id);

            if (record == null) continue;

            if (record.message.editHistory && record.message.editHistory.length > 0) {
                recivedMessage.editHistory = record.message.editHistory;

                if (record.message.attachments?.length) {
                    recivedMessage.attachments = record.message.attachments;
                }
            }
        }

        const fetchUser = (id: string) => UserStore.getUser(id) || response.body.find(e => e.author.id === id);

        for (let i = 0, len = messages.length; i < len; i++) {
            const record = messages[i];
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
    }
}

const REMOVED_LABEL_STYLE_ID = "aegis-removed-label-style";

function applyRemovedLabelStyle() {
    let style = document.getElementById(REMOVED_LABEL_STYLE_ID) as HTMLStyleElement | null;

    if (style == null) {
        style = document.createElement("style");
        style.id = REMOVED_LABEL_STYLE_ID;
        document.head.appendChild(style);
    }

    style.textContent = `:root { --aegis-removed-label: ${removedAttachmentLabelCss()}; }`;
}

function removeRemovedLabelStyle() {
    document.getElementById(REMOVED_LABEL_STYLE_ID)?.remove();
}

export default definePlugin({
    name: "AegisLogger",
    authors: [{ name: "jstks_24", id: 1015591734694129836n }],
    get description() { return t("settings.description"); },
    dependencies: ["MessageLogger"],

    patches: [
        {
            find: "_tryFetchMessagesCached",
            replacement: [
                {
                    match: /(?<=\.get\({url.+?then\()(\i)=>\(/,
                    replace: "async $1=>(await $self.processMessageFetch($1),"
                },
                {
                    match: /(?<=type:"LOAD_MESSAGES_SUCCESS",.{1,100})messages:(\i)/,
                    replace: "get messages() {return $self.coolReAddDeletedMessages($1, this);}"
                }

            ]
        },
        {
            find: ".PREMIUM_REFERRAL&&(",
            replacement: {
                match: / deleted:\i\.deleted, editHistory:\i\.editHistory,/,
                replace: "deleted:$self.getDeleted(...arguments), editHistory:$self.getEdited(...arguments),"
            }
        },
        {
            find: /toolbar:\i,mobileToolbar:\i/,
            predicate: () => settings.store.ShowLogsButton,
            replacement: {
                match: /(function \i\(\i\){)(.{1,200}toolbar.{1,100}mobileToolbar)/,
                replace: "$1$self.addIconToToolBar(arguments[0]);$2"
            }
        },

        {
            find: ".handleImageLoad)",
            replacement: {
                match: /(componentDidMount\(\){)(.{1,150}===(.+?)\.LOADING)/,
                replace:
                    "$1if(this.props?.src?.startsWith('blob:') && this.props?.item?.type === 'VIDEO')" +
                    "return this.setState({readyState: $3.READY});$2"
            }
        },

        {
            find: "Using PollReferenceMessageContext without",
            replacement: {
                match: /(?:\i\.)?\i\.(?:default\.)?focusMessage\(/,
                replace: "!(arguments[0]?.message?.deleted || arguments[0]?.message?.editHistory?.length > 0) && $&"
            }
        },

        {
            find: /\i\.attachments\.some\(\i\)\|\|\i\.embeds\.some/,
            replacement: {
                match: /\i\.attachments\.some\(\i\)\|\|\i\.embeds\.some/,
                replace: "!arguments[0].deleted && $&"
            }
        }
    ],
    settings,

    toolboxActions: {
        get [t("toolbox.messageLogger")]() {
            return logsModal.openLogModal();
        }
    },

    addIconToToolBar(e: { toolbar: React.ReactNode[] | React.ReactNode; }) {
        if (Array.isArray(e.toolbar))
            return e.toolbar.unshift(
                <ErrorBoundary noop={true}>
                    <OpenLogsButton />
                </ErrorBoundary>
            );

        e.toolbar = [
            <ErrorBoundary noop={true} key="aegis-button">
                <OpenLogsButton />
            </ErrorBoundary>,
            e.toolbar,
        ];
    },

    processMessageFetch,
    openLogModal: logsModal.openLogModal,
    doesMatch,
    reAddDeletedMessages,
    LoggedMessageManager,
    ImageManager,
    imageUtils,
    idb,

    coolReAddDeletedMessages: (messages: LoggedMessageJSON[] & { extra: LoggedMessageJSON[]; }, payload: LoadMessagePayload) => {
        try {
            if (messages.extra)
                reAddDeletedMessages(messages, messages.extra, !payload.hasMoreAfter && !payload.isBefore, !payload.hasMoreBefore && !payload.isAfter);
        }
        catch (e) {
            logger.error("Failed to re-add deleted messages", e);
        }
        finally {
            return messages;
        }
    },

    isDeletedMessage: (id: string) => cacheSentMessages.get(id)?.deleted ?? false,

    getDeleted(m1, m2) {
        const deleted = m2?.deleted;
        if (deleted == null && m1?.deleted != null) return m1.deleted;
        return deleted;
    },

    getEdited(m1, m2) {
        const editHistory = m2?.editHistory;
        if (editHistory == null && m1?.editHistory != null && m1.editHistory.length > 0)
            return m1.editHistory.map(mapTimestamp);
        return editHistory;
    },

    flux: {
        "MESSAGE_DELETE": messageDeleteHandler as any,
        "MESSAGE_DELETE_BULK": messageDeleteBulkHandler,
        "MESSAGE_UPDATE": messageUpdateHandler,
        "MESSAGE_CREATE": messageCreateHandler
    },

    async start() {
        applyLegacyPluginSettings();

        applyRemovedLabelStyle();

        this.oldGetMessage = oldGetMessage = MessageStore.getMessage;

        MessageStore.getMessage = (channelId: string, messageId: string) => {
            const cached = idb.cachedMessages.get(messageId);
            if (!cached)
                return this.oldGetMessage(channelId, messageId);

            if (cached.deleted)
                return messageJsonToMessageClass({ message: cached });

            const latestMessage = this.oldGetMessage(channelId, messageId);
            return messageJsonToMessageClass({
                message: {
                    ...cached,
                    ...(latestMessage ?? {}),
                }
            });
        };

        Native.init();

        const { imageCacheDir, logsDir } = await Native.getSettings();
        settings.store.imageCacheDir = imageCacheDir;
        settings.store.logsDir = logsDir;

        setupContextMenuPatches();
    },

    stop() {
        removeContextMenuBindings();
        MessageStore.getMessage = this.oldGetMessage;
        removeRemovedLabelStyle();
    }
});

