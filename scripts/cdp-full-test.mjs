/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

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

async function trustedClick(x, y) {
    for (const type of ["mousePressed", "mouseReleased"])
        await send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
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

const INPUT_CENTER = "(() => { const r = document.querySelector('.aegis-modal-header input').getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()";
const BOX_STATE = `(() => {
    const input = document.querySelector('.aegis-modal-header input');
    return {
        value: input.value,
        active: !!document.querySelector('.aegis-modal-search-token-active'),
        tokens: [...document.querySelectorAll('.aegis-modal-search-token')].map(e => e.textContent),
        chips: [...document.querySelectorAll('.aegis-modal-query-chip')].map(e => e.textContent),
        focused: document.activeElement === input
    };
})()`;
const SET_INPUT = value => `(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ${JSON.stringify(value)}); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`;
const pressKey = key => `(() => { document.querySelector('.aegis-modal-header input').dispatchEvent(new KeyboardEvent('keydown', { key: '${key}', bubbles: true })); return 1; })();`;

await send("Runtime.enable");
await send("Page.enable");

try {
    const reuse = await evalJs("!!document.querySelector('.aegis-modal-header input')");
    if (!reuse) {
        await evalJs("window.Vencord.Plugins.plugins.AegisLogger.openLogModal(); 1");
        await sleep(4500);
    } else {
        await evalJs(`(async () => {
            const input = document.querySelector('.aegis-modal-header input');
            for (let i = 0; i < 2; i++) {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
            }
            for (let i = 0; i < 12 && document.querySelector('.aegis-modal-query-chip-remove'); i++) {
                document.querySelector('.aegis-modal-query-chip-remove').click();
                await new Promise(r => setTimeout(r, 120));
            }
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            set.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            document.activeElement?.blur?.();
            return 1;
        })()`);
        await sleep(700);
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
        const [x, y] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('来自特定用户')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(x, y);
        await sleep(400);
        const r = await evalJs(`(state => ({ ...state, rows: document.querySelectorAll('.aegis-modal-filter-panel .aegis-modal-filter-item').length }))(${BOX_STATE})`);
        record("T3 鼠标点击进入用户候选层", r.active && r.value === "" && r.rows > 1 && r.focused, r);
    }

    {
        const [x, y] = await evalJs("(r => [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)])(document.querySelector('.aegis-modal-filter-panel .aegis-modal-filter-item').getBoundingClientRect())");
        await click(x, y);
        await sleep(400);
        const r = await evalJs(`(state => ({ ...state, titles: [...document.querySelectorAll('.aegis-modal-filter-panel-title')].map(e => e.textContent) }))(${BOX_STATE})`);
        record("T4 鼠标点击候选生成芯片并回筛选层", r.chips.length === 1 && !r.active && r.tokens.length === 1 && r.value === "" && r.titles.includes("筛选"), r);
        await screenshot("T4-chip");
    }

    {
        const [x, y] = await evalJs(INPUT_CENTER);
        await click(x, y);
        await sleep(300);
        await evalJs(`${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("Enter")}1`);
        await sleep(300);
        const r = await evalJs("({ hasLayer: [...document.querySelectorAll('.aegis-modal-filter-panel-title')].map(e => e.textContent) })");
        record("T5a 键盘↓↓↓↓+Enter 进入包含子层", r.hasLayer.includes("包含"), r);
        await evalJs(`${pressKey("ArrowDown")}${pressKey("ArrowDown")}${pressKey("Enter")}1`);
        await sleep(350);
        const r2 = await evalJs(BOX_STATE);
        record("T5b 键盘应用 has:image", r2.chips.length === 2 && r2.tokens.some(e => e.includes("图片")), r2);
        await screenshot("T5-keyboard");
    }

    {
        const r = await evalJs(`(() => new Promise(res => {
            const rm = document.querySelector('.aegis-modal-query-chip-remove');
            if (!rm) { res({ rm: false }); return; }
            for (const t of ['mousedown', 'mouseup', 'click']) rm.dispatchEvent(new MouseEvent(t, { bubbles: true, cancelable: true, view: window }));
            setTimeout(() => res((state => ({ ...state, hit: rm.tagName }))(${BOX_STATE})), 350);
        }))()`);
        record("T6 芯片×删除单个筛选", r.chips.length === 1 && r.tokens.length === 1 && r.tokens[0].includes("图片") && r.value === "", r);
    }

    {
        await evalJs("(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, '下载'); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
        await sleep(900);
        const r = await evalJs("({ input: document.querySelector('.aegis-modal-header input').value, contexts: document.querySelectorAll('.aegis-modal-msg-context').length, noResult: document.body.textContent.includes('没有找到结果') })");
        record("T7 手输关键词实时过滤", r.input === "下载" && (r.contexts > 0 || r.noResult), r);
        await screenshot("T7-filter");
    }

    {
        await evalJs("(() => { const input = document.querySelector('.aegis-modal-header input'); const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(input, ''); input.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()");
        await sleep(300);
        const cleared = await evalJs("document.querySelector('.aegis-modal-header input').value");
        record("T8a 清空查询", cleared === "", { cleared });

        await evalJs(pressKey("Escape"));
        await sleep(300);
        const [ix, iy] = await evalJs(INPUT_CENTER);
        await click(ix, iy);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(350);
        const [dx, dy] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('日期')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(dx, dy);
        await sleep(350);
        const block = await evalJs("({ add: !!document.querySelector('.aegis-modal-date-add'), label: document.querySelector('.aegis-modal-date-label')?.textContent, hint: document.querySelector('.aegis-modal-date-hint')?.textContent })");
        record("T8b 日期层显示原生式区块与「＋添加日期」", block.add && block.label === "日期" && block.hint === "当消息发送时", block);
    }

    {
        const [ax, ay] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-add'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(ax, ay);
        await sleep(450);
        const r = await evalJs(`(state => ({
            ...state,
            row: !!document.querySelector('.aegis-modal-date-row'),
            field: !!document.querySelector('.aegis-modal-date-field'),
            remove: !!document.querySelector('.aegis-modal-date-remove'),
            expected: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date())
        }))(${BOX_STATE})`);
        record("T8c 添加日期生成今日筛选 + 三格编辑器", r.row && r.field && r.remove && r.chips.some(c => c.includes(r.expected)), r);
    }

    {
        const [fx, fy] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-field'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(fx, fy);
        await sleep(450);
        const cal = await evalJs("({ open: !!document.querySelector('.aegis-modal-calendar'), cells: document.querySelectorAll('.aegis-modal-calendar-day').length, weekdays: document.querySelectorAll('.aegis-modal-calendar-weekday').length, title: document.querySelector('.aegis-modal-calendar-title')?.textContent })");
        record("T8d 点日期框弹出日历（6×7 日格）", cal.open && cal.cells === 42 && cal.weekdays === 7 && !!cal.title, cal);
        await screenshot("T8-calendar");

        const [cx, cy] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-calendar-day')].find(e => e.textContent === \"1\" && !String(e.className).includes(\"outside\")); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(cx, cy);
        await sleep(450);
        const picked = await evalJs(`(state => ({
            ...state,
            closed: !document.querySelector('.aegis-modal-calendar'),
            expected: new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "long", day: "numeric" }).format(new Date(new Date().getFullYear(), new Date().getMonth(), 1))
        }))(${BOX_STATE})`);
        record("T8e 选日期写回筛选并关闭日历", picked.closed && picked.chips.some(c => c.includes(picked.expected)), picked);
    }

    {
        const [sx, sy] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-type'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(sx, sy);
        await sleep(400);
        const list = await evalJs("({ title: document.querySelector('.aegis-modal-filter-panel .aegis-modal-filter-panel-title')?.textContent, rows: [...document.querySelectorAll('.aegis-modal-filter-panel .aegis-modal-filter-item')].map(e => e.textContent.trim()).slice(0, 3) })");
        const [ox, oy] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.trim() === '后'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        if (ox !== 0 || oy !== 0) await click(ox, oy);
        await sleep(400);
        const after = await evalJs(`(state => ({ ...state, editor: !!document.querySelector('.aegis-modal-date-row') }))(${BOX_STATE})`);
        record("T8f 切换类型为「后」并替换筛选", list.title === "更改日期过滤类型" && list.rows.includes("后") && after.editor && after.chips.some(c => c.includes("晚于")), { list, tokens: after.tokens, chips: after.chips });
    }

    {
        const [rx, ry] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-remove'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(rx, ry);
        await sleep(450);
        const r = await evalJs(`(state => ({ ...state, add: !!document.querySelector('.aegis-modal-date-add') }))(${BOX_STATE})`);
        record("T8g 垃圾桶清空日期筛选回到添加态", r.add && !r.chips.some(c => c.includes("早于") || c.includes("晚于")), r);
        await screenshot("T8-date");
    }

    {
        await evalJs(pressKey("Escape"));
        await sleep(300);
        await evalJs(pressKey("Escape"));
        await sleep(300);
        const panelGone = !(await evalJs("!!document.querySelector('.aegis-modal-filter-panel')"));
        record("T9 Esc 逐层关闭面板", panelGone, {});
    }

    {
        const r = await evalJs("(() => { const pill = document.querySelector('.aegis-modal-jump-pill'); if (!pill) return { pill: false }; const row = pill.closest('.aegis-modal-msg-context'); const pr = pill.getBoundingClientRect(); const pb = getComputedStyle(row).paddingBottom; return { pill: true, pillH: Math.round(pr.height), rowPaddingBottom: parseFloat(pb) }; })()");
        record("T10 来源 pill 与行间距", r.pill && r.pillH >= 16 && r.rowPaddingBottom >= 4, r);
        await screenshot("T10-pills");
    }

    {
        const [x, y] = await evalJs(INPUT_CENTER);
        await click(x, y);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(350);
        const [ux, uy] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('来自特定用户')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(ux, uy);
        await sleep(400);

        const steps = [];
        for (const typed of ["ali", "ali ", "ali smith"]) {
            await evalJs(SET_INPUT(typed));
            await sleep(250);
            steps.push(await evalJs(BOX_STATE));
        }

        const ok = steps[0].value === "ali" && steps[1].value === "ali " && steps[2].value === "ali smith"
            && steps.every(s => s.active && s.focused);
        record("T11 收人层输入含空格不被清空", ok, { steps });
        await screenshot("T11-space");
    }

    {
        await evalJs(`(async () => {
            const input = document.querySelector('.aegis-modal-header input');
            for (let i = 0; i < 2; i++) {
                input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
                await new Promise(r => setTimeout(r, 200));
            }
            for (let i = 0; i < 12 && document.querySelector('.aegis-modal-query-chip-remove'); i++) {
                document.querySelector('.aegis-modal-query-chip-remove').click();
                await new Promise(r => setTimeout(r, 120));
            }
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            set.call(input, '');
            input.dispatchEvent(new Event('input', { bubbles: true }));
            await new Promise(r => setTimeout(r, 200));
            document.activeElement?.blur?.();
            return 1;
        })()`);
        await sleep(700);

        const [x, y] = await evalJs(INPUT_CENTER);
        await click(x, y);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(350);
        await send("Input.insertText", { text: "下载 测试" });
        await sleep(300);
        await evalJs(pressKey("ArrowDown"));
        await sleep(600);
        const r = await evalJs(BOX_STATE);
        record("T12 中文与空格输入不被清空", r.value === "下载 测试" && r.focused, r);
        await screenshot("T12-cjk");
    }

    {
        await evalJs(SET_INPUT(""));
        await sleep(400);
        await evalJs(pressKey("Escape"));
        await sleep(1200);
        const r = await evalJs("({ rows: document.querySelectorAll('.aegis-modal-msg-context').length, previews: document.querySelectorAll('.aegis-modal-msg-preview').length, firstText: (document.querySelector('.aegis-modal-msg-preview')?.textContent || '').trim().slice(0, 40) })");
        record("T13 消息正文必须渲染（防懒加载静默置空）", r.rows > 0 && r.previews > 0 && r.firstText.length > 0, r);
    }

    {
        const js = `(async () => {
            const input = document.querySelector('.aegis-modal-header input');
            const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
            const apply = q => { set.call(input, q); input.dispatchEvent(new Event('input', { bubbles: true })); };
            const count = () => document.querySelectorAll('.aegis-modal-msg-context').length;
            for (let i = 0; i < 12 && document.querySelector('.aegis-modal-query-chip-remove'); i++) {
                document.querySelector('.aegis-modal-query-chip-remove').click();
                await new Promise(r => setTimeout(r, 150));
            }
            await apply('');
            await new Promise(r => setTimeout(r, 1500));
            const before = count();
            const t0 = performance.now();
            await apply('has:sound');
            let ms = null;
            for (let i = 0; i < 200; i++) {
                await new Promise(r => setTimeout(r, 25));
                if (count() !== before || document.body.textContent.includes('没有找到结果')) { ms = Math.round(performance.now() - t0); break; }
            }
            const after = count();
            await apply('');
            await new Promise(r => setTimeout(r, 1200));
            return { sparseMs: ms, before, after };
        })()`;
        const r = await evalJs(js);
        record("T15 稀疏检索在索引就绪后应明显变快", r.sparseMs != null && r.sparseMs < 1500, r);
    }

    {
        await evalJs(pressKey("Escape"));
        await sleep(300);
        const [ix, iy] = await evalJs(INPUT_CENTER);
        await click(ix, iy);
        await evalJs("document.querySelector('.aegis-modal-filter-area').dispatchEvent(new FocusEvent('focusin', { bubbles: true })); 1");
        await sleep(400);
        const [dx, dy] = await evalJs("(() => { const el = [...document.querySelectorAll('.aegis-modal-filter-item')].find(e => e.textContent.includes('日期')); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(dx, dy);
        await sleep(350);
        const [ax, ay] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-add') || document.querySelector('.aegis-modal-date-field'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(ax, ay);
        await sleep(450);
        const [fx, fy] = await evalJs("(() => { const el = document.querySelector('.aegis-modal-date-field'); if (!el) return [0, 0]; const r = el.getBoundingClientRect(); return [Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)]; })()");
        await click(fx, fy);
        await sleep(450);
        const opened = await evalJs("({ panel: !!document.querySelector('.aegis-modal-filter-panel'), cal: !!document.querySelector('.aegis-modal-calendar') })");
        await screenshot("T14-before-close");

        await evalJs("window.__closeProbe = []; window.__closeTimer = setInterval(() => { const root = document.querySelector('.aegis-modal-root'); window.__closeProbe.push([Math.round(performance.now()), !!document.querySelector('.aegis-modal-filter-panel'), !!document.querySelector('.aegis-modal-calendar'), !!root]); }, 40); 1");
        await trustedClick(100, 700);
        await sleep(1600);
        const s = await evalJs("(() => { clearInterval(window.__closeTimer); const p = window.__closeProbe; const t0 = p.length ? p[0][0] : 0; const rel = p.map(x => [x[0] - t0, x[1], x[2], x[3]]); const goneAt = i => { const hit = rel.find(x => !x[i]); return hit ? hit[0] : null; }; return { samples: rel.length, panelGoneAt: goneAt(1), calGoneAt: goneAt(2), rootGoneAt: goneAt(3) }; })()");
        const ok = opened.panel && opened.cal && s.panelGoneAt != null && s.rootGoneAt != null
            && s.panelGoneAt <= s.rootGoneAt && s.calGoneAt != null && s.calGoneAt <= s.rootGoneAt;
        record("T14 关窗时面板/日历随大框一起消失", ok, { opened, ...s });
    }
} catch (e) {
    record("EXCEPTION", false, { message: String(e).slice(0, 200) });
}

const pass = results.filter(r => r.pass).length;
console.log(`\n===== ${pass}/${results.length} PASS =====`);
fs.writeFileSync(`${outDir}/full-test-report.json`, JSON.stringify(results, null, 2));
ws.close();
process.exit(0);
