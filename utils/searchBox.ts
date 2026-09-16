/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { parseQuery } from "./parseQuery";

function splitActiveToken(query: string, kind: string): { head: string; rest: string; } | null {
    const marker = `${kind}:`;
    let start = -1;
    let from = 0;

    while (true) {
        const i = query.indexOf(marker, from);
        if (i < 0) break;
        if (i === 0 || query[i - 1] === " ") start = i;
        from = i + 1;
    }

    if (start < 0) return null;
    return { head: query.slice(0, start), rest: query.slice(start + marker.length) };
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

const searchBox = {
    splitActiveToken,
    splitLeadingTokens,
    composeSearchBox,
    removeTokens
};

export default searchBox;
