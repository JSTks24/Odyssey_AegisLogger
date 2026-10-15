/*
 * Vencord, a Discord client mod
 * Copyright (c) 2023 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream } from "node:fs";
import { copyFile, readdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

import { DATA_DIR } from "@main/utils/constants";
import { dialog, IpcMainInvokeEvent, net, shell } from "electron";

import { getSettings, saveSettings } from "./settings";
export { cancelNativeLogExport, finishNativeLogExport, startNativeLogExport, writeNativeLogChunk } from "./export";
export * from "./import";
export { getNewCommits, getRepoInfo, getUpdateStatus, update } from "./updater";

import { LoggedAttachment } from "../types";
import attachmentFiles from "../utils/attachmentFiles";

const { attachmentFilenames, attachmentUrls, normalizeFileExtension } = attachmentFiles;
import { LOGS_DATA_FILENAME } from "../utils/constants";
import { ensureDirectoryExists, getAttachmentIdFromFilename } from "./utils";

export { getSettings };

export function aegisLoggerNativeSentinel() { }

const nativeSavedImages = new Map<string, string>();
export const getNativeSavedImages = () => nativeSavedImages;

let logsDir: string;
let imageCacheDir: string;
let directoriesReady: Promise<void> | null = null;
let imagesReady: Promise<void> | null = null;
let imageOperations = Promise.resolve();

const getImageCacheDir = async () => { await initDirs(); return imageCacheDir; };
const getLogsDir = async () => { await initDirs(); return logsDir; };

function queueImageOperation<T>(operation: () => Promise<T>): Promise<T> {
    const task = imageOperations.then(operation, operation);
    imageOperations = task.then(() => { }, () => { });
    return task;
}

export function initDirs() {
    return directoriesReady ??= (async () => {
        const settings = await getSettings();
        logsDir = settings.logsDir || await getDefaultNativeDataDir();
        imageCacheDir = settings.imageCacheDir || await getDefaultNativeImageDir();
    })().catch(error => {
        directoriesReady = null;
        return Promise.reject(error);
    });
}

async function scanImages(dir: string) {
    await ensureDirectoryExists(dir);
    const files = await readdir(dir, { withFileTypes: true });
    return new Map(files.filter(file => file.isFile() && !file.name.startsWith(".aegis-"))
        .map(file => [getAttachmentIdFromFilename(file.name), path.join(dir, file.name)]));
}

function replaceImageIndex(images: Map<string, string>) {
    nativeSavedImages.clear();
    for (const [id, filename] of images) nativeSavedImages.set(id, filename);
}

export function init(_event?: IpcMainInvokeEvent) {
    return imagesReady ??= queueImageOperation(async () => {
        replaceImageIndex(await scanImages(await getImageCacheDir()));
    }).catch(error => {
        imagesReady = null;
        return Promise.reject(error);
    });
}

export async function getImageNative(_event: IpcMainInvokeEvent, attachmentId: string, fileExtension?: string | null): Promise<Uint8Array | Buffer | null> {
    if (!attachmentId || /[\\/.:]/.test(attachmentId)) return null;
    await init();
    const directory = imageCacheDir;
    const stored = nativeSavedImages.get(attachmentId);
    const candidates = [...new Set([stored, ...attachmentFilenames(attachmentId, fileExtension).map(filename => path.join(directory, filename))])];

    for (const imagePath of candidates) {
        if (imagePath == null) continue;
        try {
            const bytes = await readFile(imagePath);
            if (bytes.length > 0) {
                if (directory === imageCacheDir) nativeSavedImages.set(attachmentId, imagePath);
                return bytes;
            }
        } catch { }
        if (nativeSavedImages.get(attachmentId) === imagePath) nativeSavedImages.delete(attachmentId);
    }
    return null;
}

export async function writeImageNative(event: IpcMainInvokeEvent, filename: string, content: Uint8Array): Promise<string | null> {
    if (!filename || path.basename(filename) !== filename || /[\\/:]/.test(filename) || !content?.length) return null;
    const attachmentId = getAttachmentIdFromFilename(filename);
    const extension = normalizeFileExtension(path.extname(filename));
    if (extension == null || !attachmentFilenames(attachmentId, extension).length) return null;
    await init();

    return queueImageOperation(async () => {
        if (await getImageNative(event, attachmentId, extension)) return nativeSavedImages.get(attachmentId)!;
        const imagePath = path.join(imageCacheDir, `${attachmentId}${extension}`);
        const temporary = path.join(imageCacheDir, `.aegis-${randomUUID()}.tmp`);
        try {
            await ensureDirectoryExists(imageCacheDir);
            await writeFile(temporary, content);
            await rename(temporary, imagePath);
            nativeSavedImages.set(attachmentId, imagePath);
            return imagePath;
        } finally {
            await unlink(temporary).catch(() => { });
        }
    });
}

export async function deleteFileNative(_event: IpcMainInvokeEvent, attachmentId: string, fileExtension?: string | null) {
    await init();
    return queueImageOperation(async () => {
        if (!nativeSavedImages.has(attachmentId) && fileExtension != null) await getImageNative(_event, attachmentId, fileExtension);
        const imagePath = nativeSavedImages.get(attachmentId);
        if (!imagePath) return;
        await unlink(imagePath).catch(error => {
            if (error.code !== "ENOENT") return Promise.reject(error);
        });
        nativeSavedImages.delete(attachmentId);
    });
}


export async function writeLogs(_event: IpcMainInvokeEvent, contents: string) {
    const logsDir = await getLogsDir();

    writeFile(path.join(logsDir, LOGS_DATA_FILENAME), contents);
}


export async function getDefaultNativeImageDir(): Promise<string> {
    return path.join(await getDefaultNativeDataDir(), "savedImages");
}

export async function getDefaultNativeDataDir(): Promise<string> {
    return path.join(DATA_DIR, "AegisLoggerData");
}

export interface directoryChangeError {
    error: "conflict" | "copy_failed" | "settings_failed";
    filename?: string;
}

async function fileHash(filename: string) {
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(filename)) hash.update(chunk);
    return hash.digest("hex");
}

async function copyImages(source: string, target: string): Promise<directoryChangeError | null> {
    try {
        await ensureDirectoryExists(target);
        const files = await readdir(source, { withFileTypes: true });
        for (const file of files) {
            if (!file.isFile() || file.name.startsWith(".aegis-")) continue;
            const from = path.join(source, file.name);
            const to = path.join(target, file.name);
            try {
                await copyFile(from, to, constants.COPYFILE_EXCL);
            } catch (error: any) {
                if (error.code !== "EEXIST") return { error: "copy_failed", filename: file.name };
                const [left, right] = await Promise.all([stat(from), stat(to)]);
                if (!right.isFile() || left.size !== right.size || await fileHash(from) !== await fileHash(to)) {
                    return { error: "conflict", filename: file.name };
                }
            }
        }
        return null;
    } catch {
        return { error: "copy_failed" };
    }
}

export async function chooseDir(_event: IpcMainInvokeEvent, logKey: "logsDir" | "imageCacheDir"): Promise<string | directoryChangeError | null> {
    await init();
    const settings = await getSettings();
    const defaultPath = settings[logKey] || await getDefaultNativeDataDir();

    const res = await dialog.showOpenDialog({ properties: ["openDirectory"], defaultPath: defaultPath });
    const dir = res.filePaths[0];

    if (!dir) return null;

    return queueImageOperation<string | directoryChangeError>(async () => {
        let images: Map<string, string> | null = null;
        if (logKey === "imageCacheDir") {
            if (path.resolve(dir) === path.resolve(imageCacheDir)) return imageCacheDir;
            const error = await copyImages(imageCacheDir, dir);
            if (error) return error;
            try {
                images = await scanImages(dir);
            } catch {
                return { error: "copy_failed" };
            }
        }

        try {
            await saveSettings({ ...(await getSettings()), [logKey]: dir });
        } catch {
            return { error: "settings_failed" };
        }

        if (images != null) {
            imageCacheDir = dir;
            replaceImageIndex(images);
        } else {
            logsDir = dir;
        }
        return dir;
    });
}

export async function showItemInFolder(_event: IpcMainInvokeEvent, filePath: string) {
    shell.showItemInFolder(filePath);
}

export async function chooseFile(_event: IpcMainInvokeEvent, title: string, filters: Electron.FileFilter[], defaultPath?: string) {
    const res = await dialog.showOpenDialog({ title, filters, properties: ["openFile"], defaultPath });
    const [path] = res.filePaths;

    if (!path) throw Error("Invalid file");

    return await readFile(path, "utf-8");
}

const fetchAttachment = async (event: IpcMainInvokeEvent, url: string) => {
    const session = event?.sender?.session;

    if (typeof session?.fetch === "function") {
        return await session.fetch(url);
    }

    if (typeof net?.fetch === "function") {
        return await net.fetch(url);
    }

    return await fetch(url);
};

export async function downloadAttachment(event: IpcMainInvokeEvent, attachment: LoggedAttachment): Promise<{ error: string | null; path: string | null; }> {
    try {
        const extension = normalizeFileExtension(attachment?.fileExtension);
        if (extension == null || !attachmentFilenames(attachment?.id, extension).length)
            return { error: "Invalid Attachment", path: null };

        if (await getImageNative(event, attachment.id, attachment.fileExtension)) {
            return { error: null, path: nativeSavedImages.get(attachment.id)! };
        }

        for (const url of attachmentUrls(attachment)) {
            try {
                const response = await fetchAttachment(event, url);
                if (response.status !== 200) continue;
                const saved = await writeImageNative(event, `${attachment.id}${extension}`, new Uint8Array(await response.arrayBuffer()));
                if (saved) return { error: null, path: saved };
            } catch { }
        }
        return { error: "Attachment unavailable", path: null };
    } catch (error: any) {
        return { error: `${error.message} (${error.cause?.code ?? "no-cause"})`, path: null };
    }
}
