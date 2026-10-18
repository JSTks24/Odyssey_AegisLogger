/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
    convert: vi.fn(),
    parse: vi.fn(),
    acquire: vi.fn(),
    retain: vi.fn(),
    effect: vi.fn(),
    state: [] as any[],
    cursor: 0
}));

vi.mock("@webpack/common", () => {
    const React = {
        Fragment: "fragment",
        createElement: (type: any, props: any, ...children: any[]) => ({ type, props: { ...props, children: children.length === 0 ? props?.children : children } }),
        Component: class {
            props: any;
            state: any;
            constructor(props: any) { this.props = props; }
            setState(state: any) { this.state = { ...this.state, ...state }; }
        }
    };
    return {
        React,
        Parser: { parse: mocks.parse },
        SelectedChannelStore: { getChannelId: () => "selected-channel" },
        Timestamp: ({ timestamp, children }: any) => ({ type: "time", props: { "data-timestamp": timestamp.toISOString(), children } }),
        useEffect: mocks.effect,
        useState: (initial: any) => {
            const index = mocks.cursor++;
            if (mocks.state.length <= index) mocks.state.push(typeof initial === "function" ? initial() : initial);
            return [mocks.state[index], (value: any) => { mocks.state[index] = typeof value === "function" ? value(mocks.state[index]) : value; }];
        }
    };
});

vi.mock("@utils/react", async () => {
    const { React } = await import("@webpack/common");
    return { LazyComponent: (factory: () => any) => {
        let component: any;
        return (props: any) => React.createElement(component ??= factory(), props);
    } };
});
vi.mock("../utils", () => ({
    messageJsonToMessageClass: mocks.convert,
    isImageAttachment: (attachment: any) => (typeof attachment.content_type === "string" && attachment.content_type.startsWith("image/")) || /\.(png|jpe?g|gif|webp)$/i.test(attachment.filename ?? ""),
    splitRemovedAttachments: (attachments: any[]) => ({ live: attachments.filter(attachment => !attachment.deleted), removed: attachments.filter(attachment => attachment.deleted) })
}));
vi.mock("../utils/i18n", () => ({ t: (key: string) => key }));
vi.mock("../utils/saveImage", () => ({
    acquireAttachmentBlobUrl: mocks.acquire,
    acquireAttachmentLease: mocks.retain,
    displayAttachmentUrl: (url: string) => `${url}#`
}));

import content from "../components/LogsMessageContent";
import type { LoggedMessageJSON } from "../types";

function record(overrides: any = {}): LoggedMessageJSON {
    return {
        id: "m1", channel_id: "c1", author: { id: "u1", username: "alice" },
        timestamp: "2026-10-08T01:00:00Z", content: "archived message body", attachments: [], embeds: [],
        ...overrides
    } as LoggedMessageJSON;
}

function renderTree(tree: any): any {
    if (Array.isArray(tree)) return tree.map(renderTree);
    if (tree == null || typeof tree !== "object") return tree;
    if (typeof tree.type === "function") {
        if (tree.type.prototype?.render != null) {
            const boundary = new tree.type(tree.props);
            try {
                return renderTree(boundary.render());
            } catch (error) {
                boundary.state = { ...boundary.state, ...tree.type.getDerivedStateFromError(error) };
                return renderTree(boundary.render());
            }
        }
        mocks.cursor = 0;
        mocks.state = [];
        return renderTree(tree.type(tree.props));
    }
    return { ...tree, props: { ...tree.props, children: renderTree(tree.props.children) } };
}

function nodes(tree: any, type?: string): any[] {
    if (Array.isArray(tree)) return tree.flatMap(child => nodes(child, type));
    if (tree == null || typeof tree !== "object") return [];
    return [...(type == null || tree.type === type ? [tree] : []), ...nodes(tree.props?.children, type)];
}

function textContent(tree: any): string {
    if (Array.isArray(tree)) return tree.map(textContent).join(" ");
    if (tree == null || typeof tree === "boolean") return "";
    if (typeof tree === "object") return textContent(tree.props?.children);
    return String(tree);
}

function renderContent(source: LoggedMessageJSON, overrides: any = {}) {
    return renderTree(content.MessageContent({
        record: source,
        message: null,
        modules: { messagePreview: null, privateChannelRecord: null, version: 0 },
        channel: null,
        isGroupStart: true,
        ...overrides
    }));
}

function snapshotAttachment(attachment: any) {
    const tree = content.MessageSnapshot({ record: record({ attachments: [attachment] }) }) as any;
    const body = tree.props.children[0];
    const bodyTree = body.type(body.props);
    const attachments = bodyTree.props.children[2];
    mocks.cursor = 0;
    mocks.state = [];
    return attachments.props.children[0][0];
}

