/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LoggedAttachment, LoggedMessageJSON } from "./types";
import { getMessageStatus } from "./utils";
import { DB_NAME, DB_VERSION } from "./utils/constants";
import { DBSchema, IDBPDatabase, openDB } from "./utils/idb";
import { getAttachmentBlobUrl } from "./utils/saveImage";
import searchIndex from "./utils/searchIndex";

const HYDRATE_CONCURRENCY = 8;

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
}

export interface MLIDB extends DBSchema {
    messages: {
        key: string;
        value: DBMessageRecord;
        indexes: {
            by_channel_id: string;
            by_status: DBMessageStatus;
            by_timestamp: string;
            by_timestamp_and_message_id: [string, string];
        };
    };

}

export interface LogEntities {
    authors: { id: string; username?: string; globalName?: string; }[];
    guildIds: string[];
    channelIds: string[];
}

let connection!: IDBPDatabase<MLIDB>;
const cachedMessages = new Map<string, LoggedMessageJSON>();
const dbReady = initIDB();

const idb = {
    get connection() { return connection; },
    dbReady,
    cachedMessages,
    hydrateRecords,
    initIDB,
    hasMessageIDB,
    countMessagesIDB,
    countMessagesByStatusIDB,
    getAllMessagesIDB,
    getAllMessageIdsIDB,
    getMessagesForChannelIDB,
    getMessagesByIDsIDB,
    getMessageIDB,
    getMessagesByStatusIDB,
    getOldestMessagesIDB,
    getDistinctLogEntities,
    iterateRawMessagesIDB,
    iterateAllMessagesIDB,
    getDateStortedMessagesByStatusIDB,
    iterateRawMessagesByStatusIDB,
    getMessagesByChannelAndAfterTimestampIDB,
    addMessageIDB,
    addMessagesBulkIDB,
    addMessageRecordsIDB,
    deleteMessageIDB,
    deleteMessagesBulkIDB,
    clearMessagesIDB,
};

export default idb;

async function hydrateRecords(records: DBMessageRecord[]) {
    const attachments: LoggedAttachment[] = [];

    for (const record of records) {
        cacheRecord(record);
        for (const attachment of record.message.attachments) attachments.push(attachment);
    }

    let cursor = 0;
    const worker = async () => {
        while (cursor < attachments.length) {
            const attachment = attachments[cursor++];
            const blobUrl = await getAttachmentBlobUrl(attachment);

            if (blobUrl) {
                attachment.url = blobUrl + "#";
                attachment.proxy_url = blobUrl + "#";
            }
        }
    };

    await Promise.all(Array.from({ length: Math.min(HYDRATE_CONCURRENCY, attachments.length) }, worker));

    return records;
}

async function cacheRecord(record?: DBMessageRecord | null) {
    if (!record) return record;

    cachedMessages.set(record.message_id, record.message);
    return record;
}

