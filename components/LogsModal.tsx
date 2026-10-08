/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { BaseText } from "@components/BaseText";
import { Button } from "@components/Button";
import { Flex } from "@components/Flex";
import { InfoIcon } from "@components/Icons";
import { Link } from "@components/Link";
import { copyWithToast, openUserProfile } from "@utils/discord";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import { LazyComponent } from "@utils/react";
import type { RenderModalProps } from "@vencord/discord-types";
import { findByPropsLazy } from "@webpack";
import { Alerts, ChannelStore, ContextMenuApi, FluxDispatcher, GuildMemberStore, GuildStore, Menu, NavigationRouter, React, TabBar, Tooltip, useEffect, useMemo, useRef, useState } from "@webpack/common";

import idb, { DBMessageRecord } from "../db";
import { settings } from "../index";
import { LoggedAttachment, LoggedMessageJSON } from "../types";
import { getGuildIdByChannel, isImageAttachment } from "../utils";
import { t, tabDisplayName } from "../utils/i18n";
import logMessageModules from "../utils/logMessageModules";
import searchIndex from "../utils/searchIndex";
import { importLogs } from "../utils/settingsUtils";
import { ClearLogsButton } from "./ClearLogsButton";
import hooks, { type messageLoadPhase } from "./hooks";
import LogsErrorState from "./LogsErrorState";
import FilterBar from "./LogsFilterBar";
import logMessageContent from "./LogsMessageContent";

export type { MessagePreviewProps } from "../utils/logMessageModules";

const ModalUtils = findByPropsLazy("closeAllModals", "openModal");

function closeAllModals() {
    ModalUtils.closeAllModals();
}

function useLazyModules() {
    const [modules, setModules] = useState(logMessageModules.getSnapshot);

    useEffect(() => logMessageModules.subscribe(() => setModules(logMessageModules.getSnapshot())), []);

    return modules;
}

const cl = classNameFactory("aegis-modal-");

export enum LogTabs {
    DELETED = "Deleted",
    EDITED = "Edited",
    GHOST_PING = "Ghost Pinged"
}

interface Props {
    modalProps: RenderModalProps;
    initalQuery?: string;
}

