/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useRef, useState } from "@webpack/common";

import idb, { DBMessageRecord, DBMessageStatus } from "../db";
import { tokenizeQuery } from "../utils/parseQuery";
import { type leaseScope } from "../utils/saveImage";
import searchIndex from "../utils/searchIndex";
import { LogTabs } from "./LogsModal";

interface messageLoadContext {
    query: string;
    tab: LogTabs;
    sortNewest: boolean;
    reload: number;
}

export interface messageLoadResult {
    records: DBMessageRecord[];
    statusTotal: number;
    hasMore: boolean;
    nextOffset: number;
    scope: leaseScope | null;
}

export interface messagePageCursor {
    context: messageLoadContext;
    numDisplayed: number;
    records: DBMessageRecord[];
    rawOffset: number;
}

export interface messagePageRequest {
    isLoadMore: boolean;
    offset: number;
    limit: number;
    knownIds: Set<string> | undefined;
}

export type messageLoadPhase = "initial" | "searching" | "indexing" | "more";

export function resolveLoadPhase(isLoadMore: boolean, query: string, indexReady: boolean): messageLoadPhase {
    if (isLoadMore) return "more";
    if (query === "") return "initial";
    return indexReady ? "searching" : "indexing";
}

export function planPageRecords(previous: DBMessageRecord[], incoming: DBMessageRecord[]): { records: DBMessageRecord[]; dropped: string[]; } {
    const records = dedupeRecords([...previous, ...incoming]);
    const kept = new Set(records);
    const dropped = incoming.filter(record => !kept.has(record)).map(record => record.message_id);

    return { records, dropped };
}

export function planNextPage(previous: messagePageCursor | null, context: messageLoadContext, numDisplayedMessages: number): messagePageRequest {
    const isLoadMore = previous != null
        && previous.context.query === context.query
        && previous.context.tab === context.tab
        && previous.context.sortNewest === context.sortNewest
        && previous.context.reload === context.reload
        && numDisplayedMessages > previous.numDisplayed
        && previous.records.length > 0;

    if (!isLoadMore) return { isLoadMore: false, offset: 0, limit: numDisplayedMessages, knownIds: undefined };

    return {
        isLoadMore: true,
        offset: previous.rawOffset,
        limit: numDisplayedMessages - previous.records.length,
        knownIds: new Set(previous.records.map(record => record.message_id))
    };
}

export interface pageLeases {
    adopt(scope: leaseScope | null): void;
    adoptMore(scope: leaseScope | null, dropped: string[]): void;
    retire(): leaseScope[];
    releaseAll(): void;
    count(): number;
}

export function createPageLeases(): pageLeases {
    let scopes: leaseScope[] = [];
    let retired: leaseScope[] = [];

    return {
        adopt(scope) {
            retired = [...retired, ...scopes];
            scopes = scope != null ? [scope] : [];
        },
        adoptMore(scope, dropped) {
            if (scope == null) return;

            scope.releaseRecords(dropped);
            if (scope.size() === 0) return;

            scopes = [...scopes, scope];
        },
        retire() {
            const pending = retired;
            retired = [];

            return pending;
        },
        releaseAll() {
            const pending = [...scopes, ...retired];
            scopes = [];
            retired = [];

            for (const scope of pending) scope.release();
        },
        count() {
            return scopes.length;
        }
    };
}

function dedupeRecords(records: DBMessageRecord[]): DBMessageRecord[] {
    const seen = new Set<string>();
    const result: DBMessageRecord[] = [];
    for (const record of records) {
        if (seen.has(record.message_id)) continue;
        seen.add(record.message_id);
        result.push(record);
    }
    return result;
}

async function loadMessagesPage(
    query: string,
    status: DBMessageStatus,
    sortNewest: boolean,
    offset: number,
    limit: number,
    isCancelled?: () => boolean,
    knownIds?: Set<string>
): Promise<messageLoadResult> {
    const freshRecords = (records: DBMessageRecord[]) =>
        knownIds == null ? records : records.filter(record => !knownIds.has(record.message_id));

    if (query === "") {
        const [records, statusTotal] = await Promise.all([
            idb.getDateStortedMessagesByStatusIDB(sortNewest, limit, status, offset),
            idb.countMessagesByStatusIDB(status),
        ]);

        if (isCancelled?.()) return { records: [], statusTotal: 0, hasMore: false, nextOffset: offset, scope: null };

        const hydrated = await idb.hydrateRecords(freshRecords(records), isCancelled);
        return {
            records: hydrated.records,
            statusTotal,
            hasMore: offset + records.length < statusTotal,
            nextOffset: offset + records.length,
            scope: hydrated.scope
        };
    }

    const { queries, rest } = tokenizeQuery(query);

    try {
        await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB(2000));
    } catch { }

    if (isCancelled?.()) return { records: [], statusTotal: 0, hasMore: false, nextOffset: offset, scope: null };

    if (searchIndex.isReady()) {
        const { page, total } = searchIndex.search(queries, rest, status, limit, sortNewest, offset);
        const records = await idb.getMessagesByIDsIDB(page.map(entry => entry.id));

        if (isCancelled?.()) return { records: [], statusTotal: 0, hasMore: false, nextOffset: offset, scope: null };

        const hydrated = await idb.hydrateRecords(freshRecords(records), isCancelled);
        return {
            records: hydrated.records,
            statusTotal: total,
            hasMore: offset + page.length < total,
            nextOffset: offset + page.length,
            scope: hydrated.scope
        };
    }

    const matched: DBMessageRecord[] = [];
    let seen = 0;
    let hasMore = false;

    for await (const batch of idb.iterateRawMessagesByStatusIDB(status, sortNewest)) {
        if (isCancelled?.()) return { records: [], statusTotal: 0, hasMore: false, nextOffset: offset, scope: null };

        for (const record of batch) {
            if (!searchIndex.matchesRecord(record, queries, rest)) continue;

            seen++;
            if (seen <= offset) continue;
            if (matched.length < limit) {
                matched.push(record);
                continue;
            }

            hasMore = true;
            break;
        }

        if (hasMore) break;
    }

    if (isCancelled?.()) return { records: [], statusTotal: 0, hasMore: false, nextOffset: offset, scope: null };

    const page = freshRecords(dedupeRecords(matched));
    const hydrated = await idb.hydrateRecords(page, isCancelled);
    return {
        records: hydrated.records,
        statusTotal: offset + matched.length + (hasMore ? 1 : 0),
        hasMore,
        nextOffset: offset + matched.length,
        scope: hydrated.scope
    };
}

