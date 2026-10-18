/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const odyssey = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.resolve(process.argv[3] ?? odyssey);
const target = path.resolve(process.argv[2] ?? path.join(odyssey, "../../Store/odyssey-search-feedback-20261018/browser-final"));
const ilias = path.resolve(odyssey, "../Ilias_ArgusSentinel");
const require = createRequire(path.join(odyssey, "package.json"));
const esbuildPackage = readdirSync(path.join(odyssey, "node_modules/.pnpm")).find(name => /^esbuild@/.test(name));
const { build } = require(path.join(odyssey, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild"));
const { chromium } = require("playwright");
const react = path.join(ilias, "node_modules/react/index.js");
const reactDom = path.join(ilias, "node_modules/react-dom/client.js");
const reactImport = `import * as React from ${JSON.stringify(react)};`;
mkdirSync(target, { recursive: true });

const common = `${reactImport}
export { React };
export const { useCallback, useEffect, useMemo, useRef, useState } = React;
export const ChannelStore = { getChannel: () => null }, GuildStore = { getGuild: () => null }, GuildMemberStore = { getMember: () => null };
export const Alerts = { show: () => window.fixture.actions.push('clear') }, ContextMenuApi = { openContextMenu: () => window.fixture.actions.push('menu') }, FluxDispatcher = { dispatch() {} }, Menu = {};
export const NavigationRouter = { transitionTo: () => window.fixture.actions.push('jump'), transitionToGuild: () => window.fixture.actions.push('jump') };
export const Tooltip = ({ children }) => children({});
export function TabBar({ children, onItemSelect, selectedItem, className }) { return <nav className={className}>{React.Children.map(children, child => React.cloneElement(child, { onClick: () => onItemSelect(child.props.id), 'aria-pressed': selectedItem === child.props.id }))}</nav>; }
TabBar.Item = ({ children, id, ...props }) => <button data-tab={id} {...props}>{children}</button>;`;
const db = `export const DBMessageStatus = { DELETED: 0, EDITED: 1, GHOST_PINGED: 2 };
export default {
    countMessagesIDB: async () => window.fixture.total,
    getDateStortedMessagesByStatusIDB: async (_sort, limit, _status, offset) => window.fixture.old.slice(offset, offset + limit),
    getMessagesByIDsIDB: ids => window.fixture.request(ids),
    hydrateRecords: async records => ({ records, scope: { release() {} } }),
    deleteMessagesBulkIDB: async () => window.fixture.actions.push('delete'),
    deleteMessageIDB: async () => window.fixture.actions.push('delete')
};`;
const i18n = `const values = {'modal.placeholder':'搜索消息','modal.tab.deleted':'已删除','modal.tab.edited':'已编辑','modal.tab.ghostPinged':'幽灵提及','modal.loading.searching':'正在搜索日志…','modal.loading.more':'加载更多…','modal.loading.initial':'正在加载日志…','modal.clearAll':'清除全部记录','modal.clearVisible':'清除当前显示记录','modal.sort.oldestFirst':'最早优先','modal.sort.newestFirst':'最新优先','modal.empty':'没有日志','modal.noResults':'没有搜索结果','modal.error.loadFailed':'日志加载失败','modal.error.retry':'重试','modal.dm':'私信'};
export const t = key => values[key] ?? key;
export const tabDisplayName = value => value;`;
const stubs = {
    "@webpack/common": common,
    "@webpack": "export const findByPropsLazy = () => ({ closeAllModals() {} });",
    "@api/Styles": "export const classNameFactory = prefix => (...values) => values.flatMap(value => typeof value === 'string' ? [prefix + value] : Object.entries(value).filter(([, enabled]) => enabled).map(([key]) => key)).join(' ');",
    "@components/BaseText": `${reactImport} export const BaseText = ({ children, size, ...props }) => <p {...props}>{children}</p>;`,
    "@components/Button": `${reactImport} export const Button = ({ variant, size, ...props }) => <button {...props} />;`,
    "@components/Flex": `${reactImport} export const Flex = ({ flexDirection, ...props }) => <div {...props} />;`,
    "@components/Icons": `${reactImport} export const InfoIcon = () => <span>i</span>;`,
    "@components/Link": `${reactImport} export const Link = props => <button {...props} />;`,
    "@utils/discord": "export const copyWithToast = () => {}; export const openUserProfile = () => window.fixture.actions.push('profile');",
    "@utils/modal": `${reactImport}
export const ModalSize = { LARGE: 'large' };
export const openModal = () => {};
export const ModalRoot = ({ children, transitionState, onClose, size, ...props }) => <section {...props}>{children}</section>;
export const ModalHeader = props => <header {...props} />;
export const ModalFooter = props => <footer {...props} />;
export const ModalContent = ({ children, className }) => <div className={className}>{children}</div>;`,
    "@utils/react": `${reactImport} export const LazyComponent = factory => { let component; return props => { component ??= factory(); return React.createElement(component, props); }; };`,
    "../db": db,
    "../index": "export const settings = { store: { sortNewest: true, messagesToDisplayAtOnceInLogs: 12 } };",
    "../utils": "export const getGuildIdByChannel = () => null; export const isImageAttachment = () => false;",
    "../utils/i18n": i18n,
    "../utils/logMessageModules": "const state = { version: 0, messagePreview: null }; export default { getSnapshot: () => state, subscribe: () => () => {} };",
    "../utils/messageNavigation": "export default { shouldJump: () => false, getMessagePath: () => '/' };",
    "../utils/searchIndex": "export default { isReady: () => true, search: (...args) => window.fixture.search(...args) };",
    "../utils/parseQuery": "export const tokenizeQuery = query => ({ queries: [], rest: [query] });",
    "../utils/settingsUtils": "export const importLogs = async () => {};",
    "./ClearLogsButton": `${reactImport} export const ClearLogsButton = ({ label }) => <button>{label}</button>;`,
    "./LogsFilterBar": `${reactImport} export default function FilterBar({ query, onChange, onSubmit, placeholder }) { return <form onSubmit={event => { event.preventDefault(); onSubmit(query); }}><input aria-label={placeholder} placeholder={placeholder} value={query} onChange={event => onChange(event.target.value)} /><button type='submit'>搜索</button></form>; }`,
    "./LogsMessageContent": `${reactImport} export default { prepareMessage: () => ({ message: null, removedAttachments: [] }), MessageContent: ({ record }) => <article><p>{record.content}</p><button data-row-action={record.id} onClick={() => window.fixture.actions.push(record.id)}>打开记录</button></article> };`
};
const entry = `${reactImport}
import { createRoot } from ${JSON.stringify(reactDom)};
import logsModal from ${JSON.stringify(path.join(source, "components/LogsModal.tsx"))};
const root = createRoot(document.getElementById('root'));
const record = id => ({ message_id: id, channel_id: 'channel', message: { id, channel_id: 'channel', author: { id: id, username: '用户 ' + id }, timestamp: '2026-10-18T12:00:00Z', content: '日志正文 ' + id, attachments: [] } });
const fixture = window.fixture = {
    total: 40, old: Array.from({ length: 40 }, (_, i) => record('old-' + i)), actions: [], requests: [], started: [], frame: 0, overlayFrame: -1,
    search(_queries, rest, status, limit, _sort, offset) {
        const query = rest[0];
        const overlay = document.querySelector('.aegis-modal-search-overlay');
        this.started.push({ query, status, offset, overlay: !!overlay, paintedFrame: this.overlayFrame >= 0 && this.overlayFrame < this.frame, frame: this.frame });
        const ids = query === 'zero' ? [] : Array.from({ length: limit }, (_, i) => query + ':' + status + ':' + (offset + i));
        return { page: ids.map(id => ({ id })), hasMore: query === 'paged' && offset === 0 };
    },
    request(ids) { return new Promise((resolve, reject) => this.requests.push({ ids, resolve, reject, done: false })); },
    finish(index = this.requests.findLastIndex(request => !request.done), fail = false) {
        const request = this.requests[index];
        if (!request || request.done) return;
        request.done = true;
        if (fail) request.reject(new Error('isolated query failure'));
        else request.resolve(request.ids.map(record));
    },
    show(query = '') { root.render(<logsModal.LogsModal key={Math.random()} modalProps={{ transitionState: 1 }} initalQuery={query} />); },
    hide() { root.render(null); },
    more() { for (const observer of observers) if (observer.element?.isConnected && observer.element.classList.contains('aegis-modal-load-sentinel')) observer.callback([{ isIntersecting: true }]); }
};
const observers = new Set();
window.IntersectionObserver = class { constructor(callback) { this.callback = callback; observers.add(this); } observe(element) { this.element = element; } disconnect() { observers.delete(this); } };
function frame() { fixture.frame++; if (document.querySelector('.aegis-modal-search-overlay')) { if (fixture.overlayFrame < 0) fixture.overlayFrame = fixture.frame; } else fixture.overlayFrame = -1; requestAnimationFrame(frame); }
requestAnimationFrame(frame);
fixture.show();`;
await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: source },
    bundle: true,
    format: "iife",
    outfile: path.join(target, "bundle.js"),
    jsx: "transform",
    plugins: [{
        name: "isolated-search-feedback",
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "fixture" } : undefined);
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "jsx", resolveDir: source }));
        }
    }]
});
const css = readFileSync(path.join(source, "styles.css"), "utf8");
writeFileSync(path.join(target, "index.html"), `<meta charset="utf-8"><style>${css}
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#1e1f22;color:#e5e5e5;--text-default:#e5e5e5;--text-normal:#e5e5e5;--text-muted:#b5bac1;--text-link:#69adff;--background-base-lowest:#1e1f22;--background-base-low:#2b2d31;--background-surface-higher:#313338;--interactive-accent:#5865f2;--interactive-normal:#b5bac1}.aegis-modal-root{margin:5vh auto;height:80vh;display:flex;flex-direction:column;background:#313338;border-radius:12px}.aegis-modal-header{display:flex;padding:20px 24px 0;flex-shrink:0}.aegis-modal-header form button{flex-shrink:0}.aegis-modal-header form{display:flex;gap:12px;width:100%}.aegis-modal-header input{width:100%;height:38px;background:#1e1f22;color:inherit;border:1px solid #54565d;border-radius:6px;padding:8px 12px;font-size:16px}.aegis-modal-tab-bar{display:flex;padding-bottom:16px}.aegis-modal-content-container{flex:1;min-height:0}.aegis-modal-content{overflow:auto;padding:0 24px 20px}.aegis-modal-content-results{min-height:100%}.aegis-modal-footer{display:flex;padding:16px 24px;background:#2b2d31;flex-shrink:0}.aegis-modal-msg-context{padding-top:14px}article{min-height:92px;padding:8px 12px;border-bottom:1px solid #42444a}article p{margin-top:0}button{border:1px solid #6b6d73;border-radius:5px;padding:7px 12px;background:#42444a;color:inherit;cursor:pointer}button:disabled{opacity:.35;cursor:default}.aegis-modal-footer button{margin-right:10px}.aegis-modal-tab-bar button[aria-pressed=true]{border-color:#8c9eff;color:#b9c4ff}.aegis-modal-error-state{padding:50px;display:flex;gap:24px;align-items:center;justify-content:center}body.light{background:#e3e5e8;color:#242529;--text-default:#242529;--text-normal:#242529;--text-muted:#60646c;--text-link:#145ac2;--background-base-lowest:#ebedef;--background-base-low:#f7f7f8;--background-surface-higher:#fff;--interactive-normal:#60646c}body.light .aegis-modal-header input{background:#ebedef;color:#242529}body.light .aegis-modal-root{background:#fff}body.light .aegis-modal-footer{background:#f2f3f5}body.light button{background:#ebedef;color:#242529}</style><div id="root"></div><script src="bundle.js"></script>`);

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--disable-gpu", "--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
const checks = [];
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, actual, expected) => checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const tick = () => page.waitForTimeout(45);
const overlay = () => page.locator(".aegis-modal-search-overlay");
const waitRequest = async count => page.waitForFunction(count => window.fixture.requests.length >= count, count);
const finish = async (index, fail = false) => { await page.evaluate(({ index, fail }) => window.fixture.finish(index, fail), { index, fail }); await tick(); };
const submit = async text => { await page.getByRole("textbox").fill(text); await page.getByRole("textbox").press("Enter"); };
const snapshot = () => page.evaluate(() => {
    const container = document.querySelector(".aegis-modal-content-container");
    const overlay = document.querySelector(".aegis-modal-search-overlay");
    const results = document.querySelector(".aegis-modal-content-results");
    const bounds = overlay?.getBoundingClientRect();
    const viewport = container?.getBoundingClientRect();
    return {
        visible: !!overlay && bounds.width > 0 && bounds.height > 0,
        busy: results?.getAttribute("aria-busy"),
        inert: results?.inert,
        hidden: results?.getAttribute("aria-hidden"),
        modalContentFirst: container?.firstElementChild?.classList.contains("aegis-modal-content"),
        overlayOutsideScroll: overlay?.parentElement === container,
        centered: !!bounds && Math.abs(bounds.left + bounds.width / 2 - viewport.left - viewport.width / 2) < 1 && Math.abs(bounds.top + bounds.height / 2 - viewport.top - viewport.height / 2) < 1,
        clearDisabled: Array.from(document.querySelectorAll("footer button")).find(button => button.textContent === "清除当前显示记录")?.disabled,
        status: overlay?.getAttribute("role"), live: overlay?.getAttribute("aria-live"),
        oldRows: document.querySelectorAll("[data-message-id]").length,
        empty: !!document.querySelector(".aegis-modal-empty-logs")
    };
});
try {
    await page.goto(pathToFileURL(path.join(target, "index.html")).href);
    await page.locator("[data-message-id]").first().waitFor();
    check("initial records displayed", await page.locator("[data-message-id]").count(), 12);
    check("idle has no overlay", await overlay().count(), 0);
    await submit("first");
    await waitRequest(1);
    const loading = await snapshot();
    check("search overlay visible", loading.visible, true);
    check("results container busy", loading.busy, "true");
    check("stale results are inert", loading.inert, true);
    check("stale results hidden from accessibility tree", loading.hidden, "true");
    check("scroll element remains first child", loading.modalContentFirst, true);
    check("overlay outside scroll element", loading.overlayOutsideScroll, true);
    check("overlay centered on result viewport", loading.centered, true);
    check("stale results retained", loading.oldRows, 12);
    check("clear visible disabled during search", loading.clearDisabled, true);
    check("overlay has status role", loading.status, "status");
    check("overlay announces politely", loading.live, "polite");
    check("search began with overlay present", await page.evaluate(() => window.fixture.started[0].overlay), true);
    check("search began after a rendered frame", await page.evaluate(() => window.fixture.started[0].paintedFrame), true);
    check("search input retains focus", await page.getByRole("textbox").evaluate(element => element === document.activeElement), true);
    const beforeActions = await page.evaluate(() => window.fixture.actions.length);
    await page.evaluate(() => document.querySelector("[data-row-action]").focus());
    check("programmatic focus cannot enter inert results", await page.evaluate(() => !!document.activeElement?.closest("[data-message-id]")), false);
    const tabEnteredResults = [];
    for (let i = 0; i < 9; i++) {
        await page.keyboard.press("Tab");
        tabEnteredResults.push(await page.evaluate(() => !!document.activeElement?.closest("[data-message-id]")));
    }
    check("Tab cannot enter inert results", tabEnteredResults.some(Boolean), false);
    await page.locator(".aegis-modal-content").evaluate(element => element.scrollTop = 0);
    await tick();
    const rowBounds = await page.locator("[data-row-action]").first().boundingBox();
    await page.mouse.click(rowBounds.x + rowBounds.width / 2, rowBounds.y + rowBounds.height / 2);
    check("overlay blocks stale row click", await page.evaluate(() => window.fixture.actions.length), beforeActions);
    await page.locator(".aegis-modal-content").evaluate(element => element.scrollTop = 520);
    await tick();
    check("search content can be deeply scrolled for viewport check", await page.locator(".aegis-modal-content").evaluate(element => element.scrollTop > 300), true);
    check("overlay remains centered after scroll", (await snapshot()).centered, true);
    await page.screenshot({ path: path.join(target, "search-overlay-dark-scrolled.png") });
    await page.evaluate(() => document.body.classList.add("light"));
    await page.screenshot({ path: path.join(target, "search-overlay-light.png") });
    await page.evaluate(() => document.body.classList.remove("light"));
    await page.emulateMedia({ reducedMotion: "reduce" });
    check("reduced motion disables spinner animation", await page.evaluate(() => { const element = document.querySelector(".aegis-modal-search-spinner"); return element ? getComputedStyle(element).animationName : null; }), "none");
    await page.emulateMedia({ reducedMotion: "no-preference" });
    await page.getByRole("textbox").fill("editing during search");
    check("query remains editable", await page.getByRole("textbox").inputValue(), "editing during search");
    await finish(0);
    check("success removes overlay", await overlay().count(), 0);
    check("success clears busy", (await snapshot()).busy, "false");
    check("success restores result interaction", (await snapshot()).inert, false);
    check("success renders returned record IDs", await page.locator("[data-message-id]").first().getAttribute("data-message-id"), "first:0:0");
    check("success enables clear visible", (await snapshot()).clearDisabled, false);
    await submit("older"); await waitRequest(2);
    await submit("newer"); await waitRequest(3);
    await finish(1);
    check("late older success keeps new overlay", await overlay().count(), 1);
    check("late older success preserves current records", await page.locator("[data-message-id]").first().getAttribute("data-message-id"), "first:0:0");
    await finish(2);
    check("latest search renders latest IDs", await page.locator("[data-message-id]").first().getAttribute("data-message-id"), "newer:0:0");
    await submit("failure"); await waitRequest(4); await finish(3, true);
    check("failure removes overlay", await overlay().count(), 0);
    check("failure clears busy", (await snapshot()).busy, "false");
    check("failure displays retry", await page.getByRole("button", { name: "重试", exact: true }).count(), 1);
    await page.screenshot({ path: path.join(target, "search-failure-retry.png") });
    await page.getByRole("button", { name: "重试", exact: true }).click(); await waitRequest(5);
    check("retry shows overlay", await overlay().count(), 1);
    await finish(4);
    check("retry success restores records", await page.locator("[data-message-id]").first().getAttribute("data-message-id"), "failure:0:0");
    await submit("zero"); await waitRequest(6);
    check("zero result pending hides empty state", (await snapshot()).empty, false);
    await finish(5);
    check("zero result completed shows empty state", (await snapshot()).empty, true);
    await submit("zero"); await waitRequest(7);
    check("same query submission runs again", await page.evaluate(() => window.fixture.started.filter(item => item.query === "zero").length), 2);
    check("previous empty state hidden while requerying", (await snapshot()).empty, false);
    await finish(6);
    await submit("tabs"); await waitRequest(8);
    await page.getByRole("button", { name: "已编辑", exact: true }).click(); await waitRequest(9);
    check("tabs usable during search", await page.evaluate(() => window.fixture.started.at(-1).status), 1);
    await finish(7, true);
    check("old tab failure cannot hide new overlay", await overlay().count(), 1);
    await finish(8);
    check("new tab records displayed", await page.locator("[data-message-id]").first().getAttribute("data-message-id"), "tabs:1:0");
    await submit("paged"); await waitRequest(10); await finish(9);
    await page.evaluate(() => window.fixture.more()); await waitRequest(11);
    check("pagination does not show search overlay", await overlay().count(), 0);
    check("pagination shows local bottom feedback", await page.locator(".aegis-modal-load-more-text").textContent(), "加载更多…");
    check("pagination leaves records usable", (await snapshot()).inert, false);
    await finish(10);
    check("pagination appends records", await page.locator("[data-message-id]").count(), 24);
    await submit("closed"); await waitRequest(12); await page.evaluate(() => window.fixture.hide()); await tick();
    check("closing removes overlay", await overlay().count(), 0);
    await finish(11);
    check("late closed query cannot reopen modal", await page.locator(".aegis-modal-root").count(), 0);
    await page.evaluate(() => { window.fixture.total = 0; window.fixture.old = []; window.fixture.show("start-empty"); });
    await waitRequest(13);
    check("initial searching overlay appears with total zero", await overlay().count(), 1);
    check("initial total zero does not flash empty logs", (await snapshot()).empty, false);
    await page.screenshot({ path: path.join(target, "search-initial-empty.png") });
    await finish(12);
    check("no React runtime errors", errors, []);
    const failed = checks.filter(item => !item.passed);
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ checks, errors, failed, source }, null, 2));
    process.stdout.write(JSON.stringify({ checks: checks.length, failed, errors, target }) + "\n");
    process.exitCode = failed.length ? 1 : 0;
} catch (error) {
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ checks, errors, failed: checks.filter(item => !item.passed), fatal: String(error), source }, null, 2));
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
} finally {
    await browser.close();
}

