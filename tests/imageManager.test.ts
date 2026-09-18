/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadAttachmentNative = vi.fn();
const writeImageNative = vi.fn();

vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Native: {
        downloadAttachment: (...args: any[]) => downloadAttachmentNative(...args),
        writeImageNative: (...args: any[]) => writeImageNative(...args),
        getImageNative: vi.fn(async () => null),
        deleteFileNative: vi.fn(async () => { })
    }
}));

vi.mock("@api/DataStore", () => ({
    createStore: () => ({}),
    del: vi.fn(async () => { }),
    get: vi.fn(async () => null),
    keys: vi.fn(async () => []),
    set: vi.fn(async () => { })
}));

vi.mock("@utils/misc", () => ({ sleep: vi.fn(async () => { }) }));

import { downloadAttachment } from "../utils/saveImage/ImageManager";

const att = (over: any = {}) => ({
    id: "a1",
    filename: "pic.png",
    url: "https://cdn.example/pic.png",
    proxy_url: "https://cdn.example/pic.png",
    fileExtension: ".png",
    ...over
}) as any;

beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_WEB", false);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe("downloadAttachment", () => {
    it("returns the native path when the main process download succeeds", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: null, path: "C:/cache/a1.png" });
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        expect(await downloadAttachment(att())).toBe("C:/cache/a1.png");
        expect(fetchMock).not.toHaveBeenCalled();
        expect(writeImageNative).not.toHaveBeenCalled();
    });

    it("falls back to a renderer fetch and stores the bytes through the native bridge", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: "fetch failed (UND_ERR_CONNECT_TIMEOUT)", path: null });
        const bytes = new Uint8Array([1, 2, 3]).buffer;
        vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, arrayBuffer: async () => bytes })));

        expect(await downloadAttachment(att())).toBe("a1.png");
        expect(writeImageNative).toHaveBeenCalledTimes(1);
        expect(writeImageNative.mock.calls[0][0]).toBe("a1.png");
        expect(writeImageNative.mock.calls[0][1]).toBeInstanceOf(Uint8Array);
    });

    it("gives up when the renderer fetch is rejected", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: "fetch failed (no-cause)", path: null });
        vi.stubGlobal("fetch", vi.fn(async () => ({ status: 404 })));

        expect(await downloadAttachment(att())).toBeUndefined();
        expect(writeImageNative).not.toHaveBeenCalled();
    });

    it("gives up when the renderer fetch throws", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: "fetch failed (no-cause)", path: null });
        vi.stubGlobal("fetch", vi.fn(async () => {
            throw new Error("CORS");
        }));

        expect(await downloadAttachment(att())).toBeUndefined();
        expect(writeImageNative).not.toHaveBeenCalled();
    });

    it("skips the fallback when the attachment is incomplete", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: "Invalid Attachment", path: null });
        const fetchMock = vi.fn();
        vi.stubGlobal("fetch", fetchMock);

        expect(await downloadAttachment(att({ fileExtension: undefined }))).toBeUndefined();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
