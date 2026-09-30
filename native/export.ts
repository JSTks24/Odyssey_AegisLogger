/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomUUID } from "node:crypto";
import { createWriteStream, WriteStream } from "node:fs";
import { rename, unlink } from "node:fs/promises";

import { dialog, IpcMainInvokeEvent } from "electron";

type ExportState = "writing" | "finishing" | "replacing" | "completed" | "preserved" | "discarded";

interface ExportSession {
    sender: IpcMainInvokeEvent["sender"];
    stream: WriteStream;
    targetPath: string;
    tempPath: string;
    state: ExportState;
    finished: boolean;
    failure: Error | null;
    abandoned: boolean;
    onDestroyed: (() => void) | null;
    closed: Promise<void>;
    finish: Promise<void> | null;
    discard: Promise<void> | null;
}

const activeExports = new Map<string, ExportSession>();
const RENAME_ATTEMPTS = 4;
const UNLINK_ATTEMPTS = 4;
const PRESERVED_EXPORT_MARKER = "Preserved export:";

function delay(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function removeTempFile(tempPath: string) {
    for (let attempt = 0; attempt < UNLINK_ATTEMPTS; attempt++) {
        if (attempt > 0) await delay(150 * attempt);

        try {
            await unlink(tempPath);
            return;
        } catch (error) {
            if ((error as { code?: string; })?.code === "ENOENT") return;
        }
    }

    console.error(`[AegisLogger] Failed to remove the temporary export file "${tempPath}"`);
}

function releaseSession(streamId: string, session: ExportSession) {
    if (session.onDestroyed != null) {
        session.sender.off("destroyed", session.onDestroyed);
        session.onDestroyed = null;
    }

    if (activeExports.get(streamId) === session) activeExports.delete(streamId);
}

function discardSession(streamId: string, session: ExportSession) {
    if (session.state === "completed" || session.state === "preserved") return Promise.resolve();
    if (session.discard != null) return session.discard;

    session.state = "discarded";
    releaseSession(streamId, session);

    session.discard = (async () => {
        if (!session.stream.closed) {
            session.stream.destroy();
            await session.closed;
        }

        await removeTempFile(session.tempPath);
    })();

    return session.discard;
}

function abandonSession(streamId: string, session: ExportSession) {
    if (session.state === "replacing") {
        session.abandoned = true;
        return;
    }

    void discardSession(streamId, session);
}

export async function startNativeLogExport(event: IpcMainInvokeEvent, filename: string) {
    const { filePath, canceled } = await dialog.showSaveDialog({
        defaultPath: filename ?? "aegis-logger-export.json",
        filters: [{ name: "JSON", extensions: ["json"] }]
    });

    if (canceled || !filePath)
        throw new Error("No file path selected");

    const targetPath = filePath;
    const tempPath = `${targetPath}.aegis-tmp-${randomUUID()}`;
    const stream = createWriteStream(tempPath, { flags: "w", encoding: "utf-8" });

    const streamId = randomUUID();
    const session: ExportSession = {
        sender: event.sender,
        stream,
        targetPath,
        tempPath,
        state: "writing",
        finished: false,
        failure: null,
        abandoned: false,
        onDestroyed: null,
        closed: new Promise<void>(resolve => {
            stream.once("close", () => resolve());
        }),
        finish: null,
        discard: null
    };

    activeExports.set(streamId, session);

    stream.on("finish", () => {
        session.finished = true;
    });

    stream.on("error", error => {
        session.failure = session.failure ?? error;
        void discardSession(streamId, session);
    });

    session.onDestroyed = () => {
        session.failure = session.failure ?? new Error("Renderer context destroyed");
        abandonSession(streamId, session);
    };

    event.sender.once("destroyed", session.onDestroyed);

    return streamId;
}

export async function writeNativeLogChunk(_event: IpcMainInvokeEvent, streamId: string, chunk: string) {
    const session = activeExports.get(streamId);
    if (!session) throw new Error("Stream not found or closed");
    if (session.state !== "writing") throw session.failure ?? new Error("Export stream is no longer writable");

    const canContinue = session.stream.write(chunk);
    if (!canContinue) {
        await new Promise<void>((resolve, reject) => {
            let done = false;
            const settle = (error?: Error) => {
                if (done) return;
                done = true;
                session.stream.off("drain", onDrain);
                session.stream.off("error", onError);
                session.stream.off("close", onClose);
                if (error) reject(error);
                else resolve();
            };
            const onDrain = () => settle();
            const onError = (error: Error) => settle(error);
            const onClose = () => settle(new Error("Stream closed"));

            session.stream.once("drain", onDrain);
            session.stream.once("error", onError);
            session.stream.once("close", onClose);
        });
    }
}

async function completeExport(streamId: string, session: ExportSession) {
    if (session.failure) {
        await discardSession(streamId, session);
        throw session.failure;
    }

    session.state = "finishing";

    try {
        session.stream.end();
        await session.closed;
    } catch (error) {
        await discardSession(streamId, session);
        throw error;
    }

    if (session.state !== "finishing") {
        await discardSession(streamId, session);
        throw session.failure ?? new Error("Export was discarded while finishing");
    }

    if (!session.finished) {
        await discardSession(streamId, session);
        throw session.failure ?? new Error("Export stream closed before finishing");
    }

    session.state = "replacing";

    let renameError: unknown = null;

    for (let attempt = 0; attempt < RENAME_ATTEMPTS; attempt++) {
        if (attempt > 0) await delay(150 * attempt);
        if (session.abandoned) break;

        try {
            await rename(session.tempPath, session.targetPath);
            session.state = "completed";
            releaseSession(streamId, session);
            return;
        } catch (error) {
            renameError = error;
            if (session.abandoned) break;
        }
    }

    session.state = "preserved";
    releaseSession(streamId, session);

    throw new Error(
        `Failed to replace "${session.targetPath}"; the original file was kept. ${PRESERVED_EXPORT_MARKER} "${session.tempPath}"`,
        { cause: renameError }
    );
}

export async function finishNativeLogExport(_event: IpcMainInvokeEvent, streamId: string) {
    const session = activeExports.get(streamId);
    if (!session) throw new Error("Stream not found or closed");

    session.finish ??= completeExport(streamId, session);

    return session.finish;
}

export async function cancelNativeLogExport(_event: IpcMainInvokeEvent, streamId: string) {
    const session = activeExports.get(streamId);
    if (!session) return;

    if (session.state === "replacing") {
        session.abandoned = true;
        await session.finish?.catch(() => { });
        return;
    }

    await discardSession(streamId, session);
}

export function getActiveExportSessionCount() {
    return activeExports.size;
}
