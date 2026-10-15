/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import "fake-indexeddb/auto";

import { describe, expect, it, vi } from "vitest";

vi.mock("../db", () => ({ default: {} }));
vi.mock("../utils", () => ({ getMessageStatus: () => "DELETED" }));
vi.mock("../index", () => ({ Native: { getImageNative: async () => null } }));
vi.mock("@api/DataStore", () => {
    const access = async (store: any, callback: (objectStore: IDBObjectStore) => IDBRequest) => {
        const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const request = indexedDB.open(store.database);
            request.onupgradeneeded = () => request.result.createObjectStore(store.name);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
        try {
            return await new Promise<any>((resolve, reject) => {
                const request = callback(db.transaction(store.name).objectStore(store.name));
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });
        } finally {
            db.close();
        }
    };
    return {
        createStore: (database: string, name: string) => ({ database, name }),
        keys: (store: any) => access(store, objectStore => objectStore.getAllKeys()),
        get: (key: string, store: any) => access(store, objectStore => objectStore.get(key)),
        set: vi.fn(),
        del: vi.fn()
    };
});

import { migrateLegacyImages } from "../utils/migration";
import { getImage, refreshImageIndex } from "../utils/saveImage/ImageManager";

describe("migrated image consumption", () => {
    it("reads a migrated image through the existing ImageManager in the same session", async () => {
        vi.stubGlobal("IS_WEB", true);
        try {
            await refreshImageIndex();
            expect(await getImage("100")).toBeNull();
            await new Promise<void>((resolve, reject) => {
                const request = indexedDB.open("MessageLoggerImageData");
                request.onupgradeneeded = () => request.result.createObjectStore("MessageLoggerImageStore");
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction("MessageLoggerImageStore", "readwrite");
                    tx.objectStore("MessageLoggerImageStore").put(new Uint8Array([1, 2, 3]), "old/savedImages/100.png");
                    tx.oncomplete = () => { db.close(); resolve(); };
                    tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            });

            expect(await migrateLegacyImages()).toBe(1);
            expect(await getImage("100")).toEqual(new Uint8Array([1, 2, 3]));
        } finally {
            vi.unstubAllGlobals();
        }
    });
});
