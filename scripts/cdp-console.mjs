/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";

const pageWs = process.argv[2];
const seconds = Number(process.argv[3] ?? 15);

const ws = new WebSocket(pageWs);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

let msgId = 0;
const pending = new Map();
const entries = [];

ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
    }
    if (msg.method === "Runtime.consoleAPICalled") {
        const { type, args, stackTrace } = msg.params;
        const text = args.map(a => a.value ?? a.description ?? a.type).join(" ");
        entries.push({ type, text: String(text).slice(0, 500), trace: stackTrace?.[0]?.url ?? "" });
    }
    if (msg.method === "Runtime.exceptionThrown") {
        const d = msg.params.exceptionDetails;
        entries.push({ type: "EXCEPTION", text: String(d.exception?.description ?? d.text).slice(0, 800), trace: d.url ?? "" });
    }
    if (msg.method === "Log.entryAdded") {
        const e = msg.params.entry;
        entries.push({ type: e.level, text: String(e.text).slice(0, 500), trace: e.url ?? "" });
    }
};

function send(method, params = {}) {
    return new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
        ws.send(JSON.stringify({ id, method, params }));
    });
}

await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");

await new Promise(res => setTimeout(res, seconds * 1000));

const interesting = entries.filter(e =>
    !/^\[Flux\]|^\[GatewaySocket|Spellchecker|blackbox|telemetry/i.test(e.text)
);
fs.writeFileSync(process.argv[4] ?? "", interesting.map(e => `[${e.type}] ${e.text}${e.trace ? "  @ " + e.trace : ""}`).join("\n"));
console.log("captured " + interesting.length + " entries");
ws.close();
process.exit(0);
