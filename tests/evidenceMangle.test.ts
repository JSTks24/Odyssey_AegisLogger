/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const SCRIPT = fileURLToPath(new URL("../scripts/evidence-mangle.mjs", import.meta.url));
const ROUTES = [
    "/channels/100001000000000001/100002000000000001/100003000000000001",
    "/channels/100001000000000001/100002000000000002",
    "/channels/100001000000000001/100002000000000003/100003000000000002"
];
const FIXTURE = `
import { appendFileSync } from "node:fs";
globalThis.setTimeout = callback => queueMicrotask(callback);
globalThis.WebSocket = class {
    constructor() { queueMicrotask(() => this.onopen?.()); }
    send(raw) {
        const message = JSON.parse(raw);
        const expression = message.params?.expression ?? "";
        if (expression.includes("nav.transitionTo")) {
            const route = expression.match(/nav.transitionTo\\(("[^"]+")\\)/)?.[1];
            appendFileSync(process.env.EVIDENCE_TRACE, JSON.parse(route) + "\\n");
        }
        const value = expression.includes("JSON.stringify(window.__mangleTrap") ? "[]" : 1;
        queueMicrotask(() => this.onmessage({ data: JSON.stringify({ id: message.id, result: { result: { value } } }) }));
    }
    close() {}
};
`;

describe("mangle evidence inputs", () => {
    it("requires explicit routes before creating output or connecting", () => {
        const root = mkdtempSync(join(tmpdir(), "aegis-evidence-"));
        const output = join(root, "evidence");
        try {
            for (const routes of [[], ROUTES.slice(0, 2), [ROUTES[0], ROUTES[1], "/channels/private/route"]]) {
                const result = spawnSync(process.execPath, [SCRIPT, "ws://127.0.0.1:1", output, ...routes], { encoding: "utf-8", timeout: 10000 });
                expect(result.status).toBe(2);
                expect(result.stderr).toContain("routes explicitly");
                expect(existsSync(output)).toBe(false);
            }
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it("navigates only the three installer supplied fictitious routes", () => {
        const root = mkdtempSync(join(tmpdir(), "aegis-evidence-"));
        const trace = join(root, "routes.txt");
        try {
            const preload = `data:text/javascript;base64,${Buffer.from(FIXTURE).toString("base64")}`;
            const result = spawnSync(process.execPath, ["--import", preload, SCRIPT, "ws://127.0.0.1:1", root, ...ROUTES], {
                encoding: "utf-8",
                env: { ...process.env, EVIDENCE_TRACE: trace },
                timeout: 10000
            });
            expect(result.status, result.stderr).toBe(0);
            expect(readFileSync(trace, "utf-8").trim().split("\n")).toEqual(ROUTES);
            expect(JSON.parse(readFileSync(join(root, "mangle-trap.json"), "utf-8"))).toEqual({ trap: [], logEntries: [] });
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
