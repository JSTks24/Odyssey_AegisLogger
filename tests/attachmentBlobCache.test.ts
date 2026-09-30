/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../index", () => ({
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    settings: { store: { saveImages: false, messageLimit: 0 } }
}));

vi.mock("../utils/saveImage/ImageManager", () => ({
    getImage: vi.fn(async () => new Uint8Array([1, 2, 3])),
    downloadAttachment: vi.fn(async () => undefined),
    deleteImage: vi.fn(async () => { })
}));

import {
    acquireAttachmentBlobUrl,
    acquireAttachmentLease,
    clearAttachmentBlobCache,
    createLeaseScope,
    displayAttachmentUrl,
    getAttachmentBlobStats,
    guardManagedBlobUrl,
    normalizeAttachmentUrl,
    registerBlobUrlReleaser,
    resetAttachmentBlobCacheForTests,
    setAttachmentBlobCacheBudget,
    settleAttachmentCache
} from "../utils/saveImage";
import { getImage } from "../utils/saveImage/ImageManager";

const revoked: string[] = [];
let urlCounter = 0;

function stubUrl() {
    (URL as any).createObjectURL = vi.fn(() => `blob:aegis-url-${++urlCounter}`);
    registerBlobUrlReleaser(url => { revoked.push(url); });
}

function makeAttachment(id: string, overrides: Record<string, any> = {}) {
    return { id, fileExtension: ".png", ...overrides } as any;
}

beforeEach(() => {
    vi.clearAllMocks();
    urlCounter = 0;
    stubUrl();
    resetAttachmentBlobCacheForTests();
    revoked.length = 0;
    vi.mocked(getImage).mockResolvedValue(new Uint8Array([1, 2, 3]));
});

describe("acquireAttachmentBlobUrl", () => {
    it("serves the same resource for the same attachment whatever its display url is", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("a1", { url: "https://cdn/a.png", proxy_url: "https://proxy/a.png" }));
        const second = await acquireAttachmentBlobUrl(makeAttachment("a1", { url: "https://cdn/other.png", proxy_url: "https://proxy/other.png" }));

        expect(first?.url).toBe("blob:aegis-url-1");
        expect(second?.url).toBe(first?.url);
        expect(vi.mocked(URL.createObjectURL as any)).toHaveBeenCalledTimes(1);

        first!.release();
        second!.release();

        expect(revoked).toEqual([]);
    });

    it("shares one read task between concurrent callers and gives each caller its own handle", async () => {
        let resolveImage: (value: Uint8Array) => void = () => { };
        vi.mocked(getImage).mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { resolveImage = resolve; }));

        const first = acquireAttachmentBlobUrl(makeAttachment("a2"));
        const second = acquireAttachmentBlobUrl(makeAttachment("a2"));

        resolveImage(new Uint8Array([9]));

        const [firstLease, secondLease] = await Promise.all([first, second]);

        expect(firstLease?.url).toBe(secondLease?.url);
        expect(getImage).toHaveBeenCalledTimes(1);
        expect(getAttachmentBlobStats().held).toBe(2);

        firstLease!.release();

        expect(getAttachmentBlobStats().held).toBe(1);
        expect(revoked).toEqual([]);
        expect(acquireAttachmentLease(firstLease!.url)).not.toBeNull();

        secondLease!.release();
    });

    it("does not cache a missing image so a later read can retry", async () => {
        vi.mocked(getImage).mockResolvedValueOnce(null as any);

        expect(await acquireAttachmentBlobUrl(makeAttachment("a3"))).toBeNull();

        const lease = await acquireAttachmentBlobUrl(makeAttachment("a3"));

        expect(lease?.url).toBe("blob:aegis-url-1");
        expect(getImage).toHaveBeenCalledTimes(2);

        lease!.release();
    });

    it("keeps every generation of the same attachment revocable exactly once", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("a4"));

        clearAttachmentBlobCache();

        const second = await acquireAttachmentBlobUrl(makeAttachment("a4"));

        expect(second?.url).toBe("blob:aegis-url-2");

        second!.release();
        clearAttachmentBlobCache();
        first!.release();

        expect(revoked).toEqual([second!.url, first!.url]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("releases both generations once when the consumers are released in the other order", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("a5"));

        clearAttachmentBlobCache();

        const second = await acquireAttachmentBlobUrl(makeAttachment("a5"));

        first!.release();
        second!.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([first!.url, second!.url]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("discards a late read from the previous generation without touching the new cache", async () => {
        let resolveStale: (value: Uint8Array) => void = () => { };
        vi.mocked(getImage).mockImplementationOnce(() => new Promise<Uint8Array>(resolve => { resolveStale = resolve; }));

        const stale = acquireAttachmentBlobUrl(makeAttachment("a6"));

        clearAttachmentBlobCache();

        const fresh = await acquireAttachmentBlobUrl(makeAttachment("a6"));

        resolveStale(new Uint8Array([7]));

        expect(await stale).toBeNull();
        expect(fresh?.url).toBe("blob:aegis-url-1");
        expect(revoked).toEqual(["blob:aegis-url-2"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 1, live: 1, inflight: 0, held: 1 });

        fresh!.release();
    });
});

