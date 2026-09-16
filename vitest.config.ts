/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    test: {
        environment: "node",
        include: ["tests/**/*.test.ts"]
    },
    resolve: {
        alias: {
            "@webpack/common": r("./tests/mocks/webpackCommon.ts"),
            "@api/Settings": r("./tests/mocks/settings.ts")
        }
    }
});
