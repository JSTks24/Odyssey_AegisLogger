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

import {
    createStore,
    del,
    get,
    keys,
    set,
} from "@api/DataStore";

import { Native } from "../..";
import { LoggedAttachment } from "../../types";
import attachmentFiles from "../attachmentFiles";
import { DEFAULT_IMAGE_CACHE_DIR } from "../constants";

const { attachmentFilenames, attachmentUrls, normalizeFileExtension } = attachmentFiles;

const ImageStore = createStore("AegisLoggerImageData", "AegisLoggerImageStore");

const idbSavedImages = new Map<string, string>();
let imageIndexReady = Promise.resolve();

export function refreshImageIndex() {
    imageIndexReady = imageIndexReady.then(async () => {
        for (const key of await keys(ImageStore)) {
            const value = String(key);
            if (!value.startsWith(`${DEFAULT_IMAGE_CACHE_DIR}/`)) continue;
            const filename = value.slice(DEFAULT_IMAGE_CACHE_DIR.length + 1);
            const id = filename.replace(/\.[^.]+$/, "");
            idbSavedImages.set(id, value);
        }
    }).catch(() => { });
    return imageIndexReady;
}

refreshImageIndex();

export async function getImage(attachmentId: string, fileExt?: string | null): Promise<any> {
    await imageIndexReady;
    const indexed = idbSavedImages.get(attachmentId);
    const paths = [...new Set([indexed, ...attachmentFilenames(attachmentId, fileExt)
        .map(filename => idbSavedImages.get(filename.replace(/\.[^.]+$/, "")))])];
    for (const path of paths) {
        if (path == null) continue;
        try {
            const bytes = await get(path, ImageStore);
            if (bytes != null) {
                idbSavedImages.set(attachmentId, path);
                return bytes;
            }
        } catch { }
        if (idbSavedImages.get(attachmentId) === path) idbSavedImages.delete(attachmentId);
    }

    if (IS_WEB) return null;

    return await Native.getImageNative(attachmentId, fileExt);
}

export async function downloadAttachment(attachment: LoggedAttachment): Promise<string | undefined> {
    const extension = normalizeFileExtension(attachment?.fileExtension);
    if (extension == null || !attachmentFilenames(attachment?.id, extension).length) return;

    if (IS_WEB) {
        return await downloadAttachmentWeb(attachment);
    }

    try {
        const { path, error } = await Native.downloadAttachment(attachment);
        if (!error && path) return path;
    } catch { }
    return downloadAttachmentFromRenderer(attachment);
}

async function downloadAttachmentFromRenderer(attachment: LoggedAttachment): Promise<string | undefined> {
    const filename = `${attachment.id}${normalizeFileExtension(attachment.fileExtension)}`;
    for (const url of attachmentUrls(attachment)) {
        try {
            const response = await fetch(url);
            if (response.status !== 200) continue;
            const saved = await Native.writeImageNative(filename, new Uint8Array(await response.arrayBuffer()));
            if (saved) return saved;
        } catch { }
    }
}

export async function deleteImage(attachmentId: string, fileExtension?: string | null): Promise<void> {
    await imageIndexReady;
    if (!idbSavedImages.has(attachmentId) && fileExtension != null) await getImage(attachmentId, fileExtension);
    const idbPath = idbSavedImages.get(attachmentId);
    if (idbPath) {
        await del(idbPath, ImageStore);
        idbSavedImages.delete(attachmentId);
    }
    if (IS_WEB) return;

    await Native.deleteFileNative(attachmentId, fileExtension);
}


async function downloadAttachmentWeb(attachment: LoggedAttachment) {
    await imageIndexReady;
    for (const url of attachmentUrls(attachment)) {
        try {
            const response = await fetch(url);
            if (response.status !== 200) continue;
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.length) continue;
            const path = `${DEFAULT_IMAGE_CACHE_DIR}/${attachment.id}${normalizeFileExtension(attachment.fileExtension)}`;
            await set(path, bytes, ImageStore);
            idbSavedImages.set(attachment.id, path);
            return path;
        } catch { }
    }
}
