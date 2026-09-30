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

import { chooseFile as chooseFileWeb } from "@utils/web";
import { Toasts } from "@webpack/common";

import { logger, Native, settings } from "..";
import idb, { DBMessageRecord, DBMessageStatus } from "../db";
import { LoggedMessageJSON } from "../types";
import { normalizeTimestampMs } from "./constants";
import { t } from "./i18n";

const EXPORT_HEADER = '{\n  "format": "aegis-logger-logs",\n  "version": 2,\n  "messages": [\n';
const EXPORT_FOOTER = "\n  ]\n}";
const PRESERVED_EXPORT_MARKER = "Preserved export:";

export function parsePreservedExportPath(error: unknown): string | null {
    const message = error instanceof Error ? error.message : typeof error === "string" ? error : "";
    const index = message.indexOf(PRESERVED_EXPORT_MARKER);
    if (index < 0) return null;

    const rest = message.slice(index + PRESERVED_EXPORT_MARKER.length).trimStart();
    const quote = rest[0];
    if (quote !== "\"" && quote !== "'") return null;

    const end = rest.indexOf(quote, 1);
    if (end < 0) return null;

    const path = rest.slice(1, end);
    return path.length > 0 ? path : null;
}

export interface ImportSummary {
    imported: number;
    duplicates: number;
    invalid: number;
    trimmed: number;
    retained: number;
}

function deriveStatus(message: LoggedMessageJSON): DBMessageStatus | null {
    if (message.ghostPinged) return DBMessageStatus.GHOST_PINGED;
    if (message.deleted) return DBMessageStatus.DELETED;
    if (message.editHistory?.length) return DBMessageStatus.EDITED;
    return null;
}

export function normalizeLogItem(candidate: any): DBMessageRecord | null {
    if (candidate == null || typeof candidate !== "object" || Array.isArray(candidate)) return null;

    let { message } = candidate;
    let { status } = candidate;

    if (message == null || typeof message !== "object" || Array.isArray(message)) {
        message = candidate;
        status = undefined;
    }

    if (typeof message.id !== "string" || message.id === "") return null;
    if (typeof message.channel_id !== "string" || message.channel_id === "") return null;
    if (typeof message.timestamp !== "string" || Number.isNaN(Date.parse(message.timestamp))) return null;
    if (message.author == null || typeof message.author !== "object" || typeof message.author.id !== "string") return null;
    if (message.content != null && typeof message.content !== "string") return null;

    const normalized: LoggedMessageJSON = { ...message };

    normalized.attachments = Array.isArray(message.attachments)
        ? message.attachments.filter(a => a != null && typeof a === "object")
        : [];
    normalized.embeds = Array.isArray(message.embeds)
        ? message.embeds.filter(e => e != null && typeof e === "object")
        : [];
    normalized.mentions = Array.isArray(message.mentions) ? message.mentions : [];
    normalized.editHistory = Array.isArray(message.editHistory)
        ? message.editHistory.filter(e => e != null && typeof e === "object")
        : [];
    if (normalized.content == null) normalized.content = "";

    let finalStatus = status != null && Object.values(DBMessageStatus).includes(status as DBMessageStatus)
        ? status as DBMessageStatus
        : null;

    if (finalStatus == null) {
        finalStatus = deriveStatus(normalized);
        if (finalStatus == null) return null;
    }

    return {
        message_id: normalized.id,
        channel_id: normalized.channel_id,
        status: finalStatus,
        message: normalized,
        timestamp: normalized.timestamp,
        timestampMs: normalizeTimestampMs(normalized),
    };
}

function appendTrimNotice(message: string, summary: ImportSummary | null) {
    if (summary == null || summary.trimmed <= 0) return message;

    return message + " " + t("import.trimmed", { count: summary.trimmed });
}

export async function importLogs(): Promise<ImportSummary | null> {
    let imported = 0;
    let duplicates = 0;
    let invalid = 0;
    const batchSize = 50;
    let batch: DBMessageRecord[] = [];

    const flushBatch = async () => {
        if (batch.length === 0) return;
        const result = await idb.upsertMessageRecordsIDB(batch);
        imported += result.inserted;
        duplicates += result.duplicates;
        batch = [];
    };

    const finalize = async (): Promise<ImportSummary> => {
        let trimmed = 0;
        if (settings.store.messageLimit > 0)
            trimmed = await idb.enforceMessageLimitIDB(settings.store.messageLimit);

        return { imported, duplicates, invalid, trimmed, retained: await idb.countMessagesIDB() };
    };

    try {
        for await (const item of iterateLogItems()) {
            for (const candidate of Array.isArray(item) ? item : [item]) {
                const record = normalizeLogItem(candidate);
                if (record == null) {
                    invalid++;
                    continue;
                }
                batch.push(record);
            }

            if (batch.length >= batchSize)
                await flushBatch();
        }
        await flushBatch();
    } catch (e) {
        console.error(e);

        try {
            await flushBatch();
        } catch (flushError) {
            logger.error("Failed to flush import batch", flushError);
        }

        const partial = await finalize().catch(() => null);

        Toasts.show({
            id: Toasts.genId(),
            message: appendTrimNotice(
                partial != null && partial.imported > 0
                    ? t("import.failedPartial", { count: partial.imported })
                    : t("import.failed"),
                partial
            ),
            type: Toasts.Type.FAILURE
        });
        return null;
    }

    const summary = await finalize();

    if (imported === 0 && duplicates === 0 && invalid === 0) {
        Toasts.show({
            id: Toasts.genId(),
            message: appendTrimNotice(t("import.none"), summary),
            type: Toasts.Type.FAILURE
        });
        return summary;
    }

    if (imported === 0) {
        Toasts.show({
            id: Toasts.genId(),
            message: appendTrimNotice(t("import.allDuplicates", { count: duplicates }), summary),
            type: Toasts.Type.FAILURE
        });
        return summary;
    }

    let message = t("import.success", { count: imported });
    if (duplicates > 0) message += " " + t("import.duplicates", { count: duplicates });
    if (invalid > 0) message += " " + t("import.invalid", { count: invalid });
    message = appendTrimNotice(message, summary);

    Toasts.show({
        id: Toasts.genId(),
        message,
        type: Toasts.Type.SUCCESS
    });

    return summary;
}

