/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

import type { LoggedMessageJSON } from "../types";

export const DEFAULT_IMAGE_CACHE_DIR = "savedImages";

export const DISCORD_EPOCH = 14200704e5;

export function normalizeTimestampMs(message: Pick<LoggedMessageJSON, "timestamp" | "id">): number {
    const parsed = Date.parse(message.timestamp as any);
    if (!Number.isNaN(parsed)) return parsed;

    const snowflake = parseInt(message.id);
    if (Number.isFinite(snowflake) && snowflake > 0) return snowflake / 4194304 + DISCORD_EPOCH;

    return 0;
}

export const DB_NAME = "AegisLoggerIDB";
export const DB_VERSION = 2;
export const LOGS_DATA_FILENAME = "aegis-logger-logs.json";
