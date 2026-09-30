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

import { MessageAttachment } from "@vencord/discord-types";

import { logger, settings } from "../..";
import { LoggedAttachment, LoggedMessage, LoggedMessageJSON } from "../../types";
import { deleteImage, downloadAttachment, getImage, } from "./ImageManager";

const DEFAULT_CACHE_BUDGET = 2000;
const DISPLAY_URL_SUFFIX = "#";

interface blobResource {
    key: string;
    url: string;
    refs: number;
    cached: boolean;
    revoked: boolean;
}

interface inflightRead {
    task: Promise<blobResource | null>;
    reserved: boolean;
}

export interface attachmentLease {
    url: string;
    release(): void;
}

export interface leaseScope {
    hold(messageId: string, lease: attachmentLease): void;
    take(messageIds: Iterable<string>): Map<string, attachmentLease[]>;
    releaseRecords(messageIds: Iterable<string>): void;
    release(): void;
    size(): number;
}

export interface attachmentBlobStats {
    cached: number;
    live: number;
    inflight: number;
    held: number;
}

const cachedResources = new Map<string, blobResource>();
const resourcesByUrl = new Map<string, blobResource>();
const liveResources = new Set<blobResource>();
const inflightReads = new Map<string, inflightRead>();

let cacheGeneration = 0;
let cacheBudget = DEFAULT_CACHE_BUDGET;
let evictionScheduled = false;

let releaseBlobUrl: (url: string) => void = () => { };

export function displayAttachmentUrl(url: string) {
    return `${url}${DISPLAY_URL_SUFFIX}`;
}

export function resolveManagedAttachmentBase(url: string) {
    if (!url.startsWith("blob:")) return null;

    let cut = url.length;
    const query = url.indexOf("?");
    if (query !== -1) cut = Math.min(cut, query);
    const fragment = url.indexOf("#");
    if (fragment !== -1) cut = Math.min(cut, fragment);

    const base = url.slice(0, cut);
    return resourcesByUrl.has(base) ? base : null;
}

export function normalizeAttachmentUrl(url: string) {
    const managed = resolveManagedAttachmentBase(url);
    if (managed != null) return managed;

    return url.endsWith(DISPLAY_URL_SUFFIX) ? url.slice(0, -DISPLAY_URL_SUFFIX.length) : url;
}

function inertSearchParams() {
    const empty: [string, string][] = [];

    return {
        size: 0,
        append() { },
        set() { },
        delete() { },
        sort() { },
        get() { return null; },
        getAll() { return []; },
        has() { return false; },
        forEach() { },
        entries() { return empty[Symbol.iterator](); },
        keys() { return empty[Symbol.iterator](); },
        values() { return empty[Symbol.iterator](); },
        [Symbol.iterator]() { return empty[Symbol.iterator](); },
        toString() { return ""; }
    };
}

export function guardManagedBlobUrl(url: string): URL | null {
    const base = typeof url === "string" ? resolveManagedAttachmentBase(url) : null;
    if (base == null) return null;

    const display = displayAttachmentUrl(base);

    let view: URL;
    try {
        view = new URL(url);
    } catch {
        view = new URL(base);
    }

    return {
        href: display,
        protocol: view.protocol,
        origin: view.origin,
        host: view.host,
        hostname: view.hostname,
        port: view.port,
        pathname: view.pathname,
        username: view.username,
        password: view.password,
        search: "",
        hash: DISPLAY_URL_SUFFIX,
        searchParams: inertSearchParams() as unknown as URLSearchParams,
        toString() { return display; },
        toJSON() { return display; }
    } as unknown as URL;
}

function resourceKey(id: string) {
    return `${cacheGeneration}:${id}`;
}

function revokeResource(resource: blobResource) {
    if (resource.revoked) return;

    resource.revoked = true;
    liveResources.delete(resource);
    resourcesByUrl.delete(resource.url);
    releaseBlobUrl(resource.url);
}