async function initIDB() {
    connection = await openDB<MLIDB>(DB_NAME, DB_VERSION, {
        upgrade(db) {
            const messageStore = db.createObjectStore("messages", { keyPath: "message_id" });
            messageStore.createIndex("by_channel_id", "channel_id");
            messageStore.createIndex("by_status", "status");
            messageStore.createIndex("by_timestamp", "message.timestamp");
            messageStore.createIndex("by_timestamp_and_message_id", ["channel_id", "message.timestamp"]);
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

async function getAllMessagesIDB() {
    return hydrateRecords(await connection.getAll("messages"));
}

async function getAllMessageIdsIDB() {
    return connection.getAllKeys("messages") as Promise<string[]>;
}

async function getMessagesForChannelIDB(channel_id: string) {
    return hydrateRecords(await connection.getAllFromIndex("messages", "by_channel_id", channel_id));
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
    return hydrateRecords(await connection.getAllFromIndex("messages", "by_status", status));
}

async function getOldestMessagesIDB(limit: number) {
    return hydrateRecords(await connection.getAllFromIndex("messages", "by_timestamp", undefined, limit));
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

async function* iterateAllMessagesIDB(batchSize = 100) {
    for await (const batch of iterateRawMessagesIDB(batchSize)) {
        yield await hydrateRecords(batch);
    }
}

async function readMessagesByStatusIDB(status: DBMessageStatus, newest: boolean, limit: number) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_status");

    const direction = newest ? "prev" : "next";
    const cursor = await index.openCursor(IDBKeyRange.only(status), direction);

    if (!cursor) return [];

    const messages: DBMessageRecord[] = [];
    for await (const c of cursor) {
        messages.push(c.value);
        if (messages.length >= limit) break;
    }

    return messages;
}

async function getDateStortedMessagesByStatusIDB(newest: boolean, limit: number, status: DBMessageStatus) {
    return hydrateRecords(await readMessagesByStatusIDB(status, newest, limit));
}

async function* iterateRawMessagesByStatusIDB(status: DBMessageStatus, newest: boolean, batchSize = 2000) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_status");

    const direction = newest ? "prev" : "next";
    const cursor = await index.openCursor(IDBKeyRange.only(status), direction);

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

async function getMessagesByChannelAndAfterTimestampIDB(channel_id: string, start: string) {
    const tx = connection.transaction("messages", "readonly");
    const { store } = tx;
    const index = store.index("by_timestamp_and_message_id");

    const cursor = await index.openCursor(IDBKeyRange.bound([channel_id, start], [channel_id, "\uffff"]));

    if (!cursor) return [];

    const messages: DBMessageRecord[] = [];
    for await (const c of cursor) {
        messages.push(c.value);
    }

    return hydrateRecords(messages);
}

async function addMessageIDB(message: LoggedMessageJSON, status: DBMessageStatus) {
    const record = {
        channel_id: message.channel_id,
        message_id: message.id,
        status,
        message,
    };

    await connection.put("messages", record);

    cachedMessages.set(message.id, message);
    searchIndex.addRecords([record]);
}

async function addMessagesBulkIDB(messages: LoggedMessageJSON[], status?: DBMessageStatus) {
    const tx = connection.transaction("messages", "readwrite");
    const { store } = tx;
    const records = messages.map(message => ({
        channel_id: message.channel_id,
        message_id: message.id,
        status: status ?? getMessageStatus(message),
        message,
    }));

    await Promise.all([
        ...records.map(record => store.add(record)),
        tx.done
    ]);

    messages.forEach(message => cachedMessages.set(message.id, message));
    searchIndex.addRecords(records);
}

async function addMessageRecordsIDB(records: DBMessageRecord[]) {
    const tx = connection.transaction("messages", "readwrite");
    const { store } = tx;

    await Promise.all([
        ...records.map(record => store.put(record)),
        tx.done
    ]);

    records.forEach(record => cachedMessages.set(record.message_id, record.message));
    searchIndex.addRecords(records);
}


async function deleteMessageIDB(message_id: string) {
    await connection.delete("messages", message_id);

    cachedMessages.delete(message_id);
    searchIndex.removeIds([message_id]);
}

async function deleteMessagesBulkIDB(message_ids: string[]) {
    const tx = connection.transaction("messages", "readwrite");
    const { store } = tx;

    await Promise.all([...message_ids.map(id => store.delete(id)), tx.done]);
    message_ids.forEach(id => cachedMessages.delete(id));
    searchIndex.removeIds(message_ids);
}

async function clearMessagesIDB() {
    cachedMessages.clear();

    const deleted = await new Promise<boolean>(resolve => {
        connection.close();
        const req = indexedDB.deleteDatabase(DB_NAME);
        req.onsuccess = () => resolve(true);
        req.onerror = () => resolve(false);
    });

    await initIDB();
    if (!deleted) await clearMessagesChunkedIDB();

    cachedMessages.clear();
    searchIndex.clear();
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