function LogsModal({ modalProps, initalQuery }: Props) {
    const [currentTab, setCurrentTab] = useState(LogTabs.DELETED);
    const [queryEh, setQuery] = useState(initalQuery ?? "");
    const [sortNewest, setSortNewest] = useState(settings.store.sortNewest);
    const [numDisplayedMessages, setNumDisplayedMessages] = useState(settings.store.messagesToDisplayAtOnceInLogs);
    const contentRef = useRef<HTMLDivElement | null>(null);

    const { messages, total, hasMore, pending, phase, error, reset, retry } = hooks.useMessages(queryEh, currentTab, sortNewest, numDisplayedMessages);
    const active = modalProps.transitionState === 1;
    const initialPageSize = settings.store.messagesToDisplayAtOnceInLogs;
    const handleQueryChange = React.useCallback((value: string) => {
        setQuery(value);
        setNumDisplayedMessages(initialPageSize);
    }, [initialPageSize]);
    const addQueryToken = React.useCallback((token: string) => {
        setQuery(q => (q + " " + token).trim());
        setNumDisplayedMessages(initialPageSize);
    }, [initialPageSize]);
    const handleLoadMore = React.useCallback(
        () => setNumDisplayedMessages(e => e + settings.store.messagesToDisplayAtOnceInLogs),
        []
    );

    useEffect(() => {
        searchIndex.ensureReady(() => idb.iterateRawMessagesIDB(2000)).catch(error => console.error("[AegisLogger] search index build failed", error));
    }, []);

    return (
        <ModalRoot className={cl("root")} {...modalProps} size={ModalSize.LARGE}>
            <ModalHeader className={cl("header")}>
                <FilterBar
                    query={queryEh}
                    onChange={handleQueryChange}
                    placeholder={t("modal.placeholder")}
                    active={active}
                />
                <TabBar
                    type="top"
                    look="brand"
                    className={cl("tab-bar")}
                    selectedItem={currentTab}
                    onItemSelect={e => {
                        setCurrentTab(e);
                        setNumDisplayedMessages(settings.store.messagesToDisplayAtOnceInLogs);
                        contentRef.current?.firstElementChild?.scrollTo(0, 0);
                    }}
                >
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.DELETED}
                    >
                        {t("modal.tab.deleted")}
                    </TabBar.Item>
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.EDITED}
                    >
                        {t("modal.tab.edited")}
                    </TabBar.Item>
                    <TabBar.Item
                        className={cl("tab-bar-item")}
                        id={LogTabs.GHOST_PING}
                    >
                        {t("modal.tab.ghostPinged")}
                    </TabBar.Item>
                </TabBar>
            </ModalHeader>
            <div style={{ opacity: modalProps.transitionState === 1 ? "1" : "0" }} className={cl("content-container")} ref={contentRef}>
                {
                    modalProps.transitionState === 1 &&
                    <ModalContent
                        className={cl("content")}
                    >
                        {error != null && (
                            <LogsErrorState retry={retry} />
                        )}

                        {error == null && total === 0 && (
                            <EmptyLogs
                                hasQuery={queryEh.length !== 0}
                                reset={reset}
                            />
                        )}

                        {error == null && total !== 0 && pending && phase === "initial" && messages.length === 0 && (
                            <div className={cl("loading-state")}>
                                <div className={cl("load-dots")}>
                                    <span className={cl("load-dot")} />
                                    <span className={cl("load-dot")} />
                                    <span className={cl("load-dot")} />
                                </div>
                                <span>{t("modal.loading.initial")}</span>
                            </div>
                        )}

                        {error == null && (phase === "searching" || phase === "indexing") && (
                            <div className={cl("search-status")}>
                                {t(phase === "indexing" ? "modal.loading.indexing" : "modal.loading.searching")}
                            </div>
                        )}

                        {error == null && total !== 0 && (messages.length > 0 || !pending) && (
                            <LogsContentMemo
                                visibleMessages={messages}
                                canLoadMore={hasMore && messages.length >= settings.store.messagesToDisplayAtOnceInLogs}
                                pending={pending}
                                phase={phase}
                                tab={currentTab}
                                sortNewest={sortNewest}
                                reset={reset}
                                addQueryToken={addQueryToken}
                                handleLoadMore={handleLoadMore}
                            />
                        )}
                    </ModalContent>
                }
            </div>
            <ModalFooter className={cl("footer")}>
                <ClearLogsButton label={t("modal.clearAll")} onCleared={reset} />
                <Button
                    style={{ marginRight: "16px" }}
                    variant="dangerSecondary"
                    disabled={messages?.length === 0}
                    onClick={() => Alerts.show({
                        title: t("modal.clearLogs.title"),
                        body: t("modal.clearLogs.body", { count: messages.length }),
                        confirmText: t("common.clear"),
                        // @ts-ignore
                        confirmVariant: "critical-primary",
                        cancelText: t("common.cancel"),
                        onConfirm: async () => {
                            await idb.deleteMessagesBulkIDB(messages.map(e => e.message_id));
                            reset();
                        }
                    })}
                >
                    {t("modal.clearVisible")}
                </Button>
                <Link
                    style={{ marginRight: "1rem" }}
                    onClick={() => {
                        setSortNewest(e => {
                            const val = !e;
                            settings.store.sortNewest = val;
                            return val;
                        });
                        contentRef.current?.firstElementChild?.scrollTo(0, 0);
                    }}
                >
                    {sortNewest ? t("modal.sort.oldestFirst") : t("modal.sort.newestFirst")}
                </Link>
            </ModalFooter>
        </ModalRoot>
    );
}

interface LogContentProps {
    sortNewest: boolean;
    tab: LogTabs;
    visibleMessages: DBMessageRecord[];
    canLoadMore: boolean;
    pending: boolean;
    phase: messageLoadPhase | null;
    reset: () => void;
    addQueryToken: (token: string) => void;
    handleLoadMore: () => void;
}

