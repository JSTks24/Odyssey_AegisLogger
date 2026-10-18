/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import { ChannelStore, GuildStore } from "@webpack/common";

import { LoggedMessageJSON } from "../types";
import attachmentFiles from "./attachmentFiles";
import calendar from "./calendar";
import channelGuildId from "./channelGuildId";
import { normalizeTimestampMs } from "./constants";
import logFields from "./logFields";
import { memoize } from "./memoize";


const validIdSearchTypes = ["server", "guild", "channel", "in", "user", "from", "message", "has", "before", "after", "around", "near", "during"] as const;
type ValidIdSearchTypesUnion = typeof validIdSearchTypes[number];

export const HAS_VALUES = ["attachment", "image", "video", "file", "sound", "embed", "link"];

export interface QueryResult {
    key: ValidIdSearchTypesUnion;
    value: string;
    negate: boolean;
    raw: string;
}

function isDateType(type: ValidIdSearchTypesUnion) {
    return type === "before" || type === "after" || type === "around" || type === "near" || type === "during";
}

function isValidDateValue(value: string) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(value);
    return !Number.isNaN(date.getTime())
        && date.getUTCFullYear() === Number(value.slice(0, 4))
        && date.getUTCMonth() === Number(value.slice(5, 7)) - 1
        && date.getUTCDate() === Number(value.slice(8, 10));
}

export const parseQuery = memoize((query: string = ""): QueryResult | string => {
    let trimmedQuery = query.trim();
    if (!trimmedQuery) {
        return query;
    }

    let negate = false;
    if (trimmedQuery.startsWith("!")) {
        negate = true;
        trimmedQuery = trimmedQuery.substring(1);
    }

    const [filter] = trimmedQuery.split(/\s+/, 2);
    if (!filter) {
        return query;
    }

    const [type, id] = filter.split(":") as [ValidIdSearchTypesUnion, string];
    if (!type || !id || !validIdSearchTypes.includes(type)) {
        return query;
    }
    if (type === "has" && !HAS_VALUES.includes(id)) return query;
    if (isDateType(type) && !isValidDateValue(id)) return query;
    if (type === "message" && !/^\d+$/.test(id)) return query;

    return {
        key: type,
        value: id,
        negate,
        raw: query.trim(),
    };
});

export const tokenizeQuery = (query: string) => {
    const parts = query.split(/\s+/).filter(Boolean).map(parseQuery);
    const queries = parts.filter(p => typeof p !== "string") as QueryResult[];
    const rest = parts.filter(p => typeof p === "string") as string[];

    return { queries, rest };
};

export const removeQueryToken = (query: string, raw: string) =>
    query
        .split(/\s+/)
        .filter(token => token !== raw)
        .join(" ")
        .trim();

export const upsertQueryToken = (query: string, key: string, token: string, negate = false, multi = false) => {
    const kept = query
        .split(/\s+/)
        .filter(Boolean)
        .filter(part => {
            const parsed = parseQuery(part);
            if (typeof parsed === "string" || multi) return true;
            return parsed.key !== key || parsed.negate !== negate;
        });

    kept.push(token);
    return kept.join(" ");
};

export const linkRegex = /[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b([-a-zA-Z0-9()@:%_+.~#?&//=]*)/;

export const doesMatch = (type: typeof validIdSearchTypes[number], value: string, message: LoggedMessageJSON) => {
    if (message == null || typeof message !== "object") return false;
    const attachments = Array.isArray(message.attachments) ? message.attachments.filter(a => a != null && typeof a === "object") : [];
    const embeds = Array.isArray(message.embeds) ? message.embeds.filter(e => e != null && typeof e === "object") : [];
    const hasType = (prefix: string) => attachments.some(a => attachmentFiles.contentType(a).startsWith(prefix));

    switch (type) {
        case "in":
        case "channel":
            const channel = ChannelStore.getChannel(message.channel_id);
            if (!channel)
                return message.channel_id === value;
            const { name, id } = channel;
            return id === value
                || logFields.string(name).toLowerCase().includes(value.toLowerCase());
        case "message":
            return message.id === value;
        case "from":
        case "user":
            return message.author?.id === value
                || logFields.string(message.author?.username).toLowerCase().includes(value.toLowerCase())
                || logFields.globalName(message.author).toLowerCase().includes(value.toLowerCase());
        case "guild":
        case "server": {
            const guildId = logFields.guildId(message) || channelGuildId(message.channel_id);
            if (!guildId) return false;

            const guild = GuildStore.getGuild(guildId);
            if (!guild)
                return guildId === value;

            return guild.id === value
                || logFields.string(guild.name).toLowerCase().includes(value.toLowerCase());
        }
        case "before":
            return normalizeTimestampMs(message) < calendar.dateTimestamp(value);
        case "after":
            return normalizeTimestampMs(message) > calendar.dateTimestamp(value);
        case "around":
        case "near":
        case "during":
            return Math.abs(normalizeTimestampMs(message) - calendar.dateTimestamp(value)) < 1000 * 60 * 60 * 24;
        case "has": {
            switch (value) {
                case "attachment":
                    return attachments.length > 0;
                case "image":
                    return attachments.some(attachmentFiles.isImageAttachment) ||
                        embeds.some(e => e.image != null && typeof e.image === "object" || e.thumbnail != null && typeof e.thumbnail === "object");
                case "video":
                    return hasType("video/") || embeds.some(e => e.video != null && typeof e.video === "object");
                case "embed":
                    return embeds.length > 0;
                case "link":
                    return logFields.contents(message).some(content => linkRegex.test(content));
                case "file":
                    return attachments.some(a =>
                        !attachmentFiles.isImageAttachment(a)
                        && !attachmentFiles.contentType(a).startsWith("video/")
                        && !attachmentFiles.contentType(a).startsWith("audio/"));
                case "sound":
                    return hasType("audio/");
                default:
                    return false;
            }
        }
        default:
            return false;
    }
};
