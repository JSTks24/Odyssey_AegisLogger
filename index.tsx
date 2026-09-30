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
import { MessageStore, React } from "@webpack/common";

import { OpenLogsButton } from "./components/LogsButton";
import logsModal from "./components/LogsModal";
import idb from "./db";
import * as LoggedMessageManager from "./LoggedMessageManager";
import messageHandlers from "./messageHandlers";
import { settings } from "./settings";
import { LoadMessagePayload, LoggedMessageJSON } from "./types";
import { getNative, mapTimestamp, reAddDeletedMessages } from "./utils";
import chatBridge from "./utils/chatBridge";
import { removeContextMenuBindings, setupContextMenuPatches } from "./utils/contextMenu";
import { removedAttachmentLabelCss, t } from "./utils/i18n";
import { applyLegacyPluginSettings } from "./utils/legacySettings";
import { doesMatch } from "./utils/parseQuery";
import pluginRuntime from "./utils/pluginRuntime";
import * as imageUtils from "./utils/saveImage";
import * as ImageManager from "./utils/saveImage/ImageManager";
import updater from "./utils/updater";
export { settings };

export const logger = new Logger("AegisLogger", "#f26c6c");

let originalGetMessage: typeof MessageStore.getMessage | null = null;

function holdChatAttachment(instance: any) {
    chatBridge.holdAttachment(instance);
}

function releaseChatAttachment(instance: any) {
    chatBridge.releaseAttachment(instance);
}

function refreshChatAttachment(instance: any, previousProps: any) {
    chatBridge.refreshAttachment(instance, previousProps);
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
            replacement: [
                {
                    match: /(componentDidMount\(\){)(.{1,150}===(.+?)\.LOADING)/,
                    replace:
                        "$1$self.holdChatAttachment(this);" +
                        "if(this.props?.src?.startsWith('blob:') && this.props?.item?.type === 'VIDEO')" +
                        "return this.setState({readyState: $3.READY});$2"
                },
                {
                    match: /componentWillUnmount\(\){/,
                    replace: "$&$self.releaseChatAttachment(this);"
                },
                {
                    match: /componentDidUpdate\((\i)\){/,
                    replace: "$&$self.refreshChatAttachment(this,$1);"
                }
            ]
        },

        {
            find: "toURLSafe(e,t){try{return new URL(e,t)}catch(e){return null}}",
            replacement: {
                match: /toURLSafe\(e,t\)\{try\{return new URL\(e,t\)\}catch\(e\)\{return null\}\}/,
                replace: "toURLSafe(e,t){return $self.imageUtils.guardManagedBlobUrl(e)||function(){try{return new URL(e,t)}catch(e){return null}}()}"
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

    processMessageFetch: chatBridge.processMessageFetch,
    holdChatAttachment,
    releaseChatAttachment,
    refreshChatAttachment,
    chatBridge,
    openLogModal: logsModal.openLogModal,
    doesMatch,
    reAddDeletedMessages,
    LoggedMessageManager,
    messageHandlers,
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
        "MESSAGE_DELETE": messageHandlers.messageDeleteHandler as any,
        "MESSAGE_DELETE_BULK": messageHandlers.messageDeleteBulkHandler,
        "MESSAGE_UPDATE": messageHandlers.messageUpdateHandler,
        "MESSAGE_CREATE": messageHandlers.messageCreateHandler
    },

    async start() {
        pluginRuntime.start();

        applyLegacyPluginSettings();

        applyRemovedLabelStyle();

        messageHandlers.setCacheLimit(settings.store.cacheLimit);

        originalGetMessage = chatBridge.start();
        messageHandlers.setGetMessage(originalGetMessage);

        imageUtils.registerBlobUrlReleaser(url => URL.revokeObjectURL(url));

        Native.init();

        const { imageCacheDir, logsDir } = await Native.getSettings();
        settings.store.imageCacheDir = imageCacheDir;
        settings.store.logsDir = logsDir;

        setupContextMenuPatches();

        void updater.checkForUpdatesAndNotify(settings.store.autoCheckForUpdates);
    },

    stop() {
        pluginRuntime.stop();

        removeContextMenuBindings();

        chatBridge.stop();
        originalGetMessage = null;

        removeRemovedLabelStyle();
        imageUtils.clearAttachmentBlobCache();
    }
});
