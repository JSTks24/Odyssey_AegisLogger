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
    hasMore: boolean;
    nextOffset: number;
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

export type messageLoadPhase = "initial" | "searching" | "more";

function resolveLoadPhase(isLoadMore: boolean, query: string, tabChanged = false): messageLoadPhase {
    if (isLoadMore) return "more";
    if (query === "" && !tabChanged) return "initial";
    return "searching";
}

function planPageRecords(previous: DBMessageRecord[], incoming: DBMessageRecord[]) {
    return { records: dedupeRecords([...previous, ...incoming]) };
}

function planNextPage(previous: messagePageCursor | null, context: messageLoadContext, numDisplayedMessages: number): messagePageRequest {
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
        dedupeRecords(records).filter(record => !knownIds?.has(record.message_id));
    const cancelledResult = { records: [], hasMore: false, nextOffset: offset };

    if (query === "") {
        const records = await idb.getDateStortedMessagesByStatusIDB(sortNewest, limit + 1, status, offset);
        if (isCancelled?.()) return cancelledResult;
        const page = records.slice(0, limit);
        return {
            records: freshRecords(page),
            hasMore: records.length > limit,
            nextOffset: offset + page.length
        };
    }

    const { queries, rest } = tokenizeQuery(query);

    if (isCancelled?.()) return cancelledResult;

    if (searchIndex.isReady()) {
        const { page, hasMore } = searchIndex.search(queries, rest, status, limit, sortNewest, offset);
        const records = await idb.getMessagesByIDsIDB(page.map(entry => entry.id));

        if (isCancelled?.()) return cancelledResult;

        return {
            records: freshRecords(records),
            hasMore,
            nextOffset: offset + page.length
        };
    }

    const matched: DBMessageRecord[] = [];
    let seen = 0;
    let hasMore = false;

    for await (const batch of idb.iterateRawMessagesByStatusIDB(status, sortNewest)) {
        if (isCancelled?.()) return cancelledResult;

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

    if (isCancelled?.()) return cancelledResult;

    return {
        records: freshRecords(matched),
        hasMore,
        nextOffset: offset + matched.length
    };
}

function useMessages(query: string, currentTab: LogTabs, sortNewest: boolean, numDisplayedMessages: number) {
    const [messages, setMessages] = useState<DBMessageRecord[]>([]);
    const [hasMore, setHasMore] = useState<boolean>(false);
    const [total, setTotal] = useState<number | null>(null);
    const [pending, setPending] = useState<boolean>(true);
    const [phase, setPhase] = useState<messageLoadPhase | null>("initial");
    const [error, setError] = useState<unknown>(null);
    const [reloadVersion, setReloadVersion] = useState(0);

    const contextRef = useRef<messagePageCursor | null>(null);
    const tabChanged = contextRef.current != null && contextRef.current.context.tab !== currentTab;

    const reset = useCallback(() => setReloadVersion(v => v + 1), []);

    useEffect(() => {
        let cancelled = false;
        let frame: number | undefined;
        const isCancelled = () => cancelled;

        const previous = contextRef.current;
        const tabChanged = previous != null && previous.context.tab !== currentTab;
        const context: messageLoadContext = { query, tab: currentTab, sortNewest, reload: reloadVersion };
        const request = planNextPage(previous, context, numDisplayedMessages);
        const { isLoadMore } = request;

        if (previous == null || tabChanged) {
            contextRef.current = { context, numDisplayed: numDisplayedMessages, records: [], rawOffset: 0 };
            setMessages([]);
            setHasMore(false);
        }

        setPending(true);
        setError(null);
        setPhase(resolveLoadPhase(isLoadMore, query, tabChanged));

        const status = getStatus(currentTab);

        const load = () => {
            frame = undefined;
            if (cancelled) return;

            loadMessagesPage(query, status, sortNewest, request.offset, request.limit, isCancelled, request.knownIds).then(result => {
                if (cancelled) return;

                const planned = isLoadMore && previous != null
                    ? planPageRecords(previous.records, result.records)
                    : { records: result.records };

                const { records } = planned;

                contextRef.current = { context, numDisplayed: numDisplayedMessages, records, rawOffset: result.nextOffset };
                setMessages(records);
                setHasMore(result.hasMore);
                setPending(false);
                setPhase(null);
            }).catch(e => {
                if (cancelled) return;
                setError(e);
                setPending(false);
                setPhase(null);
            });
        };

        if (query === "" && !tabChanged) load();
        else frame = requestAnimationFrame(() => {
            if (!cancelled) frame = requestAnimationFrame(load);
        });

        return () => {
            cancelled = true;
            if (frame != null) cancelAnimationFrame(frame);
        };
    }, [query, currentTab, sortNewest, numDisplayedMessages, reloadVersion]);

    useEffect(() => {
        let cancelled = false;

        idb.countMessagesIDB()
            .then(count => { if (!cancelled) setTotal(count); })
            .catch(() => { if (!cancelled) setTotal(null); });

        return () => {
            cancelled = true;
        };
    }, [reloadVersion]);

    return {
        messages: tabChanged ? [] : messages,
        hasMore: !tabChanged && hasMore,
        total,
        pending: tabChanged || pending,
        phase: tabChanged ? "searching" as const : phase,
        error: tabChanged ? null : error,
        reset,
        retry: reset
    };
}

function useVisibleRecord(record: DBMessageRecord) {
    const ref = useRef<HTMLDivElement | null>(null);
    const [loaded, setLoaded] = useState<{ source: DBMessageRecord; display: DBMessageRecord } | null>(null);
    const hasAttachments = (Array.isArray(record.message.attachments) && record.message.attachments.some(Boolean))
        || (Array.isArray(record.message.editHistory) && record.message.editHistory.some(edit => Array.isArray(edit?.attachments) && edit.attachments.some(Boolean)));

    useEffect(() => {
        if (!hasAttachments) return;
        let cancelled = false;
        let started = false;
        let scope: leaseScope | null = null;
        const load = () => {
            if (started || cancelled) return;
            started = true;
            observer?.disconnect();
            idb.hydrateRecords([record], () => cancelled).then(result => {
                if (cancelled) {
                    result.scope.release();
                    return;
                }
                scope = result.scope;
                setLoaded({ source: record, display: result.records[0] ?? record });
            }).catch(() => {
                if (!cancelled) setLoaded({ source: record, display: record });
            });
        };
        const observer = typeof IntersectionObserver === "undefined" ? null : new IntersectionObserver(entries => {
            if (entries.some(entry => entry.isIntersecting)) load();
        }, { rootMargin: "240px" });

        if (observer != null && ref.current != null) observer.observe(ref.current);
        else load();

        return () => {
            cancelled = true;
            observer?.disconnect();
            scope?.release();
        };
    }, [record, hasAttachments]);

    const ready = !hasAttachments || loaded?.source === record;
    return { ref, record: loaded?.source === record ? loaded.display : record, attachmentsPending: !ready };
}

const hooks = {
    useMessages,
    loadMessagesPage,
    dedupeRecords,
    planPageRecords,
    planNextPage,
    resolveLoadPhase,
    useVisibleRecord
};

export default hooks;

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
