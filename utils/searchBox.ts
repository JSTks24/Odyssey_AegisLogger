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
    for (const match of query.matchAll(/\S+/g)) {
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
    let start = Math.max(0, Math.min(caret, query.length));
    let end = start;
    while (start > 0 && !/\s/.test(query[start - 1])) start--;
    while (end < query.length && !/\s/.test(query[end])) end++;
    return { start, end };
}

function replaceRange(query: string, range: searchRange, value: string) {
    return query.slice(0, range.start) + value + query.slice(range.end);
}

function replaceText(query: string, range: searchRange, value: string, caret = value.length, tokens: searchRange[] = segments(query).filter(segment => segment.token)) {
    const before = tokens.some(token => token.end === range.start);
    const after = tokens.some(token => token.start === range.end);
    if (range.start === 0 && after && value.trim() === "") {
        value = "";
        caret = 0;
    }
    const prefix = before && value !== "" && !/^\s/.test(value) ? " " : "";
    const suffix = after && (value !== "" ? !/\s$/.test(value) : before) ? " " : "";
    const text = prefix + value + suffix;
    return {
        query: replaceRange(query, range, text),
        caret: range.start + prefix.length + caret,
        length: text.length
    };
}

function removeRange(query: string, range: searchRange) {
    const before = query.slice(0, range.start);
    const after = query.slice(range.end);
    return (/\s$/.test(before) && /^\s/.test(after) ? before.slice(0, -1) + after : before + after).trim();
}

function removeTokens(query: string, keys: string[]) {
    return query
        .replace(/(^|\s)(\S+)/g, (raw, _separator, part) => {
            const parsed = parseQuery(part);
            return typeof parsed === "string" || !keys.includes(parsed.key) ? raw : "";
        })
        .trim();
}

function prepareSubmission(query: string) {
    return query.replace(/(^|\s)!?(?:user|from|channel|in|server|guild|has|before|after|during|near|around|message):(?=\s|$)/g, "").trim();
}

const searchBox = {
    segments,
    wordAt,
    replaceRange,
    replaceText,
    removeRange,
    removeTokens,
    prepareSubmission
};

export default searchBox;
