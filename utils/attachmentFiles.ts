/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import type { LoggedAttachment } from "../types";

function contentType(attachment: LoggedAttachment) {
    const value = attachment?.content_type;
    if (typeof value !== "string") return "";
    const type = value.split(";", 1)[0].trim().toLowerCase();
    return /^[^/\s]+\/[^/\s]+$/.test(type) ? type : "";
}

function isImageAttachment(attachment: LoggedAttachment) {
    const type = contentType(attachment);
    if (type) return type.startsWith("image/");
    return typeof attachment?.filename === "string" && /\.(png|jpe?g|gif|webp|bmp|avif|apng)$/i.test(attachment.filename);
}

function normalizeFileExtension(value?: string | null) {
    const extension = value?.split(";")[0].split("/").pop()?.replace(/^\./, "").toLowerCase();
    return extension && /^[a-z0-9]+$/.test(extension) ? `.${extension}` : null;
}

function attachmentUrls(attachment: LoggedAttachment) {
    return [...new Set([attachment.url, attachment.proxy_url, attachment.oldUrl, attachment.oldProxyUrl]
        .filter((url): url is string => typeof url === "string" && /^https?:\/\//i.test(url)))];
}

function attachmentFilenames(id: string, extension?: string | null) {
    if (!id || /[\\/.:]/.test(id)) return [];
    const normalized = normalizeFileExtension(extension);
    if (normalized == null) return [];

    return [...new Set([`${id}${normalized}`, `${id}${extension}`, `${id}${normalized.slice(1)}`])]
        .filter(filename => !/[\\/:]/.test(filename));
}

const attachmentFiles = { contentType, isImageAttachment, normalizeFileExtension, attachmentUrls, attachmentFilenames };

export default attachmentFiles;
