/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LoggedAttachment, LoggedMessageJSON } from "./types";
import { DB_NAME, DB_VERSION, normalizeTimestampMs } from "./utils/constants";
import { DBSchema, IDBPDatabase, openDB } from "./utils/idb";
import { LimitedMap } from "./utils/LimitedMap";
import messageChanges from "./utils/messageChanges";
import { acquireAttachmentBlobUrl, attachmentLease, clearAttachmentBlobCache, createLeaseScope, displayAttachmentUrl, leaseScope } from "./utils/saveImage";
import searchIndex from "./utils/searchIndex";

const HYDRATE_CONCURRENCY = 8;
const LIMIT_TRIM_BATCH = 5000;

export enum DBMessageStatus {
    DELETED = "DELETED",
    EDITED = "EDITED",
    GHOST_PINGED = "GHOST_PINGED",
}

export interface DBMessageRecord {
    message_id: string;
    channel_id: string;
    status: DBMessageStatus;
    message: LoggedMessageJSON;
    timestamp: string;
    timestampMs: number;
    version?: number;
}

export interface MLIDB extends DBSchema {
    messages: {
        key: string;
        value: DBMessageRecord;
        indexes: {
            by_channel_id: string;
            by_status: DBMessageStatus;
            by_timestamp: string;
            by_channel_and_timestamp: [string, number];
            by_status_and_timestamp: [DBMessageStatus, number];
            by_timestamp_ms: number;
        };
    };

}

export interface LogEntities {
    authors: { id: string; username?: string; globalName?: string; }[];
    guildIds: string[];
    channelIds: string[];
}

export interface hydratedRecords {
    records: DBMessageRecord[];
    scope: leaseScope;
}

let connection!: IDBPDatabase<MLIDB>;
const cachedMessages = new LimitedMap<string, LoggedMessageJSON>(5000);
const dbReady = initIDB();

let writeEpoch = Date.now();
let writeQueue: Promise<unknown> = Promise.resolve();

function nextWriteEpoch() {
    return ++writeEpoch;
}

function withWriteLock<T>(task: () => Promise<T>): Promise<T> {
    const run = writeQueue.then(task, task);
    writeQueue = run.then(() => undefined, () => undefined);
    return run;
}

const idb = {
    get connection() { return connection; },
    dbReady,
    cachedMessages,
    hydrateRecords,
    initIDB,
    hasMessageIDB,
    countMessagesIDB,
    countMessagesByStatusIDB,
    getAllMessageIdsIDB,
    getMessagesForChannelIDB,
    getMessagesByIDsIDB,
    getMessageIDB,
    getMessagesByStatusIDB,
    getDistinctLogEntities,
    iterateRawMessagesIDB,
    getDateStortedMessagesByStatusIDB,
    iterateRawMessagesByStatusIDB,
    getMessagesByChannelAndAfterTimestampIDB,
    addMessageIDB,
    upsertMessageRecordsIDB,
    addMessageRecordsIDB,
    updateMessageIfCurrentIDB,
    enforceMessageLimitIDB,
    deleteMessageIDB,
    deleteMessagesBulkIDB,
    clearMessagesIDB,
};

export default idb;

async function hydrateRecords(records: DBMessageRecord[], isCancelled?: () => boolean): Promise<hydratedRecords> {
    const scope = createLeaseScope();
    const display: DBMessageRecord[] = [];
    const pending: { messageId: string; source: LoggedAttachment; target: LoggedAttachment; }[] = [];

    for (const record of records) {
        cacheRecord(record);

        const attachments = Array.isArray(record.message.attachments) ? record.message.attachments : [];
        if (attachments.length === 0) {
            display.push(record);
            continue;
        }

        const copies = attachments.map(attachment => ({ ...attachment }));
        display.push({ ...record, message: { ...record.message, attachments: copies } });

        for (let i = 0; i < attachments.length; i++) {
            pending.push({ messageId: record.message_id, source: attachments[i], target: copies[i] });
        }
    }

    let cursor = 0;
    const worker = async () => {
        while (cursor < pending.length) {
            if (isCancelled?.()) return;
            const item = pending[cursor++];

            let lease: attachmentLease | null;
            try {
                lease = await acquireAttachmentBlobUrl(item.source);
            } catch {
                continue;
            }

            if (lease == null) continue;

            if (isCancelled?.()) {
                lease.release();
                return;
            }

            scope.hold(item.messageId, lease);
            item.target.url = displayAttachmentUrl(lease.url);
            item.target.proxy_url = displayAttachmentUrl(lease.url);
        }
    };

    try {
        await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, pending.length) }, worker));
    } catch (error) {
        scope.release();
        throw error;
    }

    return { records: display, scope };
}

