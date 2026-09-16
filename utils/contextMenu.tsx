/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addContextMenuPatch, NavContextMenuPatchCallback, removeContextMenuPatch } from "@api/ContextMenu";
import { updateMessage } from "@api/MessageUpdater";
import { findStoreLazy } from "@webpack";
import { FluxDispatcher, Menu, MessageActions, React, Toasts, UserStore } from "@webpack/common";

import { openLogModal } from "../components/LogsModal";
import { deleteMessageIDB } from "../db";
import { settings } from "../index";
import { addToXAndRemoveFromOpposite, getListMenuState, getIdList, ListType, removeFromX } from ".";
import { t } from "./i18n";

const SortedGuildStore = findStoreLazy("SortedGuildStore");

const idFunctions = {
    Folder: props =>
        props?.folderId &&
        SortedGuildStore?.getGuildFolders?.().find(f => f?.folderId === props.folderId)?.guildIds,
    Server: props => props?.guild?.id,
    User: props => props?.message?.author?.id || props?.user?.id,
    Channel: props => props.message?.channel_id || props.channel?.id
} as Record<string, (props: any) => string | string[] | null | undefined>;

type idKeys = keyof typeof idFunctions;

function renderListOption(listType: ListType, IdType: idKeys, props: any) {
    const rawId = idFunctions[IdType](props);
    if (!rawId) return null;

    const ids = Array.isArray(rawId) ? rawId : [rawId];
    const state = getListMenuState(listType, ids);
    const list = listType === "blacklistedIds" ? t("menu.blacklist") : t("menu.whitelist");
    const type = t("idType." + IdType.toLowerCase());

    const label = state === "remove"
        ? t("menu.removeFrom", { type, list })
        : state === "move"
            ? t("menu.moveTo", { type, list })
            : t("menu.addTo", { type, list });

    return (
        <Menu.MenuItem
            id={`${listType}-${IdType}-${ids[0]}`}
            label={label}
            action={state === "remove"
                ? () => ids.forEach(id => removeFromX(listType, id))
                : () => ids.forEach(id => addToXAndRemoveFromOpposite(listType, id))}
        />
    );
}

function renderOpenLogs(idType: idKeys, props: any) {
    const id = idFunctions[idType](props);
    if (!id || Array.isArray(id)) return null;

    return (
        <Menu.MenuItem
            id={`open-logs-for-${idType.toLowerCase()}`}
            label={t("menu.openLogsFor", { type: t("idType." + idType.toLowerCase()) })}
            action={() => openLogModal(`${idType.toLowerCase()}:${id}`)}
        />
    );
}

const removeMessageAction = async (props: any) => {
    try {
        await deleteMessageIDB(props.message.id);
        if (props.message.deleted) {
            FluxDispatcher.dispatch({
                type: "MESSAGE_DELETE",
                channelId: props.message.channel_id,
                id: props.message.id,
                mlDeleted: true
            });
        } else {
            updateMessage(props.message.channel_id, props.message.id, { editHistory: [] });
        }
    } catch (e) {
        console.error("Failed to remove message", e);
        Toasts.show({
            type: Toasts.Type.FAILURE,
            message: t("menu.removeFailed"),
            id: Toasts.genId()
        });
    }
};

export const contextMenuPath: NavContextMenuPatchCallback = (children, props) => {
    if (!props) return;

    if (!children.some(child => child?.props?.id === "aegis-logger")) {
        if (settings.store.permanentlyRemoveLogByDefault) {
            const mlRemoveHistory = children.find(c => c?.props?.id === "ml-remove-history");
            if (mlRemoveHistory) {
                mlRemoveHistory.props.action = () => removeMessageAction(props);
            }
        }

        children.push(
            <Menu.MenuSeparator />,
            <Menu.MenuItem
                id="aegis-logger"
                label={t("menu.label")}
            >

                <Menu.MenuItem
                    id="open-logs"
                    label={t("menu.openLogs")}
                    action={() => openLogModal()}
                />

                {Object.keys(idFunctions).map(IdType => renderOpenLogs(IdType as idKeys, props))}

                <Menu.MenuSeparator />

                {Object.keys(idFunctions).map(IdType => (
                    <React.Fragment key={IdType}>
                        {renderListOption("blacklistedIds", IdType as idKeys, props)}
                        {renderListOption("whitelistedIds", IdType as idKeys, props)}
                    </React.Fragment>
                ))}

                {
                    props.navId === "message"
                    && (props.message?.deleted || props.message?.editHistory?.length > 0)
                    && (
                        <>
                            <Menu.MenuSeparator />
                            <Menu.MenuItem
                                id="remove-message"
                                label={props.message?.deleted ? t("menu.removeMessagePermanent") : t("menu.removeHistoryPermanent")}
                                color="danger"
                                action={() => removeMessageAction(props)}
                            />
                        </>
                    )
                }

                {
                    settings.store.hideMessageFromMessageLoggers
                    && props.navId === "message"
                    && props.message?.author?.id === UserStore.getCurrentUser().id
                    && props.message?.deleted === false
                    && (
                        <>
                            <Menu.MenuSeparator />
                            <Menu.MenuItem
                                id="hide-from-message-loggers"
                                label={t("menu.hideDelete")}
                                color="danger"

                                action={async () => {
                                    await MessageActions.deleteMessage(props.message.channel_id, props.message.id);
                                    MessageActions._sendMessage(props.message.channel_id, {
                                        "content": settings.store.hideMessageFromMessageLoggersDeletedMessage,
                                        "tts": false,
                                        "invalidEmojis": [],
                                        "validNonShortcutEmojis": []
                                    }, { nonce: props.message.id });
                                }}
                            />
                        </>
                    )
                }

            </Menu.MenuItem>
        );
    }
};

export const setupContextMenuPatches = () => {
    addContextMenuPatch("message", contextMenuPath);
    addContextMenuPatch("channel-context", contextMenuPath);
    addContextMenuPatch("user-context", contextMenuPath);
    addContextMenuPatch("guild-context", contextMenuPath);
    addContextMenuPatch("gdm-context", contextMenuPath);
};

export const removeContextMenuBindings = () => {
    removeContextMenuPatch("message", contextMenuPath);
    removeContextMenuPatch("channel-context", contextMenuPath);
    removeContextMenuPatch("user-context", contextMenuPath);
    removeContextMenuPatch("guild-context", contextMenuPath);
    removeContextMenuPatch("gdm-context", contextMenuPath);
};
