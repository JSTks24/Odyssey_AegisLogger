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
const target = path.resolve(process.argv[2] ?? path.join(odyssey, "../../Store/odyssey-log-history-20261018/browser-final"));
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
export const Parser = { parse: text => text };
export const SelectedChannelStore = { getChannelId: () => 'unrelated-channel' };
export const Timestamp = ({ children, timestamp, isEdited }) => <span className='native-edited-timestamp' title={timestamp.toISOString()} data-edited={isEdited}>{children}</span>;
export const ChannelStore = { getChannel: () => ({ id: 'channel', name: '测试频道', isDM: () => false }) }, GuildStore = { getGuild: () => ({ id: 'guild', name: '隔离服务器' }) }, GuildMemberStore = { getMember: () => null };
export const Alerts = { show: () => window.fixture.actions.push('clear') }, ContextMenuApi = { openContextMenu: () => window.fixture.actions.push('menu') }, FluxDispatcher = { dispatch() {} }, Menu = {};
export const NavigationRouter = { transitionTo: () => window.fixture.actions.push('jump'), transitionToGuild: () => window.fixture.actions.push('jump') };
export const Tooltip = ({ children }) => children({});
export function TabBar({ children, onItemSelect, selectedItem, className }) { return <nav className={className}>{React.Children.map(children, child => React.cloneElement(child, { onClick: () => onItemSelect(child.props.id), 'aria-pressed': selectedItem === child.props.id }))}</nav>; }
TabBar.Item = ({ children, id, ...props }) => <button data-tab={id} {...props}>{children}</button>;`;
const db = `export const DBMessageStatus = { DELETED: 0, EDITED: 1, GHOST_PINGED: 2 };
export default {
    countMessagesIDB: async () => window.fixture.old.length,
    getDateStortedMessagesByStatusIDB: async (_sort, limit, _status, offset) => window.fixture.old.slice(offset, offset + limit),
    getMessagesByIDsIDB: ids => window.fixture.request(ids),
    hydrateRecords: records => window.fixture.hydrate(records),
    deleteMessagesBulkIDB: async () => window.fixture.actions.push('delete'),
    deleteMessageIDB: async () => window.fixture.actions.push('delete')
};`;
const i18n = `const values = {'modal.placeholder':'搜索消息','modal.tab.deleted':'已删除','modal.tab.edited':'已修改','modal.tab.ghostPinged':'幽灵提及','modal.loading.searching':'正在搜索日志…','modal.loading.more':'加载更多…','modal.loading.initial':'正在加载日志…','modal.clearAll':'清除全部记录','modal.clearVisible':'清除当前显示记录','modal.sort.oldestFirst':'最早优先','modal.sort.newestFirst':'最新优先','modal.empty':'没有日志','modal.noResults':'没有搜索结果','modal.error.loadFailed':'日志加载失败','modal.error.retry':'重试','modal.dm':'私信','modal.snapshot.empty':'无文字内容','modal.snapshot.attachmentUnavailable':'附件不可用'};
export const t = (key, params = {}) => key === 'modal.snapshot.history' ? '编辑历史（' + params.count + '）' : values[key] ?? key;
export const tabDisplayName = value => value;`;
const modules = `${reactImport}
const listeners = new Set();
function Preview({ message }) {
    window.fixture.nativeInputs.push({ id: message.id, histories: message.editHistory?.length ?? 0 });
    if (window.fixture.previewThrows) throw new Error('controlled native preview failure');
    const cachedHistory = message.editHistory?.length ? window.fixture.cache[message.id]?.editHistory ?? [] : [];
    return <article className='native-preview' data-native-id={message.id}><div className='native-current'>{message.content}</div>{cachedHistory.map((edit, index) => <div key={index} className='native-cache-edit'>{edit.content}</div>)}</article>;
}
let state = { version: 0, messagePreview: null, privateChannelRecord: null };
export default {
    getSnapshot: () => state,
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    publish(native, throwing = false) { window.fixture.previewThrows = throwing; state = { ...state, version: state.version + 1, messagePreview: native ? Preview : null }; for (const listener of listeners) listener(); }
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
export const ModalSize = { LARGE: 'large' };
export const openModal = () => {};
export const ModalRoot = ({ children, transitionState, onClose, size, ...props }) => <section {...props}>{children}</section>;
export const ModalHeader = props => <header {...props} />;
export const ModalFooter = props => <footer {...props} />;
export const ModalContent = ({ children, className }) => <div className={className}>{children}</div>;`,
    "@utils/react": `${reactImport} export const LazyComponent = factory => { let component; return props => { component ??= factory(); return React.createElement(component, props); }; };`,
    "../db": db,
    "../index": "export const settings = { store: { sortNewest: true, messagesToDisplayAtOnceInLogs: 4 } };",
    "../utils": "export const getGuildIdByChannel = () => 'guild'; export const isImageAttachment = attachment => attachment.content_type?.startsWith('image/') || /\\.(png|jpg)$/i.test(attachment.filename ?? ''); export const messageJsonToMessageClass = ({ message }) => ({ ...message }); export const splitRemovedAttachments = attachments => ({ live: attachments.filter(attachment => !attachment.deleted), removed: attachments.filter(attachment => attachment.deleted) });",
    "../utils/i18n": i18n,
    "../utils/logMessageModules": modules,
    "../utils/searchIndex": "export default { isReady: () => true, search: (...args) => window.fixture.search(...args) };",
    "../utils/parseQuery": "export const tokenizeQuery = query => ({ queries: [], rest: [query] });",
    "../utils/settingsUtils": "export const importLogs = async () => {};",
    "../utils/saveImage": "export const displayAttachmentUrl = url => url; export const acquireAttachmentLease = url => { window.fixture.leaseInputs.push(url); return null; }; export const acquireAttachmentBlobUrl = async attachment => { window.fixture.attachmentReads.push(attachment.id); return { url: window.fixture.pixel, release() { window.fixture.leaseReleases.push(attachment.id); } }; };",
    "./ClearLogsButton": `${reactImport} export const ClearLogsButton = ({ label }) => <button>{label}</button>;`,
    "./LogsFilterBar": `${reactImport} export default function FilterBar({ query, onChange, onSubmit, placeholder }) { return <form onSubmit={event => { event.preventDefault(); onSubmit(query); }}><input aria-label={placeholder} placeholder={placeholder} value={query} onChange={event => onChange(event.target.value)} /><button type='submit'>搜索</button></form>; }`
};
const entry = `${reactImport}
import { createRoot } from ${JSON.stringify(reactDom)};
import logsModal from ${JSON.stringify(path.join(source, "components/LogsModal.tsx"))};
import modules from '../utils/logMessageModules';
const root = createRoot(document.getElementById('root'));
const attachment = id => ({ id, filename: '旧截图-' + id + '.png', path: 'saved/' + id, content_type: 'image/png', width: 160, height: 90 });
const record = id => ({ message_id: id, channel_id: 'channel', message: { id, channel_id: 'channel', guildId: 'guild', author: { id, username: '测试用户' }, timestamp: '2026-10-18T12:00:00Z', content: '当前正文：第三版 ' + id, attachments: id === 'edited-0' ? [{ ...attachment('history-image'), deleted: true }] : [], editHistory: id === 'edited-0' ? [{ content: '编辑前中文：第一版', timestamp: '2026-10-17T10:00:00Z' }, { content: '编辑前中文：第二版', timestamp: '2026-10-17T11:00:00Z', attachments: [attachment('history-image')] }, { content: '', timestamp: '2026-10-17T12:00:00Z' }, { content: 42, timestamp: '2026-10-17T13:00:00Z' }, null] : [{ content: '已保存旧正文 ' + id, timestamp: '2026-10-17T09:00:00Z', attachments: id === 'edited-1' ? [attachment('history-only')] : [] }] } });
const observers = new Set();
const fixture = window.fixture = {
    old: Array.from({ length: 9 }, (_, index) => record('edited-' + index)), actions: [], requests: [], hydrations: [], nativeInputs: [], attachmentReads: [], leaseReleases: [], leaseInputs: [], cache: {}, previewThrows: false,
    pixel: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aY1cAAAAASUVORK5CYII=',
    search(_queries, rest, _status, limit, _sort, offset) { const ids = Array.from({ length: limit }, (_, i) => rest[0] + '-' + (offset + i)); return { page: ids.map(id => ({ id })), hasMore: offset === 0 }; },
    request(ids) { return new Promise((resolve, reject) => this.requests.push({ ids, resolve, reject })); },
    finish(index = this.requests.length - 1) { this.requests[index]?.resolve(this.requests[index].ids.map(record)); },
    hydrate(records) { return new Promise(resolve => this.hydrations.push({ records, resolve })); },
    finishHydration(index) { const request = this.hydrations[index]; if (!request) return; const records = request.records.map(record => ({ ...record, message: { ...record.message, attachments: record.message.attachments.map(attachment => ({ ...attachment, url: this.pixel })), editHistory: record.message.editHistory.filter(Boolean).map(edit => ({ ...edit, attachments: edit.attachments?.map(attachment => ({ ...attachment, url: attachment.id === 'malformed-attachment' ? attachment.url : this.pixel })) })) } })); request.resolve({ records, scope: { release: () => this.actions.push('scope-release') } }); },
    observe(id) { for (const observer of Array.from(observers)) if (observer.element?.isConnected && observer.element.dataset.messageId === id) observer.callback([{ isIntersecting: true }]); },
    more() { for (const observer of Array.from(observers)) if (observer.element?.isConnected && observer.element.classList.contains('aegis-modal-load-sentinel')) observer.callback([{ isIntersecting: true }]); },
    publish: (native, throwing) => modules.publish(native, throwing),
    show() { root.render(<logsModal.LogsModal key={Math.random()} modalProps={{ transitionState: 1 }} />); },
    hide() { root.render(null); }
};
fixture.malformed = () => {
    fixture.hide();
    const malformed = record('malformed-optional');
    malformed.message.editHistory[0].content = '异常附件字段不能隐藏这份历史';
    malformed.message.editHistory[0].attachments = [{ ...attachment('malformed-attachment'), filename: { invalid: true }, url: { invalid: true } }];
    fixture.old = [malformed];
    modules.publish(false);
    fixture.show();
};
window.IntersectionObserver = class { constructor(callback) { this.callback = callback; observers.add(this); } observe(element) { this.element = element; } disconnect() { observers.delete(this); } };
fixture.show();`;
await build({
    stdin: { contents: entry, loader: "tsx", resolveDir: source },
    bundle: true,
    format: "iife",
    outfile: path.join(target, "bundle.js"),
    jsx: "transform",
    plugins: [{
        name: "isolated-log-history",
        setup(builder) {
            builder.onResolve({ filter: /.*/ }, args => args.path in stubs ? { path: args.path, namespace: "fixture" } : undefined);
            builder.onLoad({ filter: /.*/, namespace: "fixture" }, args => ({ contents: stubs[args.path], loader: "jsx", resolveDir: source }));
        }
    }]
});
const css = readFileSync(path.join(source, "styles.css"), "utf8");
writeFileSync(path.join(target, "index.html"), `<meta charset="utf-8"><style>${css}
*{box-sizing:border-box}body{margin:0;font-family:Arial,sans-serif;background:#1e1f22;color:#e5e5e5;--text-default:#e5e5e5;--text-normal:#e5e5e5;--text-muted:#b5bac1;--text-link:#69adff;--background-base-lowest:#1e1f22;--background-base-low:#2b2d31;--background-surface-higher:#313338;--interactive-accent:#5865f2;--interactive-normal:#b5bac1}.aegis-modal-root{margin:4vh auto;height:88vh;display:flex;flex-direction:column;background:#313338;border-radius:12px}.aegis-modal-header{display:flex;padding:20px 24px 0;flex-shrink:0}.aegis-modal-header form{display:flex;gap:12px;width:100%}.aegis-modal-header input{width:100%;height:38px;background:#1e1f22;color:inherit;border:1px solid #54565d;border-radius:6px;padding:8px 12px;font-size:16px}.aegis-modal-tab-bar{display:flex;padding-bottom:16px}.aegis-modal-content-container{flex:1;min-height:0}.aegis-modal-content{overflow:auto;padding:0 24px 20px}.aegis-modal-content-results{min-height:100%}.aegis-modal-footer{display:flex;padding:16px 24px;background:#2b2d31;flex-shrink:0}.aegis-modal-msg-context{padding-top:14px}.native-preview{padding:8px 16px 0 72px;min-height:44px}button{border:1px solid #6b6d73;border-radius:5px;padding:7px 12px;background:#42444a;color:inherit;cursor:pointer}button:disabled{opacity:.35;cursor:default}.aegis-modal-footer button{margin-right:10px}.aegis-modal-tab-bar button[aria-pressed=true]{border-color:#8c9eff;color:#b9c4ff}.aegis-modal-error-state{padding:50px}</style><div id="root"></div><script src="bundle.js"></script>`);

const browser = await chromium.launch({ executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe", headless: true, args: ["--disable-gpu", "--allow-file-access-from-files"] });
const page = await browser.newPage({ viewport: { width: 1150, height: 1000 } });
const checks = [];
const errors = [];
page.on("pageerror", error => errors.push(error.message));
const check = (name, actual, expected) => checks.push({ name, passed: JSON.stringify(actual) === JSON.stringify(expected), actual, expected });
const tick = () => page.waitForTimeout(60);
const rows = () => page.locator(".aegis-modal-content-inner > [data-message-id]");
const first = () => rows().first();
const historyState = () => first().evaluate(element => ({
    controls: element.querySelectorAll("details, summary").length,
    count: element.querySelectorAll(".aegis-modal-edit-version").length,
    texts: Array.from(element.querySelectorAll(".aegis-modal-edit-version")).map(node => { const copy = node.cloneNode(true); copy.querySelectorAll(".aegis-modal-snapshot-attachments").forEach(item => item.remove()); return copy.textContent.replace(/ \(已修改\)$/u, ""); }),
    times: Array.from(element.querySelectorAll(".aegis-modal-edit-version .native-edited-timestamp")).map(node => node.title),
    markers: element.querySelectorAll(".aegis-modal-edit-marker").length,
    nativeCopies: element.querySelectorAll(".native-cache-edit").length
}));
const assertHistory = async name => {
    const state = await historyState();
    check(name + ": no disclosure controls", state.controls, 0);
    check(name + ": all stored valid versions", state.count, 4);
    check(name + ": Chinese and empty versions in order", state.texts, ["编辑前中文：第一版", "编辑前中文：第二版", "", ""]);
    check(name + ": timestamps available through native markers", state.times, ["2026-10-17T10:00:00.000Z", "2026-10-17T11:00:00.000Z", "2026-10-17T12:00:00.000Z", "2026-10-17T13:00:00.000Z"]);
    check(name + ": marker for every version including malformed body", state.markers, 4);
    check(name + ": no native history duplicate", state.nativeCopies, 0);
};
const publish = async (native, throwing = false) => { await page.evaluate(({ native, throwing }) => window.fixture.publish(native, throwing), { native, throwing }); await tick(); };
try {
    await page.goto(pathToFileURL(path.join(target, "index.html")).href);
    await rows().first().waitFor();
    await page.getByRole("button", { name: "已修改", exact: true }).click();
    await tick();
    check("edited tab selected without original-channel navigation", await page.getByRole("button", { name: "已修改", exact: true }).getAttribute("aria-pressed"), "true");
    check("initial page contains four records", await rows().count(), 4);
    check("current version visible before native module", await first().getByText("当前正文：第三版 edited-0", { exact: true }).isVisible(), true);
    await assertHistory("native missing and chat cache empty");
    check("opening log history does not navigate", await page.evaluate(() => window.fixture.actions), []);
    check("history text renders while attachments wait", await first().locator(".aegis-modal-attachment-placeholder").count() > 0, true);
    check("unseen historical attachments do not read files", await page.evaluate(() => window.fixture.attachmentReads), []);
    check("unseen rows do not hydrate attachments", await page.evaluate(() => window.fixture.hydrations.length), 0);
    await page.screenshot({ path: path.join(target, "history-first-open-missing-native.png") });
    check("history is directly visible without collapsing UI", (await historyState()).controls, 0);
    await publish(true);
    check("late native module keeps all versions visible", (await historyState()).count, 4);
    check("native current body appears", await first().locator(".native-current").textContent(), "当前正文：第三版 edited-0");
    check("native preview receives history-free message copies", await page.evaluate(() => window.fixture.nativeInputs.every(input => input.histories === 0)), true);
    check("stored source history is not modified", await page.evaluate(() => window.fixture.old[0].message.editHistory.length), 5);
    await page.evaluate(() => window.fixture.observe("edited-0"));
    await tick();
    check("visible current attachment starts one hydration", await page.evaluate(() => window.fixture.hydrations.length), 1);
    await page.evaluate(() => window.fixture.finishHydration(0));
    await tick();
    check("hydration keeps all versions visible", (await historyState()).count, 4);
    await assertHistory("native ready after attachment hydration");
    check("hydrated historic image displays", await first().locator(".aegis-modal-edit-version img").count(), 1);
    await page.screenshot({ path: path.join(target, "history-native-ready.png") });
    for (const cache of ["empty", "stale", "loaded"]) {
        await page.evaluate(cache => { window.fixture.cache = cache === "empty" ? {} : { "edited-0": { editHistory: [{ content: cache === "stale" ? "缓存过期正文" : "编辑前中文：第一版" }] } }; }, cache);
        await publish(true);
        await assertHistory("chat cache " + cache);
    }
    await publish(true, true);
    await assertHistory("native renderer fails");
    check("native error fallback keeps latest body", await first().getByText("当前正文：第三版 edited-0", { exact: true }).isVisible(), true);
    await page.screenshot({ path: path.join(target, "history-native-error-fallback.png") });
    await publish(false);
    await assertHistory("native unavailable again");
    await publish(true);
    await assertHistory("native recovers");
    await publish(false);
    check("history survives native disappearance", (await historyState()).count, 4);
    await publish(true);
    check("history survives native recovery", (await historyState()).count, 4);
    const jumpsBefore = await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length);
    if (await first().locator(".aegis-modal-edit-version").count()) {
        const selected = await first().locator(".aegis-modal-edit-version").first().evaluate(element => { const range = document.createRange(); range.selectNodeContents(element); const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range); element.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 })); return selection.toString(); });
        check("history text can be selected", selected, "编辑前中文：第一版 (已修改)");
    } else check("history text can be selected", null, "编辑前中文：第一版 (已修改)");
    check("selecting history text does not jump to original", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), jumpsBefore);
    await page.evaluate(() => window.getSelection().removeAllRanges());
    check("history selection remains independent of navigation", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), jumpsBefore);
    await page.evaluate(() => window.fixture.observe("edited-1"));
    await tick();
    check("visible history-only attachment uses row hydration", await page.evaluate(() => window.fixture.hydrations.some(request => request.records[0].message_id === "edited-1")), true);
    check("history-only attachment waits for hydration", await page.evaluate(() => window.fixture.attachmentReads.includes("history-only")), false);
    await page.evaluate(() => { const index = window.fixture.hydrations.findIndex(request => request.records[0].message_id === "edited-1"); window.fixture.finishHydration(index); });
    await tick();
    check("hydrated history-only image appears", await rows().nth(1).locator(".aegis-modal-edit-version img").count(), 1);
    await page.evaluate(() => window.fixture.more());
    await tick();
    check("pagination appends four actual log components", await rows().count(), 8);
    check("newly paged history is inline", await rows().nth(7).locator(".aegis-modal-edit-version").count(), 1);
    check("newly paged saved version visible", await rows().nth(7).getByText("已保存旧正文 edited-7", { exact: false }).isVisible(), true);
    await rows().nth(7).scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(target, "history-pagination.png") });
    await first().scrollIntoViewIfNeeded();
    await page.getByRole("textbox").fill("search");
    await page.getByRole("textbox").press("Enter");
    await page.waitForFunction(() => window.fixture.requests.length === 1);
    check("search overlay covers actual historical results", await page.locator(".aegis-modal-search-overlay").isVisible(), true);
    check("history remains mounted while search waits", await first().locator(".aegis-modal-edit-version").count(), 4);
    check("old history is inert during search", await page.locator(".aegis-modal-content-results").evaluate(element => element.inert), true);
    const actionsBeforeClick = await page.evaluate(() => window.fixture.actions.length);
    const historyBounds = await first().locator(".aegis-modal-edit-version").first().boundingBox();
    if (historyBounds) await page.mouse.click(historyBounds.x + historyBounds.width / 2, historyBounds.y + historyBounds.height / 2);
    await tick();
    check("overlay blocks historical text pointer navigation", await page.evaluate(() => window.fixture.actions.length), actionsBeforeClick);
    check("search box stays editable with history overlay", await page.getByRole("textbox").isEditable(), true);
    await page.screenshot({ path: path.join(target, "history-search-overlay.png") });
    await page.evaluate(() => window.fixture.finish());
    await tick();
    check("search completion removes overlay", await page.locator(".aegis-modal-search-overlay").count(), 0);
    check("search results use actual history content", await first().getByText("已保存旧正文 search-0", { exact: false }).isVisible(), true);
    check("new search history directly visible", (await historyState()).count, 1);
    check("navigation is never required for historical text", await page.evaluate(() => window.fixture.actions.filter(action => action === "jump").length), 0);
    check("native copies stay history-free across all transitions", await page.evaluate(() => window.fixture.nativeInputs.every(input => input.histories === 0)), true);
    await page.evaluate(() => window.fixture.hide());
    await tick();
    check("attachment hydration scopes release on replacement", await page.evaluate(() => window.fixture.actions.filter(action => action === "scope-release").length), 2);
    await page.evaluate(() => window.fixture.malformed());
    await tick();
    check("malformed optional attachment fields preserve current text", await page.getByText("当前正文：第三版 malformed-optional", { exact: true }).isVisible(), true);
    check("malformed optional attachment fields preserve historical text", await page.getByText("异常附件字段不能隐藏这份历史", { exact: false }).isVisible(), true);
    check("malformed filename uses placeholder without hiding the row", await page.locator(".aegis-modal-attachment-placeholder").count() ? await page.locator(".aegis-modal-attachment-placeholder").textContent() : null, "malformed-attachment");
    check("malformed URL waits for visible attachment hydration", await page.evaluate(() => window.fixture.attachmentReads.includes("malformed-attachment")), false);
    await page.evaluate(() => window.fixture.observe("malformed-optional"));
    await tick();
    await page.evaluate(() => { const index = window.fixture.hydrations.findIndex(request => request.records[0].message_id === "malformed-optional"); window.fixture.finishHydration(index); });
    await tick();
    check("malformed URL falls back to saved attachment after hydration", await page.locator(".aegis-modal-edit-version img").count(), 1);
    check("invalid URL is not passed to attachment lease lookup", await page.evaluate(() => window.fixture.leaseInputs.every(value => typeof value === "string")), true);
    check("malformed fields preserve history after hydration", await page.getByText("异常附件字段不能隐藏这份历史", { exact: false }).isVisible(), true);
    await page.evaluate(() => window.fixture.hide());
    await tick();
    check("no unhandled React runtime errors", errors, []);
    const failed = checks.filter(item => !item.passed);
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ checks, errors, failed, source, boundaries: "Actual LogsModal, hooks, LogsMessageContent, styles and messageNavigation. Controlled native preview/cache, host UI, module subscription, DB, search index, filter input, conversion and attachment I/O. No real Discord or logs." }, null, 2));
    process.stdout.write(JSON.stringify({ checks: checks.length, failed, errors, target }) + "\n");
    process.exitCode = failed.length ? 1 : 0;
} catch (error) {
    writeFileSync(path.join(target, "results.json"), JSON.stringify({ checks, errors, failed: checks.filter(item => !item.passed), fatal: String(error), source }, null, 2));
    process.stderr.write(String(error) + "\n");
    process.exitCode = 1;
} finally {
    await browser.close();
}