async function cacheRecord(record?: DBMessageRecord | null) {
    if (!record) return record;

    cachedMessages.set(record.message_id, record.message);
    return record;
}

async function initIDB() {
    connection = await openDB<MLIDB>(DB_NAME, DB_VERSION, {
        async upgrade(db, oldVersion, _newVersion, tx) {
            if (!db.objectStoreNames.contains("messages")) {
                const messageStore = db.createObjectStore("messages", { keyPath: "message_id" });
                messageStore.createIndex("by_channel_id", "channel_id");
                messageStore.createIndex("by_status", "status");
                messageStore.createIndex("by_timestamp", "timestamp");
                messageStore.createIndex("by_channel_and_timestamp", ["channel_id", "timestampMs"]);
                messageStore.createIndex("by_status_and_timestamp", ["status", "timestampMs"]);
                messageStore.createIndex("by_timestamp_ms", "timestampMs");
            }

            if (oldVersion > 0 && oldVersion < 2) {
                const store = tx.objectStore("messages");

                if (!store.indexNames.contains("by_timestamp")) store.createIndex("by_timestamp", "timestamp");

                let cursor = await store.openCursor();
                while (cursor != null) {
                    const record = cursor.value as DBMessageRecord;
                    if (typeof record.timestampMs !== "number" || typeof record.timestamp !== "string") {
                        record.timestamp = record.timestamp ?? record.message.timestamp;
                        record.timestampMs = typeof record.timestampMs === "number" ? record.timestampMs : normalizeTimestampMs(record.message);
                        await cursor.update(record);
                    }
                    cursor = await cursor.continue();
                }

                store.createIndex("by_channel_and_timestamp", ["channel_id", "timestampMs"]);
                store.createIndex("by_status_and_timestamp", ["status", "timestampMs"]);
                store.createIndex("by_timestamp_ms", "timestampMs");
            }
        }
    });
}


async function hasMessageIDB(message_id: string) {
    return cachedMessages.has(message_id) || (await connection.count("messages", message_id)) > 0;
}

async function countMessagesIDB() {
    return connection.count("messages");
}

async function countMessagesByStatusIDB(status: DBMessageStatus) {
    return connection.countFromIndex("messages", "by_status", status);
}

async function getAllMessageIdsIDB() {
    return connection.getAllKeys("messages") as Promise<string[]>;
}

async function getMessagesForChannelIDB(channel_id: string) {
    return connection.getAllFromIndex("messages", "by_channel_id", channel_id);
}

async function getMessagesByIDsIDB(message_ids: string[]) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const records = await Promise.all(message_ids.map(id => store.get(id)));

    return records.filter((record): record is DBMessageRecord => record != null);
}

async function getMessageIDB(message_id: string) {
    return cacheRecord(await connection.get("messages", message_id));
}

async function getMessagesByStatusIDB(status: DBMessageStatus) {
    return readMessagesByStatusIDB(status, false, Infinity);
}

async function getDistinctLogEntities(): Promise<LogEntities> {
    const authors = new Map<string, { id: string; username?: string; globalName?: string; }>();
    const guildIds = new Set<string>();
    const channelIds = new Set<string>();

    if (searchIndex.isReady()) {
        searchIndex.forEach(entry => {
            if (entry.authorId) authors.set(entry.authorId, { id: entry.authorId, username: entry.username, globalName: entry.globalName });
            if (entry.guildId) guildIds.add(entry.guildId);
            if (entry.channelId) channelIds.add(entry.channelId);
        });

        return { authors: [...authors.values()], guildIds: [...guildIds], channelIds: [...channelIds] };
    }

    for await (const batch of iterateRawMessagesIDB(200)) {
        for (const record of batch) {
            const m = record.message;
            if (m.author?.id)
                authors.set(m.author.id, { id: m.author.id, username: m.author.username, globalName: (m.author as any).globalName });
            if (m.guildId) guildIds.add(m.guildId);
            if (m.channel_id) channelIds.add(m.channel_id);
        }
    }

    return { authors: [...authors.values()], guildIds: [...guildIds], channelIds: [...channelIds] };
}