function useMessages(query: string, currentTab: LogTabs, sortNewest: boolean, numDisplayedMessages: number) {
    const [messages, setMessages] = useState<DBMessageRecord[]>([]);
    const [statusTotal, setStatusTotal] = useState<number>(0);
    const [hasMore, setHasMore] = useState<boolean>(false);
    const [total, setTotal] = useState<number | null>(null);
    const [pending, setPending] = useState<boolean>(true);
    const [phase, setPhase] = useState<messageLoadPhase | null>("initial");
    const [error, setError] = useState<unknown>(null);
    const [reloadVersion, setReloadVersion] = useState(0);

    const debouncedQuery = useDebouncedValue(query, 300);
    const contextRef = useRef<messagePageCursor | null>(null);
    const pageLeasesRef = useRef<pageLeases | null>(null);
    if (pageLeasesRef.current == null) pageLeasesRef.current = createPageLeases();

    const reset = useCallback(() => setReloadVersion(v => v + 1), []);

    useEffect(() => {
        let cancelled = false;
        const isCancelled = () => cancelled;

        const previous = contextRef.current;
        const context: messageLoadContext = { query: debouncedQuery, tab: currentTab, sortNewest, reload: reloadVersion };
        const request = planNextPage(previous, context, numDisplayedMessages);
        const { isLoadMore } = request;

        setPending(true);
        setError(null);
        setPhase(resolveLoadPhase(isLoadMore, debouncedQuery, searchIndex.isReady()));

        const status = getStatus(currentTab);

        const adoptAsPage = (scope: leaseScope | null) => {
            pageLeasesRef.current!.adopt(scope);
        };

        const adoptIntoPages = (result: messageLoadResult, dropped: string[]) => {
            pageLeasesRef.current!.adoptMore(result.scope, dropped);
        };

        const run = async () => {
            if (!isLoadMore && debouncedQuery !== "" && !searchIndex.isReady()) {
                try {
                    await searchIndex.ensureReady(() => idb.iterateRawMessagesIDB(2000));
                } catch { }
                if (cancelled) return null;
                setPhase("searching");
            }

            const result = await loadMessagesPage(
                debouncedQuery,
                status,
                sortNewest,
                request.offset,
                request.limit,
                isCancelled,
                request.knownIds
            );

            if (cancelled) {
                result.scope?.release();
                return null;
            }

            return result;
        };

        run().then(result => {
            if (result == null || cancelled) return;

            const planned = isLoadMore && previous != null
                ? planPageRecords(previous.records, result.records)
                : { records: result.records, dropped: [] };

            if (isLoadMore && previous != null) adoptIntoPages(result, planned.dropped);
            else adoptAsPage(result.scope);

            const { records } = planned;

            contextRef.current = { context, numDisplayed: numDisplayedMessages, records, rawOffset: result.nextOffset };
            setMessages(records);
            setStatusTotal(result.statusTotal);
            setHasMore(result.hasMore);
            setPending(false);
            setPhase(null);
        }).catch(e => {
            if (cancelled) return;
            setError(e);
            setPending(false);
            setPhase(null);
        });

        return () => {
            cancelled = true;
        };
    }, [debouncedQuery, currentTab, sortNewest, numDisplayedMessages, reloadVersion]);

    useEffect(() => {
        let cancelled = false;

        idb.countMessagesIDB()
            .then(count => { if (!cancelled) setTotal(count); })
            .catch(() => { if (!cancelled) setTotal(null); });

        return () => {
            cancelled = true;
        };
    }, [reloadVersion]);

    useEffect(() => {
        for (const scope of pageLeasesRef.current!.retire()) scope.release();
    }, [messages]);

    useEffect(() => {
        return () => {
            pageLeasesRef.current!.releaseAll();
        };
    }, []);

    return { messages, statusTotal, hasMore, total, pending, phase, error, reset, retry: reset };
}

const hooks = {
    useMessages,
    loadMessagesPage,
    dedupeRecords,
    planPageRecords,
    planNextPage,
    createPageLeases
};

export default hooks;

function useDebouncedValue<T>(value: T, delay: number): T {
    const [debouncedValue, setDebouncedValue] = useState(value);

    useEffect(() => {
        const handler = setTimeout(() => {
            setDebouncedValue(value);
        }, delay);

        return () => {
            clearTimeout(handler);
        };
    }, [value, delay]);

    return debouncedValue;
}

function getStatus(currentTab: LogTabs) {
    switch (currentTab) {
        case LogTabs.DELETED:
            return DBMessageStatus.DELETED;
        case LogTabs.EDITED:
            return DBMessageStatus.EDITED;
        default:
            return DBMessageStatus.GHOST_PINGED;
    }
}
