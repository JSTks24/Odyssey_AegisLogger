/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const AUTHOR_ID = "1015591734694129836";
const PUBLIC_APPLICATION_ID = "1409882731634098328";
const PRIVATE_DIGESTS = new Set([
    "e4af2a0628fdf916522073ac757d197d27725aa54f7edca80e486b8b0751b426",
    "303f91334ae0fb686289ec218e70a5a446b2f8348436ab6f8ced550ed1cca9d0",
    "f7f54964c7f76f4b5ed3208ec57f95de35c1747fa214692923e1f087ae08a2b4",
    "c9f56f367673d0c1b49901f3b14dc1c97f9b160de3666f68fd2a41571ff96811",
    "2e0e103f557569184a49705387ee54f28adb1f1b1a1597bbd307d83f3ae4d642",
    "df48d2c83545569c508888937f41ca59be493bd8bfb7fa9710e85e75e94dd256",
    "6c9a7a9a8df3e3ac28544ab9583c7a68839c57e40154dd2e0c324b4afe1f04a7",
    "c8ac2d42c742b32c71c86f4ced6ed0c4907c1764aea0bb2ddcff4606085b3825",
    "a33f6d60ebb685c1004ec868f3e69646306e9630674baf6cc10e85d6d2a9300b",
    "c5ba4ce17e63bb42761cafd4b4668f5d7ec26c65aaf4733f85f0cd2b5246c0ce",
    "929d098f8e96f7f0cf3d19c6f5c38875e00999f8985b75fb1ad4bd8e87634eee",
    "3a0fb4d64aeeb868334324f7074bff27307335cd0248d4ece2626273f9bafb5f",
    "4d003ae3429be776a9754d61ae642edc97d7b50931d1a9b0c6ab19006362efa5"
]);
const TEXT_FILES = /(?:\.(?:cmd|bat|css|html|json|lock|md|mjs|ps1|py|sh|toml|ts|tsx|txt|ya?ml)|\.gitignore|\.gitattributes|\.npmrc)$/;

function digest(value: string) {
    return createHash("sha256").update(value.toLowerCase()).digest("hex");
}

function privateReferences(text: string, knownDigests = PRIVATE_DIGESTS) {
    const normalized = text.replace(/\\+/g, "/").toLowerCase();
    const candidates = [
        ...Array.from(normalized.matchAll(/(?<!\d)\d{17,20}(?!\d)/g), match => match[0]),
        ...Array.from(normalized.matchAll(/\b[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\b/g), match => match[0]),
        ...Array.from(normalized.matchAll(/(?:[a-z]:)?\/users\/([^/\r\n"'<>]+)/g), match => match[1]),
        ...Array.from(normalized.matchAll(/[a-z_][a-z0-9_.-]*/g), match => match[0]),
        ...Array.from(normalized.matchAll(/(?:\.\.\/){3}[^/\s"'`]+\/[^/\s"'`]+/g), match => match[0]),
        ...Array.from(normalized.matchAll(/[.\w-]+(?:\/[.\w-]+){2,}/g), match => match[0])
    ];
    const rules = [
        { name: "known private environment or acceptance data", matches: candidates.some(candidate => knownDigests.has(digest(candidate))) },
        { name: "private key", matches: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text) },
        { name: "Discord token", matches: /\bmfa\.[\w-]{70,}\b|\b[\w-]{24,28}\.[\w-]{6}\.[\w-]{27,}\b/.test(text) },
        { name: "GitHub token", matches: /\bgh[pousr]_[a-zA-Z0-9]{36,}\b|\bgithub_pat_[a-zA-Z0-9_]{50,}\b/.test(text) },
        { name: "authenticated webhook", matches: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{40,}/.test(text) }
    ];
    return rules.filter(rule => rule.matches).map(rule => rule.name);
}

describe("publish privacy", () => {
    it("rejects known private references and credentials while accepting public identities", () => {
        expect(privateReferences(`author=${AUTHOR_ID} application=${PUBLIC_APPLICATION_ID} https://github.com/JSTks24`)).toEqual([]);
        expect(privateReferences(`mfa.${"a".repeat(80)}`)).toEqual(["Discord token"]);
        expect(privateReferences(`ghp_${"a".repeat(40)}`)).toEqual(["GitHub token"]);
    });

    it("hashes candidate identifiers and directory segments using fictitious blocked samples", () => {
        const samples = ["100001000000000001", "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee", "fictional-private-owner", "fictional_private_workspace", "../../../fixture-source/host", ".fixtures/audit/report.json"];
        const fixtureDigests = new Set(samples.map(digest));
        for (const text of [samples[0], samples[1], `C:/Users/${samples[2]}/source`, `"C:/Users/${samples[2]}"`, `'C:/Users/${samples[2]}'`, `D:/Source/${samples[3]}/plugin`, `${samples[4]}/src/api`, samples[5]]) {
            expect(privateReferences(text, fixtureDigests)).toEqual(["known private environment or acceptance data"]);
            expect(privateReferences(text)).toEqual([]);
        }
    });

    it("scans tracked and new publishable text without reading ignored local data", () => {
        const listed = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "utf-8" });
        const offenders: string[] = [];
        for (const file of new Set(listed.split("\0").filter(Boolean))) {
            const full = join(ROOT, file);
            if (!TEXT_FILES.test(file) || !existsSync(full) || !statSync(full).isFile()) continue;
            for (const rule of privateReferences(readFileSync(full, "utf-8"))) offenders.push(`${file}: ${rule}`);
        }
        expect(offenders, `private data in publish candidates:\n${offenders.join("\n")}`).toEqual([]);
    });
});
