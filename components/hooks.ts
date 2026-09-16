/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { useCallback, useEffect, useState } from "@webpack/common";

import idb, { DBMessageRecord, DBMessageStatus } from "../db";
import { tokenizeQuery } from "../utils/parseQuery";
import searchIndex from "../utils/searchIndex";
import { LogTabs } from "./LogsModal";

function useMessages(query: string, currentTab: LogTabs, sortNewest: boolean, numDisplayedMessages: number) {
    const [pending, setPending] = useState(true);
    const [messages, setMessages] = useState<DBMessageRecord[]>([]);
    const [statusTotal, setStatusTotal] = useState<number>(0);
    const [total, setTotal] = useState<number>(0);

    const debouncedQuery = useDebouncedValue(query, 300);

    useEffect(() => {
        idb.countMessagesIDB().then(x => setTotal(x));
    }, [pending]);

    useEffect(() => {
        let isMounted = true;

        const loadMessages = async () => {
            const status = getStatus(currentTab);

            if (debouncedQuery === "") {
                const [messages, statusTotal] = await Promise.all([
                    idb.getDateStortedMessagesByStatusIDB(sortNewest, numDisplayedMessages, status),
                    idb.countMessagesByStatusIDB(status),
                ]);


                if (isMounted) {
                    setMessages(messages);
                    setStatusTotal(statusTotal);
                }

                setPending(false);
            } else {
                const { queries, rest } = tokenizeQuery(debouncedQuery);
                let matchedTotal: number;

                if (searchIndex.isReady()) {
                    const { page: hits, total } = searchIndex.search(queries, rest, status, numDisplayedMessages, sortNewest);
                    const records = await idb.getMessagesByIDsIDB(hits.map(entry => entry.id));

                    matchedTotal = total;

                    if (isMounted) {
                        setMessages(await idb.hydrateRecords(records));
                        setStatusTotal(matchedTotal);
                    }
                } else {
                    const matched: DBMessageRecord[] = [];
                    let hasMore = false;

                    for await (const batch of idb.iterateRawMessagesByStatusIDB(status, sortNewest)) {
                        for (const record of batch) {
                            if (!searchIndex.matchesRecord(record, queries, rest)) continue;

                            if (matched.length < numDisplayedMessages) {
                                matched.push(record);
                            } else {
                                hasMore = true;
                                break;
                            }
                        }

                        if (hasMore) break;
                    }

                    matchedTotal = matched.length + (hasMore ? 1 : 0);

                    if (isMounted) {
                        setMessages(await idb.hydrateRecords(matched));
                        setStatusTotal(matchedTotal);
                    }
                }

                setPending(false);
            }
        };

        loadMessages();

        return () => {
            isMounted = false;
        };

    }, [debouncedQuery, sortNewest, numDisplayedMessages, currentTab, pending]);


    return { messages, statusTotal, total, pending, reset: useCallback(() => setPending(true), []) };
}

const hooks = {
    useMessages,
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
