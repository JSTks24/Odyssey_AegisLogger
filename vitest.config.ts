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
        alias: [
            { find: "@webpack/common", replacement: r("./tests/mocks/webpackCommon.ts") },
            { find: "@webpack", replacement: r("./tests/mocks/webpack.ts") },
            { find: "@api/Settings", replacement: r("./tests/mocks/settings.ts") },
            { find: /^@components\/Button$/, replacement: r("./tests/mocks/components/button.ts") },
            { find: /^.*[\\/]Odyssey_AegisLogger[\\/]index\.tsx$/, replacement: r("./tests/mocks/pluginIndex.ts") }
        ]
    }
});
