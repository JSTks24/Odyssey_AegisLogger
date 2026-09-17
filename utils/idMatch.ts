/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MatchCandidate {
    id: string;
    name: string;
    username?: string;
    sub?: string;
    typeLabel: string;
}

export function matchCandidates(input: string, pool: MatchCandidate[], limit = 8): MatchCandidate[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];

    const scored: { candidate: MatchCandidate; score: number; index: number; }[] = [];
    const idPrefix = /^\d{3,}$/.test(q);
    pool.forEach((candidate, index) => {
        if (candidate.id === q) {
            scored.push({ candidate, score: 0, index });
            return;
        }

        const name = candidate.name.toLowerCase();
        const username = candidate.username?.toLowerCase();
        let score: number | null = null;
        if (name.startsWith(q)) score = 1;
        else if (username?.startsWith(q)) score = 2;
        else if (name.includes(q)) score = 3;
        else if (username?.includes(q)) score = 4;
        else if (idPrefix && candidate.id.startsWith(q)) score = 5;

        if (score != null) scored.push({ candidate, score, index });
    });

    return scored
        .sort((a, b) => a.score - b.score || a.index - b.index)
        .slice(0, limit)
        .map(entry => entry.candidate);
}

export function resolveInput(input: string, pool: MatchCandidate[]): string {
    const q = input.trim();
    if (!q) return "";
    if (/^\d+$/.test(q)) return q;
    return matchCandidates(q, pool, 1)[0]?.id ?? q;
}
