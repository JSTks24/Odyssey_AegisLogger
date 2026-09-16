import { randomUUID } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ensureDirectoryExists, exists, getAttachmentIdFromFilename, sleep } from "../native/utils";

function makeTempDirPath() {
    return path.join(tmpdir(), `aegis-test-${randomUUID()}`);
}

describe("getAttachmentIdFromFilename", () => {
    it("returns the bare filename without extension", () => {
        expect(getAttachmentIdFromFilename("12345.png")).toBe("12345");
        expect(getAttachmentIdFromFilename("photo.jpg")).toBe("photo");
    });

    it("strips slash separated directory components from traversal strings", () => {
        expect(getAttachmentIdFromFilename("../evil.png")).toBe("evil");
        expect(getAttachmentIdFromFilename("sub/dir/evil.png")).toBe("evil");
    });

    it("strips backslash separated components only where they are separators", () => {
        const traversed = getAttachmentIdFromFilename("..\\evil.png");
        const nested = getAttachmentIdFromFilename("sub\\dir\\evil.png");

        if (path.sep === "\\") {
            expect(traversed).toBe("evil");
            expect(nested).toBe("evil");
        } else {
            expect(traversed).toBe("..\\evil");
            expect(nested).toBe("sub\\dir\\evil");
        }
    });
});

describe("ensureDirectoryExists", () => {
    it("creates a missing directory under the system temp dir", async () => {
        const dir = makeTempDirPath();
        try {
            expect(await exists(dir)).toBe(false);

            await ensureDirectoryExists(dir);

            expect(await exists(dir)).toBe(true);
            expect((await stat(dir)).isDirectory()).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });

    it("does not throw when the directory already exists", async () => {
        const dir = makeTempDirPath();
        await mkdir(dir);
        try {
            await ensureDirectoryExists(dir);

            expect(await exists(dir)).toBe(true);
        } finally {
            await rm(dir, { recursive: true, force: true });
        }
    });
});

describe("sleep", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("resolves only after the requested delay", async () => {
        vi.useFakeTimers();
        let resolved = false;
        const pending = sleep(250).then(() => {
            resolved = true;
        });

        await vi.advanceTimersByTimeAsync(249);
        expect(resolved).toBe(false);

        await vi.advanceTimersByTimeAsync(1);
        await pending;
        expect(resolved).toBe(true);
    });
});
