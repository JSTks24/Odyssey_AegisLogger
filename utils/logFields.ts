/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

function string(value: unknown): string {
    return typeof value === "string" ? value : "";
}

function firstString(...values: unknown[]): string {
    return values.find((value): value is string => typeof value === "string" && value.trim() !== "") ?? "";
}

function globalName(author: { globalName?: unknown; global_name?: unknown; } | null | undefined): string {
    return firstString(author?.globalName, author?.global_name);
}

function guildId(message: { guildId?: unknown; guild_id?: unknown; } | null | undefined): string {
    return firstString(message?.guildId, message?.guild_id);
}

function contents(message: { content?: unknown; editHistory?: unknown; }): string[] {
    const history = Array.isArray(message.editHistory) ? message.editHistory : [];
    return [string(message.content), ...history.map(edit => string(edit?.content))];
}

const logFields = { string, firstString, globalName, guildId, contents };

export default logFields;
