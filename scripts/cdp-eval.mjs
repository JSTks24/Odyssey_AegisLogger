/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import fs from "node:fs";

const pageWs = process.argv[2];
const expr = process.argv[3];
const outFile = process.argv[4];

const ws = new WebSocket(pageWs);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error("ws connect failed")); });

let msgId = 0;
const pending = new Map();
ws.onmessage = ev => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
    }
};

function send(method, params = {}) {
    return new Promise((res, rej) => {
        const id = ++msgId;
        pending.set(id, m => m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result));
        ws.send(JSON.stringify({ id, method, params }));
    });
}

async function main() {
    if (expr === "SCREENSHOT") {
        const result = await send("Page.captureScreenshot", { format: "png" });
        fs.writeFileSync(outFile, Buffer.from(result.data, "base64"));
        console.log("saved " + outFile);
        return;
    }

    if (expr.startsWith("CLICK ")) {
        const [x, y] = expr.slice(6).split(",").map(Number);
        for (const type of ["mousePressed", "mouseReleased"]) {
            await send("Input.dispatchMouseEvent", {
                type, x, y, button: "left", clickCount: 1
            });
        }
        console.log(`clicked ${x},${y}`);
        return;
    }

    const result = await send("Runtime.evaluate", {
        expression: expr,
        awaitPromise: true,
        returnByValue: true,
        userGesture: true
    });

    if (result.exceptionDetails) {
        console.log("ERROR: " + (result.exceptionDetails.exception?.description ?? JSON.stringify(result.exceptionDetails)).slice(0, 3000));
        process.exitCode = 1;
        return;
    }

    const out = JSON.stringify(result.result.value ?? null, null, 2);
    if (outFile) fs.writeFileSync(outFile, out);
    else console.log(out.length > 8000 ? out.slice(0, 8000) : out);
}

await main();
ws.close();
process.exit(0);
