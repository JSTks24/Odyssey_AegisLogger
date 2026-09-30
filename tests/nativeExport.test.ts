/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import EventEmitter from "node:events";
import { mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Writable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
    renameFailuresLeft: 0,
    renameFailures: 0,
    renameCalls: 0,
    renameGate: null as Promise<void> | null,
    gateFromCall: 0,
    unlinkPaths: [] as string[],
    unlinkFailuresLeft: 0,
    createStream: null as null | ((path: string) => any)
}));

vi.mock("electron", () => ({
    dialog: { showSaveDialog: vi.fn() }
}));

vi.mock("node:fs", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs")>();
    return {
        ...actual,
        createWriteStream: (path: string, options: any) => fsState.createStream?.(path) ?? actual.createWriteStream(path, options)
    };
});

vi.mock("node:fs/promises", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return {
        ...actual,
        rename: vi.fn(async (from: string, to: string) => {
            fsState.renameCalls++;
            if (fsState.gateFromCall > 0 && fsState.renameCalls >= fsState.gateFromCall) await fsState.renameGate;

            if (fsState.renameFailuresLeft > 0) {
                fsState.renameFailuresLeft--;
                fsState.renameFailures++;
                throw Object.assign(new Error(`EPERM: mocked rename failure ${from}`), { code: "EPERM" });
            }

            return actual.rename(from, to);
        }),
        unlink: vi.fn(async (path: string) => {
            fsState.unlinkPaths.push(path);

            if (fsState.unlinkFailuresLeft > 0) {
                fsState.unlinkFailuresLeft--;
                throw Object.assign(new Error(`EPERM: mocked unlink failure ${path}`), { code: "EPERM" });
            }

            return actual.unlink(path);
        })
    };
});

import { dialog } from "electron";

import { cancelNativeLogExport, finishNativeLogExport, getActiveExportSessionCount, startNativeLogExport, writeNativeLogChunk } from "../native/export";

let dir: string;
let targetPath: string;
let sender: EventEmitter;

const makeEvent = () => ({ sender }) as any;

function resolveDialog(path: string) {
    vi.mocked(dialog.showSaveDialog).mockResolvedValue({ filePath: path, canceled: false } as any);
}

async function tempFileNames() {
    return (await readdir(dir)).filter((name: string) => name.includes("aegis-tmp"));
}

async function tempContents() {
    const names = await tempFileNames();
    return await Promise.all(names.map((name: string) => readFile(join(dir, name), "utf-8")));
}

async function waitForTempCount(count: number) {
    await vi.waitFor(async () => {
        expect(await tempFileNames()).toHaveLength(count);
    });
}

function gateRename(call: number) {
    let release = () => { };
    const gate = new Promise<void>(resolve => {
        release = resolve;
    });

    fsState.gateFromCall = call;
    fsState.renameGate = gate;

    return release;
}

function installFakeStream(mode: "finishOnly" | "deferClose") {
    let content = "";
    let pendingDestroy: ((error?: Error | null) => void) | null = null;
    let created: any = null;

    fsState.createStream = (path: string) => {
        created = new Writable({
            autoDestroy: false,
            write(chunk: any, _encoding: any, callback: (error?: Error | null) => void) {
                content += chunk.toString();
                writeFile(path, content, "utf-8").then(() => callback(), (error: Error) => callback(error));
            },
            destroy(error: Error | null, callback: (error?: Error | null) => void) {
                if (mode === "deferClose") {
                    pendingDestroy = callback;
                    return;
                }

                callback(error);
            }
        });

        return created;
    };

    return {
        get stream() {
            return created;
        },
        release() {
            const callback = pendingDestroy;
            pendingDestroy = null;
            callback?.();
        }
    };
}

async function startExport() {
    resolveDialog(targetPath);
    return await startNativeLogExport(makeEvent(), "export.json");
}

beforeEach(async () => {
    vi.clearAllMocks();
    fsState.renameFailuresLeft = 0;
    fsState.renameFailures = 0;
    fsState.renameCalls = 0;
    fsState.gateFromCall = 0;
    fsState.renameGate = null;
    fsState.unlinkPaths = [];
    fsState.unlinkFailuresLeft = 0;
    fsState.createStream = null;
    dir = await mkdtemp(join(tmpdir(), "aegis-export-test-"));
    targetPath = join(dir, "export.json");
    sender = new EventEmitter();
});

afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

