/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFile } from "node:child_process";
import { access, readdir } from "node:fs/promises";
import path from "node:path";

import type { IpcMainInvokeEvent } from "electron";

import { Commit, GitInfo, GitResult } from "../types";

declare const __dirname: string;

const PLUGIN_FOLDER_NAME = "odyssey-aegis-logger";
const GIT_MAX_BUFFER = 64 * 1024 * 1024;

let pluginDirPromise: Promise<string | null> | undefined;

const dirIsPlugin = async (dir: string) => {
    try {
        const files = await readdir(dir);
        return files.includes("settings.tsx") && files.includes("install.cmd");
    } catch {
        return false;
    }
};

async function findPluginDir() {
    const userpluginsDir = path.join(__dirname, "..", "src", "userplugins");

    const fixed = path.join(userpluginsDir, PLUGIN_FOLDER_NAME);
    if (await dirIsPlugin(fixed)) return fixed;

    try {
        for (const entry of await readdir(userpluginsDir)) {
            const dir = path.join(userpluginsDir, entry);
            if (await dirIsPlugin(dir)) return dir;
        }
    } catch { }

    return null;
}

const getPluginDir = () => pluginDirPromise ??= findPluginDir();

const isGitRepo = async (dir: string) => {
    try {
        await access(path.join(dir, ".git"));
        return true;
    } catch {
        return false;
    }
};

async function git(args: string[]): Promise<GitResult> {
    const cmd = `git ${args.join(" ")}`;
    const cwd = await getPluginDir();
    if (cwd == null)
        return { ok: false, cmd, message: "plugin directory not found", error: null };

    if (!await isGitRepo(cwd))
        return { ok: false, cmd, message: "not a git repository", error: null };

    return new Promise(resolve => {
        execFile("git", args, { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true }, (error, stdout, stderr) => {
            if (error)
                resolve({ ok: false, cmd, message: String(stderr || error.message), error });
            else
                resolve({ ok: true, value: String(stdout).trim() });
        });
    });
}

export function parseGitLog(output: string): Commit[] {
    return output
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.includes(";"))
        .map(line => {
            const [hash, author, ...message] = line.split(";");
            return { hash, author, message: message.join(";") };
        });
}

export async function getRepoInfo(_event: IpcMainInvokeEvent): Promise<GitResult> {
    const repo = await git(["remote", "get-url", "origin"]);
    if (!repo.ok) return repo;

    const branch = await git(["branch", "--show-current"]);
    if (!branch.ok) return branch;

    const gitHash = await git(["rev-parse", "HEAD"]);
    if (!gitHash.ok) return gitHash;

    const value: GitInfo = {
        repo: repo.value.replace(/\.git$/, ""),
        branch: branch.value,
        gitHash: gitHash.value
    };
    return { ok: true, value };
}

export async function getNewCommits(_event: IpcMainInvokeEvent): Promise<GitResult> {
    const branch = await git(["branch", "--show-current"]);
    if (!branch.ok) return branch;

    const fetch = await git(["fetch"]);
    if (!fetch.ok) return fetch;

    const log = await git(["log", "--format=%H;%an;%s", `HEAD..origin/${branch.value}`]);
    if (!log.ok) return log;

    return { ok: true, value: parseGitLog(log.value) };
}

export async function update(_event: IpcMainInvokeEvent): Promise<GitResult> {
    return await git(["pull", "--ff-only"]);
}
