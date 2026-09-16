/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { addMessageRecordsIDB, DBMessageRecord, DBMessageStatus, getAllMessageIdsIDB } from "../db";
import { getMessageStatus } from "./index";
import { DEFAULT_IMAGE_CACHE_DIR } from "./constants";

const LEGACY_DB_NAME = "MessageLoggerIDB";
const LEGACY_IMAGE_DB_NAME = "MessageLoggerImageData";
const LEGACY_IMAGE_STORE_NAME = "MessageLoggerImageStore";
const IMAGE_DB_NAME = "AegisLoggerImageData";
const IMAGE_STORE_NAME = "AegisLoggerImageStore";
const CHUNK_SIZE = 2000;

export interface MigrationResult {
    migrated: number;
    duplicates: number;
    invalid: number;
}

export async function legacyDbExists(): Promise<boolean> {
    const databases = await indexedDB.databases?.() ?? [];
    return databases.some(db => db.name === LEGACY_DB_NAME);
}

function openLegacyDb(): Promise<IDBDatabase> {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open(LEGACY_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
}

function readChunk(db: IDBDatabase, afterId: string | null): Promise<DBMessageRecord[]> {
    return new Promise((resolve, reject) => {
        const tx = db.transaction("messages", "readonly");
        const range = afterId != null ? IDBKeyRange.lowerBound(afterId, true) : undefined;
        const request = tx.objectStore("messages").getAll(range, CHUNK_SIZE);
        request.onsuccess = () => resolve(request.result as DBMessageRecord[]);
        request.onerror = () => reject(request.error);
    });
}

async function* iterateLegacyChunks() {
    const db = await openLegacyDb();
    try {
        if (!db.objectStoreNames.contains("messages")) return;

        let lastId: string | null = null;
        while (true) {
            const chunk = await readChunk(db, lastId);
            if (chunk.length === 0) break;

            yield chunk;

            lastId = chunk[chunk.length - 1].message_id;
            if (chunk.length < CHUNK_SIZE) break;
        }
    } finally {
        db.close();
    }
}

function normalizeRecord(record: DBMessageRecord): DBMessageRecord | null {
    if (!record?.message_id || !record.channel_id || !record.message?.id) return null;
    if (record.status && Object.values(DBMessageStatus).includes(record.status)) return record;
    try {
        return { ...record, status: getMessageStatus(record.message) };
    } catch {
        return null;
    }
}

export async function migrateLegacyLogs(): Promise<MigrationResult> {
    const result: MigrationResult = { migrated: 0, duplicates: 0, invalid: 0 };
    if (!await legacyDbExists()) return result;

    const existing = new Set(await getAllMessageIdsIDB());

    for await (const chunk of iterateLegacyChunks()) {
        const eligible: DBMessageRecord[] = [];

        for (const record of chunk) {
            if (!record?.message_id) continue;
            if (existing.has(record.message_id)) {
                result.duplicates++;
                continue;
            }

            const normalized = normalizeRecord(record);
            if (!normalized) {
                result.invalid++;
                continue;
            }

            eligible.push(normalized);
        }

        if (eligible.length) {
            await addMessageRecordsIDB(eligible);
            result.migrated += eligible.length;
        }

        for (const record of chunk) {
            if (record?.message_id) existing.add(record.message_id);
        }
    }

    return result;
}

export async function countLegacyRemaining(): Promise<number> {
    if (!await legacyDbExists()) return 0;

    const existing = new Set(await getAllMessageIdsIDB());
    let remaining = 0;

    for await (const chunk of iterateLegacyChunks()) {
        for (const record of chunk) {
            if (!record?.message_id || existing.has(record.message_id)) continue;
            if (!normalizeRecord(record)) continue;
            remaining++;
        }
    }

    return remaining;
}

export async function migrateLegacyImages(): Promise<number> {
    const databases = await indexedDB.databases?.() ?? [];
    if (!databases.some(db => db.name === LEGACY_IMAGE_DB_NAME)) return 0;

    const legacyDb = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(LEGACY_IMAGE_DB_NAME);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });

    try {
        if (!legacyDb.objectStoreNames.contains(LEGACY_IMAGE_STORE_NAME)) return 0;

        const targetDb = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(IMAGE_DB_NAME);
            request.onupgradeneeded = () => {
                if (!request.result.objectStoreNames.contains(IMAGE_STORE_NAME))
                    request.result.createObjectStore(IMAGE_STORE_NAME);
            };
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });

        try {
            const readTx = legacyDb.transaction(LEGACY_IMAGE_STORE_NAME, "readonly");
            const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
                const request = readTx.objectStore(LEGACY_IMAGE_STORE_NAME).getAllKeys();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            const existingTx = targetDb.transaction(IMAGE_STORE_NAME, "readonly");
            const existing = new Set(await new Promise<IDBValidKey[]>((resolve, reject) => {
                const request = existingTx.objectStore(IMAGE_STORE_NAME).getAllKeys();
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            }));

            let migrated = 0;
            for (const legacyKey of keys) {
                const fileName = String(legacyKey).split("/").pop();
                if (!fileName) continue;

                const newKey = `${DEFAULT_IMAGE_CACHE_DIR}/${fileName}`;
                if (existing.has(newKey)) continue;

                const value = await new Promise<any>((resolve, reject) => {
                    const tx = legacyDb.transaction(LEGACY_IMAGE_STORE_NAME, "readonly");
                    const request = tx.objectStore(LEGACY_IMAGE_STORE_NAME).get(legacyKey);
                    request.onsuccess = () => resolve(request.result);
                    request.onerror = () => reject(request.error);
                });
                if (value == null) continue;

                const writeTx = targetDb.transaction(IMAGE_STORE_NAME, "readwrite");
                await new Promise<void>((resolve, reject) => {
                    const request = writeTx.objectStore(IMAGE_STORE_NAME).put(value, newKey);
                    request.onsuccess = () => resolve();
                    request.onerror = () => reject(request.error);
                });
                migrated++;
            }

            return migrated;
        } finally {
            targetDb.close();
        }
    } finally {
        legacyDb.close();
    }
}

export async function clearLegacyLogs(): Promise<void> {
    const deleteDb = (name: string) => new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase(name);
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error(`${name} deletion blocked by another connection`));
    });

    await deleteDb(LEGACY_DB_NAME);
    await deleteDb(LEGACY_IMAGE_DB_NAME);
}

export async function isLegacyDbCleared(): Promise<boolean> {
    const databases = await indexedDB.databases?.() ?? [];
    return !databases.some(db => db.name === LEGACY_DB_NAME || db.name === LEGACY_IMAGE_DB_NAME);
}
