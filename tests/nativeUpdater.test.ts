import { join, resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    readFile: vi.fn(),
    realpath: vi.fn(),
    execFile: vi.fn()
}));
vi.mock("node:fs/promises", () => ({ readFile: mocks.readFile, realpath: mocks.realpath }));
vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));

import { getUpdateStatus, update } from "../native/updater";

const hostRoot = resolve("fixture-host");
const sourceRoot = resolve("fixture-source");
const value = {
    info: { repo: "https://example.test/plugin", branch: "main", gitHash: "h2", installedHash: "h1" },
    changes: [{ hash: "h2", author: "author", message: "fix" }],
    state: "behind",
    pendingBuild: false,
    built: true
};

beforeEach(() => {
    vi.resetAllMocks();
    vi.stubGlobal("__dirname", join(hostRoot, "dist"));
    mocks.realpath.mockImplementation(async path => [sourceRoot, join(sourceRoot, "scripts", "install.mjs"), resolve("different-host")].includes(path) ? path : hostRoot);
    mocks.readFile.mockResolvedValue(JSON.stringify({ schemaVersion: 1, sourceRoot, hostRoot, builtCommit: "h1" }));
    mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, value })));
});

describe("native managed update bridge", () => {
    it("uses the installation record and passes paths as individual arguments", async () => {
        expect((await getUpdateStatus({} as any)).ok).toBe(true);
        expect(mocks.execFile).toHaveBeenCalledWith("node", [
            join(sourceRoot, "scripts", "install.mjs"), "--check", "--vencord-dir", hostRoot, "--json"
        ], expect.objectContaining({ cwd: sourceRoot, windowsHide: true }), expect.any(Function));
    });

    it("requires a matching absolute host and known record version", async () => {
        for (const record of [
            { schemaVersion: 2, sourceRoot, hostRoot },
            { schemaVersion: 1, sourceRoot: "relative", hostRoot },
            { schemaVersion: 1, sourceRoot, hostRoot: resolve("different-host") }
        ]) {
            mocks.readFile.mockResolvedValue(JSON.stringify(record));
            expect(await getUpdateStatus({} as any)).toMatchObject({ ok: false, message: "installation_record_invalid" });
        }
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it("does not scan arbitrary userplugins when the record is absent", async () => {
        mocks.readFile.mockRejectedValue(new Error("missing"));
        expect(await getUpdateStatus({} as any)).toMatchObject({ ok: false });
        expect(mocks.execFile).not.toHaveBeenCalled();
    });

    it("rejects malformed success output and uncompleted updates", async () => {
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, '{"ok":true,"value":{}}'));
        expect(await getUpdateStatus({} as any)).toMatchObject({ ok: false, message: "installer_response_invalid" });
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback(null, JSON.stringify({ ok: true, value: { ...value, built: false } })));
        expect(await update({} as any)).toMatchObject({ ok: false });
    });

    it("reports timeouts and incomplete recovery", async () => {
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback({ killed: true }, ""));
        expect(await update({} as any)).toMatchObject({ ok: false, message: "operation_timed_out; recovery_unconfirmed" });
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback({ code: 1 }, JSON.stringify({ ok: false, error: "build_failed", restored: false })));
        expect(await update({} as any)).toMatchObject({ ok: false, message: "build_failed; recovery_incomplete" });
        const backupRoot = join(hostRoot, "retained-backup");
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => callback({ code: 1 }, JSON.stringify({ ok: false, error: "restore_failed", restored: false, backupRoot })));
        expect(await update({} as any)).toMatchObject({ ok: false, message: `restore_failed; recovery_incomplete; backup: ${backupRoot}` });
    });

    it("prevents duplicate update subprocesses", async () => {
        let finish: any;
        mocks.execFile.mockImplementation((_command, _args, _options, callback) => { finish = callback; });
        const first = update({} as any);
        await vi.waitFor(() => expect(mocks.execFile).toHaveBeenCalledOnce());
        expect(await update({} as any)).toMatchObject({ ok: false, message: "update_busy" });
        finish(null, JSON.stringify({ ok: true, value }));
        expect((await first).ok).toBe(true);
    });
});
