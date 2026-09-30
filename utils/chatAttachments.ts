/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LoggedMessageJSON } from "../types";
import { LimitedMap } from "./LimitedMap";
import { acquireAttachmentLease, attachmentLease, leaseScope } from "./saveImage";

export interface messageLeaseRecord {
    messageId: string;
    message: LoggedMessageJSON;
}

export interface messageLeaseEntry {
    message: LoggedMessageJSON;
    leases: attachmentLease[];
}

export interface messageLeaseStore {
    adopt(scope: leaseScope, records: messageLeaseRecord[]): void;
    get(messageId: string): messageLeaseEntry | undefined;
    invalidate(messageIds: Iterable<string>): void;
    invalidateAll(): void;
    setLimit(limit: number): void;
    size(): number;
}

export interface chatAttachmentHolders {
    hold(instance: unknown, src: string | null | undefined): void;
    release(instance: unknown): void;
    refresh(instance: unknown, previousSrc: string | null | undefined, src: string | null | undefined): void;
    sweep(isReferenced: (url: string) => boolean): number;
    size(): number;
}

function releaseLeases(leases: attachmentLease[]) {
    for (const lease of leases) lease.release();
}

function createMessageLeaseStore(limit = 0): messageLeaseStore {
    const entries = new LimitedMap<string, messageLeaseEntry>(limit, (_key, entry) => releaseLeases(entry.leases));

    const invalidateAll = () => {
        const all = [...entries.map.values()];
        entries.clear();

        for (const entry of all) releaseLeases(entry.leases);
    };

    return {
        adopt(scope, records) {
            const taken = scope.take(records.map(record => record.messageId));

            for (const record of records) {
                const previous = entries.get(record.messageId);
                if (previous != null) releaseLeases(previous.leases);

                entries.set(record.messageId, { message: record.message, leases: taken.get(record.messageId) ?? [] });
            }

            scope.release();
            entries.trim();
        },
        get(messageId) {
            return entries.get(messageId);
        },
        invalidate(messageIds) {
            for (const messageId of messageIds) {
                const entry = entries.get(messageId);
                if (entry == null) continue;

                entries.delete(messageId);
                releaseLeases(entry.leases);
            }
        },
        invalidateAll,
        setLimit(value) {
            entries.limit = value;
            entries.trim();
        },
        size() {
            return entries.size;
        }
    };
}

function createChatAttachmentHolders(): chatAttachmentHolders {
    const held = new Map<unknown, attachmentLease>();

    const release = (instance: unknown) => {
        const lease = held.get(instance);
        if (lease == null) return;

        held.delete(instance);
        lease.release();
    };

    const hold = (instance: unknown, src: string | null | undefined) => {
        const lease = typeof src === "string" ? acquireAttachmentLease(src) : null;

        release(instance);

        if (lease != null) held.set(instance, lease);
    };

    return {
        hold,
        release,
        refresh(instance, previousSrc, src) {
            if (previousSrc === src) return;

            hold(instance, src);
        },
        sweep(isReferenced) {
            let released = 0;

            for (const [instance, lease] of [...held]) {
                if (isReferenced(lease.url)) continue;

                release(instance);
                released++;
            }

            return released;
        },
        size() {
            return held.size;
        }
    };
}

const chatAttachments = {
    createMessageLeaseStore,
    createChatAttachmentHolders
};

export default chatAttachments;