function scheduleEviction() {
    if (evictionScheduled) return;

    evictionScheduled = true;
    queueMicrotask(() => {
        evictionScheduled = false;
        evictOverflow(0);
    });
}

function releaseResource(resource: blobResource) {
    if (resource.refs > 0) resource.refs--;
    if (resource.refs > 0) return;

    if (!resource.cached) {
        revokeResource(resource);
        return;
    }

    scheduleEviction();
}

function createLease(resource: blobResource): attachmentLease {
    let active = true;

    return {
        url: resource.url,
        release() {
            if (!active) return;
            active = false;
            releaseResource(resource);
        }
    };
}

function holdResource(resource: blobResource | null | undefined): attachmentLease | null {
    if (resource == null || resource.revoked) return null;

    resource.refs++;
    return createLease(resource);
}

function touchCached(resource: blobResource) {
    cachedResources.delete(resource.key);
    cachedResources.set(resource.key, resource);
}

function dropFromCache(resource: blobResource) {
    cachedResources.delete(resource.key);
    resource.cached = false;
    if (resource.refs === 0) revokeResource(resource);
}

function evictOverflow(incoming: number) {
    if (cachedResources.size + incoming <= cacheBudget) return;

    for (const resource of cachedResources.values()) {
        if (cachedResources.size + incoming <= cacheBudget) break;
        if (resource.refs > 0) continue;

        dropFromCache(resource);
    }
}

async function readResource(key: string, id: string, fileExtension: string | null | undefined, generation: number): Promise<blobResource | null> {
    const imageData = await getImage(id, fileExtension);
    if (!imageData) return null;

    const url = URL.createObjectURL(new Blob([imageData]));

    if (generation !== cacheGeneration) {
        releaseBlobUrl(url);
        return null;
    }

    const resource: blobResource = { key, url, refs: 1, cached: true, revoked: false };
    evictOverflow(1);
    cachedResources.set(key, resource);
    resourcesByUrl.set(url, resource);
    liveResources.add(resource);

    return resource;
}

export async function acquireAttachmentBlobUrl(attachment: LoggedAttachment): Promise<attachmentLease | null> {
    const id = attachment?.id;
    if (id == null) return null;

    const key = resourceKey(id);
    const cached = cachedResources.get(key);
    if (cached != null) {
        touchCached(cached);
        return holdResource(cached);
    }

    let read = inflightReads.get(key);
    if (read == null) {
        const generation = cacheGeneration;
        const created: inflightRead = { task: null as unknown as Promise<blobResource | null>, reserved: true };
        created.task = readResource(key, id, attachment.fileExtension, generation)
            .finally(() => {
                if (inflightReads.get(key) === created) inflightReads.delete(key);
            });
        inflightReads.set(key, created);
        read = created;
    }

    const resource = await read.task;
    if (resource == null || resource.revoked) return null;

    if (read.reserved) {
        read.reserved = false;
        return createLease(resource);
    }

    resource.refs++;
    return createLease(resource);
}

export function acquireAttachmentLease(url: string): attachmentLease | null {
    const resource = resourcesByUrl.get(normalizeAttachmentUrl(url));
    if (resource == null) return null;

    if (resource.cached) touchCached(resource);
    return holdResource(resource);
}

export function createLeaseScope(): leaseScope {
    const held = new Map<string, attachmentLease[]>();

    const releaseAll = (leases: attachmentLease[]) => {
        for (const lease of leases) lease.release();
    };

    return {
        hold(messageId: string, lease: attachmentLease) {
            const leases = held.get(messageId);
            if (leases == null) held.set(messageId, [lease]);
            else leases.push(lease);
        },
        take(messageIds: Iterable<string>) {
            const taken = new Map<string, attachmentLease[]>();

            for (const messageId of messageIds) {
                const leases = held.get(messageId);
                if (leases == null) continue;

                held.delete(messageId);
                taken.set(messageId, leases);
            }

            return taken;
        },
        releaseRecords(messageIds: Iterable<string>) {
            for (const messageId of messageIds) {
                const leases = held.get(messageId);
                if (leases == null) continue;

                held.delete(messageId);
                releaseAll(leases);
            }
        },
        release() {
            const lists = [...held.values()];
            held.clear();

            for (const leases of lists) releaseAll(leases);
        },
        size() {
            let count = 0;
            for (const leases of held.values()) count += leases.length;

            return count;
        }
    };
}

