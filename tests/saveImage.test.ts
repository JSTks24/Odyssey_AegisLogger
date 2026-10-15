/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    logger: { log: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: {
        store: {
            attachmentSizeLimitInMegabytes: 8,
            attachmentFileExtensions: ""
        }
    }
}));

vi.mock("../utils/saveImage/ImageManager", () => ({
    downloadAttachment: vi.fn(async (attachment: any) => `/cache/${attachment.id}`),
    getImage: vi.fn(async () => null),
    deleteImage: vi.fn(async () => { })
}));

import { cacheMessageImages } from "../utils/saveImage";
import { downloadAttachment, getImage } from "../utils/saveImage/ImageManager";

beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getImage).mockResolvedValue(null);
});

describe("cacheMessageImages", () => {
    it("downloads attachments and stores their cached path", async () => {
        const attachment: any = { id: "a1", filename: "pic.png", url: "https://cdn/x.png", proxy_url: "https://cdn/p.png" };

        await cacheMessageImages({ attachments: [attachment] } as any);

        expect(vi.mocked(downloadAttachment)).toHaveBeenCalledTimes(1);
        expect(attachment.path).toBe("/cache/a1");
        expect(attachment.fileExtension).toBe(".png");
    });

    it("skips attachments that already have a cached path", async () => {
        vi.mocked(getImage).mockResolvedValueOnce(new Uint8Array([1]) as any);
        const cached: any = { id: "a1", filename: "pic.png", url: "https://cdn/x.png", proxy_url: "https://cdn/p.png", path: "/cache/a1" };
        const fresh: any = { id: "a2", filename: "pic2.png", url: "https://cdn/x2.png", proxy_url: "https://cdn/p2.png" };

        await cacheMessageImages({ attachments: [cached, fresh] } as any);

        expect(vi.mocked(downloadAttachment)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(downloadAttachment).mock.calls[0][0]).toBe(fresh);
        expect(cached.url).toBe("https://cdn/x.png");
        expect(fresh.path).toBe("/cache/a2");
    });

    it("repairs a path whose stored file is missing", async () => {
        const attachment: any = { id: "a1", filename: "pic.png", url: "https://cdn/x.png", path: "/missing/a1.png" };

        await cacheMessageImages({ attachments: [attachment] } as any);

        expect(downloadAttachment).toHaveBeenCalledOnce();
        expect(attachment.path).toBe("/cache/a1");
    });

    it("normalizes MIME extensions without changing remote addresses across failed retries", async () => {
        vi.mocked(downloadAttachment).mockResolvedValueOnce(undefined as any).mockResolvedValueOnce(undefined as any);
        const attachment: any = { id: "a1", filename: "photo", content_type: "image/PNG; charset=utf-8", url: "https://cdn/new", proxy_url: "https://proxy/new", oldUrl: "https://cdn/original" };

        await cacheMessageImages({ attachments: [attachment] } as any);
        await cacheMessageImages({ attachments: [attachment] } as any);

        expect(attachment.fileExtension).toBe(".png");
        expect(attachment.url).toBe("https://cdn/new");
        expect(attachment.proxy_url).toBe("https://proxy/new");
        expect(attachment.oldUrl).toBe("https://cdn/original");
        expect(attachment.path).toBeUndefined();
    });

    it("keeps going when a download fails", async () => {
        vi.mocked(downloadAttachment).mockResolvedValueOnce(undefined as any);
        const failed: any = { id: "a1", filename: "pic.png", url: "https://cdn/x.png", proxy_url: "https://cdn/p.png" };
        const ok: any = { id: "a2", filename: "pic2.png", url: "https://cdn/x2.png", proxy_url: "https://cdn/p2.png" };

        await cacheMessageImages({ attachments: [failed, ok] } as any);

        expect(failed.path).toBeUndefined();
        expect(ok.path).toBe("/cache/a2");
    });

    it("only downloads attachments accepted by the filter", async () => {
        const kept: any = { id: "a1", filename: "kept.png", url: "https://cdn/x.png", proxy_url: "https://cdn/p.png" };
        const removed: any = { id: "a2", filename: "removed.png", url: "https://cdn/x2.png", proxy_url: "https://cdn/p2.png", deleted: true };

        await cacheMessageImages({ attachments: [kept, removed] } as any, attachment => attachment.deleted === true);

        expect(vi.mocked(downloadAttachment)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(downloadAttachment).mock.calls[0][0]).toBe(removed);
        expect(kept.path).toBeUndefined();
        expect(removed.path).toBe("/cache/a2");
    });
});
