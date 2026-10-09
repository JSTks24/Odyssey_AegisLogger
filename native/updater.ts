/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";

import { Commit, GitResult, UpdateStatus } from "../types";

declare const __dirname: string;

let updatePromise: Promise<GitResult> | undefined;

const failure = (cmd: string, message: string): GitResult => ({ ok: false, cmd, message, error: null });

function validStatus(value: any): boolean {
    return value != null && typeof value.info?.repo === "string" && typeof value.info.branch === "string"
        && typeof value.info.gitHash === "string" && typeof value.pendingBuild === "boolean"
        && ["current", "behind", "ahead", "diverged", "detached", "missing_upstream", "dirty"].includes(value.state)
        && Array.isArray(value.changes) && value.changes.every((commit: any) => typeof commit?.hash === "string"
            && typeof commit.author === "string" && typeof commit.message === "string");
}

async function runInstaller(mode: "check" | "update"): Promise<GitResult> {
    const cmd = `AegisLogger ${mode}`;
    try {
        const hostRoot = await realpath(path.join(__dirname, ".."));
        const record = JSON.parse(await readFile(path.join(hostRoot, ".aegislogger-install.json"), "utf8"));
        if (record.schemaVersion !== 1 || typeof record.sourceRoot !== "string" || typeof record.hostRoot !== "string"
            || !path.isAbsolute(record.sourceRoot) || !path.isAbsolute(record.hostRoot)
            || await realpath(record.hostRoot) !== hostRoot) {
            return failure(cmd, "installation_record_invalid");
        }
        const sourceRoot = await realpath(record.sourceRoot);
        const script = path.join(sourceRoot, "scripts", "install.mjs");
        if (await realpath(script) !== script) return failure(cmd, "installation_script_invalid");
        return await new Promise(resolve => {
            let timer: ReturnType<typeof setTimeout> | undefined;
            let finished = false;
            let timedOut = false;
            const finish = (result: GitResult) => {
                if (finished) return;
                finished = true;
                if (timer) clearTimeout(timer);
                resolve(result);
            };
            const child = execFile("node", [script, `--${mode}`, "--vencord-dir", hostRoot, "--json"], {
                cwd: sourceRoot,
                maxBuffer: 2 * 1024 * 1024,
                windowsHide: true
            }, (error, stdout) => {
                if (timedOut) {
                    finish(failure(cmd, "operation_timed_out; recovery_unconfirmed"));
                    return;
                }
                try {
                    const result = JSON.parse(String(stdout).trim());
                    if (result.ok === true && validStatus(result.value) && !error
                        && (mode === "check" || result.value.built === true)) finish(result);
                    else finish(failure(cmd, String(result.message || result.error || "installer_response_invalid")
                        + (result.restored === false ? "; recovery_incomplete" : "")
                        + (typeof result.backupRoot === "string" ? `; backup: ${result.backupRoot}` : "")));
                } catch {
                    finish(failure(cmd, error?.killed ? "operation_timed_out; recovery_unconfirmed" : "installer_response_invalid"));
                }
            });
            if (!finished) timer = setTimeout(() => {
                timedOut = true;
                if (process.platform === "win32" && child?.pid) {
                    execFile("taskkill", ["/PID", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 10000 }, () => {
                        finish(failure(cmd, "operation_timed_out; recovery_unconfirmed"));
                    });
                } else {
                    child?.kill();
                    finish(failure(cmd, "operation_timed_out; recovery_unconfirmed"));
                }
            }, mode === "check" ? 600000 : 1800000);
        });
    } catch {
        return failure(cmd, "installation_record_missing_or_unavailable; run install.cmd from the Git clone");
    }
}

export function parseGitLog(output: string): Commit[] {
    return output.split("\n").map(line => line.trim()).filter(line => line.includes(";")).map(line => {
        const [hash, author, ...message] = line.split(";");
        return { hash, author, message: message.join(";") };
    });
}

export async function getUpdateStatus(_event: IpcMainInvokeEvent): Promise<GitResult> {
    return runInstaller("check");
}

export async function getRepoInfo(event: IpcMainInvokeEvent): Promise<GitResult> {
    const result = await getUpdateStatus(event);
    return result.ok ? { ok: true, value: (result.value as UpdateStatus).info } : result;
}

export async function getNewCommits(event: IpcMainInvokeEvent): Promise<GitResult> {
    const result = await getUpdateStatus(event);
    return result.ok ? { ok: true, value: (result.value as UpdateStatus).changes } : result;
}

export async function update(_event: IpcMainInvokeEvent): Promise<GitResult> {
    if (updatePromise) return failure("AegisLogger update", "update_busy");
    updatePromise = runInstaller("update");
    try {
        return await updatePromise;
    } finally {
        updatePromise = undefined;
    }
}
