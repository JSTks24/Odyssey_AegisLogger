/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LazyComponent } from "@utils/react";
import type { Channel } from "@vencord/discord-types";
import { Parser, React, SelectedChannelStore, Timestamp, useEffect, useState } from "@webpack/common";

import type { LoggedAttachment, LoggedEdit, LoggedMessage, LoggedMessageJSON } from "../types";
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
    attachmentsPending?: boolean;
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

function prepareMessage(record: LoggedMessageJSON, attachmentsPending = false): { message: LoggedMessage | null; removedAttachments: LoggedAttachment[] } {
    const attachments = Array.isArray(record.attachments) ? record.attachments.filter(Boolean) : [];
    const { live, removed } = splitRemovedAttachments(attachments);

    try {
        const source = {
            ...record,
            attachments: attachmentsPending ? [] : live,
            editHistory: []
        };
        return { message: messageJsonToMessageClass({ message: source }), removedAttachments: attachmentsPending ? [] : removed };
    } catch {
        return { message: null, removedAttachments: removed };
    }
}

function NativePreview({ record, message, modules, channel, isGroupStart, attachmentsPending }: contentProps) {
    const MessagePreview = modules.messagePreview;
    if (MessagePreview == null || message == null) return <MessageSnapshot record={record} showHistory={false} attachmentsPending={attachmentsPending} />;

    const PrivateChannelRecord = modules.privateChannelRecord;
    const previewChannel = channel ?? (PrivateChannelRecord != null ? new PrivateChannelRecord({ id: record.channel_id }) : null);
    if (previewChannel == null) return <MessageSnapshot record={record} showHistory={false} includeRemoved={!!attachmentsPending} attachmentsPending={attachmentsPending} />;

    return (
        <>
            <MessagePreview
            className={`aegis-modal-msg-preview ${message.deleted ? "messagelogger-deleted" : ""}`}
            author={message.author}
            message={message}
            channel={previewChannel}
            compact={false}
            isGroupStart={isGroupStart}
            hideSimpleEmbedContent={false}
            />
            {attachmentsPending && record.attachments?.map(attachment => <AttachmentPlaceholder key={attachment.id} attachment={attachment} />)}
        </>
    );
}

function MessageContent(props: contentProps) {
    return (
        <>
            <MessageBoundary
                key={props.modules.version}
                record={props.record}
                fallback={<MessageSnapshot record={props.record} showHistory={false} includeRemoved={!!props.attachmentsPending} attachmentsPending={props.attachmentsPending} />}
            >
                <NativePreview {...props} />
            </MessageBoundary>
            <MessageHistory record={props.record} attachmentsPending={props.attachmentsPending} version={props.modules.version} />
        </>
    );
}

function safeUrl(value: unknown) {
    return typeof value === "string" && /^(?:https?:|blob:|data:)/i.test(value) ? value : undefined;
}

function AttachmentPlaceholder({ attachment }: { attachment: LoggedAttachment }) {
    const width = Math.min(attachment.width || 280, 400);
    const height = attachment.width && attachment.height ? Math.min(width * attachment.height / attachment.width, 300) : 80;
    return <div className="aegis-modal-attachment-placeholder" style={{ width, height }} aria-busy="true">
        <span>{typeof attachment.filename === "string" ? attachment.filename : attachment.id}</span>
    </div>;
}

