/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { vi } from "vitest";

import { DEFAULT_IMAGE_CACHE_DIR } from "../../utils/constants";

export const logger: any = {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
};

export const settings: any = {
    store: {
        cacheLimit: 1000,
        messageLimit: 1000,
        saveImages: false,
        exclusionRules: "",
        language: "en",
        attachmentSizeLimitInMegabytes: 8,
        attachmentFileExtensions: "",
        imageCacheDir: DEFAULT_IMAGE_CACHE_DIR,
        logsDir: ""
    }
};

export const Native: any = {
    init: vi.fn(async () => { }),
    getSettings: vi.fn(async () => ({ imageCacheDir: DEFAULT_IMAGE_CACHE_DIR, logsDir: "" })),
    chooseDir: vi.fn(async () => null),
    startNativeLogExport: vi.fn(async () => "stream"),
    writeNativeLogChunk: vi.fn(async () => { }),
    finishNativeLogExport: vi.fn(async () => { }),
    cancelNativeLogExport: vi.fn(async () => { }),
    startNativeLogImport: vi.fn(async () => "file"),
    readNativeLogChunk: vi.fn(async () => null),
    closeNativeLogImport: vi.fn(async () => { })
};

export const imageUtils: any = {
    registerBlobUrlReleaser: vi.fn()
};

export default {};