async function* iterateRawMessagesIDB(batchSize = 100) {
    let lastId: string | undefined;
    while (true) {
        const batch: DBMessageRecord[] = [];
        const tx = connection.transaction("messages");
        const range = lastId ? IDBKeyRange.lowerBound(lastId, true) : undefined;
        let cursor = await tx.store.openCursor(range);

        while (cursor && batch.length < batchSize) {
            batch.push(cursor.value);
            cursor = await cursor.continue();
        }

        if (batch.length === 0) break;

        lastId = batch[batch.length - 1].message_id;

        yield batch;

        if (batch.length < batchSize) break;
    }
}

async function readMessagesByStatusIDB(status: DBMessageStatus, newest: boolean, limit: number, offset = 0) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_status_and_timestamp");

    const direction = newest ? "prev" : "next";
    let cursor = await index.openCursor(IDBKeyRange.bound([status], [status, Number.MAX_SAFE_INTEGER]), direction);

    if (!cursor) return [];

    if (offset > 0) {
        cursor = await cursor.advance(offset);
        if (!cursor) return [];
    }

    const messages: DBMessageRecord[] = [];
    for (; cursor && messages.length < limit;) {
        messages.push(cursor.value);
        cursor = await cursor.continue();
    }

    return messages;
}

async function getDateStortedMessagesByStatusIDB(newest: boolean, limit: number, status: DBMessageStatus, offset = 0) {
    return readMessagesByStatusIDB(status, newest, limit, offset);
}

async function* iterateRawMessagesByStatusIDB(status: DBMessageStatus, newest: boolean, batchSize = 2000) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_status_and_timestamp");

    const direction = newest ? "prev" : "next";
    const cursor = await index.openCursor(IDBKeyRange.bound([status], [status, Number.MAX_SAFE_INTEGER]), direction);

    if (!cursor) return;

    let batch: DBMessageRecord[] = [];

    for await (const c of cursor) {
        batch.push(c.value);

        if (batch.length >= batchSize) {
            yield batch;
            batch = [];
        }
    }

    if (batch.length > 0) yield batch;
}

async function getMessagesByChannelAndAfterTimestampIDB(channel_id: string, start: string, isCancelled?: () => boolean): Promise<hydratedRecords> {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_channel_and_timestamp");
    const startMs = Date.parse(start);

    const cursor = await index.openCursor(IDBKeyRange.bound(
        [channel_id, Number.isNaN(startMs) ? 0 : startMs],
        [channel_id, Number.MAX_SAFE_INTEGER]
    ));

    if (!cursor) return { records: [], scope: createLeaseScope() };

    const messages: DBMessageRecord[] = [];
    for await (const c of cursor) {
        messages.push(c.value);
    }

    return hydrateRecords(messages, isCancelled);
}

async function addMessageIDB(message: LoggedMessageJSON, status: DBMessageStatus) {
    const record: DBMessageRecord = {
        message_id: message.id,
        channel_id: message.channel_id,
        status,
        message,
        timestamp: message.timestamp,
        timestampMs: normalizeTimestampMs(message),
    };

    await withWriteLock(() => {
        record.version = nextWriteEpoch();
        return connection.put("messages", record);
    });

    cachedMessages.set(message.id, message);
    searchIndex.addRecords([record]);
    messageChanges.notifyChanged([message.id]);
}

async function upsertMessageRecordsIDB(records: DBMessageRecord[]): Promise<{ inserted: number; duplicates: number; }> {
    let inserted = 0;
    let duplicates = 0;
    const written: DBMessageRecord[] = [];

    await withWriteLock(async () => {
        const tx = connection.transaction("messages", "readwrite");
        const { store } = tx;

        for (const record of records) {
            const existing = await store.get(record.message_id);
            if (existing != null) {
                duplicates++;
                continue;
            }

            record.version = nextWriteEpoch();
            await store.put(record);
            inserted++;
            written.push(record);
        }

        await tx.done;
    });

    written.forEach(record => cachedMessages.set(record.message_id, record.message));
    searchIndex.addRecords(written);
    messageChanges.notifyChanged(written.map(record => record.message_id));

    return { inserted, duplicates };
}