describe("finishNativeLogExport", () => {
    it("replaces an existing backup after a clean write", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");
        await finishNativeLogExport(makeEvent(), streamId);

        expect(await readFile(targetPath, "utf-8")).toBe("NEW");
    });

    it("keeps the original backup when the first rename fails but the retry succeeds", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 1;
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");
        await finishNativeLogExport(makeEvent(), streamId);

        expect(rename).toHaveBeenCalledTimes(2);
        expect(await readFile(targetPath, "utf-8")).toBe("NEW");
        expect(await tempFileNames()).toHaveLength(0);
    });

    it("keeps the original backup and preserves the finished export when every rename fails", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow(/original file was kept/);

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
        expect(fsState.unlinkPaths).not.toContain(targetPath);

        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");
    });

    it("keeps the preserved export when the renderer is destroyed after the replacement failed", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow(/Preserved export/);

        sender.emit("destroyed");
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
        expect(fsState.unlinkPaths).not.toContain(targetPath);
        expect(sender.listenerCount("destroyed")).toBe(0);
    });

    it("keeps the preserved export when the renderer cancels after the replacement failed", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow(/Preserved export/);

        await expect(cancelNativeLogExport(makeEvent(), streamId)).resolves.toBeUndefined();
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
        expect(fsState.unlinkPaths).not.toContain(targetPath);
    });

    it("discards the temp file and keeps the target when the temp write fails", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        resolveDialog(join(dir, "missing-dir", "export.json"));

        const streamId = await startNativeLogExport(makeEvent(), "export.json");

        await writeNativeLogChunk(makeEvent(), streamId, "NEW").catch(() => { });
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow();

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        await waitForTempCount(0);
    });

    it("keeps the target untouched when the export is cancelled", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");
        await cancelNativeLogExport(makeEvent(), streamId);

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempFileNames()).toHaveLength(0);
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");
    });

    it("retries the temp file cleanup until the handle is released", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        fsState.unlinkFailuresLeft = 2;
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

        try {
            await cancelNativeLogExport(makeEvent(), streamId);

            expect(fsState.unlinkPaths).toHaveLength(3);
            await waitForTempCount(0);
            expect(errorSpy).not.toHaveBeenCalled();
        } finally {
            errorSpy.mockRestore();
        }
    });

    it("reports a temp file that cannot be removed instead of swallowing it", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        fsState.unlinkFailuresLeft = 99;
        const errorSpy = vi.spyOn(console, "error").mockImplementation(() => { });

        try {
            await cancelNativeLogExport(makeEvent(), streamId);

            expect(fsState.unlinkPaths).toHaveLength(4);
            expect(errorSpy).toHaveBeenCalledTimes(1);
            expect(String(errorSpy.mock.calls[0][0])).toContain("aegis-tmp");
            expect(await readFile(targetPath, "utf-8")).toBe("OLD");
            expect(await tempFileNames()).toHaveLength(1);
        } finally {
            errorSpy.mockRestore();
        }
    });

    it("cleans the incomplete export when the renderer is destroyed while writing", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");
        await waitForTempCount(1);

        sender.emit("destroyed");

        expect(sender.listenerCount("destroyed")).toBe(0);
        expect(getActiveExportSessionCount()).toBe(0);
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");

        await waitForTempCount(0);
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
    });

    it("cleans the incomplete export when the renderer cancels while the stream is finishing", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const fake = installFakeStream("finishOnly");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fake.stream.writableFinished).toBe(true);
        });

        const cancelPromise = cancelNativeLogExport(makeEvent(), streamId);

        await expect(finishPromise).rejects.toThrow();
        await expect(cancelPromise).resolves.toBeUndefined();

        expect(fsState.renameCalls).toBe(0);
        expect(await tempFileNames()).toHaveLength(0);
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
    });

    it("settles finish with a rejection when the renderer is destroyed during the finish wait", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        sender.emit("destroyed");

        await expect(finishPromise).rejects.toThrow();
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        await waitForTempCount(0);
    });
});

describe("stream close discipline", () => {
    it("does not start replacing a fully written export before the stream is really closed", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const fake = installFakeStream("finishOnly");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fake.stream.writableFinished).toBe(true);
        });

        expect(fake.stream.closed).toBe(false);
        expect(fsState.renameCalls).toBe(0);

        fake.stream.destroy();
        await expect(finishPromise).resolves.toBeUndefined();

        expect(fsState.renameCalls).toBe(1);
        expect(await readFile(targetPath, "utf-8")).toBe("NEW");
        expect(await tempFileNames()).toHaveLength(0);
    });

    it("rejects a chunk that arrives once the export started finishing", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const fake = installFakeStream("finishOnly");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fake.stream.writableFinished).toBe(true);
        });

        await expect(writeNativeLogChunk(makeEvent(), streamId, "LATE")).rejects.toThrow("no longer writable");

        fake.stream.destroy();
        await expect(finishPromise).resolves.toBeUndefined();

        expect(await readFile(targetPath, "utf-8")).toBe("NEW");
        expect(await tempFileNames()).toHaveLength(0);
    });

    it("does not unlink an incomplete export before the stream is really closed after a write error", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const fake = installFakeStream("deferClose");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");
        await waitForTempCount(1);

        fake.stream.emit("error", new Error("ENOSPC: mocked write failure"));
        await vi.waitFor(() => {
            expect(fake.stream.destroyed).toBe(true);
        });

        expect(fsState.unlinkPaths).toHaveLength(0);
        expect(await tempFileNames()).toHaveLength(1);

        fake.release();
        await vi.waitFor(() => {
            expect(fsState.unlinkPaths).toHaveLength(1);
        });

        expect(fsState.unlinkPaths[0]).toContain("aegis-tmp");
        await waitForTempCount(0);
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");
    });
});

