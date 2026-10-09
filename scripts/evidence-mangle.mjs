/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";

const pageWs = process.argv[2];
const outDir = process.argv[3];
const routes = process.argv.slice(4);

if (!/^wss?:\/\//.test(pageWs ?? "") || !outDir || routes.length !== 3
    || routes.some(route => !/^\/channels\/(?:@me|\d{17,20})\/\d{17,20}(?:\/\d{17,20})?$/.test(route))) {
    process.stderr.write("Usage: node scripts/evidence-mangle.mjs <page-websocket> <output-dir> <first-message-route> <intermediate-channel-route> <second-message-route>\nProvide the three Discord /channels/... routes explicitly.\n");
    process.exit(2);
}

const ws = new WebSocket(pageWs);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

let msgId = 0;
const pending = new Map();
const logEntries = [];

ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
    }
    if (msg.method === "Log.entryAdded") {
        const entry = msg.params.entry ?? {};
        const text = `${entry.text ?? ""}`;
        if (text.includes("blob:") || (entry.url ?? "").startsWith("blob:")) {
            logEntries.push({ text: text.slice(0, 300), url: entry.url ?? "", level: entry.level, stack: entry.stackTrace ?? null });
        }
    }
};

function send(method, params = {}) {
    return new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
        ws.send(JSON.stringify({ id, method, params }));
    });
}

function evalJs(expression) {
    return send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
}

async function json(expression) {
    const result = await evalJs(expression);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails).slice(0, 500));
    return result.result.value;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INSTALL_TRAP = `
(() => {
    if (window.__mangleTrap != null) return "already";
    const NativeURL = URL;
    window.__mangleTrap = [];
    window.URL = class extends NativeURL {
        constructor(arg, base) {
            super(arg, base);
            if (typeof arg === "string" && arg.startsWith("blob:")) {
                const rawParams = super.searchParams ?? this.searchParams;
                const trap = window.__mangleTrap;
                const wrapped = new Proxy(rawParams, {
                    get(target, key) {
                        if (key === "append" || key === "set" || key === "delete") {
                            return (...args) => {
                                trap.push({ op: key, args: args.map(String), input: arg, stack: new Error().stack });
                                return target[key](...args);
                            };
                        }
                        const value = Reflect.get(target, key, target);
                        return typeof value === "function" ? value.bind(target) : value;
                    }
                });
                Object.defineProperty(this, "searchParams", { value: wrapped, configurable: true });
            }
        }
    };
    return "trap installed";
})()
`;

async function main() {
    fs.mkdirSync(outDir, { recursive: true });
    await send("Runtime.enable");
    await send("Log.enable");

    const installed = await json(INSTALL_TRAP);
    console.log("trap:", installed);

    await json(`(() => { const nav = window.Vencord.Webpack.Common.NavigationRouter; nav.transitionTo(${JSON.stringify(routes[0])}); return 1; })()`);
    await sleep(9000);

    await json(`(() => { const nav = window.Vencord.Webpack.Common.NavigationRouter; nav.transitionTo(${JSON.stringify(routes[1])}); return 1; })()`);
    await sleep(6000);

    await json(`(() => { const nav = window.Vencord.Webpack.Common.NavigationRouter; nav.transitionTo(${JSON.stringify(routes[2])}); return 1; })()`);
    await sleep(9000);

    const trap = await json(`JSON.stringify(window.__mangleTrap.slice(0, 12))`);
    const trapList = JSON.parse(trap);

    fs.writeFileSync(`${outDir}/mangle-trap.json`, JSON.stringify({ trap: trapList, logEntries }, null, 2));
    console.log(`trap hits: ${trapList.length}, blob log entries: ${logEntries.length}`);

    for (const hit of trapList.slice(0, 4)) {
        console.log("---", hit.op, JSON.stringify(hit.args).slice(0, 80), "input:", hit.input.slice(0, 70));
        console.log((hit.stack ?? "").split("\n").slice(1, 6).map(line => "    " + line.trim().slice(0, 150)).join("\n"));
    }
    for (const entry of logEntries.slice(0, 4)) {
        console.log("LOG:", entry.level, entry.url.slice(0, 90), "|", entry.text.slice(0, 80));
    }
}

await main();
ws.close();
process.exit(0);