function LogsContent({ visibleMessages, canLoadMore, pending, phase, sortNewest, tab, reset, addQueryToken, handleLoadMore }: LogContentProps) {
    const sentinelRef = useRef<HTMLDivElement | null>(null);
    const fetchingRef = useRef(false);

    useEffect(() => {
        if (!pending) fetchingRef.current = false;
    }, [pending, visibleMessages.length]);

    useEffect(() => {
        const el = sentinelRef.current;
        if (!el) return;

        const observer = new IntersectionObserver(entries => {
            if (entries[0].isIntersecting && canLoadMore && !fetchingRef.current) {
                fetchingRef.current = true;
                handleLoadMore();
            }
        }, { rootMargin: "240px" });

        observer.observe(el);
        return () => observer.disconnect();
    }, [canLoadMore, handleLoadMore]);

    if (visibleMessages.length === 0)
        return <NoResults tab={tab} />;

    return (
        <div className={cl("content-inner")}>
            {visibleMessages
                .map(({ message }, i) => (
                    <LMessageMemo
                        key={message.id}
                        message={message}
                        reset={reset}
                        isGroupStart={isGroupStart(message, visibleMessages[i - 1]?.message, sortNewest)}
                        addQueryToken={addQueryToken}
                    />
                ))}
            <div ref={sentinelRef} className={cl("load-sentinel")}>
                {canLoadMore && (
                    <div className={cl("load-dots", { idle: phase !== "more" })}>
                        <span className={cl("load-dot")} />
                        <span className={cl("load-dot")} />
                        <span className={cl("load-dot")} />
                        {phase === "more" && <span className={cl("load-more-text")}>{t("modal.loading.more")}</span>}
                    </div>
                )}
            </div>
        </div>
    );
}

const LogsContentMemo = LazyComponent(() => React.memo(LogsContent));
const LMessageMemo = LazyComponent<LMessageProps>(() => React.memo(LMessage));


function NoResults({ tab }: { tab: LogTabs; }) {
    const generateSuggestedTabs = (tab: LogTabs) => {
        switch (tab) {
            case LogTabs.DELETED:
                return { nextTab: LogTabs.EDITED, lastTab: LogTabs.GHOST_PING };
            case LogTabs.EDITED:
                return { nextTab: LogTabs.GHOST_PING, lastTab: LogTabs.DELETED };
            case LogTabs.GHOST_PING:
                return { nextTab: LogTabs.DELETED, lastTab: LogTabs.EDITED };
            default:
                return { nextTab: "", lastTab: "" };
        }
    };

    const { nextTab, lastTab } = generateSuggestedTabs(tab);

    return (
        <div className={cl("empty-logs", "content-inner")} style={{ textAlign: "center" }}>
            <BaseText size="lg">
                {t("modal.noResults", { tab: tabDisplayName(tab) })}
            </BaseText>
            <BaseText size="lg" style={{ marginTop: "0.2rem" }}>
                {t("modal.noResults.try", { a: tabDisplayName(nextTab), b: tabDisplayName(lastTab) })}
            </BaseText>
        </div>
    );
}

function EmptyLogs({ hasQuery, reset: forceUpdate }: { hasQuery: boolean; reset: () => void; }) {
    return (
        <div className={cl("empty-logs", "content-inner")} style={{ textAlign: "center" }}>
            <Flex flexDirection="column" style={{ position: "relative" }}>

                <BaseText size="lg">
                    {t("modal.empty")}
                </BaseText>

                {!hasQuery && (
                    <>
                        <Tooltip text={t("modal.empty.migrationTooltip")}>
                            {({ onMouseEnter, onMouseLeave }) => (
                                <div
                                    className={cl("info-icon")}
                                    onMouseEnter={onMouseEnter}
                                    onMouseLeave={onMouseLeave}
                                >
                                    <InfoIcon />
                                </div>
                            )}
                        </Tooltip>

                        <Button onClick={() => importLogs().then(() => forceUpdate())}>
                            {t("modal.empty.import")}
                        </Button>
                    </>
                )}
            </Flex>
        </div>
    );

}

interface LMessageProps {
    message: LoggedMessageJSON;
    isGroupStart: boolean,
    reset: () => void;
    addQueryToken: (token: string) => void;
}

