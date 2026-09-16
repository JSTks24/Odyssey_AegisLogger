import fs from "node:fs";

const pageWs = process.argv[2];
const outDir = process.argv[3] ?? ".";
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function evalJs(expr) {
    const r = await send("Runtime.evaluate", { expression: expr, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error("EVAL: " + (r.exceptionDetails.exception?.description ?? "").slice(0, 300));
    return r.result.value;
}

async function click(x, y) {
    await evalJs(`(() => { const el = document.elementFromPoint(${x}, ${y}); if (!el) return "no-target"; for (const type of ["mousedown", "mouseup", "click"]) el.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, view: window })); if (el.tagName === "INPUT" && el.focus) el.focus(); return "ok"; })()`);
}

async function screenshot(name) {
    const result = await send("Page.captureScreenshot", { format: "png" });
    fs.writeFileSync(`${outDir}/${name}.png`, Buffer.from(result.data, "base64"));
}

const results = [];
function record(name, pass, detail) {
    results.push({ name, pass, detail });
    console.log(`${pass ? "PASS" : "FAIL"}  ${name}  ${JSON.stringify(detail)}`);
}

const INPUT_CENTER = `(() => { const r = document.querySelector('.aegis-modal-header input').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`;
const pressKey = key => `(() => { document.querySelector('.aegis-modal-header input').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); return 1; })();`;

await send("Runtime.enable");
await send("Page.enable");

try {
    const reuse = await evalJs("!!document.querySelector('.aegis-modal-header input')");
    if (!reuse) {
        await evalJs("window.Vencord.Plugins.plugins.AegisLogger.openLogModal(); 1");
        await sleep(4500);
    } else {
        await evalJs("(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
        await sleep(300);
    }

    {
        const r = await evalJs("({ focused: document.activeElement === document.querySelector('.aegis-modal-header input'), panel: !!document.querySelector('.aegis-modal-filter-panel') })");
        record("T1 打开默认不聚焦、面板不弹", !r.focused && !r.panel, r);
    }

    {
        const [x, y] = await evalJs(INPUT_CENTER);
        await click(x, y);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(400);
        const r = await evalJs("(() => { const p = document.querySelector('.aegis-modal-filter-panel'); return { panel: !!p, bg: p ? getComputedStyle(p).backgroundColor : null, inLayer: p ? !!p.closest('[class*=layer]') : false }; })()");
        record("T2 点击搜索框弹出悬浮不透明面板", r.panel && r.bg !== "rgba(0, 0, 0, 0)" && r.inLayer, r);
        await screenshot("T2-panel");
    }

    {
        const [x, y] = await evalJs(`(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('来自特定用户')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
        await click(x, y);
        await sleep(400);
        const r = await evalJs("({ pick: !!document.querySelector('.aegis-modal-pick-input'), rows: document.querySelectorAll('.aegis-modal-filter-panel .aegis-modal-filter-item').length })");
        record("T3 鼠标点击进入用户候选层", r.pick && r.rows > 1, r);
    }

    {
        const [x, y] = await evalJs(`(r => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)])(document.querySelector('.aegis-modal-filter-panel .aegis-modal-filter-item').getBoundingClientRect())`);
        await click(x, y);
        await sleep(400);
        const r = await evalJs("({ chip: document.querySelector('.aegis-modal-query-chip')?.textContent?.slice(0, 26), input: document.querySelector('.aegis-modal-header input').value, titles: [...document.querySelectorAll('.aegis-modal-filter-panel-title')].map(e => e.textContent) })");
        record("T4 鼠标点击候选生成芯片并回筛选层", !!r.chip && r.input.startsWith("user:") && r.titles.includes("筛选"), r);
        await screenshot("T4-chip");
    }

    {
        const [x, y] = await evalJs(INPUT_CENTER);
        await click(x, y);
        await sleep(300);
        await evalJs(`${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("Enter")}1`);
        await sleep(300);
        const r = await evalJs("({ hasLayer: [...document.querySelectorAll('.aegis-modal-filter-panel-title')].map(e => e.textContent) })");
        record("T5a 键盘↓↓+Enter 进入包含子层", r.hasLayer.includes("包含"), r);
        await evalJs(`${pressKey("ArrowDown")}${pressKey("Enter")}1`);
        await sleep(350);
        const r2 = await evalJs("({ input: document.querySelector('.aegis-modal-header input').value, chips: document.querySelectorAll('.aegis-modal-query-chip').length })");
        record("T5b 键盘应用 has:image", r2.input.includes("has:image") && r2.chips === 2, r2);
        await screenshot("T5-keyboard");
    }

    {
        const r = await evalJs(`(() => new Promise(res => {
            const input = document.querySelector('.aegis-modal-header input');
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            set.call(input, 'user:1046046570241601586 has:image');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                setTimeout(() => {
                    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                    setTimeout(() => {
                        const panel = !!document.querySelector('.aegis-modal-filter-panel');
                        const rm = document.querySelector('.aegis-modal-query-chip-remove');
                        if (!rm) { res({ panel, rm: false }); return; }
                        const rect = rm.getBoundingClientRect();
                        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
                        for (const t of ['mousedown', 'mouseup', 'click']) hit && hit.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
                        setTimeout(() => res({ panel, hit: hit ? hit.tagName + '|' + String(hit.className).slice(0, 30) : 'none', input: input.value, chips: document.querySelectorAll('.aegis-modal-query-chip').length }), 350);
                    }, 250);
                }, 250);
            }, 300);
        }))()`);
        record("T6 芯片×删除单个筛选", !r.input.includes("user:") && r.input.includes("has:image") && r.chips === 1, r);
    }

    {
        await evalJs(`(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '下载'); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        await sleep(900);
        const r = await evalJs("({ input: document.querySelector('.aegis-modal-header input').value, contexts: document.querySelectorAll('.aegis-modal-msg-context').length, noResult: document.body.textContent.includes('没有找到结果') })");
        record("T7 手输关键词实时过滤", r.input === "下载" && (r.contexts > 0 || r.noResult), r);
        await screenshot("T7-filter");
    }

    {
        await evalJs(`(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        await sleep(300);
        const cleared = await evalJs("document.querySelector('.aegis-modal-header input').value");
        record("T8a 清空查询", cleared === "", { cleared });

        const [ix, iy] = await evalJs(INPUT_CENTER);
        await click(ix, iy);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(300);
        const [bx, by] = await evalJs(`(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('早于特定日期')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
        await click(bx, by);
        await sleep(300);
        const hasDate = await evalJs("!!document.querySelector('.aegis-modal-date-input')");
        record("T8b 点击早于打开内联日期", hasDate, { hasDate });

        await evalJs(`(() => { const input = document.querySelector('.aegis-modal-date-input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '2026-09-01'); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
        const [ax, ay] = await evalJs(`(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-btn')].find(b => !b.className.includes('secondary')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()`);
        await click(ax, ay);
        await sleep(350);
        const r = await evalJs("document.querySelector('.aegis-modal-header input').value");
        record("T8c 应用生成 before 芯片", r.includes("before:2026-09-01"), { input: r });
        await screenshot("T8-date");
    }

    {
        await evalJs(`${pressKey("Escape")}1`);
        await sleep(300);
        const panelGone = !(await evalJs("!!document.querySelector('.aegis-modal-filter-panel')"));
        record("T9 Esc 关闭面板", panelGone, {});
    }

    {
        const r = await evalJs("(() => { const pill = document.querySelector('.aegis-modal-jump-pill'); if (!pill) return { pill: false }; const row = pill.closest('.aegis-modal-msg-context'); const pr = pill.getBoundingClientRect(); const pb = getComputedStyle(row).paddingBottom; return { pill: true, pillH: Math.round(pr.height), rowPaddingBottom: parseFloat(pb) }; })()");
        record("T10 来源 pill 与行间距", r.pill && r.pillH >= 16 && r.rowPaddingBottom >= 4, r);
        await screenshot("T10-pills");
    }
} catch (e) {
    record("EXCEPTION", false, { message: String(e).slice(0, 200) });
}

const pass = results.filter(r => r.pass).length;
console.log(`\n===== ${pass}/${results.length} PASS =====`);
fs.writeFileSync(`${outDir}/full-test-report.json`, JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
