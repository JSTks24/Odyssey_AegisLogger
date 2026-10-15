/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
    settings: { logsDir: "", imageCacheDir: "" },
    selected: "" as string | undefined,
    save: vi.fn(),
    fetch: vi.fn(),
    read: vi.fn(),
    copy: vi.fn(),
    get: vi.fn()
}));

vi.mock("@main/utils/constants", () => ({ DATA_DIR: "unused-test-directory" }));
vi.mock("../native/settings", () => ({
    getSettings: () => state.get(),
    saveSettings: (value: any) => state.save(value)
}));
vi.mock("electron", () => ({
    dialog: { showOpenDialog: async () => ({ filePaths: state.selected ? [state.selected] : [] }) },
    net: { fetch: (...args: any[]) => state.fetch(...args) },
    shell: {}
}));
vi.mock("node:fs/promises", async importOriginal => {
    const actual = await importOriginal<typeof import("node:fs/promises")>();
    return { ...actual, copyFile: (...args: any[]) => state.copy(...args), readFile: (...args: any[]) => state.read(...args) };
});
vi.mock("../native/export", () => ({}));
vi.mock("../native/import", () => ({}));
vi.mock("../native/updater", () => ({}));

let root: string;
let original: string;
let destination: string;
let native: typeof import("../native");
const event = {} as any;

beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    root = await mkdtemp(path.join(process.cwd(), ".aegislogger-image-test-"));
    original = path.join(root, "original");
    destination = path.join(root, "destination");
    state.settings = { imageCacheDir: original, logsDir: path.join(root, "logs") };
    state.selected = destination;
    state.get.mockImplementation(async () => ({ ...state.settings }));
    state.save.mockImplementation(async value => { state.settings = { ...value }; });
    state.fetch.mockResolvedValue({ status: 200, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer });
    const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
    state.copy.mockImplementation(actual.copyFile);
    state.read.mockImplementation(actual.readFile);
    native = await import("../native");
});

afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
});

async function save(id = "100", bytes = [1, 2, 3]) {
    return native.writeImageNative(event, `${id}.png`, new Uint8Array(bytes));
}

