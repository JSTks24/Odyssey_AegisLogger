import { describe, expect, it } from "vitest";
import { diffAttachments } from "../utils/attachmentDiff";

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
