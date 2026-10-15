/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseQuery, type QueryResult } from "./parseQuery";

export interface searchRange {
    start: number;
    end: number;
}

export interface searchSegment extends searchRange {
    raw: string;
    token?: QueryResult;
}

function segments(query: string, editing?: searchRange | null): searchSegment[] {
    const result: searchSegment[] = [];
    let start = 0;
    for (const match of query.matchAll(/[^ ]+/g)) {
        const from = match.index!;
        const end = from + match[0].length;
        if (editing && from < editing.end && end > editing.start) continue;
        const token = parseQuery(match[0]);
        if (typeof token === "string") continue;
        result.push({ start, end: from, raw: query.slice(start, from) });
        result.push({ start: from, end, raw: match[0], token });
        start = end;
    }
    result.push({ start, end: query.length, raw: query.slice(start) });
    return result;
}

function wordAt(query: string, caret: number): searchRange {
    const end = query.indexOf(" ", caret);
    return { start: caret <= 0 ? 0 : query.lastIndexOf(" ", caret - 1) + 1, end: end < 0 ? query.length : end };
}

function replaceRange(query: string, range: searchRange, value: string) {
    return query.slice(0, range.start) + value + query.slice(range.end);
}

function removeRange(query: string, range: searchRange) {
    const before = query.slice(0, range.start);
    const after = query.slice(range.end);
    return (before.endsWith(" ") && after.startsWith(" ") ? before.slice(0, -1) + after : before + after).trim();
}

function removeTokens(query: string, keys: string[]) {
    return query
        .split(" ")
        .filter(part => {
            const parsed = parseQuery(part);
            return typeof parsed === "string" || !keys.includes(parsed.key);
        })
        .join(" ")
        .trim();
}

function prepareSubmission(query: string) {
    return query.split(" ").filter(part => !/^!?(?:user|from|channel|in|server|guild|has|before|after|during|near|around|message):$/.test(part)).join(" ").trim();
}

const searchBox = {
    segments,
    wordAt,
    replaceRange,
    removeRange,
    removeTokens,
    prepareSubmission
};

export default searchBox;