describe("native archived images", () => {
    it("does not restore a source-directory mapping when an old read finishes after a directory switch", async () => {
        await save();
        const source = path.join(original, "100.png");
        let complete: () => void = () => { };
        const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
        state.read.mockImplementationOnce(async filename => {
            await new Promise<void>(resolve => { complete = resolve; });
            return actual.readFile(filename);
        });
        const pending = native.getImageNative(event, "100", ".png");
        await vi.waitFor(() => expect(state.read).toHaveBeenLastCalledWith(source));
        expect(await native.chooseDir(event, "imageCacheDir")).toBe(destination);
        complete();
        expect(await pending).toEqual(Buffer.from([1, 2, 3]));
        expect(native.getNativeSavedImages().get("100")).toBe(path.join(destination, "100.png"));
        await native.deleteFileNative(event, "100");
        expect(await actual.readFile(source)).toEqual(Buffer.from([1, 2, 3]));
        await expect(actual.readFile(path.join(destination, "100.png"))).rejects.toMatchObject({ code: "ENOENT" });
    });

    it("waits for custom directory initialization before scanning or reading", async () => {
        let complete: (value: any) => void = () => { };
        state.get.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        let finished = false;
        const pending = save().then(value => { finished = true; return value; });
        await Promise.resolve();
        await Promise.resolve();
        expect(finished).toBe(false);
        complete(state.settings);

        expect(await pending).toBe(path.join(original, "100.png"));
    });

    it("removes stale mappings and really downloads a deleted image again", async () => {
        await save();
        await native.deleteFileNative(event, "100");

        expect(native.getNativeSavedImages().has("100")).toBe(false);
        const result = await native.downloadAttachment(event, { id: "100", fileExtension: ".png", url: "https://cdn.test/image" } as any);

        expect(result.error).toBeNull();
        expect(state.fetch).toHaveBeenCalledOnce();
        expect(await readFile(result.path!)).toEqual(Buffer.from([1, 2, 3]));
    });

    it("does not accept an externally removed file as a successful archive", async () => {
        const filename = await save();
        await rm(filename!);
        expect(await native.getImageNative(event, "100")).toBeNull();
        expect(native.getNativeSavedImages().has("100")).toBe(false);
        expect(await save()).toBe(filename);
        expect(await native.getImageNative(event, "100")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("finds historical filenames without a dot and normalizes new ones", async () => {
        await native.init();
        await writeFile(path.join(original, "100png"), new Uint8Array([8]));
        expect(await native.getImageNative(event, "100", "png")).toEqual(Buffer.from([8]));

        const result = await native.downloadAttachment(event, { id: "200", fileExtension: "PNG", url: "https://cdn.test/image" } as any);
        expect(result.path).toBe(path.join(original, "200.png"));
        vi.resetModules();
        native = await import("../native");
        expect(await native.getImageNative(event, "200")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("deletes historical filenames using the recorded extension after a cold scan", async () => {
        await native.init();
        const historical = path.join(original, "100png");
        await writeFile(historical, new Uint8Array([8]));
        vi.resetModules();
        native = await import("../native");
        await native.deleteFileNative(event, "100", "png");
        await expect(readFile(historical)).rejects.toMatchObject({ code: "ENOENT" });
        expect(native.getNativeSavedImages().has("100")).toBe(false);
    });

    it("tries the next distinct URL after network and HTTP failures", async () => {
        state.fetch.mockRejectedValueOnce(new Error("network")).mockResolvedValueOnce({ status: 403 });
        const attachment: any = { id: "100", fileExtension: ".png", url: "https://cdn.test/expired", proxy_url: "https://proxy.test/expired", oldUrl: "https://cdn.test/old", oldProxyUrl: "https://cdn.test/expired" };
        const originalAttachment = { ...attachment };

        const result = await native.downloadAttachment(event, attachment);

        expect(result.error).toBeNull();
        expect(state.fetch.mock.calls.map(args => args[0])).toEqual([attachment.url, attachment.proxy_url, attachment.oldUrl]);
        expect(attachment).toEqual(originalAttachment);
    });
});

describe("image directory changes", () => {
    it("copies archives, preserves originals and reads them after restart", async () => {
        await save();
        expect(await native.chooseDir(event, "imageCacheDir")).toBe(destination);
        expect(await readFile(path.join(original, "100.png"))).toEqual(Buffer.from([1, 2, 3]));
        expect(state.settings.imageCacheDir).toBe(destination);

        vi.resetModules();
        native = await import("../native");
        expect(await native.getImageNative(event, "100")).toEqual(Buffer.from([1, 2, 3]));
        expect(native.getNativeSavedImages().get("100")).toBe(path.join(destination, "100.png"));
    });

    it("accepts identical existing files without overwriting them", async () => {
        await save();
        await native.chooseDir(event, "imageCacheDir");
        state.selected = original;

        expect(await native.chooseDir(event, "imageCacheDir")).toBe(original);
        expect(await readdir(original)).toEqual(["100.png"]);
    });

    it("rejects same-name different contents without changing settings or source", async () => {
        await save();
        await native.chooseDir(event, "imageCacheDir");
        await writeFile(path.join(original, "100.png"), new Uint8Array([9, 9, 9]));
        state.selected = original;

        expect(await native.chooseDir(event, "imageCacheDir")).toEqual({ error: "conflict", filename: "100.png" });
        expect(state.settings.imageCacheDir).toBe(destination);
        expect(await native.getImageNative(event, "100")).toEqual(Buffer.from([1, 2, 3]));
        expect(await readFile(path.join(original, "100.png"))).toEqual(Buffer.from([9, 9, 9]));
    });

    it("keeps the old directory usable when copying fails", async () => {
        await save();
        state.copy.mockRejectedValueOnce(Object.assign(new Error("denied"), { code: "EACCES" }));

        expect(await native.chooseDir(event, "imageCacheDir")).toEqual({ error: "copy_failed", filename: "100.png" });
        expect(state.settings.imageCacheDir).toBe(original);
        expect(await native.getImageNative(event, "100")).toEqual(Buffer.from([1, 2, 3]));
    });

    it("keeps the old directory when saving settings fails and reuses copied files on retry", async () => {
        await save();
        state.save.mockRejectedValueOnce(new Error("settings locked"));

        expect(await native.chooseDir(event, "imageCacheDir")).toEqual({ error: "settings_failed" });
        expect(state.settings.imageCacheDir).toBe(original);
        expect(native.getNativeSavedImages().get("100")).toBe(path.join(original, "100.png"));
        expect(await native.chooseDir(event, "imageCacheDir")).toBe(destination);
    });

    it("does not wait for network downloads and saves their bytes in the new directory", async () => {
        let complete: (value: any) => void = () => { };
        state.fetch.mockImplementationOnce(() => new Promise(resolve => { complete = resolve; }));
        const download = native.downloadAttachment(event, { id: "100", fileExtension: ".png", url: "https://cdn.test/image" } as any);
        await vi.waitFor(() => expect(state.fetch).toHaveBeenCalledOnce());

        expect(await native.chooseDir(event, "imageCacheDir")).toBe(destination);
        complete({ status: 200, arrayBuffer: async () => new Uint8Array([7]).buffer });

        expect((await download).path).toBe(path.join(destination, "100.png"));
        expect(await native.getImageNative(event, "100")).toEqual(Buffer.from([7]));
    });

    it("treats cancellation and selecting the current directory as no changes", async () => {
        state.selected = undefined;
        expect(await native.chooseDir(event, "imageCacheDir")).toBeNull();
        state.selected = original;
        expect(await native.chooseDir(event, "imageCacheDir")).toBe(original);
        expect(state.save).not.toHaveBeenCalled();
        expect(state.copy).not.toHaveBeenCalled();
    });
});
