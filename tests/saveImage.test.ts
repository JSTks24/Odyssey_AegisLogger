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
import { downloadAttachment } from "../utils/saveImage/ImageManager";

beforeEach(() => {
    vi.clearAllMocks();
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
        const cached: any = { id: "a1", filename: "pic.png", url: "https://cdn/x.png", proxy_url: "https://cdn/p.png", path: "/cache/a1" };
        const fresh: any = { id: "a2", filename: "pic2.png", url: "https://cdn/x2.png", proxy_url: "https://cdn/p2.png" };

        await cacheMessageImages({ attachments: [cached, fresh] } as any);

        expect(vi.mocked(downloadAttachment)).toHaveBeenCalledTimes(1);
        expect(vi.mocked(downloadAttachment).mock.calls[0][0]).toBe(fresh);
        expect(cached.url).toBe("https://cdn/x.png");
        expect(fresh.path).toBe("/cache/a2");
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