function formatLogDate(value: string | Date | undefined | null) {
    if (value == null) return null;
    const date = value instanceof Date ? value : new Date(value);
    if (isNaN(date.getTime())) return null;
    return date.toLocaleString(undefined, { year: "numeric", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

function LMessage({ message: record, isGroupStart, reset, addQueryToken }: LMessageProps) {
    const modules = useLazyModules();
    const { message: converted, removedAttachments } = useMemo(
        () => logMessageContent.prepareMessage(record),
        [record, modules.version]
    );
    const message = converted ?? record;
    const author = message.author ?? { id: "", username: t("modal.snapshot.unknownAuthor") };

    const guildId = record.guildId ?? getGuildIdByChannel(message.channel_id);
    const guild = guildId != null ? GuildStore.getGuild(guildId) : null;
    const channel = ChannelStore.getChannel(message.channel_id);
    const isDM = channel?.isDM?.() ?? guildId == null;
    const member = guildId != null ? GuildMemberStore.getMember(guildId, author.id) : null;
    const authorName = member?.nick ?? (author as any).globalName ?? author.username ?? t("modal.snapshot.unknownAuthor");

    const jumpTo = (path: string) => {
        closeAllModals();
        NavigationRouter.transitionTo(path);
    };
    const jumpToGuild = () => {
        if (guild == null) return;
        closeAllModals();
        NavigationRouter.transitionToGuild(guild.id);
    };
    const openAuthorProfile = () => {
        closeAllModals();
        openUserProfile(author.id);
    };

    const sentAt = formatLogDate(message.timestamp);
    const deletedAt = formatLogDate(record.deletedTimestamp);
    const editedAt = formatLogDate(record.editHistory?.[record.editHistory.length - 1]?.timestamp);

    return (
        <div
            onContextMenu={e => {
                ContextMenuApi.openContextMenu(e, () =>
                    <Menu.Menu
                        navId="aegis-logger"
                        onClose={() => FluxDispatcher.dispatch({ type: "CONTEXT_MENU_CLOSE" })}
                        aria-label={t("modal.menu.ariaLabel")}
                    >

                        <Menu.MenuItem
                            key="jump-to-message"
                            id="jump-to-message"
                            label={t("modal.menu.jump")}
                            action={() => {
                                NavigationRouter.transitionTo(`/channels/${ChannelStore.getChannel(message.channel_id)?.guild_id ?? "@me"}/${message.channel_id}${message.id ? "/" + message.id : ""}`);
                                closeAllModals();
                            }}
                        />
                        <Menu.MenuItem
                            key="open-user-profile"
                            id="open-user-profile"
                            label={t("modal.menu.profile")}
                            action={() => {
                                closeAllModals();
                                openUserProfile(author.id);
                            }}
                        />

                        <Menu.MenuItem
                            key="only-this-user"
                            id="only-this-user"
                            label={t("modal.menu.onlyUser")}
                            action={() => addQueryToken(`user:${author.id}`)}
                        />
                        {guildId != null && (
                            <Menu.MenuItem
                                key="only-this-server"
                                id="only-this-server"
                                label={t("modal.menu.onlyServer")}
                                action={() => addQueryToken(`server:${guildId}`)}
                            />
                        )}
                        <Menu.MenuItem
                            key="exclude-this-user"
                            id="exclude-this-user"
                            label={t("modal.menu.excludeUser")}
                            action={() => addQueryToken(`!user:${author.id}`)}
                        />

                        <Menu.MenuItem
                            key="copy-content"
                            id="copy-content"
                            label={t("modal.menu.copyContent")}
                            action={() => copyWithToast(message.content, t("copy.copied"))}
                        />

                        <Menu.MenuItem
                            key="copy-user-id"
                            id="copy-user-id"
                            label={t("modal.menu.copyUserId")}
                            action={() => copyWithToast(author.id, t("copy.copied"))}
                        />

                        <Menu.MenuItem
                            key="copy-message-id"
                            id="copy-message-id"
                            label={t("modal.menu.copyMessageId")}
                            action={() => copyWithToast(message.id, t("copy.copied"))}
                        />

                        <Menu.MenuItem
                            key="copy-channel-id"
                            id="copy-channel-id"
                            label={t("modal.menu.copyChannelId")}
                            action={() => copyWithToast(message.channel_id, t("copy.copied"))}
                        />

                        {
                            record.guildId != null
                            && (
                                <Menu.MenuItem
                                    key="copy-server-id"
                                    id="copy-server-id"
                                    label={t("modal.menu.copyServerId")}
                                    action={() => copyWithToast(record.guildId!, t("copy.copied"))}
                                />
                            )
                        }

                        <Menu.MenuItem
                            key="delete-log"
                            id="delete-log"
                            label={t("modal.menu.deleteLog")}
                            color="danger"
                            action={() =>
                                idb.deleteMessageIDB(record.id).then(() => reset())
                            }
                        />

                    </Menu.Menu>
                );
            }}>
        <div>
            <div className={cl("msg-context")}>
                {isDM ? (
                    <span
                        className={cl("jump-pill")}
                        role="button"
                        onClick={() => jumpTo(`/channels/@me/${message.channel_id}`)}
                    >
                        {t("modal.dm")}
                    </span>
                ) : (
                    <>
                        {guild ? (
                            <span className={cl("jump-pill")} role="button" onClick={jumpToGuild}>
                                {guild.name}
                            </span>
                        ) : (
                            <span className={cl("msg-context-source")}>{guildId}</span>
                        )}
                        {channel ? (
                            <span
                                className={cl("jump-pill")}
                                role="button"
                                onClick={() => jumpTo(`/channels/${guildId ?? "@me"}/${message.channel_id}`)}
                            >
                                #{channel.name}
                            </span>
                        ) : (
                            <span>#{message.channel_id}</span>
                        )}
                    </>
                )}
                <span
                    className={cl("author-name")}
                    role="button"
                    onClick={openAuthorProfile}
                >
                    {authorName}
                </span>
                {sentAt && <span> · {t("modal.context.sent", { time: sentAt })}</span>}
                {deletedAt && <span> · {t("modal.context.deleted", { time: deletedAt })}</span>}
                {editedAt && <span> · {t("modal.context.edited", { time: editedAt })}</span>}
            </div>
            <logMessageContent.MessageContent
                record={record}
                message={converted}
                modules={modules}
                channel={channel}
                isGroupStart={isGroupStart}
            />
            {converted != null && modules.messagePreview != null && removedAttachments.length > 0 && (
                <div className={cl("removed-attachments")}>
                    <div className={cl("removed-label")}>{t("modal.attachmentRemoved")}</div>
                    <div className={cl("removed-row")}>
                        {removedAttachments.map(attachment => (
                            <RemovedAttachment key={attachment.id} attachment={attachment} />
                        ))}
                    </div>
                </div>
            )}
        </div>
        </div>
    );
}

function RemovedAttachment({ attachment }: { attachment: LoggedAttachment; }) {
    const [failed, setFailed] = useState(false);

    if (!isImageAttachment(attachment)) {
        return (
            <span className={cl("removed-file")}>
                {attachment.filename ?? attachment.id}
            </span>
        );
    }

    if (failed) {
        return (
            <span className={cl("removed-file")}>
                {attachment.filename ?? attachment.id}
                <span className={cl("removed-file-note")}> · {t("modal.attachmentUnavailable")}</span>
            </span>
        );
    }

    return (
        <span className={cl("removed-attachment-wrap")}>
            <img
                className={cl("removed-attachment")}
                src={attachment.url}
                alt={attachment.filename ?? ""}
                onError={() => setFailed(true)}
            />
        </span>
    );
}

const openLogModal = (initalQuery?: string) => openModal(modalProps => <LogsModal modalProps={modalProps} initalQuery={initalQuery} />);

const logsModal = {
    LogsModal,
    openLogModal,
};

export default logsModal;

function isGroupStart(
    currentMessage: LoggedMessageJSON | undefined,
    previousMessage: LoggedMessageJSON | undefined,
    sortNewest: boolean
) {
    if (!currentMessage || !previousMessage) return true;

    if (currentMessage.id === previousMessage.id) return true;

    const [newestMessage, oldestMessage] = sortNewest
        ? [previousMessage, currentMessage]
        : [currentMessage, previousMessage];

    if (newestMessage.author?.id !== oldestMessage.author?.id) return true;

    const timeDifferenceInMinutes = Math.abs(
        (new Date(newestMessage.timestamp).getTime() - new Date(oldestMessage.timestamp).getTime()) / (1000 * 60)
    );

    return timeDifferenceInMinutes >= 5;
}
