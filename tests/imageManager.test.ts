/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const downloadAttachmentNative = vi.fn();
const writeImageNative = vi.fn();
const getImageNative = vi.fn();

vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    Native: {
        downloadAttachment: (...args: any[]) => downloadAttachmentNative(...args),
        writeImageNative: (...args: any[]) => writeImageNative(...args),
        getImageNative: (...args: any[]) => getImageNative(...args),
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

import { get, keys } from "@api/DataStore";

import { downloadAttachment, getImage, refreshImageIndex } from "../utils/saveImage/ImageManager";

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
    writeImageNative.mockImplementation(async filename => filename);
    getImageNative.mockResolvedValue(null);
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

    it("tries another remote address when the first renderer request throws", async () => {
        downloadAttachmentNative.mockRejectedValueOnce(new Error("bridge unavailable"));
        const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline proxy")).mockResolvedValueOnce({ status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer });
        vi.stubGlobal("fetch", fetchMock);

        expect(await downloadAttachment(att({ proxy_url: "https://proxy.example/pic.png" }))).toBe("a1.png");
        expect(fetchMock.mock.calls.map(args => args[0])).toEqual(["https://cdn.example/pic.png", "https://proxy.example/pic.png"]);
    });

    it("does not report a saved image when the native write rejects the bytes", async () => {
        downloadAttachmentNative.mockResolvedValue({ error: "offline", path: null });
        writeImageNative.mockResolvedValue(null);
        vi.stubGlobal("fetch", vi.fn(async () => ({ status: 200, arrayBuffer: async () => new Uint8Array([1]).buffer })));

        expect(await downloadAttachment(att())).toBeUndefined();
    });
});

describe("image index", () => {
    it("reads images migrated after the initial scan without reloading the module", async () => {
        const bytes = new Uint8Array([1, 2]);
        vi.mocked(keys).mockResolvedValueOnce(["savedImages/migrated.png"]);
        vi.mocked(get).mockResolvedValueOnce(bytes);

        await refreshImageIndex();

        expect(await getImage("migrated")).toEqual(bytes);
    });

    it("waits for an outstanding image index scan before reading", async () => {
        let complete: (value: any) => void = () => { };
        vi.mocked(keys).mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }) as any);
        const scan = refreshImageIndex();
        await Promise.resolve();
        let settled = false;
        const read = getImage("delayed").then(value => { settled = true; return value; });
        await Promise.resolve();
        expect(settled).toBe(false);
        vi.mocked(get).mockResolvedValueOnce(new Uint8Array([3]));
        complete(["savedImages/delayed.png"]);
        await scan;
        expect(await read).toEqual(new Uint8Array([3]));
    });

    it("falls back to native storage when an indexed IDB image is gone", async () => {
        vi.mocked(keys).mockResolvedValueOnce(["savedImages/missing.png"]);
        await refreshImageIndex();
        vi.mocked(get).mockResolvedValue(null);
        getImageNative.mockResolvedValue(new Uint8Array([4]));

        expect(await getImage("missing", ".png")).toEqual(new Uint8Array([4]));
        expect(getImageNative).toHaveBeenCalledWith("missing", ".png");
    });

    it("finds the old filename without an extension dot", async () => {
        vi.mocked(keys).mockResolvedValueOnce(["savedImages/legacyPNG"]);
        await refreshImageIndex();
        vi.mocked(get).mockImplementation(async key => key === "savedImages/legacyPNG" ? new Uint8Array([5]) : null);

        expect(await getImage("legacy", "PNG")).toEqual(new Uint8Array([5]));
        expect(getImageNative).not.toHaveBeenCalled();
    });
});
