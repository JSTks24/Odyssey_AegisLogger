/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { ChannelStore, GuildStore } from "@webpack/common";

import type { DBMessageRecord } from "../db";
import { normalizeTimestampMs } from "./constants";
import { linkRegex, QueryResult } from "./parseQuery";

const entries = new Map<string, indexedMessage>();
const statusEntries = new Map<string, indexedMessage[]>();
const replay: { add: boolean; id: string; entry?: indexedMessage; }[] = [];
const readyListeners = new Set<() => void>();
let activeBuild: { generation: number; promise: Promise<void>; } | null = null;
let activeGeneration = 0;
let ready = false;

interface indexedMessage {
    id: string;
    channelId: string;
    guildId: string;
    authorId: string;
    username: string;
    globalName: string;
    timestamp: string;
    timestampMs: number;
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
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    const embeds = Array.isArray(message.embeds) ? message.embeds : [];
    const rawContent = (message as any).content;
    const content = typeof rawContent === "string" ? rawContent : "";
    const hasType = (prefix: string) => attachments.some(a => (a as any).content_type?.startsWith(prefix));

    return {
        id: record.message_id,
        channelId: record.channel_id,
        guildId: (message as any).guildId ?? ChannelStore.getChannel(record.channel_id)?.guild_id ?? "",
        authorId: (message as any).author?.id ?? "",
        username: ((message as any).author?.username ?? "").toLowerCase(),
        globalName: ((message as any).author?.globalName ?? "").toLowerCase(),
        timestamp: message.timestamp,
        timestampMs: normalizeTimestampMs(message),
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

function compareEntries(a: indexedMessage, b: indexedMessage): number {
    if (a.timestampMs !== b.timestampMs) return a.timestampMs - b.timestampMs;
    if (a.id === b.id) return 0;
    return a.id < b.id ? -1 : 1;
}

function statusList(status: string): indexedMessage[] {
    let list = statusEntries.get(status);
    if (list == null) {
        list = [];
        statusEntries.set(status, list);
    }
    return list;
}

function insertSorted(list: indexedMessage[], entry: indexedMessage) {
    let low = 0;
    let high = list.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        if (compareEntries(list[mid], entry) < 0) low = mid + 1;
        else high = mid;
    }
    list.splice(low, 0, entry);
}

function removeSorted(list: indexedMessage[], entry: indexedMessage) {
    let low = 0;
    let high = list.length;
    while (low < high) {
        const mid = (low + high) >>> 1;
        const comparison = compareEntries(list[mid], entry);
        if (comparison < 0) low = mid + 1;
        else high = mid;
    }
    if (low < list.length && compareEntries(list[low], entry) === 0) list.splice(low, 1);
}

function publishEntry(entry: indexedMessage) {
    const existing = entries.get(entry.id);
    if (existing != null) {
        const oldList = statusEntries.get(existing.status);
        if (oldList != null) removeSorted(oldList, existing);
    }

    entries.set(entry.id, entry);
    insertSorted(statusList(entry.status), entry);
}

function unpublishId(id: string) {
    const existing = entries.get(id);
    if (existing == null) return;

    entries.delete(id);
    const list = statusEntries.get(existing.status);
    if (list != null) removeSorted(list, existing);
}

function isReady() {
    return ready;
}

function subscribeReady(listener: () => void) {
    readyListeners.add(listener);
    return () => { readyListeners.delete(listener); };
}

function addRecords(records: DBMessageRecord[]) {
    if (activeBuild == null && !ready) return;

    for (const record of records) {
        let entry: indexedMessage;
        try {
            entry = buildEntry(record);
        } catch {
            continue;
        }

        if (activeBuild != null) {
            replay.push({ add: true, id: entry.id, entry });
        } else {
            publishEntry(entry);
        }
    }
}

function removeIds(ids: string[]) {
    if (activeBuild == null && !ready) return;

    for (const id of ids) {
        if (activeBuild != null) {
            replay.push({ add: false, id });
        } else {
            unpublishId(id);
        }
    }
}

function clear() {
    activeGeneration++;
    activeBuild = null;
    ready = false;
    entries.clear();
    statusEntries.clear();
    replay.length = 0;
    for (const listener of readyListeners) listener();
}

function ensureReady(source: () => AsyncGenerator<DBMessageRecord[]>): Promise<void> {
    if (ready && activeBuild == null) return Promise.resolve();
    if (activeBuild != null) return activeBuild.promise;
    return startBuild(source).promise;
}

function startBuild(source: () => AsyncGenerator<DBMessageRecord[]>) {
    const generation = ++activeGeneration;
    const build = { generation, promise: null as unknown as Promise<void> };

    build.promise = (async () => {
        const staged = new Map<string, indexedMessage>();

        try {
            for await (const batch of source()) {
                if (activeGeneration !== generation) return;

                for (const record of batch) {
                    try {
                        staged.set(record.message_id, buildEntry(record));
                    } catch { }
                }

                await new Promise(resolve => setTimeout(resolve, 0));
                if (activeGeneration !== generation) return;
            }

            if (activeGeneration !== generation) return;

            for (const op of replay.splice(0)) {
                if (op.add && op.entry != null) staged.set(op.id, op.entry);
                else staged.delete(op.id);
            }

            if (activeGeneration !== generation) return;

            entries.clear();
            statusEntries.clear();
            for (const entry of staged.values()) {
                entries.set(entry.id, entry);
                statusList(entry.status).push(entry);
            }
            for (const list of statusEntries.values()) list.sort(compareEntries);

            ready = true;
            activeBuild = null;
            for (const listener of readyListeners) listener();
        } finally {
            if (activeBuild === build) activeBuild = null;
            if (activeGeneration === generation) replay.length = 0;
        }
    })();

    activeBuild = build;
    return build;
}

function forEach(callback: (entry: indexedMessage) => void) {
    entries.forEach(callback);
}

function search(queries: QueryResult[], rest: string[], status: string, limit: number, newest: boolean, offset = 0) {
    const compiled = queries.map(query =>
        query.key === "before" || query.key === "after" || query.key === "around" || query.key === "near" || query.key === "during"
            ? { ...query, ts: Date.parse(query.value) }
            : query
    );

    const list = statusEntries.get(status) ?? [];
    const page: indexedMessage[] = [];
    let matched = 0;
    const start = newest ? list.length - 1 : 0;
    const step = newest ? -1 : 1;

    for (let i = start; i >= 0 && i < list.length; i += step) {
        const entry = list[i];
        if (!matchesIndex(entry, compiled, rest)) continue;
        if (matched++ < offset) continue;
        if (page.length === limit) return { page, hasMore: true };
        page.push(entry);
    }

    return { page, hasMore: false };
}

function matchesRecord(record: DBMessageRecord, queries: QueryResult[], rest: string[]) {
    try {
        return matchesIndex(buildEntry(record), queries, rest);
    } catch {
        return false;
    }
}

function matchesIndex(entry: indexedMessage, queries: QueryResult[], rest: string[]) {
    for (const query of queries) {
        const matching = matchesQuery(entry, query);
        if (query.negate ? matching : !matching) return false;
    }

    return rest.every(part => entry.content.includes(part.toLowerCase()));
}

function matchesQuery(entry: indexedMessage, query: QueryResult & { ts?: number; }) {
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
        case "before": {
            const ts = query.ts ?? Date.parse(query.value);
            return Number.isNaN(ts) ? false : entry.timestampMs < ts;
        }
        case "after": {
            const ts = query.ts ?? Date.parse(query.value);
            return Number.isNaN(ts) ? false : entry.timestampMs > ts;
        }
        case "around":
        case "near":
        case "during": {
            const ts = query.ts ?? Date.parse(query.value);
            return Number.isNaN(ts) ? false : Math.abs(entry.timestampMs - ts) < 1000 * 60 * 60 * 24;
        }
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
    subscribeReady,
    addRecords,
    removeIds,
    clear,
    ensureReady,
    forEach,
    search,
    matchesRecord,
    matchesIndex
};

export default searchIndex;
