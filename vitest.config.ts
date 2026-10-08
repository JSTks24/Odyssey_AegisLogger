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
            { find: "@api/Styles", replacement: r("./tests/mocks/apiStyles.ts") },
            { find: /^@components\/Button$/, replacement: r("./tests/mocks/components/button.ts") },
            { find: /^@components\/ErrorCard$/, replacement: r("./tests/mocks/components/errorCard.ts") },
            { find: /^@components\/Link$/, replacement: r("./tests/mocks/components/link.ts") },
            { find: "@utils/modal", replacement: r("./tests/mocks/utilsModal.ts") },
            { find: "@utils/discord", replacement: r("./tests/mocks/utilsDiscord.ts") },
            { find: "@utils/misc", replacement: r("./tests/mocks/utilsMisc.ts") },
            { find: /^.*[\\/]Odyssey_AegisLogger[\\/]index\.tsx$/, replacement: r("./tests/mocks/pluginIndex.ts") }
        ]
    }
});