export async function exportLogs() {
    const filename = "aegis-logger-export.json";

    if (!IS_WEB) {
        let streamId: string | null = null;
        try {
            streamId = await Native.startNativeLogExport(filename);

            await Native.writeNativeLogChunk(streamId, EXPORT_HEADER);

            let first = true;
            let count = 0;
            for await (const records of idb.iterateRawMessagesIDB()) {
                if (records.length === 0) continue;

                const chunk = (first ? "" : ",\n") + records.map(record => "    " + JSON.stringify(record)).join(",\n");
                first = false;
                count += records.length;

                await Native.writeNativeLogChunk(streamId, chunk);
            }

            await Native.writeNativeLogChunk(streamId, EXPORT_FOOTER);
            await Native.finishNativeLogExport(streamId);
            streamId = null;

            Toasts.show({
                id: Toasts.genId(),
                message: t("export.success", { count }),
                type: Toasts.Type.SUCCESS
            });
        } catch (e) {
            if (streamId != null) {
                await Native.cancelNativeLogExport(streamId).catch(() => { });
            }
            console.error(e);

            const preservedPath = parsePreservedExportPath(e);

            Toasts.show({
                id: Toasts.genId(),
                message: preservedPath != null
                    ? t("export.failedPreserved", { path: preservedPath })
                    : t("export.failed"),
                type: Toasts.Type.FAILURE
            });
        }
        return;
    }

    if (IS_WEB) {
        try {
            const { showSaveFilePicker } = await import("./native-file-system-adapter/mod");

            const handle = await showSaveFilePicker({
                suggestedName: filename,
                types: [{
                    description: "JSON File",
                    accept: { "application/json": [".json"] },
                }],
            });

            const writable = await handle.createWritable();
            const writer = writable.getWriter();
            const encoder = new TextEncoder();

            try {
                await writer.write(encoder.encode(EXPORT_HEADER));

                let first = true;
                let count = 0;
                for await (const records of idb.iterateRawMessagesIDB()) {
                    if (records.length === 0) continue;

                    const chunk = (first ? "" : ",\n") + records.map(record => "    " + JSON.stringify(record)).join(",\n");
                    first = false;
                    count += records.length;

                    await writer.write(encoder.encode(chunk));
                }

                await writer.write(encoder.encode(EXPORT_FOOTER));
                await writer.close();

                Toasts.show({
                    id: Toasts.genId(),
                    message: t("export.success", { count }),
                    type: Toasts.Type.SUCCESS
                });
            } catch (e) {
                await writer.abort?.();
                throw e;
            }
        } catch (e) {
            console.error(e);

            Toasts.show({
                id: Toasts.genId(),
                message: t("export.failed"),
                type: Toasts.Type.FAILURE
            });
        }
    }
}


async function* parseJsonStream(readChunk: () => Promise<string | null>) {
    const { JSONParser } = await import("./streamparser-json");

    const parser = new JSONParser({
        paths: ["$.messages.*"],
        keepStack: false,
    });
    const queue: any[] = [];
    let error: Error | null = null;

    parser.onValue = ({ value }) => {
        queue.push(value);
    };

    parser.onError = (err: Error) => {
        error = err;
    };

    let streamError: unknown = null;

    try {
        while (true) {
            if (error) break;
            while (queue.length > 0) {
                yield queue.shift();
            }

            const chunk = await readChunk();
            if (chunk === null) break;

            parser.write(chunk);
        }
    } catch (e) {
        streamError = e;
    } finally {
        if (!parser.isEnded)
            parser.end();
    }

    while (queue.length > 0) {
        yield queue.shift();
    }

    if (streamError) throw streamError;
    if (error) throw error;
}

async function* iterateLogItems(): AsyncGenerator<any> {
    if (IS_WEB) {
        const file = await chooseFileWeb(".json");
        if (!file) throw new Error("No file selected");

        const stream = file.stream();
        const reader = stream.getReader();
        const decoder = new TextDecoder();

        yield* parseJsonStream(async () => {
            const { done, value } = await reader.read();
            if (done) return null;
            return decoder.decode(value, { stream: true });
        });
    } else {
        const settings = await Native.getSettings();
        const fileId = await Native.startNativeLogImport(settings.logsDir, t("import.dialogTitle"), t("import.dialogFilter"));

        try {
            yield* parseJsonStream(async () => {
                return await Native.readNativeLogChunk(fileId);
            });
        } finally {
            await Native.closeNativeLogImport(fileId);
        }
    }
}
