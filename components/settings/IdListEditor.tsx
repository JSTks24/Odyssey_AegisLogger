/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { ChannelStore, GuildStore, RelationshipStore, TextInput, UserStore, useEffect, useMemo, useState } from "@webpack/common";

import { getDistinctLogEntities } from "../../db";
import { settings } from "../../settings";
import { addToXAndRemoveFromOpposite, getIdList, removeFromX, ListType } from "../../utils";
import { MatchCandidate, resolveInput } from "../../utils/idMatch";
import { t } from "../../utils/i18n";
import { resolveId } from "./resolveId";

const cl = classNameFactory("aegis-id-");

function typeLabel(type: string) {
    switch (type) {
        case "user": return t("settings.typeUser");
        case "channel": return t("settings.typeChannel");
        case "server": return t("settings.typeServer");
        default: return t("settings.unknownId");
    }
}

function IdChip({ id, onRemove }: { id: string; onRemove: () => void; }) {
    const info = resolveId(id);

    return (
        <span className={cl("chip") + (info.type === "unknown" ? " " + cl("chip-unknown") : "")}>
            {info.iconUrl
                ? <img className={cl("chip-icon")} src={info.iconUrl} alt="" />
                : <span className={cl("chip-icon") + " " + cl("chip-icon-placeholder")}>
                    {info.type === "server" ? "S" : info.type === "channel" ? "#" : "?"}
                </span>}
            <span className={cl("chip-text")}>
                <span className={cl("chip-name")}>{info.name}</span>
                <span className={cl("chip-type")}>{typeLabel(info.type)}</span>
            </span>
            <button className={cl("chip-remove")} onClick={onRemove}>×</button>
        </span>
    );
}

function useCandidatePool(ids: string[]) {
    const [pool, setPool] = useState<MatchCandidate[]>([]);

    useEffect(() => {
        const entries = new Map<string, MatchCandidate>();
        const push = (id: string, name: string | undefined, type: string) => {
            if (!id || entries.has(id)) return;
            entries.set(id, { id, name: name ?? id, typeLabel: typeLabel(type) });
        };

        for (const friendId of (RelationshipStore.getFriendIDs?.() ?? [])) {
            const user = UserStore.getUsers()[friendId];
            if (user) push(friendId, user.globalName ?? user.username, "user");
        }

        for (const dmUserId of (ChannelStore.getDMUserIds?.() ?? [])) {
            const user = UserStore.getUsers()[dmUserId];
            if (user) push(dmUserId, user.globalName ?? user.username, "user");
        }

        for (const guild of Object.values(GuildStore.getGuilds?.() ?? {}))
            push(guild.id, guild.name, "server");

        for (const channelId of (ChannelStore.getChannelIds?.() ?? [])) {
            const channel = ChannelStore.getBasicChannel(channelId);
            if (channel?.name) push(channelId, channel.name, "channel");
        }

        getDistinctLogEntities()
            .then(entities => {
                for (const author of entities.authors)
                    push(author.id, author.globalName ?? author.username, "user");
                for (const guildId of entities.guildIds)
                    push(guildId, GuildStore.getGuild?.(guildId)?.name ?? guildId, "server");
                for (const channelId of entities.channelIds)
                    push(channelId, ChannelStore.getChannel?.(channelId)?.name ?? channelId, "channel");
                setPool([...entries.values()]);
            })
            .catch(() => setPool([...entries.values()]));
    }, []);

    return useMemo(() => pool.filter(entry => !ids.includes(entry.id)), [pool, ids.join(",")]);
}

export function IdListEditor({ listKey }: { listKey: ListType; }) {
    settings.use([listKey]);
    const ids = getIdList(listKey);
    const pool = useCandidatePool(ids);
    const [manual, setManual] = useState("");

    const add = () => {
        const id = resolveInput(manual, pool);
        if (!id) return;
        addToXAndRemoveFromOpposite(listKey, id);
        setManual("");
    };

    return (
        <div>
            <div className={cl("chip-list")}>
                {ids.map(id => (
                    <IdChip key={id} id={id} onRemove={() => removeFromX(listKey, id)} />
                ))}
            </div>
            <div className={cl("manual")}>
                <TextInput
                    value={manual}
                    onChange={setManual}
                    placeholder={t("settings.idMatchPlaceholder")}
                    onKeyDown={e => {
                        if (e.key !== "Enter") return;
                        add();
                    }}
                />
            </div>
        </div>
    );
}
