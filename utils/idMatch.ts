/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface MatchCandidate {
    id: string;
    name: string;
    typeLabel: string;
}

export function matchCandidates(input: string, pool: MatchCandidate[], limit = 8): MatchCandidate[] {
    const q = input.trim().toLowerCase();
    if (!q) return [];

    const scored: { candidate: MatchCandidate; score: number; index: number; }[] = [];
    pool.forEach((candidate, index) => {
        if (candidate.id === q) {
            scored.push({ candidate, score: 0, index });
            return;
        }

        const name = candidate.name.toLowerCase();
        if (!name.includes(q)) return;

        scored.push({ candidate, score: name.startsWith(q) ? 1 : 2, index });
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