export function clearAttachmentBlobCache() {
    cacheGeneration++;

    for (const resource of [...cachedResources.values()]) dropFromCache(resource);
}

export function setAttachmentBlobCacheBudget(limit: number) {
    cacheBudget = Math.max(1, Math.floor(limit));
    evictOverflow(0);
}

export async function settleAttachmentCache() {
    if (!evictionScheduled) return;

    evictionScheduled = false;
    evictOverflow(0);
}

export function resetAttachmentBlobCacheForTests() {
    for (const resource of [...liveResources]) revokeResource(resource);

    cachedResources.clear();
    inflightReads.clear();
    cacheGeneration++;
    cacheBudget = DEFAULT_CACHE_BUDGET;
}

export function getAttachmentBlobStats(): attachmentBlobStats {
    let held = 0;
    for (const resource of liveResources) held += resource.refs;

    return { cached: cachedResources.size, live: liveResources.size, inflight: inflightReads.size, held };
}

export function registerBlobUrlReleaser(releaser: (url: string) => void) {
    releaseBlobUrl = releaser;
}

export function getFileExtension(str: string) {
    const matches = str.match(/(\.[a-zA-Z0-9]+)(?:\?.*)?$/);
    if (!matches) return null;

    return matches[1];
}

export function isAttachmentGoodToCache(attachment: MessageAttachment, fileExtension: string) {
    if (attachment.size > settings.store.attachmentSizeLimitInMegabytes * 1024 * 1024) {
        logger.log("Attachment too large to cache", attachment.filename);
        return false;
    }
    const attachmentFileExtensionsStr = settings.store.attachmentFileExtensions.trim();

    if (attachmentFileExtensionsStr === "")
        return true;

    const allowedFileExtensions = attachmentFileExtensionsStr.split(",");

    if (fileExtension.startsWith(".")) {
        fileExtension = fileExtension.slice(1);
    }

    if (!fileExtension || !allowedFileExtensions.includes(fileExtension)) {
        logger.log("Attachment not in allowed file extensions", attachment.filename);
        return false;
    }

    return true;
}

export async function cacheMessageImages(message: LoggedMessage | LoggedMessageJSON, filter?: (attachment: LoggedAttachment) => boolean) {
    try {
        for (const attachment of message.attachments) {
            if (filter != null && !filter(attachment))
                continue;

            if (attachment.path != null)
                continue;

            const fileExtension = getFileExtension(attachment.filename ?? attachment.url) ?? attachment.content_type?.split("/")?.[1] ?? ".png";

            if (!isAttachmentGoodToCache(attachment, fileExtension)) {
                logger.log("skipping", attachment.filename);
                continue;
            }

            attachment.oldUrl = attachment.url;
            attachment.oldProxyUrl = attachment.proxy_url;

            // only normal urls work if theres a charset in the content type /shrug
            if (attachment.content_type?.includes(";")) {
                attachment.proxy_url = attachment.url;
            } else {
                // apparently proxy urls last longer
                attachment.url = attachment.proxy_url;
                attachment.proxy_url = attachment.url;
            }

            attachment.fileExtension = fileExtension;

            const path = await downloadAttachment(attachment);

            if (!path) {
                logger.error("Failed to cache attachment", attachment);
                continue;
            }

            attachment.path = path;
        }

    } catch (error) {
        logger.error("Error caching message images:", error);
    }
}

export async function deleteMessageImages(message: LoggedMessage | LoggedMessageJSON) {
    for (let i = 0; i < message.attachments.length; i++) {
        const attachment = message.attachments[i];
        await deleteImage(attachment.id);
    }
}
