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
const target = path.resolve(process.argv[2] ?? path.join(odyssey, "../../Store/odyssey-inline-tabs-20261018/browser-final"));
const require = createRequire(path.join(odyssey, "package.json"));
const esbuildPackage = readdirSync(path.join(odyssey, "node_modules/.pnpm")).find(name => /^esbuild@/.test(name));
const { build } = require(path.join(odyssey, "node_modules/.pnpm", esbuildPackage, "node_modules/esbuild"));
const { chromium } = require("playwright");
const react = path.resolve(odyssey, "../Ilias_ArgusSentinel/node_modules/react/index.js");
const reactDom = path.resolve(odyssey, "../Ilias_ArgusSentinel/node_modules/react-dom/client.js");
const reactImport = `import * as React from ${JSON.stringify(react)};`;
mkdirSync(target, { recursive: true });

const common = `${reactImport}
export { React };
export const { useCallback, useEffect, useMemo, useRef, useState } = React;
export const ChannelStore = { getChannel: () => ({ id: 'channel', name: '测试频道', isDM: () => false }) }, GuildStore = { getGuild: () => ({ id: 'guild', name: '隔离服务器' }) }, GuildMemberStore = { getMember: () => null };
export const SelectedChannelStore = { getChannelId: () => 'unrelated-channel' };
export const Parser = { parse(text, _inline, options) {
    window.fixture.parses.push({ text, options });
    if (window.fixture.parserUnavailable || (window.fixture.parserFails && text.includes('第一版'))) throw new Error('controlled parser unavailable');
    if (!text.includes('**粗体**')) return text;
    const [prefix, suffix] = text.split('**粗体**');
    return <>{prefix}<strong>粗体</strong>{suffix.split('https://example.invalid')[0]}<a href='https://example.invalid' onClick={event => event.preventDefault()}>https://example.invalid</a><span className='native-emoji'>🙂</span></>;
} };
export const Timestamp = ({ children, timestamp, isEdited }) => <span className='native-edited-timestamp' title={timestamp.toISOString()} data-edited={isEdited}>{children}</span>;
export const Alerts = { show: () => window.fixture.actions.push('clear') }, ContextMenuApi = { openContextMenu: () => window.fixture.actions.push('menu') }, FluxDispatcher = { dispatch() {} }, Menu = {};
export const NavigationRouter = { transitionTo: () => window.fixture.actions.push('jump'), transitionToGuild: () => window.fixture.actions.push('jump') };
export const Tooltip = ({ children }) => children({});
export function TabBar({ children, onItemSelect, selectedItem, className }) { return <nav role='tablist' className={className}>{React.Children.map(children, child => React.cloneElement(child, { onClick: () => onItemSelect(child.props.id), 'aria-selected': selectedItem === child.props.id }))}</nav>; }
TabBar.Item = ({ children, id, ...props }) => <button role='tab' data-tab={id} {...props}>{children}</button>;`;
const modules = `${reactImport}
const listeners = new Set();
function Preview({ message }) {
    window.fixture.nativeInputs.push({ id: message.id, histories: message.editHistory?.length ?? 0 });
    if (window.fixture.previewThrows) throw new Error('controlled native preview failure');
    const history = message.editHistory?.length ? window.fixture.cache[message.id]?.editHistory ?? [] : [];
    return <article className='native-preview'><div className='native-current'>{message.content}</div>{history.map((edit, index) => <div key={index} className='native-cache-edit'>{edit.content}</div>)}</article>;
}
let state = { version: 0, messagePreview: null, privateChannelRecord: null };
export default { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); }, publish(native, throwing = false) { window.fixture.previewThrows = throwing; state = { ...state, version: state.version + 1, messagePreview: native ? Preview : null }; for (const listener of listeners) listener(); } };`;
const i18n = `const values = {'modal.placeholder':'搜索消息','modal.tab.deleted':'已删除','modal.tab.edited':'已编辑','modal.tab.ghostPinged':'幽灵提及','modal.loading.searching':'正在搜索日志…','modal.loading.more':'加载更多…','modal.loading.initial':'正在加载日志…','modal.clearAll':'清除全部记录','modal.clearVisible':'清除当前显示记录','modal.sort.oldestFirst':'最早优先','modal.sort.newestFirst':'最新优先','modal.empty':'没有日志','modal.noResults':'没有搜索结果','modal.error.loadFailed':'日志加载失败','modal.error.retry':'重试','modal.dm':'私信','modal.snapshot.empty':'无文字内容'};
export const t = key => values[key] ?? key;
export const tabDisplayName = value => value;`;
const db = `export const DBMessageStatus = { DELETED: 0, EDITED: 1, GHOST_PINGED: 2 };
export default {
    countMessagesIDB: async () => 21,
    getDateStortedMessagesByStatusIDB: (sort, limit, status, offset) => window.fixture.request({ kind: 'status', status, offset, limit, sort }),
    getMessagesByIDsIDB: ids => window.fixture.request({ kind: 'ids', ids, status: Number(ids[0]?.split('-')[0]), offset: Number(ids[0]?.split('-')[1] ?? 0) }),
    hydrateRecords: async records => ({ records, scope: { release() {} } }),
    deleteMessagesBulkIDB: async () => window.fixture.actions.push('delete'),
    deleteMessageIDB: async () => window.fixture.actions.push('delete')
};`;
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
export const ModalSize = { LARGE: 'large' }, openModal = () => {};
export const ModalRoot = ({ children, transitionState, onClose, size, ...props }) => <section {...props}>{children}</section>;
export const ModalHeader = props => <header {...props} />;
export const ModalFooter = props => <footer {...props} />;
export const ModalContent = ({ children, className }) => <div className={className}>{children}</div>;`,
    "@utils/react": `${reactImport} export const LazyComponent = factory => { let component; return props => { component ??= factory(); return React.createElement(component, props); }; };`,
    "../db": db,
    "../index": "export const settings = { store: { sortNewest: true, messagesToDisplayAtOnceInLogs: 3 } };",
    "../utils": "export const getGuildIdByChannel = () => 'guild'; export const isImageAttachment = () => false; export const messageJsonToMessageClass = ({ message }) => ({ ...message }); export const splitRemovedAttachments = attachments => ({ live: attachments, removed: [] });",
    "../utils/i18n": i18n,
    "../utils/logMessageModules": modules,
    "../utils/searchIndex": "export default { isReady: () => true, search: (...args) => window.fixture.search(...args) };",
    "../utils/parseQuery": "export const tokenizeQuery = query => ({ queries: [], rest: [query] });",
    "../utils/settingsUtils": "export const importLogs = async () => {};",
    "../utils/saveImage": "export const displayAttachmentUrl = url => url; export const acquireAttachmentLease = () => null; export const acquireAttachmentBlobUrl = async () => null;",
    "./ClearLogsButton": `${reactImport} export const ClearLogsButton = ({ label }) => <button>{label}</button>;`,
    "./LogsFilterBar": `${reactImport} export default function FilterBar({ query, onChange, onSubmit, placeholder }) { return <form onSubmit={event => { event.preventDefault(); onSubmit(query); }}><input aria-label={placeholder} value={query} onChange={event => onChange(event.target.value)} /><button type='submit'>搜索</button></form>; }`
};
const entry = `${reactImport}
import { createRoot } from ${JSON.stringify(reactDom)};
import logsModal from ${JSON.stringify(path.join(source, "components/LogsModal.tsx"))};
import modules from '../utils/logMessageModules';
const root = createRoot(document.getElementById('root'));
const record = (status, index) => ({ message_id: status + '-' + index, channel_id: 'channel', status, message: { id: status + '-' + index, channel_id: 'channel', guildId: 'guild', author: { id: 'author', username: '隔离用户' }, timestamp: '2026-10-18T12:00:00Z', content: '当前正文 ' + status + '-' + index, attachments: [], editHistory: status === 1 ? [{ content: '第一版中文 **粗体**\\n链接 https://example.invalid 🙂', timestamp: '2026-10-17T10:00:00Z' }, { content: '第二版中文\\n保留换行', timestamp: '2026-10-17T11:00:00Z' }] : [] } });
const observers = new Set();
const fixture = window.fixture = {
    requests: [], starts: [], actions: [], nativeInputs: [], parses: [], cache: {}, previewThrows: false, parserFails: false, parserUnavailable: false,
    request(details) { return new Promise((resolve, reject) => this.requests.push({ ...details, resolve, reject, done: false })); },
    finish(index = this.requests.length - 1, fail = false) { const request = this.requests[index]; if (!request || request.done) return; request.done = true; if (fail) request.reject(new Error('controlled status query failure')); else request.resolve(request.kind === 'ids' ? request.ids.map(id => record(...id.split('-').map(Number))) : Array.from({ length: Math.max(0, Math.min(request.limit, 7 - request.offset)) }, (_, i) => record(request.status, request.offset + i))); },
    search(_queries, rest, status, limit, _sort, offset) { this.starts.push({ query: rest[0], status, offset, limit }); const size = rest[0] === 'zero' ? 0 : Math.max(0, Math.min(limit, 7 - offset)); return { page: Array.from({ length: size }, (_, i) => ({ id: status + '-' + (offset + i) })), hasMore: offset + size < 7 && size !== 0 }; },
    publish: (native, throwing) => modules.publish(native, throwing),
    show(query = '') { root.render(<logsModal.LogsModal key={Math.random()} modalProps={{ transitionState: 1 }} initalQuery={query} />); }, hide() { root.render(null); },
    more() { for (const observer of Array.from(observers)) if (observer.element?.isConnected && observer.element.classList.contains('aegis-modal-load-sentinel')) observer.callback([{ isIntersecting: true }]); }
};
window.IntersectionObserver = class { constructor(callback) { this.callback = callback; observers.add(this); } observe(element) { this.element = element; } disconnect() { observers.delete(this); } };
fixture.show();`;
await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: source }, bundle: true, format: "iife", outfile: path.join(target, "bundle.js"), jsx: "transform",
    plugins: [{ name: "isolated-inline-tabs", setup(builder) {
        builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "fixture" } : undefined);
        builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "jsx", resolveDir: source }));
    } }]
});
const css = readFileSync(path.join(source, "styles.css"), "utf8");
writeFileSync(path.join(target, "index.html"), `<meta charset="utf-8"><style>${css}
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;--text-normal:#242529;--text-default:#242529;--text-muted:#60646c;--text-link:#145ac2;--background-base-lowest:#ebedef;--background-base-low:#f7f7f8;--background-surface-higher:#fff;--interactive-accent:#5865f2;--interactive-normal:#60646c;--background-modifier-accent:rgba(0,0,0,.08);--custom-message-margin-left-content-cozy:calc(40px + var(--custom-message-margin-horizontal)*2);--custom-message-margin-horizontal:16px;background:#e3e5e8}.aegis-modal-root{margin:3vh auto;height:94vh;display:flex;flex-direction:column;background:var(--background-surface-higher);border-radius:8px}.aegis-modal-header{display:flex;padding:20px 24px 0;flex-shrink:0}.aegis-modal-header form{display:flex;gap:12px;width:100%}.aegis-modal-header input{width:100%;height:36px;background:var(--background-base-lowest);color:var(--text-normal);border:1px solid #80848e;padding:6px 12px;font-size:16px}.aegis-modal-tab-bar{display:flex;padding-bottom:12px}.aegis-modal-content-container{flex:1;min-height:0}.aegis-modal-content{overflow:auto;padding:0 24px 20px}.aegis-modal-content-results{min-height:100%}.aegis-modal-footer{display:flex;gap:12px;padding:16px 24px;background:var(--background-base-low);flex-shrink:0}.aegis-modal-msg-context{padding-top:14px;color:var(--text-muted)}.native-preview{min-height:44px;padding:8px var(--custom-message-margin-horizontal) 0 var(--custom-message-margin-left-content-cozy);color:var(--text-normal)}.native-current{white-space:pre-wrap}button{border:1px solid #80848e;border-radius:4px;padding:7px 12px;background:var(--background-base-lowest);color:var(--text-normal);cursor:pointer}button:disabled{opacity:.35;cursor:default}.aegis-modal-tab-bar button[aria-selected=true]{border-color:var(--text-link);color:var(--text-link)}.aegis-modal-error-state{padding:40px}a{color:var(--text-link)}.native-edited-timestamp{display:inline}
body.dark{--text-normal:#e5e5e5;--text-default:#e5e5e5;--text-muted:#b5bac1;--text-link:#69adff;--background-base-lowest:#1e1f22;--background-base-low:#2b2d31;--background-surface-higher:#313338;--interactive-normal:#b5bac1;--background-modifier-accent:rgba(255,255,255,.08);background:#1e1f22}
</style><div id="root"></div><script src="bundle.js"></script>`);

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--disable-gpu", "--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
const checks = [];
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, actual, expected) => checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const tick = () => page.waitForTimeout(65);
const rows = () => page.locator(".aegis-modal-content-inner > [data-message-id]");
const ids = () => rows().evaluateAll(elements => elements.map(element => element.dataset.messageId));
const first = () => rows().first();
const versionText = async index => { const version = first().locator(".aegis-modal-edit-version").nth(index); return await version.count() ? version.textContent() : null; };
const tab = name => page.getByRole("tab", { name, exact: true });
const requestCount = () => page.evaluate(() => window.fixture.requests.length);
const waitRequest = count => page.waitForFunction(count => window.fixture.requests.length >= count, count);
const finish = async (index, fail = false) => { await page.evaluate(({ index, fail }) => window.fixture.finish(index, fail), { index, fail }); await tick(); };
const publish = async (native, throwing = false) => { await page.evaluate(({ native, throwing }) => window.fixture.publish(native, throwing), { native, throwing }); await tick(); };
const submit = async text => { await page.getByRole("textbox").fill(text); await page.getByRole("textbox").press("Enter"); };
const selected = () => page.locator('[role="tab"][aria-selected="true"]').getAttribute("data-tab");
const loadingCheck = async name => {
    check(name + ": overlay visible", await page.locator(".aegis-modal-search-overlay").isVisible(), true);
    check(name + ": previous classification absent", await ids(), []);
    check(name + ": results inert", await page.locator(".aegis-modal-content-results").evaluate(element => element.inert), true);
    check(name + ": clear current disabled", await page.getByRole("button", { name: "清除当前显示记录", exact: true }).isDisabled(), true);
    check(name + ": no early empty state", await page.locator(".aegis-modal-empty-logs").count(), 0);
};
const historyCheck = async name => {
    check(name + ": two saved versions visible", await first().locator(".aegis-modal-edit-version").count(), 2);
    check(name + ": no fold control", await first().locator("details,summary").count(), 0);
    check(name + ": no snapshot card", await first().locator(".aegis-modal-snapshot-edit").count(), 0);
    check(name + ": no cache duplicate", await first().locator(".native-cache-edit").count(), 0);
    check(name + ": current version remains visible", await first().getByText("当前正文 1-0", { exact: true }).isVisible(), true);
};
try {
    await page.goto(pathToFileURL(path.join(target, "index.html")).href);
    await waitRequest(1);
    check("first open selects Deleted", await selected(), "Deleted");
    check("first open queries Deleted status", await page.evaluate(() => window.fixture.requests[0].status), 0);
    await finish(0);
    check("first open IDs belong to Deleted", await ids(), ["0-0", "0-1", "0-2"]);
    await tab("已编辑").click();
    await tick();
    await loadingCheck("empty query switches to Edited");
    check("Edited highlighter matches request", [await selected(), await page.evaluate(() => window.fixture.requests.at(-1).status)], ["Edited", 1]);
    await finish();
    check("Edited result IDs match selected category", await ids(), ["1-0", "1-1", "1-2"]);
    await historyCheck("module missing and cache empty");
    await publish(true);
    await historyCheck("native module available");
    for (const theme of ["light", "dark"]) {
        await page.evaluate(theme => { document.body.className = theme === "dark" ? "dark" : ""; document.body.style.setProperty("--custom-message-margin-horizontal", theme === "dark" ? "24px" : "16px"); }, theme);
        const state = await first().evaluate(element => {
            const version = element.querySelector(".aegis-modal-edit-version");
            const history = element.querySelector(".aegis-modal-edit-history");
            const native = element.querySelector(".native-current");
            const style = version && getComputedStyle(version);
            const historyStyle = history && getComputedStyle(history);
            return { currentOffset: native ? native.getBoundingClientRect().left - element.getBoundingClientRect().left : null, color: style?.color, muted: getComputedStyle(document.body).getPropertyValue("--text-muted").trim(), opacity: style?.opacity, historyOpacity: historyStyle?.opacity, background: style?.backgroundColor, border: style?.borderLeftWidth, historyBackground: historyStyle?.backgroundColor, historyBorder: historyStyle?.borderLeftWidth, aligned: !!native && !!history && Math.abs(native.getBoundingClientRect().left - history.getBoundingClientRect().left) <= 1, whitespace: style?.whiteSpace, strong: version?.querySelector("strong")?.textContent, link: version?.querySelector("a")?.getAttribute("href"), emoji: version?.querySelector(".native-emoji")?.textContent, lineBreak: version?.textContent.includes("\n"), markers: element.querySelectorAll(".aegis-modal-edit-marker").length, times: Array.from(element.querySelectorAll(".aegis-modal-edit-history .native-edited-timestamp")).map(node => node.title), rawISO: /2026-10-17T/.test(history?.textContent ?? "") };
        });
        check(theme + ": explicit theme grey", state.color, theme === "light" ? "rgb(96, 100, 108)" : "rgb(181, 186, 193)");
        check(theme + ": version fully opaque", state.opacity, "1");
        check(theme + ": history fully opaque", state.historyOpacity, "1");
        check(theme + ": version transparent", state.background, "rgba(0, 0, 0, 0)");
        check(theme + ": version has no border", state.border, "0px");
        check(theme + ": history transparent", state.historyBackground, "rgba(0, 0, 0, 0)");
        check(theme + ": history has no border", state.historyBorder, "0px");
        check(theme + ": independent host cozy layout offset", state.currentOffset, theme === "light" ? 72 : 88);
        check(theme + ": aligned with native current content", state.aligned, true);
        check(theme + ": multiline preserves whitespace", state.whitespace, "pre-wrap");
        check(theme + ": host parser bold", state.strong, "粗体");
        check(theme + ": host parser link", state.link, "https://example.invalid");
        check(theme + ": host parser emoji", state.emoji, "🙂");
        check(theme + ": newline retained", state.lineBreak, true);
        check(theme + ": native edited marker per version", state.markers, 2);
        check(theme + ": timestamp tooltip retained", state.times, ["2026-10-17T10:00:00.000Z", "2026-10-17T11:00:00.000Z"]);
        check(theme + ": ISO dates not in body", state.rawISO, false);
        await page.screenshot({ path: path.join(target, "inline-" + theme + "-native.png") });
    }
    for (const cache of ["missing", "stale", "loaded"]) {
        await page.evaluate(cache => { window.fixture.cache = cache === "missing" ? {} : { "1-0": { editHistory: [{ content: cache === "stale" ? "过期缓存" : "第一版中文" }] } }; }, cache);
        await publish(true);
        await historyCheck("cache " + cache);
    }
    check("native history copies remain clear", await page.evaluate(() => window.fixture.nativeInputs.every(input => input.histories === 0)), true);
    check("parser gets stored channel and message IDs", await page.evaluate(() => window.fixture.parses.every(input => input.options.channelId === "channel" && input.options.messageId.startsWith("1-"))), true);
    await publish(true, true);
    await historyCheck("native preview throws");
    check("fallback history aligns with snapshot body", await first().evaluate(element => { const current = element.querySelector(".aegis-modal-snapshot-text"); const history = element.querySelector(".aegis-modal-edit-history"); return !!current && !!history && Math.abs(current.getBoundingClientRect().left - history.getBoundingClientRect().left) <= 1; }), true);
    await page.screenshot({ path: path.join(target, "inline-dark-fallback.png") });
    await page.evaluate(() => window.fixture.parserFails = true);
    await publish(false);
    check("one parser failure shows plain first version", await versionText(0), "第一版中文 **粗体**\n链接 https://example.invalid 🙂 (已编辑)");
    check("one parser failure keeps second parsed version", await versionText(1), "第二版中文\n保留换行 (已编辑)");
    await page.evaluate(() => { window.fixture.parserFails = false; window.fixture.parserUnavailable = true; });
    await publish(false);
    await historyCheck("parser unavailable");
    check("unavailable parser leaves plain text readable", await versionText(0), "第一版中文 **粗体**\n链接 https://example.invalid 🙂 (已编辑)");
    await page.evaluate(() => window.fixture.parserUnavailable = false);
    await publish(true);
    const jumpsBefore = await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length);
    const selection = await first().locator(".aegis-modal-edit-version").count() ? await first().locator(".aegis-modal-edit-version").nth(1).evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })); return selection.toString(); }) : null;
    check("history text selectable", selection, "第二版中文\n保留换行 (已编辑)");
    check("selecting text does not navigate", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), jumpsBefore);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    if (await first().locator(".aegis-modal-edit-version a").count()) await first().locator(".aegis-modal-edit-version a").evaluate(element => element.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, button: 0 })));
    check("history links do not jump original message", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), jumpsBefore);
    await page.evaluate(() => window.fixture.more());
    await tick();
    check("pagination keeps existing category visible", await ids(), ["1-0", "1-1", "1-2"]);
    check("pagination uses Edited status and next offset", await page.evaluate(() => ({ status: window.fixture.requests.at(-1).status, offset: window.fixture.requests.at(-1).offset })), { status: 1, offset: 3 });
    check("pagination uses bottom feedback", await page.locator(".aegis-modal-load-more-text").isVisible(), true);
    await finish();
    check("pagination appends exact Edited IDs", await ids(), ["1-0", "1-1", "1-2", "1-3", "1-4", "1-5"]);
    await page.locator(".aegis-modal-content").evaluate(element => element.scrollTop = 300);
    await tab("幽灵提及").click();
    await tick();
    await loadingCheck("empty query switches to Ghost Ping");
    check("tab switch resets scroll", await page.locator(".aegis-modal-content").evaluate(element => element.scrollTop), 0);
    check("tab switch resets page offset and limit", await page.evaluate(() => ({ status: window.fixture.requests.at(-1).status, offset: window.fixture.requests.at(-1).offset, limit: window.fixture.requests.at(-1).limit })), { status: 2, offset: 0, limit: 4 });
    await finish();
    check("Ghost selected and IDs consistent", [await selected(), await ids()], ["Ghost Pinged", ["2-0", "2-1", "2-2"]]);
    let count = await requestCount();
    await submit("needle");
    await waitRequest(count + 1);
    check("same tab search retains old IDs", await ids(), ["2-0", "2-1", "2-2"]);
    check("same tab search makes old rows inert", await page.locator(".aegis-modal-content-results").evaluate(element => element.inert), true);
    check("keyboard focus cannot enter retained old row", await first().evaluate(element => { element.tabIndex = 0; element.focus(); return element === document.activeElement; }), false);
    await finish();
    count = await requestCount();
    await submit("needle");
    await waitRequest(count + 1);
    check("identical query Enter starts another active request", await requestCount(), count + 1);
    check("identical query keeps matching selected status", [await selected(), await page.evaluate(() => window.fixture.starts.at(-1).status)], ["Ghost Pinged", 2]);
    await finish();
    await tab("已编辑").click();
    await tick();
    await loadingCheck("keyword query switches to Edited");
    check("keyword tab search context matches highlight", [await selected(), await page.evaluate(() => window.fixture.starts.at(-1).status)], ["Edited", 1]);
    const editedRequest = await requestCount() - 1;
    await tab("已删除").click();
    await tick();
    const deletedRequest = await requestCount() - 1;
    await loadingCheck("fast switch to Deleted");
    await finish(editedRequest);
    await loadingCheck("late Edited reply cannot close Deleted overlay");
    await finish(deletedRequest);
    check("late reply cannot overwrite Deleted IDs", [await selected(), await ids()], ["Deleted", ["0-0", "0-1", "0-2"]]);
    await tab("已编辑").click();
    await tick();
    const failedRequest = await requestCount() - 1;
    await tab("幽灵提及").click();
    await tick();
    const ghostRequest = await requestCount() - 1;
    await finish(failedRequest, true);
    check("obsolete error cannot replace active loading", await page.locator(".aegis-modal-error-state").count(), 0);
    await finish(ghostRequest, true);
    check("active failure clears loading overlay", await page.locator(".aegis-modal-search-overlay").count(), 0);
    check("active failure exposes retry", await page.getByRole("button", { name: "重试", exact: true }).isVisible(), true);
    count = await requestCount();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await waitRequest(count + 1);
    await finish();
    check("retry keeps active category", [await selected(), await ids()], ["Ghost Pinged", ["2-0", "2-1", "2-2"]]);
    await page.evaluate(() => document.body.className = "");
    await tab("已编辑").click();
    await tick();
    await page.screenshot({ path: path.join(target, "inline-light-category-loading.png") });
    const closingRequest = await requestCount() - 1;
    await page.evaluate(() => window.fixture.hide());
    await tick();
    await finish(closingRequest);
    check("closed modal remains unmounted after late reply", await page.locator(".aegis-modal-root").count(), 0);
    count = await requestCount();
    await page.evaluate(() => window.fixture.show());
    await waitRequest(count + 1);
    check("reopen always highlights Deleted", await selected(), "Deleted");
    check("reopen queries Deleted status", await page.evaluate(() => window.fixture.requests.at(-1).status), 0);
    await finish();
    check("reopen data is Deleted first page", await ids(), ["0-0", "0-1", "0-2"]);
    check("reopen query resets empty", await page.getByRole("textbox").inputValue(), "");
    await page.screenshot({ path: path.join(target, "inline-light-reopen-deleted.png") });
    check("no original-channel navigation required", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), jumpsBefore);
    check("no unhandled runtime errors", errors, []);
    const failed = checks.filter(item => !item.passed);
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ source, checks, failed, errors, boundaries: "Actual LogsModal, hooks, LogsMessageContent, local styles and messageNavigation. Controlled host native Preview/Parser/Timestamp/TabBar, module subscription, cache, DB I/O, search index/tokenization and filter input. Theme variables supply colors; no global body text color. Host layout is simulated; no actual Discord or real logs." }, null, 2));
    process.stdout.write(JSON.stringify({ checks: checks.length, failed, errors, target }) + "\n");
    process.exitCode = failed.length ? 1 : 0;
} catch (error) {
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ source, checks, failed: checks.filter(item => !item.passed), errors, fatal: String(error) }, null, 2));
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
} finally {
    await browser.close();
}
