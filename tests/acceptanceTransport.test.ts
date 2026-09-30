/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it } from "vitest";

import acceptance from "../scripts/acceptanceLib.mjs";

class TestSocket extends EventTarget {
    sent: string[] = [];

    send(value: string) {
        this.sent.push(value);
    }
}

describe("acceptance CDP lifecycle", () => {
    it("rejects every outstanding request immediately when disconnected", async () => {
        const ws = new TestSocket();
        const client = acceptance.createCdpClient(ws, { timeoutMs: 30000 });
        const requests = Promise.allSettled([client.send("Runtime.enable"), client.evalJson("1")]);
        ws.dispatchEvent(new Event("close"));
        const result = await requests;
        expect(result.every(item => item.status === "rejected")).toBe(true);
        expect(client.pendingCount()).toBe(0);
        await expect(client.send("Runtime.enable")).rejects.toThrow("closed");
        client.dispose();
    });

    it.each(["{", "null", "42"])("settles malformed response %s instead of leaving timers hanging", async data => {
        const ws = new TestSocket();
        const client = acceptance.createCdpClient(ws);
        const rejected = expect(client.send("Runtime.enable")).rejects.toThrow("invalid CDP");
        ws.dispatchEvent(new MessageEvent("message", { data }));
        await rejected;
        expect(client.pendingCount()).toBe(0);
        client.dispose();
    });

    it("reports initialization failure using the same runner used by the scripts", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-init-"));
        const reportPath = path.join(root, "report.json");
        try {
            const report = await acceptance.runAcceptance({
                scriptVersion: "test",
                reportPath,
                execute: async () => { throw new Error("connection failed before open"); }
            });
            expect(report.exitCode).toBe(1);
            expect(report.fatal).toContain("connection failed");
            expect(JSON.parse(fs.readFileSync(reportPath, "utf8")).exitCode).toBe(1);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it("does not return success if report writing fails", async () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), "aegis-write-"));
        try {
            const report = await acceptance.runAcceptance({
                scriptVersion: "test",
                reportPath: root,
                execute: async ({ results }: { results: any[]; }) => { results.push({ status: "pass" }); }
            });
            expect(report.exitCode).toBe(1);
            expect(report.writeError).toBeTruthy();
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });
});