describe("attachment blob cache limits", () => {
    it("never revokes a resource that a consumer still holds, even over budget", async () => {
        setAttachmentBlobCacheBudget(1);

        const first = await acquireAttachmentBlobUrl(makeAttachment("old"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("fresh"));

        expect(revoked).toEqual([]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 2, live: 2, inflight: 0, held: 2 });
        expect(acquireAttachmentLease(first!.url)).not.toBeNull();

        first!.release();
        second!.release();
    });

    it("revokes the oldest idle resource once the budget is exceeded", async () => {
        setAttachmentBlobCacheBudget(2);

        const first = await acquireAttachmentBlobUrl(makeAttachment("idle-1"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("idle-2"));

        first!.release();
        second!.release();

        const third = await acquireAttachmentBlobUrl(makeAttachment("idle-3"));
        const fourth = await acquireAttachmentBlobUrl(makeAttachment("idle-4"));

        expect(revoked).toEqual(["blob:aegis-url-1", "blob:aegis-url-2"]);
        expect(acquireAttachmentLease(first!.url)).toBeNull();
        expect(acquireAttachmentLease(third!.url)).not.toBeNull();

        third!.release();
        fourth!.release();
    });

    it("drops idle entries down to a lowered budget", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("shrunk"));
        first!.release();

        setAttachmentBlobCacheBudget(1);
        expect(revoked).toEqual([]);

        clearAttachmentBlobCache();
        expect(revoked).toEqual(["blob:aegis-url-1"]);
    });
});

describe("attachment url identity", () => {
    it("resolves the display form and the raw form to the same resource", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("identity"));

        expect(normalizeAttachmentUrl(displayAttachmentUrl(lease!.url))).toBe(lease!.url);

        const fromDisplay = acquireAttachmentLease(displayAttachmentUrl(lease!.url));
        const fromRaw = acquireAttachmentLease(lease!.url);

        expect(fromDisplay?.url).toBe(lease!.url);
        expect(fromRaw?.url).toBe(lease!.url);
        expect(vi.mocked(URL.createObjectURL as any)).toHaveBeenCalledTimes(1);

        lease!.release();
        fromDisplay!.release();
        fromRaw!.release();

        expect(revoked).toEqual([]);
    });

    it("keeps the resource alive while either display form is held", async () => {
        const raw = await acquireAttachmentBlobUrl(makeAttachment("two-forms"));
        const display = acquireAttachmentLease(displayAttachmentUrl(raw!.url));

        raw!.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);
        expect(display?.url).toBe(raw!.url);

        display!.release();

        expect(revoked).toEqual([raw!.url]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("does not match unknown blobs, https or empty addresses", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("known"));

        expect(acquireAttachmentLease("blob:aegis-unknown")).toBeNull();
        expect(acquireAttachmentLease("blob:aegis-unknown#")).toBeNull();
        expect(acquireAttachmentLease("https://cdn/a.png")).toBeNull();
        expect(acquireAttachmentLease("https://cdn/a.png#")).toBeNull();
        expect(acquireAttachmentLease("")).toBeNull();
        expect(acquireAttachmentLease(displayAttachmentUrl(lease!.url))).not.toBeNull();

        lease!.release();
    });

    it("releases a display url the same way as the raw url", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("release-form"));

        lease!.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([lease!.url]);
        expect(acquireAttachmentLease(displayAttachmentUrl(lease!.url))).toBeNull();
    });
});

