/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { adoptAttachmentMetadata } from "../utils/recordMerge";

describe("attachment metadata", () => {
    it("preserves fresh remote URLs while adopting stored archive metadata", () => {
        const target: any[] = [{ id: "a1", url: "https://cdn/new", proxy_url: "https://proxy/new" }];
        const previous: any[] = [{ id: "a1", path: "/cache/a1.png", fileExtension: ".png", url: "https://cdn/expired", proxy_url: "https://proxy/expired", oldUrl: "https://cdn/original" }];

        adoptAttachmentMetadata(target, previous);

        expect(target[0]).toEqual({ id: "a1", url: "https://cdn/new", proxy_url: "https://proxy/new", path: "/cache/a1.png", fileExtension: ".png", oldUrl: "https://cdn/original" });
    });

    it("does not replace a usable signed URL after a previous download failed", () => {
        const target: any[] = [{ id: "a1", url: "https://cdn/fresh" }];
        adoptAttachmentMetadata(target, [{ id: "a1", url: "https://proxy/expired", oldUrl: "https://cdn/expired" }] as any);

        expect(target[0].url).toBe("https://cdn/fresh");
        expect(target[0].path).toBeUndefined();
    });
});