function SnapshotAttachment({ attachment, pending = false }: { attachment: LoggedAttachment; pending?: boolean }) {
    const [preview, setPreview] = useState({ url: safeUrl(attachment.url), failed: false });

    useEffect(() => {
        if (pending) return;
        let cancelled = false;
        let lease: attachmentLease | null = acquireAttachmentLease(typeof attachment.url === "string" ? attachment.url : "");
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
    }, [attachment.id, attachment.url, attachment.path, attachment.fileExtension, pending]);

    if (pending) return <AttachmentPlaceholder attachment={attachment} />;

    const filename = typeof attachment.filename === "string" ? attachment.filename : attachment.id;
    const unavailable = preview.failed || preview.url == null;
    const image = isImageAttachment(attachment);
    const failed = () => setPreview(previous => ({ ...previous, failed: true }));
    const contentType = typeof attachment.content_type === "string" ? attachment.content_type : "";
    const video = contentType.startsWith("video/") || /\.(mp4|webm|mov|mkv)$/i.test(filename ?? "");
    const audio = contentType.startsWith("audio/") || /\.(mp3|wav|ogg|flac|m4a)$/i.test(filename ?? "");

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

function SnapshotBody({ content, attachments, embeds, showEmpty = true, attachmentsPending = false }: { content: unknown; attachments: LoggedAttachment[]; embeds?: unknown[]; showEmpty?: boolean; attachmentsPending?: boolean }) {
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
                {attachments.map((attachment, index) => <SnapshotAttachment key={`${attachment.id}:${index}:${attachment.url}:${attachmentsPending}`} attachment={attachment} pending={attachmentsPending} />)}
            </div>}
            {showEmpty && body === "" && summaries.length === 0 && attachments.length === 0 && <div className="aegis-modal-snapshot-empty">{t("modal.snapshot.empty")}</div>}
        </>
    );
}

function MessageSnapshot({ record, includeRemoved = true, attachmentsPending = false, showHistory = true }: { record: LoggedMessageJSON; includeRemoved?: boolean; attachmentsPending?: boolean; showHistory?: boolean }) {
    const allAttachments = Array.isArray(record.attachments) ? record.attachments.filter(Boolean) : [];
    const attachments = includeRemoved ? allAttachments : allAttachments.filter(attachment => !attachment.deleted);

    return (
        <div className="aegis-modal-snapshot" data-message-id={record.id}>
            <SnapshotBody content={record.content} attachments={attachments} embeds={Array.isArray(record.embeds) ? record.embeds : []} showEmpty={includeRemoved || allAttachments.length === 0} attachmentsPending={attachmentsPending} />
            {showHistory && <MessageHistory record={record} attachmentsPending={attachmentsPending} />}
        </div>
    );
}

function EditContent({ record, edit }: { record: LoggedMessageJSON; edit: LoggedEdit }) {
    const body = typeof edit.content === "string" ? edit.content : "";
    const parsed = Parser.parse(body, true, {
        channelId: record.channel_id,
        messageId: record.id,
        allowLinks: true,
        allowHeading: true,
        allowList: true,
        allowEmojiLinks: true,
        viewingChannelId: SelectedChannelStore.getChannelId()
    });
    const timestamp = new Date(edit.timestamp);
    const marker = <span className="aegis-modal-edit-marker"> ({t("modal.tab.edited")})</span>;

    return <>{parsed}{isNaN(timestamp.getTime()) ? marker : <Timestamp timestamp={timestamp} isEdited={true} isInline={false}>{marker}</Timestamp>}</>;
}

function MessageHistory({ record, attachmentsPending = false, version = 0 }: { record: LoggedMessageJSON; attachmentsPending?: boolean; version?: number }) {
    const history = Array.isArray(record.editHistory) ? record.editHistory.filter(edit => edit != null && typeof edit === "object") : [];
    if (history.length === 0) return null;
    const allAttachments = Array.isArray(record.attachments) ? record.attachments.filter(Boolean) : [];

    return (
        <div className="aegis-modal-edit-history">
            {history.map((edit, index) => <div className="aegis-modal-edit-version" key={index}>
                <MessageBoundary
                    key={version}
                    record={record}
                    fallback={<>{typeof edit.content === "string" ? edit.content : ""}<span className="aegis-modal-edit-marker"> ({t("modal.tab.edited")})</span></>}
                >
                    <EditContent record={record} edit={edit} />
                </MessageBoundary>
                <SnapshotBody
                    content=""
                    attachments={Array.isArray(edit.attachments) ? edit.attachments.filter(Boolean).map(attachment => ({
                        ...attachment,
                        url: allAttachments.find(current => current.id === attachment.id)?.url ?? attachment.url
                    })) : []}
                    showEmpty={false}
                    attachmentsPending={attachmentsPending}
                />
            </div>)}
        </div>
    );
}

const logMessageContent = {
    MessageContent,
    MessageSnapshot,
    prepareMessage
};

export default logMessageContent;