async function addMessageRecordsIDB(records: DBMessageRecord[]) {
    const normalized = records.map(record => ({
        ...record,
        timestamp: record.timestamp ?? record.message.timestamp,
        timestampMs: record.timestampMs ?? normalizeTimestampMs(record.message),
    }));

    await withWriteLock(async () => {
        const tx = connection.transaction("messages", "readwrite");
        const { store } = tx;

        await Promise.all([
            ...normalized.map(record => {
                record.version = nextWriteEpoch();
                return store.put(record);
            }),
            tx.done
        ]);
    });

    normalized.forEach(record => cachedMessages.set(record.message_id, record.message));
    searchIndex.addRecords(normalized);
    messageChanges.notifyChanged(normalized.map(record => record.message_id));
}

async function updateMessageIfCurrentIDB(
    message_id: string,
    expectedVersion: number | undefined,
    mutate: (message: LoggedMessageJSON) => void
): Promise<boolean> {
    let applied = false;

    await withWriteLock(async () => {
        const tx = connection.transaction("messages", "readwrite");
        const { store } = tx;
        const record = await store.get(message_id);
        if (record == null || record.version !== expectedVersion) return;

        mutate(record.message);
        record.version = nextWriteEpoch();
        await Promise.all([store.put(record), tx.done]);
        applied = true;

        cachedMessages.set(record.message_id, record.message);
    });

    if (applied) messageChanges.notifyChanged([message_id]);

    return applied;
}


async function deleteMessageIDB(message_id: string) {
    await withWriteLock(() => connection.delete("messages", message_id));

    cachedMessages.delete(message_id);
    searchIndex.removeIds([message_id]);
    messageChanges.notifyChanged([message_id]);
}

async function deleteMessagesBulkIDB(message_ids: string[]) {
    await withWriteLock(async () => {
        const tx = connection.transaction("messages", "readwrite");
        const { store } = tx;
        await Promise.all([...message_ids.map(id => store.delete(id)), tx.done]);
    });

    message_ids.forEach(id => cachedMessages.delete(id));
    searchIndex.removeIds(message_ids);
    messageChanges.notifyChanged(message_ids);
}

async function enforceMessageLimitIDB(limit: number): Promise<number> {
    if (limit <= 0) return 0;

    let evicted = 0;
    const evictedIds: string[] = [];

    await withWriteLock(async () => {
        while (true) {
            const count = await connection.count("messages");
            if (count <= limit) return;

            const excess = Math.min(count - limit, LIMIT_TRIM_BATCH);

            const tx = connection.transaction("messages", "readwrite");
            const index = tx.store.index("by_timestamp_ms");
            const keys: string[] = [];
            let cursor = await index.openKeyCursor();

            while (cursor != null && keys.length < excess) {
                keys.push(cursor.primaryKey as string);
                cursor = await cursor.continue();
            }

            if (keys.length === 0) {
                await tx.done;
                return;
            }

            await Promise.all([...keys.map(key => tx.store.delete(key)), tx.done]);
            evicted += keys.length;

            keys.forEach(key => cachedMessages.delete(key));
            searchIndex.removeIds(keys);
            evictedIds.push(...keys);
        }
    });

    messageChanges.notifyChanged(evictedIds);

    return evicted;
}

async function clearMessagesIDB() {
    await withWriteLock(async () => {
        cachedMessages.clear();
        searchIndex.clear();
        clearAttachmentBlobCache();
        await clearMessagesChunkedIDB();
        cachedMessages.clear();
        searchIndex.clear();
    });

    messageChanges.notifyCleared();
}

async function clearMessagesChunkedIDB() {
    const CLEAR_BATCH_SIZE = 5000;
    while (true) {
        const tx = connection.transaction("messages", "readwrite", { durability: "relaxed" });
        const { store } = tx;
        const keys = (await store.getAllKeys(undefined, CLEAR_BATCH_SIZE)) as string[];
        if (keys.length === 0) {
            await tx.done;
            break;
        }

        const range = IDBKeyRange.bound(keys[0], keys[keys.length - 1]);
        await Promise.all([store.delete(range), tx.done]);
    }

    cachedMessages.clear();
}
