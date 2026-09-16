/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface ExclusionScope {
    serverIds: string[];
    channelIds: string[];
    userIds: string[];
}

export interface ExclusionRule extends ExclusionScope {
    source: string;
    pattern: RegExp;
}

export interface ExclusionTarget {
    content?: string | null;
    guildId?: string | null;
    channelId?: string | null;
    authorId?: string | null;
}

const SCOPE_KEYS: Record<string, keyof ExclusionScope> = {
    server: "serverIds",
    guild: "serverIds",
    channel: "channelIds",
    user: "userIds",
    from: "userIds"
};

const SCOPE_TOKEN = /^(server|guild|channel|user|from):(\S+)\s*/i;

export function parseExclusionRule(line: string): ExclusionRule | null {
    let rest = line.trim();
    if (!rest) return null;

    const scope: ExclusionScope = { serverIds: [], channelIds: [], userIds: [] };
    let match: RegExpMatchArray | null;
    while ((match = rest.match(SCOPE_TOKEN))) {
        scope[SCOPE_KEYS[match[1].toLowerCase()]].push(match[2]);
        rest = rest.slice(match[0].length);
    }

    if (!rest) return null;

    let pattern: RegExp;
    try {
        pattern = new RegExp(rest);
    } catch {
        return null;
    }

    return { ...scope, source: rest, pattern };
}

export function parseExclusionRules(raw: string | undefined | null): ExclusionRule[] {
    return (raw ?? "")
        .split("\n")
        .map(parseExclusionRule)
        .filter((rule): rule is ExclusionRule => rule != null);
}

export function messageMatchesRules(rules: ExclusionRule[], target: ExclusionTarget): boolean {
    if (!target.content) return false;

    return rules.some(rule => {
        if (rule.serverIds.length && !(target.guildId != null && rule.serverIds.includes(target.guildId))) return false;
        if (rule.channelIds.length && !(target.channelId != null && rule.channelIds.includes(target.channelId))) return false;
        if (rule.userIds.length && !(target.authorId != null && rule.userIds.includes(target.authorId))) return false;
        return rule.pattern.test(target.content);
    });
}
