/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

const script = `
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const ts = require("typescript");
const cache = new Map();
function load(file) {
    file = path.resolve(file);
    if (cache.has(file)) return cache.get(file).exports;
    const module = { exports: {} };
    cache.set(file, module);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    const localRequire = id => {
        if (id === "@webpack/common") return { ChannelStore: { getChannel: () => null }, GuildStore: { getGuild: () => null } };
        if (id === "./misc") return { getGuildIdByChannel: () => undefined };
        return load(path.resolve(path.dirname(file), id) + ".ts");
    };
    vm.runInThisContext("(function(require,module,exports){" + code + "\\n})", { filename: file })(localRequire, module, module.exports);
    return module.exports;
}
(async () => {
    const parser = load("utils/parseQuery.ts");
    const index = load("utils/searchIndex.ts").default;
    const rows = [];
    for (const date of ["2026-03-08", "2026-11-01"]) {
        const [year, month, day] = date.split("-").map(Number);
        const midnight = new Date(year, month - 1, day).getTime();
        const offsets = [-86400000, -1, 0, 1, 7200000, 86399999, 86400000];
        const records = offsets.map((offset, position) => ({
            message_id: String(position + 1), channel_id: "200", status: "EDITED",
            message: { id: String(position + 1), channel_id: "200", timestamp: new Date(midnight + offset).toISOString(), author: { id: "100" }, content: "body", attachments: [], embeds: [] }
        }));
        index.clear();
        await index.ensureReady(async function* () { yield records; });
        for (const kind of ["before", "after", "around", "near", "during"]) {
            for (const negate of [false, true]) {
                const query = parser.tokenizeQuery((negate ? "!" : "") + kind + ":" + date);
                const expected = offsets.map(offset => kind === "before" ? offset < 0 : kind === "after" ? offset > 0 : Math.abs(offset) < 86400000).map(value => negate ? !value : value);
                const direct = records.map(record => { const value = !!parser.doesMatch(kind, date, record.message); return negate ? !value : value; });
                const scan = records.map(record => index.matchesRecord(record, query.queries, query.rest));
                const indexed = index.search(query.queries, query.rest, "EDITED", 100, false).page.map(entry => entry.id);
                rows.push({ date, kind, negate, expected, direct, scan, indexed, expectedIds: records.filter((_record, position) => expected[position]).map(record => record.message_id) });
            }
        }
    }
    process.stdout.write(JSON.stringify({ zone: Intl.DateTimeFormat().resolvedOptions().timeZone, rows }));
})().catch(error => { process.stderr.write(String(error)); process.exitCode = 1; });
`;

describe.each(["UTC", "Asia/Shanghai", "America/New_York"])("local date search in %s", timezone => {
    it("uses local midnight and strict boundaries in both search paths, including DST transition dates", () => {
        const result = JSON.parse(execFileSync(process.execPath, ["--input-type=commonjs"], {
            input: script,
            encoding: "utf8",
            cwd: process.cwd(),
            env: { ...process.env, TZ: timezone },
            windowsHide: true,
            timeout: 15000
        }));
        expect(result.zone).toBe(timezone);
        for (const row of result.rows) {
            const context = `${timezone} ${row.date} ${row.negate ? "!" : ""}${row.kind}`;
            expect(row.direct, context).toEqual(row.expected);
            expect(row.scan, context).toEqual(row.expected);
            expect(row.indexed, context).toEqual(row.expectedIds);
        }
    }, 20000);
});
