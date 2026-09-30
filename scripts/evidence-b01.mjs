/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";

const pageWs = process.argv[2];
const outDir = process.argv[3];
const channelPath = process.argv[4];

const ws = new WebSocket(pageWs);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

let msgId = 0;
const pending = new Map();
const consoleErrors = [];

ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
        return;
    }
    if (msg.method === "Runtime.consoleAPICalled" && (msg.params.type === "error" || msg.params.type === "warning")) {
        consoleErrors.push({ type: msg.params.type, text: msg.params.args.map(a => a.value ?? a.description ?? "").join(" ").slice(0, 400) });
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

const INSTALL_PROBE = `
(() => {
    window.__aegisProbe = { resourceErrors: [], navigations: [] };
    document.addEventListener("error", e => {
        const t = e.target;
        if (t == null || t.tagName == null) return;
        const src = t.getAttribute && (t.getAttribute("src") || t.getAttribute("poster"));
        if (typeof src === "string" && src.includes("blob:")) {
            window.__aegisProbe.resourceErrors.push({ tag: t.tagName, src, currentSrc: t.currentSrc || null, at: Date.now() });
        }
    }, true);
    return "probe installed";
})()
`;

const COLLECT = `
(() => {
    const out = { resourceErrors: window.__aegisProbe ? window.__aegisProbe.resourceErrors : [], mangled: [], blobEls: [] };
    const walkFiber = el => {
        const chain = [];
        let key = Object.keys(el).find(k => k.startsWith("__reactFiber$"));
        if (!key) return chain;
        let f = el[key];
        let depth = 0;
        while (f != null && depth < 25) {
            const name = f.type && (f.type.displayName || f.type.name) || null;
            const propKeys = f.memoizedProps ? Object.keys(f.memoizedProps).slice(0, 10) : [];
            const srcProp = f.memoizedProps && (f.memoizedProps.src || f.memoizedProps.poster || f.memoizedProps.url);
            const srcSetProp = f.memoizedProps && f.memoizedProps.srcSet;
            chain.push({ name, propKeys, src: typeof srcProp === "string" ? srcProp.slice(0, 150) : null, srcSet: typeof srcSetProp === "string" ? srcSetProp.slice(0, 250) : null });
            f = f.return;
            depth++;
        }
        return chain;
    };
    const els = document.querySelectorAll("img, video, audio, source");
    for (const el of els) {
        const attrs = {};
        for (const a of el.attributes) attrs[a.name] = a.value;
        const all = [attrs.src, attrs.poster, el.currentSrc].filter(v => typeof v === "string" && v.startsWith("blob:"));
        if (all.length === 0) continue;
        const entry = {
            tag: el.tagName,
            src: (attrs.src || "").slice(0, 200),
            poster: (attrs.poster || "").slice(0, 200),
            srcset: (attrs.srcset || "").slice(0, 300),
            currentSrc: (el.currentSrc || "").slice(0, 200),
            loaded: el.tagName === "IMG" ? (el.complete && el.naturalWidth > 0) : null,
            fiber: walkFiber(el).filter(c => c.name || c.src || c.srcSet)
        };
        out.blobEls.push(entry);
        const combined = [attrs.src, attrs.poster, attrs.srcset, el.currentSrc].filter(Boolean).join(" ");
        if (/blob:[^\\s"']*\\?/.test(combined)) out.mangled.push(entry);
    }
    return JSON.stringify(out);
})()
`;

async function main() {
    await send("Runtime.enable");

    const install = await evalJs(INSTALL_PROBE);
    if (install.exceptionDetails) throw new Error(JSON.stringify(install.exceptionDetails).slice(0, 500));

    await evalJs(`Vencord.Webpack.findByProps("transitionTo").transitionTo(${JSON.stringify(channelPath)})`);
    await sleep(9000);

    const collect = await evalJs(COLLECT);
    if (collect.exceptionDetails) {
        fs.writeFileSync(`${outDir}/exception.txt`, JSON.stringify(collect.exceptionDetails, null, 2));
    }

    const report = {
        channelPath,
        probeConsoleErrors: consoleErrors,
        dom: collect.result?.value ? JSON.parse(collect.result.value) : null
    };

    fs.writeFileSync(`${outDir}/evidence.json`, JSON.stringify(report, null, 2));
    console.log(`resourceErrors=${report.dom?.resourceErrors?.length ?? "?"} mangled=${report.dom?.mangled?.length ?? "?"} blobEls=${report.dom?.blobEls?.length ?? "?"} consoleErrors=${consoleErrors.length}`);
}

await main();
ws.close();
process.exit(0);
