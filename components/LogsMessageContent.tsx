/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LazyComponent } from "@utils/react";
import type { Channel } from "@vencord/discord-types";
import { React, useEffect, useState } from "@webpack/common";

import type { LoggedAttachment, LoggedMessage, LoggedMessageJSON } from "../types";
import { isImageAttachment, messageJsonToMessageClass, splitRemovedAttachments } from "../utils";
import { t } from "../utils/i18n";
import logMessageModules from "../utils/logMessageModules";
import { acquireAttachmentBlobUrl, acquireAttachmentLease, type attachmentLease, displayAttachmentUrl } from "../utils/saveImage";

interface contentProps {
    record: LoggedMessageJSON;
    message: LoggedMessage | null;
    modules: ReturnType<typeof logMessageModules.getSnapshot>;
    channel: Channel | null | undefined;
    isGroupStart: boolean;
}

interface boundaryProps {
    children: React.ReactNode;
    fallback: React.ReactNode;
    record: LoggedMessageJSON;
}

const MessageBoundary = LazyComponent(() => class extends React.Component<boundaryProps, { failed: boolean }> {
    state = { failed: false };

    static getDerivedStateFromError() {
        return { failed: true };
    }

    componentDidUpdate(previous: boundaryProps) {
        if (this.state.failed && previous.record !== this.props.record) this.setState({ failed: false });
    }

    render() {
        return this.state.failed ? this.props.fallback : this.props.children;
    }
});

function prepareMessage(record: LoggedMessageJSON): { message: LoggedMessage | null; removedAttachments: LoggedAttachment[] } {
    const attachments = Array.isArray(record.attachments) ? record.attachments.filter(Boolean) : [];
    const { live, removed } = splitRemovedAttachments(attachments);

    try {
        const source = {
            ...record,
            attachments: live,
            editHistory: Array.isArray(record.editHistory) ? record.editHistory.map(edit => ({ ...edit })) : []
        };
        return { message: messageJsonToMessageClass({ message: source }), removedAttachments: removed };
    } catch {
        return { message: null, removedAttachments: removed };
    }
}

function NativePreview({ record, message, modules, channel, isGroupStart }: contentProps) {
    const MessagePreview = modules.messagePreview;
    if (MessagePreview == null || message == null) return <MessageSnapshot record={record} />;

    const PrivateChannelRecord = modules.privateChannelRecord;
    const previewChannel = channel ?? (PrivateChannelRecord != null ? new PrivateChannelRecord({ id: record.channel_id }) : null);
    if (previewChannel == null) return <MessageSnapshot record={record} includeRemoved={false} />;

    return (
        <MessagePreview
            className={`aegis-modal-msg-preview ${message.deleted ? "messagelogger-deleted" : ""}`}
            author={message.author}
            message={message}
            channel={previewChannel}
            compact={false}
            isGroupStart={isGroupStart}
            hideSimpleEmbedContent={false}
        />
    );
}

function MessageContent(props: contentProps) {
    if (props.message == null || props.modules.messagePreview == null) return <MessageSnapshot record={props.record} />;

    return (
        <MessageBoundary
            key={props.modules.version}
            record={props.record}
            fallback={<MessageSnapshot record={props.record} includeRemoved={false} />}
        >
            <NativePreview {...props} />
        </MessageBoundary>
    );
}

function safeUrl(value: unknown) {
    return typeof value === "string" && /^(?:https?:|blob:|data:)/i.test(value) ? value : undefined;
}