beforeEach(() => {
    mocks.convert.mockReset().mockImplementation(({ message }) => message);
    mocks.parse.mockReset().mockImplementation(content => ({ type: "parsed-edit", props: { children: content } }));
    mocks.acquire.mockReset().mockResolvedValue(null);
    mocks.retain.mockReset().mockReturnValue(null);
    mocks.effect.mockReset();
    mocks.state = [];
    mocks.cursor = 0;
});

describe("log message content", () => {
    it("shows actual archived text when the native component has not loaded", () => {
        expect(textContent(renderContent(record()))).toContain("archived message body");
    });

    it("keeps the original text and attachments when message conversion throws", () => {
        mocks.convert.mockImplementation(() => { throw new Error("native constructor unavailable"); });
        const source = record({ attachments: [{ id: "a1", filename: "saved.png", content_type: "image/png", url: "blob:saved#" }] });
        const prepared = content.prepareMessage(source);
        expect(prepared.message).toBeNull();
        const rendered = renderContent(source, { message: prepared.message });
        expect(textContent(rendered)).toContain("archived message body");
        expect(nodes(rendered, "img")[0].props.src).toBe("blob:saved#");
    });

    it("isolates a native render exception to that row and retains adjacent message content", () => {
        const throwing = () => { throw new Error("broken native preview"); };
        const source = record();
        const failed = renderContent(source, {
            message: source,
            channel: { id: "c1" },
            modules: { messagePreview: throwing, privateChannelRecord: null, version: 1 }
        });
        const adjacent = renderContent(record({ id: "m2", content: "next archived body" }));
        expect(textContent([failed, adjacent])).toContain("archived message body");
        expect(textContent([failed, adjacent])).toContain("next archived body");
    });

    it("uses the native component once it becomes ready without requiring a window reopen", () => {
        const source = record();
        expect(textContent(renderContent(source))).toContain("archived message body");
        const native = ({ message }: any) => ({ type: "native-message", props: { children: message.content } });
        const rendered = renderContent(source, {
            message: source,
            channel: { id: "c1" },
            modules: { messagePreview: native, privateChannelRecord: null, version: 1 }
        });
        expect(nodes(rendered, "native-message")).toHaveLength(1);
        expect(textContent(rendered)).toContain("archived message body");
    });

    it("shows the snapshot when the channel and private channel constructor are both unavailable", () => {
        const native = vi.fn();
        const source = record();
        const rendered = renderContent(source, {
            message: source,
            modules: { messagePreview: native, privateChannelRecord: null, version: 1 }
        });
        expect(textContent(rendered)).toContain("archived message body");
        expect(native).not.toHaveBeenCalled();
    });

    it("shows archived edit text, embed summaries and the hydrated historical attachment URL", () => {
        const source = record({
            attachments: [{ id: "a1", filename: "removed.png", url: "blob:archived#", deleted: true }],
            embeds: [{ title: "embed title", description: "embed body", url: "https://example.test", fields: [{ name: "field", value: "field value" }] }],
            editHistory: [{ timestamp: "2026-10-08T00:59:00Z", content: "previous body", attachments: [{ id: "a1", filename: "removed.png", url: "https://expired.test/removed.png" }] }]
        });
        const rendered = renderTree(content.MessageSnapshot({ record: source }));
        expect(textContent(rendered)).toContain("previous body");
        expect(textContent(rendered)).toContain("embed title\nembed body\nhttps://example.test\nfield\nfield value");
        expect(nodes(rendered, "details")).toHaveLength(0);
        expect(nodes(rendered, "summary")).toHaveLength(0);
        expect(nodes(rendered, "img").every(image => image.props.src === "blob:archived#")).toBe(true);
        expect(textContent(rendered)).toContain("modal.attachmentRemoved");
    });

    it.each([undefined, { editHistory: [] }, { editHistory: [{ content: "stale cached body" }] }, { editHistory: [{ content: "previous body" }] }])("shows every saved edit independently of the chat cache: %j", cached => {
        const source = record({
            editHistory: [
                { timestamp: "2026-10-08T00:58:00Z", content: "最早的正文" },
                { timestamp: "2026-10-08T00:59:00Z", content: "previous body" }
            ]
        });
        const native = vi.fn(({ message }) => ({ type: "native-message", props: { children: [message.content, ...(message.editHistory?.length ? cached?.editHistory?.map(edit => edit.content) ?? [] : [])] } }));
        const prepared = content.prepareMessage(source);
        const rendered = renderContent(source, {
            message: prepared.message,
            channel: { id: "c1" },
            modules: { messagePreview: native, privateChannelRecord: null, version: 1 }
        });
        expect(textContent(rendered)).toContain("archived message body");
        expect(textContent(rendered)).toContain("最早的正文");
        expect(textContent(rendered).match(/previous body/g)).toHaveLength(1);
        expect(textContent(rendered)).not.toContain("stale cached body");
        expect(nodes(rendered, "time").map(node => node.props["data-timestamp"])).toEqual(["2026-10-08T00:58:00.000Z", "2026-10-08T00:59:00.000Z"]);
        expect(native.mock.calls[0][0].message.editHistory).toEqual([]);
        expect(source.editHistory).toHaveLength(2);
    });

    it("shows saved edits immediately when the native preview throws", () => {
        const source = record({ editHistory: [{ content: "保存的旧正文", timestamp: "2026-10-08T00:59:00Z" }] });
        const rendered = renderContent(source, {
            message: content.prepareMessage(source).message,
            channel: { id: "c1" },
            modules: { messagePreview: () => { throw new Error("native failure"); }, privateChannelRecord: null, version: 1 }
        });
        expect(textContent(rendered)).toContain("archived message body");
        expect(textContent(rendered).match(/保存的旧正文/g)).toHaveLength(1);
        expect(nodes(rendered, "details")).toHaveLength(0);
    });

    it("shows history text while historical attachments wait for row visibility", () => {
        mocks.effect.mockImplementation(effect => effect());
        const source = record({
            content: "",
            editHistory: [{ content: "attachment's old body", timestamp: "2026-10-08T00:59:00Z", attachments: [{ id: "old", filename: "old.png", path: "old.png", content_type: 42 }] }]
        });
        const rendered = renderContent(source, { attachmentsPending: true });
        expect(textContent(rendered)).toContain("attachment's old body");
        expect(nodes(rendered, "img")).toHaveLength(0);
        expect(nodes(rendered).some(node => node.props["aria-busy"] === "true")).toBe(true);
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(mocks.retain).not.toHaveBeenCalled();
    });

    it("keeps valid history visible around malformed optional fields", () => {
        const source = record({
            editHistory: [null, 4, { content: 12 }, { content: "saved history", timestamp: "2026-10-08T00:59:00Z", attachments: [null, { id: "a1", filename: "old.png", content_type: 42 }] }]
        });
        const rendered = renderContent(source);
        expect(textContent(rendered)).toContain("saved history");
        expect(textContent(rendered)).toContain("old.png");
        expect(mocks.parse).toHaveBeenCalledWith("", true, expect.any(Object));
    });

    it("parses each saved version with the native message context and inline edited marker", () => {
        const source = record({ editHistory: [{ content: "**旧正文**\nhttps://example.test 😀", timestamp: "2026-10-08T00:59:00Z" }] });
        const rendered = renderContent(source);
        expect(mocks.parse).toHaveBeenCalledWith(source.editHistory![0].content, true, expect.objectContaining({ channelId: "c1", messageId: "m1", viewingChannelId: "selected-channel", allowLinks: true, allowHeading: true, allowList: true, allowEmojiLinks: true }));
        expect(nodes(rendered, "parsed-edit")).toHaveLength(1);
        expect(nodes(rendered, "time")).toHaveLength(1);
        expect(textContent(rendered)).toContain("modal.tab.edited");
        expect(textContent(rendered)).not.toContain("2026-10-08T00:59");
    });

    it("falls back only the failed version to plain text while other versions keep native parsing", () => {
        mocks.parse.mockImplementation(content => {
            if (content === "broken version") throw new Error("parser unavailable");
            return { type: "parsed-edit", props: { children: content } };
        });
        const rendered = renderContent(record({ editHistory: [{ content: "broken version" }, { content: "working version" }] }));
        expect(textContent(rendered)).toContain("broken version");
        expect(textContent(rendered)).toContain("working version");
        expect(nodes(rendered, "parsed-edit")).toHaveLength(1);
        expect(nodes(rendered, "details")).toHaveLength(0);
    });

    it("treats a non-string historical attachment URL as missing", () => {
        mocks.effect.mockImplementation(effect => effect());
        mocks.retain.mockImplementation(url => {
            expect(typeof url).toBe("string");
            return null;
        });
        const source = record({ editHistory: [{ content: "saved text", attachments: [{ id: "old", filename: "old.png", url: 42 }] }] });
        expect(textContent(renderContent(source))).toContain("saved text");
        expect(mocks.retain).toHaveBeenCalledWith("");
    });

    it("uses the historical attachment ID when a pending filename is malformed", () => {
        const source = record({ editHistory: [{ content: "saved text", attachments: [{ id: "old", filename: { invalid: true } }] }] });
        const rendered = renderContent(source, { attachmentsPending: true });
        expect(nodes(rendered, "span").some(node => node.props.children?.[0] === "old")).toBe(true);
        expect(textContent(rendered)).toContain("saved text");
    });

    it("makes truly empty content explicit and tolerates malformed optional collections", () => {
        const rendered = renderContent(record({ content: "", attachments: null, embeds: null, editHistory: null }));
        expect(textContent(rendered)).toContain("modal.snapshot.empty");
        expect(content.prepareMessage(record({ attachments: [null], editHistory: null })).message).not.toBeNull();
    });

    it("shows text and sized placeholders without starting attachment reads before the row is visible", () => {
        mocks.effect.mockImplementation(effect => effect());
        const source = record({ attachments: [{ id: "a1", filename: "slow.png", width: 640, height: 480, path: "a1.png", url: "https://expired.test/a1" }] });
        const rendered = renderContent(source, { attachmentsPending: true });
        expect(textContent(rendered)).toContain("archived message body");
        expect(nodes(rendered, "img")).toHaveLength(0);
        expect(nodes(rendered).some(node => node.props["aria-busy"] === "true")).toBe(true);
        expect(mocks.acquire).not.toHaveBeenCalled();
        expect(content.prepareMessage(source, true).message!.attachments).toEqual([]);
        expect(source.attachments).toHaveLength(1);
    });

    it("does not call a removed-attachment message empty when the separate removed block owns its preview", () => {
        const rendered = renderTree(content.MessageSnapshot({
            record: record({ content: "", attachments: [{ id: "a1", filename: "removed.png", url: "blob:removed#", deleted: true }] }),
            includeRemoved: false
        }));
        expect(textContent(rendered)).not.toContain("modal.snapshot.empty");
    });

    it("renders video and audio with their own media elements", () => {
        const rendered = renderContent(record({ content: "", attachments: [
            { id: "v1", filename: "clip.mp4", content_type: "video/mp4", url: "blob:clip#" },
            { id: "a1", filename: "song.mp3", content_type: "audio/mpeg", url: "blob:song#" }
        ] }));
        expect(nodes(rendered, "video")[0].props.src).toBe("blob:clip#");
        expect(nodes(rendered, "audio")[0].props.src).toBe("blob:song#");
        expect(nodes(rendered, "img")).toHaveLength(0);
    });

    it("keeps image-only and empty embed records visible instead of calling them empty messages", () => {
        const rendered = renderContent(record({ content: "", embeds: [{ image: { url: "https://example.test/image.png" } }, {}] }));
        expect(textContent(rendered)).toContain("https://example.test/image.png");
        expect(textContent(rendered)).toContain("modal.snapshot.embed");
        expect(textContent(rendered)).not.toContain("modal.snapshot.empty");
    });

    it("shows an unavailable preview label for unsupported file types", () => {
        const rendered = renderContent(record({ content: "", attachments: [{ id: "f1", filename: "archive.zip", url: "https://cdn.test/archive.zip" }] }));
        expect(textContent(rendered)).toContain("archive.zip");
        expect(textContent(rendered)).toContain("modal.snapshot.attachmentUnavailable");
    });

    it("shows the filename and unavailable label when an image fails", () => {
        const element = snapshotAttachment({ id: "a1", filename: "lost.png", url: "https://cdn.test/lost.png" });
        mocks.cursor = 0;
        const first = element.type(element.props);
        nodes(first, "img")[0].props.onError();
        mocks.cursor = 0;
        const failed = element.type(element.props);
        expect(nodes(failed, "img")).toHaveLength(0);
        expect(textContent(failed)).toContain("lost.png");
        expect(textContent(failed)).toContain("modal.snapshot.attachmentUnavailable");
    });

    it("keeps a managed attachment lease until the fallback media unmounts", () => {
        const release = vi.fn();
        mocks.retain.mockReturnValue({ url: "blob:saved", release });
        let cleanup: (() => void) | undefined;
        mocks.effect.mockImplementation(effect => { cleanup = effect(); });
        const element = snapshotAttachment({ id: "a1", filename: "saved.png", url: "blob:saved#" });
        element.type(element.props);
        expect(release).not.toHaveBeenCalled();
        cleanup?.();
        expect(release).toHaveBeenCalledOnce();
    });

    it("releases a late archive read after the fallback attachment has unmounted", async () => {
        let resolve: (lease: any) => void = () => { };
        mocks.acquire.mockReturnValue(new Promise(done => { resolve = done; }));
        let cleanup: (() => void) | undefined;
        mocks.effect.mockImplementation(effect => { cleanup = effect(); });
        const element = snapshotAttachment({ id: "a1", filename: "saved.png", url: "https://old.test/saved.png", path: "savedImages/a1.png" });
        element.type(element.props);
        cleanup?.();
        const release = vi.fn();
        resolve({ url: "blob:saved", release });
        await Promise.resolve();
        expect(release).toHaveBeenCalledOnce();
        expect(mocks.state[0].url).toBe("https://old.test/saved.png");
    });
});
