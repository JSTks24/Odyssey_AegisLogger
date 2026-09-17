/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore } from "@webpack/common";

import type { DBMessageRecord } from "../db";
import { doesMatch, linkRegex, QueryResult } from "./parseQuery";

const entries = new Map<string, indexedMessage>();
const pendingAdds: indexedMessage[] = [];
const pendingRemoves: string[] = [];
let building = false;
let ready = false;

interface indexedMessage {
    id: string;
    channelId: string;
    guildId: string;
    authorId: string;
    username: string;
    globalName: string;
    timestamp: string;
    status: string;
    content: string;
    attachment: boolean;
    image: boolean;
    video: boolean;
    file: boolean;
    sound: boolean;
    embed: boolean;
    link: boolean;
}

function buildEntry(record: DBMessageRecord): indexedMessage {
    const { message } = record;
    const attachments = message.attachments ?? [];
    const embeds = message.embeds ?? [];
    const content = (message as any).content ?? "";
    const hasType = (prefix: string) => attachments.some(a => (a as any).content_type?.startsWith(prefix));

    return {
        id: record.message_id,
        channelId: record.channel_id,
        guildId: (message as any).guildId ?? ChannelStore.getChannel(record.channel_id)?.guild_id ?? "",
        authorId: (message as any).author?.id ?? "",
        username: ((message as any).author?.username ?? "").toLowerCase(),
        globalName: ((message as any).author?.globalName ?? "").toLowerCase(),
        timestamp: message.timestamp,
        status: record.status,
        content: content.toLowerCase(),
        attachment: attachments.length > 0,
        image: hasType("image") || embeds.some(e => e.image || e.thumbnail),
        video: hasType("video") || embeds.some(e => e.video),
        file: attachments.some(a => {
            const type = (a as any).content_type;
            return !type?.startsWith("image") && !type?.startsWith("video") && !type?.startsWith("audio");
        }),
        sound: hasType("audio"),
        embed: embeds.length > 0,
        link: linkRegex.test(content)
    };
}

function isReady() {
    return ready;
}

function addRecords(records: DBMessageRecord[]) {
    if (!ready && !building) return;

    for (const record of records) {
        const entry = buildEntry(record);
        if (building) pendingAdds.push(entry);
        else entries.set(entry.id, entry);
    }
}

function removeIds(ids: string[]) {
    if (!ready && !building) return;

    for (const id of ids) {
        if (building) pendingRemoves.push(id);
        else entries.delete(id);
    }
}

function clear() {
    entries.clear();
    pendingAdds.length = 0;
    pendingRemoves.length = 0;
}

async function build(source: () => AsyncGenerator<DBMessageRecord[]>) {
    if (building || ready) return;

    building = true;
    try {
        for await (const batch of source()) {
            for (const record of batch) entries.set(record.message_id, buildEntry(record));
            await new Promise(resolve => setTimeout(resolve, 0));
        }

        for (const entry of pendingAdds.splice(0)) entries.set(entry.id, entry);
        for (const id of pendingRemoves.splice(0)) entries.delete(id);

        ready = true;
    } finally {
        building = false;
        pendingAdds.length = 0;
        pendingRemoves.length = 0;
    }
}

function forEach(callback: (entry: indexedMessage) => void) {
    entries.forEach(callback);
}

function search(queries: QueryResult[], rest: string[], status: string, limit: number, newest: boolean) {
    const matches: indexedMessage[] = [];

    for (const entry of entries.values()) {
        if (entry.status !== status) continue;
        if (matchesIndex(entry, queries, rest)) matches.push(entry);
    }

    matches.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (newest) matches.reverse();

    return { page: matches.slice(0, limit), total: matches.length };
}

function matchesRecord(record: DBMessageRecord, queries: QueryResult[], rest: string[]) {
    for (const query of queries) {
        const matching = doesMatch(query.key, query.value, record.message);
        if (query.negate ? matching : !matching) return false;
    }

    return rest.every(part => ((record.message as any).content ?? "").toLowerCase().includes(part.toLowerCase()));
}

function matchesIndex(entry: indexedMessage, queries: QueryResult[], rest: string[]) {
    for (const query of queries) {
        const matching = matchesQuery(entry, query);
        if (query.negate ? matching : !matching) return false;
    }

    return rest.every(part => entry.content.includes(part.toLowerCase()));
}

function matchesQuery(entry: indexedMessage, query: QueryResult) {
    switch (query.key) {
        case "in":
        case "channel": {
            const channel = ChannelStore.getChannel(entry.channelId);
            if (!channel) return entry.channelId === query.value;
            return channel.id === query.value || (channel.name ?? "").toLowerCase().includes(query.value.toLowerCase());
        }
        case "message":
            return entry.id === query.value;
        case "from":
        case "user": {
            const value = query.value.toLowerCase();
            return entry.authorId === query.value
                || entry.username.includes(value)
                || entry.globalName.includes(value);
        }
        case "guild":
        case "server": {
            if (!entry.guildId) return false;
            const guild = GuildStore.getGuild(entry.guildId);
            if (!guild) return entry.guildId === query.value;
            return guild.id === query.value || guild.name.toLowerCase().includes(query.value.toLowerCase());
        }
        case "before":
            return new Date(entry.timestamp) < new Date(query.value);
        case "after":
            return new Date(entry.timestamp) > new Date(query.value);
        case "around":
        case "near":
        case "during":
            return Math.abs(new Date(entry.timestamp).getTime() - new Date(query.value).getTime()) < 1000 * 60 * 60 * 24;
        case "has":
            switch (query.value) {
                case "attachment": return entry.attachment;
                case "image": return entry.image;
                case "video": return entry.video;
                case "file": return entry.file;
                case "sound": return entry.sound;
                case "embed": return entry.embed;
                case "link": return entry.link;
                default: return false;
            }
        default:
            return false;
    }
}

const searchIndex = {
    buildEntry,
    isReady,
    addRecords,
    removeIds,
    clear,
    build,
    forEach,
    search,
    matchesRecord,
    matchesIndex
};

export default searchIndex;
