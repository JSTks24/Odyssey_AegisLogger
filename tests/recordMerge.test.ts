/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { adoptAttachmentMetadata, mergeEditHistory } from "../utils/recordMerge";

describe("card history merge", () => {
    const timestamp = "2026-10-26T00:00:00.000Z";
    const edit = (title: string): any => ({ timestamp, content: "same", embeds: [{ type: "rich", title }] });

    it("retains distinct cards with equal text and timestamps in insertion order", () => {
        expect(mergeEditHistory([edit("first")], [edit("second"), edit("third")]).map(item => item.embeds?.[0].title)).toEqual(["first", "second", "third"]);
    });

    it("enriches legacy text history without duplicating the same edit", () => {
        const legacy: any = { timestamp, content: "same", attachments: [{ id: "removed", deleted: true }] };
        const merged = mergeEditHistory([legacy], [edit("card")]);
        expect(merged).toEqual([{ ...legacy, embeds: edit("card").embeds }]);
        expect(mergeEditHistory(merged, [legacy])).toEqual(merged);
    });

    it("deduplicates native normalization and ignores proxy refreshes", () => {
        const first: any = { ...edit("card"), embeds: [{ type: "rich", title: "card", color: 16711680, image: { url: "https://image", proxy_url: "https://old" } }] };
        const next: any = { ...first, embeds: [{ id: "internal", type: "rich", rawTitle: "card", color: "#ff0000", image: { url: "https://image", proxyURL: "https://new" } }] };
        expect(mergeEditHistory([first], [next])).toHaveLength(1);
    });

    it("keeps different text versions containing the key separator", () => {
        const card = { ...edit("card"), content: "status|ready" };
        const text = { timestamp, content: "status" };
        expect(mergeEditHistory([card], [text])).toEqual([text, card]);
    });
});

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