describe("replacing policy", () => {
    it("keeps the finished export when the renderer is destroyed while a rename is in flight", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const releaseRename = gateRename(1);
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fsState.renameCalls).toBe(1);
        });

        sender.emit("destroyed");
        releaseRename();

        await expect(finishPromise).rejects.toThrow(/Preserved export/);

        expect(fsState.renameCalls).toBe(1);
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
        expect(sender.listenerCount("destroyed")).toBe(0);
        expect(getActiveExportSessionCount()).toBe(0);
    });

    it("keeps the finished export when the renderer is destroyed between rename attempts", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const releaseRetry = gateRename(2);
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fsState.renameFailures).toBe(1);
        });

        sender.emit("destroyed");
        releaseRetry();

        await expect(finishPromise).rejects.toThrow(/Preserved export/);

        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
    });

    it("keeps the finished export when the renderer cancels while a retry rename is in flight", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        fsState.renameFailuresLeft = 99;
        const releaseRetry = gateRename(2);
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fsState.renameCalls).toBe(2);
        });

        const cancelPromise = cancelNativeLogExport(makeEvent(), streamId);
        releaseRetry();

        await expect(finishPromise).rejects.toThrow(/Preserved export/);
        await expect(cancelPromise).resolves.toBeUndefined();

        expect(fsState.renameCalls).toBe(2);
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        expect(await tempContents()).toEqual(["NEW"]);
    });

    it("completes the replacement when a rename in flight succeeds after the renderer cancels", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const releaseRename = gateRename(1);
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const finishPromise = finishNativeLogExport(makeEvent(), streamId);
        await vi.waitFor(() => {
            expect(fsState.renameCalls).toBe(1);
        });

        const cancelPromise = cancelNativeLogExport(makeEvent(), streamId);
        releaseRename();

        await expect(finishPromise).resolves.toBeUndefined();
        await expect(cancelPromise).resolves.toBeUndefined();

        expect(fsState.renameCalls).toBe(1);
        expect(await readFile(targetPath, "utf-8")).toBe("NEW");
        expect(await tempFileNames()).toHaveLength(0);
        expect(fsState.unlinkPaths).toHaveLength(0);
    });
});

describe("session bookkeeping", () => {
    it("shares a single finish and tolerates repeated cancel calls", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        const first = finishNativeLogExport(makeEvent(), streamId);
        const second = finishNativeLogExport(makeEvent(), streamId);

        await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);

        expect(fsState.renameCalls).toBe(1);
        expect(await readFile(targetPath, "utf-8")).toBe("NEW");

        await expect(cancelNativeLogExport(makeEvent(), streamId)).resolves.toBeUndefined();
        await expect(cancelNativeLogExport(makeEvent(), streamId)).resolves.toBeUndefined();

        expect(fsState.unlinkPaths).toHaveLength(0);
        expect(await tempFileNames()).toHaveLength(0);
        expect(getActiveExportSessionCount()).toBe(0);
    });

    it("settles an interleaved write error and destroyed renderer with a single cleanup", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const fake = installFakeStream("deferClose");
        const streamId = await startExport();
        await writeNativeLogChunk(makeEvent(), streamId, "NEW");

        fake.stream.emit("error", new Error("ENOSPC: mocked write failure"));
        await vi.waitFor(() => {
            expect(fake.stream.destroyed).toBe(true);
        });

        sender.emit("destroyed");
        expect(sender.listenerCount("destroyed")).toBe(0);

        fake.release();
        await waitForTempCount(0);
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(fsState.unlinkPaths).toHaveLength(1);
        expect(fsState.unlinkPaths[0]).toContain("aegis-tmp");
        expect(await readFile(targetPath, "utf-8")).toBe("OLD");
        await expect(finishNativeLogExport(makeEvent(), streamId)).rejects.toThrow("Stream not found or closed");
        await expect(cancelNativeLogExport(makeEvent(), streamId)).resolves.toBeUndefined();
    });

    it("releases every destroyed listener and session slot once the exports settle", async () => {
        await writeFile(targetPath, "OLD", "utf-8");
        const baseline = sender.listenerCount("destroyed");

        const completedId = await startExport();
        await writeNativeLogChunk(makeEvent(), completedId, "NEW");
        await finishNativeLogExport(makeEvent(), completedId);

        const cancelledId = await startExport();
        await writeNativeLogChunk(makeEvent(), cancelledId, "NEW");
        await cancelNativeLogExport(makeEvent(), cancelledId);

        fsState.renameFailuresLeft = 99;
        const preservedId = await startExport();
        await writeNativeLogChunk(makeEvent(), preservedId, "NEW");
        await expect(finishNativeLogExport(makeEvent(), preservedId)).rejects.toThrow(/Preserved export/);

        fsState.renameFailuresLeft = 0;
        const destroyedId = await startExport();
        await writeNativeLogChunk(makeEvent(), destroyedId, "NEW");
        sender.emit("destroyed");

        expect(sender.listenerCount("destroyed")).toBe(baseline);
        expect(getActiveExportSessionCount()).toBe(0);

        await waitForTempCount(1);
        expect(await tempContents()).toEqual(["NEW"]);
    });
});
