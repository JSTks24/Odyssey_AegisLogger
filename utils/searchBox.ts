/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseQuery } from "./parseQuery";

function splitActiveToken(query: string, kind: string): { head: string; rest: string; prefix: string; } | null {
    const marker = `${kind}:`;
    let start = -1;
    let prefixLen = marker.length;
    let from = 0;

    while (true) {
        const i = query.indexOf(marker, from);
        if (i < 0) break;
        let s = -1;
        if (i === 0 || query[i - 1] === " ") s = i;
        else if (query[i - 1] === "!" && (i === 1 || query[i - 2] === " ")) s = i - 1;
        if (s >= 0) {
            start = s;
            prefixLen = s === i ? marker.length : marker.length + 1;
        }
        from = i + 1;
    }

    if (start < 0) return null;
    return { head: query.slice(0, start), rest: query.slice(start + prefixLen), prefix: query.slice(start, start + prefixLen) };
}

function splitLeadingTokens(query: string): { tokens: string[]; rest: string; } {
    const parts = query.split(" ");
    let count = 0;

    while (count < parts.length && typeof parseQuery(parts[count]) !== "string") count++;

    return { tokens: parts.slice(0, count), rest: parts.slice(count).join(" ") };
}

function composeSearchBox(tokens: string[], rest: string) {
    return [...tokens, rest].join(" ");
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

function cancelPick(query: string, kind: string, editRaw: string | null) {
    const split = splitActiveToken(query, kind);
    if (split == null) return query;
    if (editRaw == null) return split.head.trimEnd();
    const restored = (split.head.trimEnd() + " " + editRaw).trim();
    return restored === query ? query : restored;
}

const searchBox = {
    splitActiveToken,
    splitLeadingTokens,
    composeSearchBox,
    removeTokens,
    cancelPick
};

export default searchBox;