function SnapshotAttachment({ attachment }: { attachment: LoggedAttachment }) {
    const [preview, setPreview] = useState({ url: safeUrl(attachment.url), failed: false });

    useEffect(() => {
        let cancelled = false;
        let lease: attachmentLease | null = acquireAttachmentLease(attachment.url ?? "");
        setPreview({ url: safeUrl(attachment.url), failed: false });

        if (lease == null && attachment.path != null) {
            acquireAttachmentBlobUrl(attachment).then(acquired => {
                if (cancelled) {
                    acquired?.release();
                    return;
                }
                lease = acquired;
                if (acquired != null) setPreview({ url: displayAttachmentUrl(acquired.url), failed: false });
            }).catch(() => { });
        }

        return () => {
            cancelled = true;
            lease?.release();
        };
    }, [attachment.id, attachment.url, attachment.path, attachment.fileExtension]);

    const filename = attachment.filename ?? attachment.id;
    const unavailable = preview.failed || preview.url == null;
    const image = isImageAttachment(attachment);
    const failed = () => setPreview(previous => ({ ...previous, failed: true }));
    const video = attachment.content_type?.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(filename ?? "");
    const audio = attachment.content_type?.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)$/i.test(filename ?? "");

    return (
        <div className="aegis-modal-snapshot-attachment">
            {attachment.deleted && <span className="aegis-modal-removed-label">{t("modal.attachmentRemoved")}</span>}
            {!unavailable && image && <img src={preview.url} alt={filename} onError={failed} />}
            {!unavailable && video && <video src={preview.url} controls preload="metadata" onError={failed} />}
            {!unavailable && audio && <audio src={preview.url} controls preload="metadata" onError={failed} />}
            <span>{filename}{(unavailable || (!image && !video && !audio)) && <> · {t("modal.snapshot.attachmentUnavailable")}</>}</span>
        </div>
    );
}

function SnapshotBody({ content, attachments, embeds, showEmpty = true }: { content: unknown; attachments: LoggedAttachment[]; embeds?: unknown[]; showEmpty?: boolean }) {
    const body = typeof content === "string" ? content : "";
    const summaries = (embeds ?? []).filter(embed => embed != null && typeof embed === "object").map(embed => {
        const value = embed as { title?: string; description?: string; url?: string; image?: { url?: string }; thumbnail?: { url?: string }; fields?: { name?: string; value?: string }[] };
        return [value.title, value.description, value.url, value.image?.url, value.thumbnail?.url, ...(Array.isArray(value.fields) ? value.fields.flatMap(field => [field?.name, field?.value]) : [])]
            .filter(value => typeof value === "string" && value !== "").join("\n") || t("modal.snapshot.embed");
    }).filter(Boolean);

    return (
        <>
            {body !== "" && <div className="aegis-modal-snapshot-text">{body}</div>}
            {summaries.map((summary, index) => <div className="aegis-modal-snapshot-embed" key={index}>{summary}</div>)}
            {attachments.length > 0 && <div className="aegis-modal-snapshot-attachments">
                {attachments.map((attachment, index) => <SnapshotAttachment key={`${attachment.id}:${index}`} attachment={attachment} />)}
            </div>}
            {showEmpty && body === "" && summaries.length === 0 && attachments.length === 0 && <div className="aegis-modal-snapshot-empty">{t("modal.snapshot.empty")}</div>}
        </>
    );
}

function MessageSnapshot({ record, includeRemoved = true }: { record: LoggedMessageJSON; includeRemoved?: boolean }) {
    const allAttachments = Array.isArray(record.attachments) ? record.attachments.filter(Boolean) : [];
    const attachments = includeRemoved ? allAttachments : allAttachments.filter(attachment => !attachment.deleted);
    const history = Array.isArray(record.editHistory) ? record.editHistory.filter(Boolean) : [];

    return (
        <div className="aegis-modal-snapshot" data-message-id={record.id}>
            <SnapshotBody content={record.content} attachments={attachments} embeds={Array.isArray(record.embeds) ? record.embeds : []} showEmpty={includeRemoved || allAttachments.length === 0} />
            {history.length > 0 && <details className="aegis-modal-snapshot-history">
                <summary>{t("modal.snapshot.history", { count: history.length })}</summary>
                {history.map((edit, index) => <div className="aegis-modal-snapshot-edit" key={index}>
                    <time>{edit.timestamp}</time>
                    <SnapshotBody
                        content={edit.content}
                        attachments={Array.isArray(edit.attachments) ? edit.attachments.filter(Boolean).map(attachment => ({
                            ...attachment,
                            url: allAttachments.find(current => current.id === attachment.id)?.url ?? attachment.url
                        })) : []}
                    />
                </div>)}
            </details>}
        </div>
    );
}

const logMessageContent = {
    MessageContent,
    MessageSnapshot,
    prepareMessage
};

export default logMessageContent;
