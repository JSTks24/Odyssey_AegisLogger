import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@utils/web", () => ({ chooseFile: vi.fn(async () => null) }));
vi.mock("../index", () => ({ Native: {} }));
vi.mock("../db", () => ({
    addMessagesBulkIDB: vi.fn(async () => { }),
    getAllMessageIdsIDB: vi.fn(async () => []),
    iterateAllMessagesIDB: vi.fn(() => { })
}));
vi.mock("../utils/i18n", () => ({ t: (key: string, params?: Record<string, any>) => key }));

vi.stubGlobal("IS_WEB", true);

import { Toasts } from "@webpack/common";
import { chooseFile } from "@utils/web";
import { addMessagesBulkIDB, getAllMessageIdsIDB } from "../db";
import { importLogs } from "../utils/settingsUtils";

function makeMessage(id: string) {
    return {
        id,
        channel_id: "100",
        timestamp: new Date(Date.UTC(2026, 0, 1, 12, 0, 0)).toISOString(),
        author: { id: "u1", username: "alice" },
        content: `content-${id}`,
        attachments: []
    };
}

function makeFile(messages: any[]): File {
    return new File([JSON.stringify({ messages })], "logs.json", { type: "application/json" });
}

function makeStreamFile(chunks: string[]): any {
    const encoder = new TextEncoder();
    let index = 0;
    return {
        stream: () => new ReadableStream<Uint8Array>({
            pull(controller) {
                if (index < chunks.length) {
                    controller.enqueue(encoder.encode(chunks[index]));
                    index++;
                } else {
                    controller.close();
                }
            }
        })
    };
}

beforeEach(() => {
    vi.stubGlobal("IS_WEB", true);
    vi.spyOn(console, "error").mockImplementation(() => { });
    vi.mocked(addMessagesBulkIDB).mockClear();
    vi.mocked(getAllMessageIdsIDB).mockReset();
    vi.mocked(getAllMessageIdsIDB).mockResolvedValue([]);
    vi.mocked(Toasts.show).mockClear();
    vi.mocked(chooseFile).mockReset();
});

describe("importLogs", () => {
    it("imports valid messages and shows a success toast", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeFile([makeMessage("1"), makeMessage("2"), makeMessage("3")]) as any);

        await importLogs();

        expect(addMessagesBulkIDB).toHaveBeenCalledTimes(1);
        const batch = vi.mocked(addMessagesBulkIDB).mock.calls[0][0];
        expect(batch.map(m => m.id)).toEqual(["1", "2", "3"]);
        expect(batch.length).toBeLessThanOrEqual(50);
        expect(Toasts.show).toHaveBeenCalledTimes(1);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ message: "import.success", type: "SUCCESS" }));
    });

    it("writes large imports in batches of at most 50 messages", async () => {
        const messages = Array.from({ length: 120 }, (_, i) => makeMessage(String(i + 1)));
        vi.mocked(chooseFile).mockResolvedValue(makeFile(messages) as any);

        await importLogs();

        expect(vi.mocked(addMessagesBulkIDB).mock.calls.map(call => call[0].length)).toEqual([50, 50, 20]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });

    it("imports records wrapped in an item.message property", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeFile([{ message: makeMessage("1") }, { message: makeMessage("2") }]) as any);

        await importLogs();

        expect(vi.mocked(addMessagesBulkIDB).mock.calls[0][0].map(m => m.id)).toEqual(["1", "2"]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });

    it("skips records missing id, channel_id or timestamp", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeFile([
            makeMessage("1"),
            { channel_id: "100", timestamp: "t", author: { id: "u1" }, content: "missing id" },
            { id: "2", timestamp: "t", author: { id: "u1" }, content: "missing channel" },
            { id: "3", channel_id: "100", author: { id: "u1" }, content: "missing timestamp" },
            makeMessage("4")
        ]) as any);

        await importLogs();

        expect(vi.mocked(addMessagesBulkIDB).mock.calls[0][0].map(m => m.id)).toEqual(["1", "4"]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ type: "SUCCESS" }));
    });

    it("skips messages whose ids already exist in the database", async () => {
        vi.mocked(getAllMessageIdsIDB).mockResolvedValue(["1", "2"]);
        vi.mocked(chooseFile).mockResolvedValue(makeFile([makeMessage("1"), makeMessage("2"), makeMessage("3")]) as any);

        await importLogs();

        expect(vi.mocked(addMessagesBulkIDB).mock.calls[0][0].map(m => m.id)).toEqual(["3"]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ message: "import.success import.duplicates", type: "SUCCESS" }));
    });

    it("shows a failure toast without writing when every message is a duplicate", async () => {
        vi.mocked(getAllMessageIdsIDB).mockResolvedValue(["1", "2"]);
        vi.mocked(chooseFile).mockResolvedValue(makeFile([makeMessage("1"), makeMessage("2")]) as any);

        await importLogs();

        expect(addMessagesBulkIDB).not.toHaveBeenCalled();
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ message: "import.allDuplicates", type: "FAILURE" }));
    });

    it("keeps already written batches and salvages the pending tail when the stream turns out malformed", async () => {
        const valid = Array.from({ length: 60 }, (_, i) => makeMessage(String(i + 1)));
        const firstChunk = JSON.stringify({ messages: valid }).slice(0, -2);
        vi.mocked(chooseFile).mockResolvedValue(makeStreamFile([firstChunk, ',{"bad json']) as any);

        await importLogs();

        expect(vi.mocked(addMessagesBulkIDB).mock.calls.map(call => call[0].length)).toEqual([50, 10]);
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ message: "import.failed", type: "FAILURE" }));
    });

    it("shows a failure toast for an empty import file", async () => {
        vi.mocked(chooseFile).mockResolvedValue(makeFile([]) as any);

        await importLogs();

        expect(addMessagesBulkIDB).not.toHaveBeenCalled();
        expect(Toasts.show).toHaveBeenCalledWith(expect.objectContaining({ message: "import.none", type: "FAILURE" }));
    });
});
