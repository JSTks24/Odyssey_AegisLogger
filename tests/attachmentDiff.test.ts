/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import { diffAttachments, mergeRemovedAttachments } from "../utils/attachmentDiff";

const att = (id: string) => ({ id, url: `https://cdn.example/${id}.png` }) as any;

describe("diffAttachments", () => {
    it("reports no change when lists are equivalent", () => {
        const diff = diffAttachments([att("1"), att("2")], [att("2"), att("1")]);
        expect(diff.changed).toBe(false);
        expect(diff.merged).toHaveLength(2);
    });

    it("flags removals as deleted and preserves order", () => {
        const diff = diffAttachments([att("1"), att("2")], [att("2")]);
        expect(diff.changed).toBe(true);
        expect(diff.removed).toHaveLength(1);
        expect(diff.removed[0].id).toBe("1");
        expect(diff.merged[0].id).toBe("1");
        expect(diff.merged[0].deleted).toBe(true);
        expect(diff.merged[1].id).toBe("2");
    });

    it("detects additions", () => {
        const diff = diffAttachments([att("1")], [att("1"), att("2")]);
        expect(diff.changed).toBe(true);
        expect(diff.added).toHaveLength(1);
        expect(diff.added[0].id).toBe("2");
        expect(diff.merged).toHaveLength(2);
        expect(diff.merged[1].deleted).toBeFalsy();
    });

    it("does not re-report already deleted attachments", () => {
        const previous = [{ ...att("1"), deleted: true }, att("2")];
        const diff = diffAttachments(previous, [att("2")]);
        expect(diff.changed).toBe(false);
        expect(diff.merged).toHaveLength(2);
        expect(diff.merged[0].deleted).toBe(true);
    });

    it("handles empty and missing states", () => {
        expect(diffAttachments(undefined, undefined).changed).toBe(false);
        expect(diffAttachments([], undefined).changed).toBe(false);

        const allRemoved = diffAttachments([att("1"), att("2")], []);
        expect(allRemoved.changed).toBe(true);
        expect(allRemoved.merged).toHaveLength(2);
        expect(allRemoved.merged.every(a => a.deleted)).toBe(true);
    });

    it("keeps fresh payload data for surviving attachments", () => {
        const updated = { ...att("1"), filename: "renamed.png" };
        const diff = diffAttachments([att("1")], [updated]);
        expect(diff.changed).toBe(false);
        expect(diff.merged[0].filename).toBe("renamed.png");
    });
});

describe("mergeRemovedAttachments", () => {
    it("logs a removal from the previous snapshot when the live message is gone", () => {
        const previous = { id: "m1", content: "hi", attachments: [att("1")] } as any;
        const payload = { id: "m1", content: "hi", attachments: [], edited_timestamp: "2026-09-18T12:00:00.000Z" } as any;

        const merged = mergeRemovedAttachments(previous.attachments, { ...previous }, payload);

        expect(merged).not.toBeNull();
        expect(merged!.attachments).toHaveLength(1);
        expect(merged!.attachments[0].deleted).toBe(true);
        expect(merged!.editHistory).toHaveLength(1);
        expect(merged!.editHistory[0].content).toBe("hi");
        expect(merged!.editHistory[0].timestamp).toBe("2026-09-18T12:00:00.000Z");
        expect(merged!.editHistory[0].attachments).toBe(merged!.attachments);
    });

    it("reuses the last edit history entry when one exists", () => {
        const previous = {
            id: "m1",
            content: "hi",
            attachments: [att("1")],
            editHistory: [{ content: "first", timestamp: "t1" }]
        } as any;

        const merged = mergeRemovedAttachments(previous.attachments, previous, { attachments: [], edited_timestamp: "t2" } as any);

        expect(merged!.editHistory).toHaveLength(1);
        expect(merged!.editHistory[0].content).toBe("first");
        expect(merged!.editHistory[0].timestamp).toBe("t1");
        expect(merged!.editHistory[0].attachments).toBe(merged!.attachments);
    });

    it("returns null when nothing changed", () => {
        const previous = { id: "m1", attachments: [att("1")] } as any;

        expect(mergeRemovedAttachments(previous.attachments, previous, { attachments: [att("1")] } as any)).toBeNull();
    });

    it("returns null without a previous snapshot or payload attachments", () => {
        const base = { id: "m1", attachments: [] } as any;

        expect(mergeRemovedAttachments(null, base, { attachments: [] } as any)).toBeNull();
        expect(mergeRemovedAttachments(undefined, base, {} as any)).toBeNull();
        expect(mergeRemovedAttachments([att("1")], base, {} as any)).toBeNull();
    });

    it("does not mutate the base message", () => {
        const previous = { id: "m1", content: "hi", attachments: [att("1")] } as any;
        const base = { ...previous };

        mergeRemovedAttachments(previous.attachments, base, { attachments: [] } as any);

        expect(base.attachments).toHaveLength(1);
        expect(base.attachments[0].deleted).toBeUndefined();
        expect(base.editHistory).toBeUndefined();
    });
});
