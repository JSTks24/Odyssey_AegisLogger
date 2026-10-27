/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import ErrorBoundary from "@components/ErrorBoundary";
import { openModal } from "@utils/modal";
import { ChannelStore, MessageStore, Modal, React, useStateFromStores } from "@webpack/common";

import { settings } from "..";
import type { LoggedMessage } from "../types";
import { cleanUpCachedMessage, shouldIgnoreMessage } from "../utils";
import { t } from "../utils/i18n";
import content from "./LogsMessageContent";

function InlineHistory({ message, original }: any) {
    const current = useStateFromStores([MessageStore], () => MessageStore.getMessage(message.channel_id, message.id)) as LoggedMessage | undefined;
    const { inlineEdits } = settings.use(["inlineEdits"]);
    if (!current?.editHistory?.some(edit => edit.embeds != null)) return React.createElement(original, { message });
    if (!inlineEdits || shouldIgnoreMessage(current, undefined, true)) return null;
    return <ErrorBoundary noop>
        <content.MessageHistory record={cleanUpCachedMessage(current)} channel={ChannelStore.getChannel(message.channel_id)} />
    </ErrorBoundary>;
}

function EditMarker({ message, original, className, children, ...props }: any) {
    const current = (MessageStore.getMessage(message.channel_id, message.id) ?? message) as LoggedMessage;
    if (!current.editHistory?.some(edit => edit.embeds != null)) return React.createElement(original, { ...props, message, className }, children);
    return <span {...props} className={`messagelogger-edit-marker ${className ?? ""}`} role="button" onClick={() => {
        const latest = MessageStore.getMessage(message.channel_id, message.id) ?? current;
        if (shouldIgnoreMessage(latest, undefined, true)) return;
        const record = cleanUpCachedMessage(latest);
        openModal(modalProps => <ErrorBoundary>
            <Modal {...modalProps} size="lg" title={t("modal.tab.edited")}>
                <content.MessageHistory record={record} channel={ChannelStore.getChannel(message.channel_id)} />
                <content.MessageSnapshot record={{ ...record, editHistory: [] }} />
            </Modal>
        </ErrorBoundary>);
    }}>{children}</span>;
}

const chatHistory = { InlineHistory, EditMarker };

export default chatHistory;