describe("mangled display urls", () => {
    it("resolves every observed mangling of a display url to the same resource", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("mangled"));
        const raw = lease!.url;
        const forms = [
            displayAttachmentUrl(raw),
            `${displayAttachmentUrl(raw)}?format=webp`,
            `${raw}?format=webp#`,
            `${raw}?format=webp`,
            `${raw}?format=webp&width=320&height=240`
        ];

        for (const form of forms) {
            expect(normalizeAttachmentUrl(form)).toBe(raw);
            expect(acquireAttachmentLease(form)?.url).toBe(raw);
        }

        expect(vi.mocked(URL.createObjectURL as any)).toHaveBeenCalledTimes(1);

        lease!.release();
    });

    it("keeps the resource alive while only a mangled form is held", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("mangled-hold"));
        const held = acquireAttachmentLease(`${lease!.url}?format=webp#`);

        expect(held?.url).toBe(lease!.url);

        lease!.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual([]);

        held!.release();

        expect(revoked).toEqual([lease!.url]);
    });

    it("does not recognize a mangled form of an unknown or foreign url", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("foreign"));

        expect(acquireAttachmentLease("blob:not-ours?format=webp")).toBeNull();
        expect(acquireAttachmentLease("blob:not-ours#?format=webp")).toBeNull();
        expect(acquireAttachmentLease("https://cdn/a.png?format=webp")).toBeNull();
        expect(normalizeAttachmentUrl("https://cdn/a.png?format=webp&size=32")).toBe("https://cdn/a.png?format=webp&size=32");

        lease!.release();
    });

    it("does not leak a mangled form of a previous generation into the new one", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("gen"));
        const oldMangled = `${first!.url}?format=webp#`;

        clearAttachmentBlobCache();

        const second = await acquireAttachmentBlobUrl(makeAttachment("gen"));
        expect(second?.url).not.toBe(first?.url);

        first!.release();
        clearAttachmentBlobCache();

        expect(acquireAttachmentLease(oldMangled)).toBeNull();
        expect(acquireAttachmentLease(displayAttachmentUrl(second!.url))?.url).toBe(second!.url);

        second!.release();
    });
});

describe("guardManagedBlobUrl", () => {
    it("returns a url view that ignores query param rewrites and stays loadable", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("guard"));
        const display = displayAttachmentUrl(lease!.url);

        const view = guardManagedBlobUrl(display);
        expect(view).not.toBeNull();

        view!.searchParams.append("format", "webp");
        view!.searchParams.set("width", "320");
        view!.searchParams.delete("format");

        expect(view!.toString()).toBe(display);
        expect(view!.href).toBe(display);
        expect(view!.searchParams.get("format")).toBeNull();
        expect(`${view}`).toBe(display);

        const src = view!.toString();
        expect(acquireAttachmentLease(src)?.url).toBe(lease!.url);

        lease!.release();
    });

    it("guards the raw and mangled forms of a managed url alike", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("guard-forms"));
        const raw = lease!.url;

        for (const form of [raw, displayAttachmentUrl(raw), `${displayAttachmentUrl(raw)}?format=webp`, `${raw}?format=webp#`]) {
            const view = guardManagedBlobUrl(form);
            expect(view).not.toBeNull();
            expect(view!.toString()).toBe(displayAttachmentUrl(raw));
        }

        lease!.release();
    });

    it("leaves https, data and unknown blob urls to the original logic", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("guard-scope"));

        expect(guardManagedBlobUrl("https://cdn/a.png?format=webp")).toBeNull();
        expect(guardManagedBlobUrl("https://cdn/a.png#")).toBeNull();
        expect(guardManagedBlobUrl("data:image/png;base64,xxx")).toBeNull();
        expect(guardManagedBlobUrl("blob:not-ours")).toBeNull();
        expect(guardManagedBlobUrl("blob:not-ours?format=webp#")).toBeNull();
        expect(guardManagedBlobUrl("")).toBeNull();

        lease!.release();
    });
});

