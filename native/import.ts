/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { FileHandle, open } from "node:fs/promises";

import { dialog, IpcMainInvokeEvent } from "electron";

interface ImportSession {
    handle: FileHandle;
    decoder: TextDecoder;
}

const activeFiles = new Map<string, ImportSession>();

async function releaseFile(fileId: string, session: ImportSession) {
    activeFiles.delete(fileId);
    try {
        await session.handle.close();
    } catch { }
}

export async function startNativeLogImport(_event: IpcMainInvokeEvent, defaultPath?: string, dialogTitle?: string, filterName?: string) {
    const res = await dialog.showOpenDialog({
        title: dialogTitle ?? "Import Logs",
        filters: [{ name: filterName ?? "Logs", extensions: ["json"] }],
        properties: ["openFile"],
        defaultPath
    });
    const [path] = res.filePaths;

    if (!path) throw Error("No file selected");

    const session: ImportSession = {
        handle: await open(path, "r"),
        decoder: new TextDecoder("utf-8"),
    };

    const fileId = randomUUID();
    activeFiles.set(fileId, session);

    return fileId;
}

export async function readNativeLogChunk(_event: IpcMainInvokeEvent, fileId: string, size: number = 64 * 1024): Promise<string | null> {
    const session = activeFiles.get(fileId);
    if (!session) return null;

    const buffer = Buffer.alloc(size);
    let bytesRead: number;
    try {
        ({ bytesRead } = await session.handle.read(buffer, 0, size));
    } catch (error) {
        await releaseFile(fileId, session);
        throw error;
    }

    if (bytesRead === 0) {
        const tail = session.decoder.decode();
        if (tail !== "") return tail;

        await releaseFile(fileId, session);
        return null;
    }

    return session.decoder.decode(buffer.subarray(0, bytesRead), { stream: true });
}

export async function closeNativeLogImport(_event: IpcMainInvokeEvent, fileId: string) {
    const session = activeFiles.get(fileId);
    if (session) {
        await releaseFile(fileId, session);
    }
}