describe("attachment leases", () => {
    it("ignores a repeated release of the same handle", async () => {
        const lease = await acquireAttachmentBlobUrl(makeAttachment("repeated"));

        lease!.release();
        lease!.release();

        clearAttachmentBlobCache();

        expect(revoked).toEqual(["blob:aegis-url-1"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });

    it("keeps serving a url while any consumer still holds it", async () => {
        const owner = await acquireAttachmentBlobUrl(makeAttachment("shared"));
        const guest = acquireAttachmentLease(owner!.url);

        expect(guest?.url).toBe(owner!.url);

        owner!.release();

        expect(revoked).toEqual([]);

        const extra = acquireAttachmentLease(guest!.url);
        expect(extra).not.toBeNull();
        extra!.release();

        guest!.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual(["blob:aegis-url-1"]);
    });

    it("does not hand out a lease for an unknown or already released url", async () => {
        expect(acquireAttachmentLease("blob:not-ours")).toBeNull();

        const lease = await acquireAttachmentBlobUrl(makeAttachment("gone"));
        lease!.release();
        clearAttachmentBlobCache();

        expect(acquireAttachmentLease(lease!.url)).toBeNull();
    });

    it("survives repeated clears, releases and a clear after release", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("stable-1"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("stable-2"));

        clearAttachmentBlobCache();
        clearAttachmentBlobCache();

        first!.release();
        first!.release();
        second!.release();

        clearAttachmentBlobCache();

        expect(revoked).toHaveLength(2);
        expect(new Set(revoked)).toEqual(new Set(["blob:aegis-url-1", "blob:aegis-url-2"]));
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });
});

describe("attachment blob cache convergence", () => {
    it("drops back to a small budget once every consumer is released", async () => {
        setAttachmentBlobCacheBudget(2);

        const first = await acquireAttachmentBlobUrl(makeAttachment("keep-1"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("keep-2"));
        const third = await acquireAttachmentBlobUrl(makeAttachment("keep-3"));

        expect(getAttachmentBlobStats().cached).toBe(3);
        expect(revoked).toEqual([]);

        first!.release();
        second!.release();
        third!.release();

        await settleAttachmentCache();

        expect(getAttachmentBlobStats().cached).toBe(2);
        expect(getAttachmentBlobStats().held).toBe(0);
        expect(revoked).toEqual(["blob:aegis-url-1"]);
        expect(acquireAttachmentLease(first!.url)).toBeNull();
        expect(acquireAttachmentLease(third!.url)).not.toBeNull();
    });

    it("keeps the resources of consumers that are still holding while converging", async () => {
        setAttachmentBlobCacheBudget(2);

        const held = await acquireAttachmentBlobUrl(makeAttachment("held"));
        const idleOne = await acquireAttachmentBlobUrl(makeAttachment("idle-1"));
        const idleTwo = await acquireAttachmentBlobUrl(makeAttachment("idle-2"));

        idleOne!.release();
        idleTwo!.release();

        await settleAttachmentCache();

        expect(getAttachmentBlobStats().cached).toBe(2);
        expect(revoked).toEqual(["blob:aegis-url-2"]);
        expect(acquireAttachmentLease(held!.url)).not.toBeNull();

        held!.release();
    });

    it("converges the default budget after releasing a large page", async () => {
        const leases = [];

        for (let index = 0; index < 3000; index++) {
            leases.push(await acquireAttachmentBlobUrl(makeAttachment(`bulk-${index}`)));
        }

        expect(getAttachmentBlobStats()).toEqual({ cached: 3000, live: 3000, inflight: 0, held: 3000 });

        for (const lease of leases) lease!.release();

        await settleAttachmentCache();

        expect(getAttachmentBlobStats().cached).toBe(2000);
        expect(getAttachmentBlobStats().live).toBe(2000);
        expect(revoked).toHaveLength(1000);
    });

    it("does not revoke twice when settling, clearing and releasing repeat", async () => {
        const first = await acquireAttachmentBlobUrl(makeAttachment("repeat-1"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("repeat-2"));

        first!.release();
        first!.release();
        second!.release();

        await settleAttachmentCache();
        await settleAttachmentCache();
        clearAttachmentBlobCache();

        expect(revoked).toEqual(["blob:aegis-url-1", "blob:aegis-url-2"]);
        expect(getAttachmentBlobStats()).toEqual({ cached: 0, live: 0, inflight: 0, held: 0 });
    });
});

describe("leaseScope", () => {
    it("hands the held handles over with take and releases the rest", async () => {
        const scope = createLeaseScope();
        const first = await acquireAttachmentBlobUrl(makeAttachment("scope-1"));
        const second = await acquireAttachmentBlobUrl(makeAttachment("scope-2"));

        scope.hold("m1", first!);
        scope.hold("m1", second!);

        const taken = scope.take(["m1", "m2"]);

        expect(taken.get("m1")).toEqual([first, second]);
        expect(scope.size()).toBe(0);

        scope.release();
        expect(revoked).toEqual([]);

        first!.release();
        second!.release();
    });

    it("releases only the records that are dropped", async () => {
        const scope = createLeaseScope();
        const dropped = await acquireAttachmentBlobUrl(makeAttachment("dropped"));
        const kept = await acquireAttachmentBlobUrl(makeAttachment("kept"));

        scope.hold("m1", dropped!);
        scope.hold("m2", kept!);

        scope.releaseRecords(["m1"]);

        expect(scope.size()).toBe(1);
        expect(revoked).toEqual([]);

        scope.release();
        clearAttachmentBlobCache();

        expect(revoked).toEqual(["blob:aegis-url-1", "blob:aegis-url-2"]);
    });
});
