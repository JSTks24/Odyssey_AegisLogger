/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspace = resolve(project, "../..");
const fixture = resolve(process.argv[2] ?? resolve(workspace, "Store/filter-fix-20261016/browser-final/index.html"));
const output = resolve(process.argv[3] ?? resolve(workspace, "Store/filter-blue-20261016/browser"));
const capturePath = resolve(workspace, "Store/filter-colors-20261016/current-colors.json");
const require = createRequire(resolve(project, "package.json"));
const { chromium } = require("playwright");
const browserPath = process.env.CHROME_PATH ?? resolve(process.env.ProgramFiles ?? "C:/Program Files", "Google/Chrome/Application/chrome.exe");
const captured = JSON.parse(readFileSync(capturePath, "utf8"));
const tokens = "background-base-lowest background-base-low background-surface-highest modal-background text-default text-normal text-strong text-muted text-subtle text-link interactive-normal interactive-accent".split(" ");
const themes = Object.fromEntries(Object.entries({
    light: ["#f2f3f5", "#fafafa", "#ffffff", "#ffffff", "#313338", "#313338", "#232428", "#5c5e66", "#4e5058", "#006ce7", "#4f5660", "#5865f2"],
    dark: ["#1e1f22", "#2b2d31", "#404249", "#313338", "#dbdee1", "#dbdee1", "#f2f3f5", "#b5bac1", "#b5bac1", "#69adff", "#b5bac1", "#5865f2"]
}).map(([theme, values]) => {
    const variables = Object.fromEntries(tokens.map((token, index) => [`--${token}`, values[index]]));
    const tint = theme === "light" ? "0,0,0" : "255,255,255";
    for (const [token, alpha] of Object.entries({ "background-modifier-accent": .08, "background-modifier-selected": .12, "background-modifier-hover": .08, "background-mod-subtle": .12, "background-mod-strong": .24, "border-muted": .2, "border-subtle": .28, "border-strong": .52 })) variables[`--${token}`] = `rgba(${tint},${alpha})`;
    return [theme, variables];
}));
themes.current = captured.find(item => item.selector === ".aegis-modal-search-token").variables;
const states = ["normal", "active", "selected", "focus-visible", "whole-selected"];
const results = [];
const checks = [];
const errors = [];
const check = (name, passed) => checks.push({ name, passed });
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ executablePath: browserPath, headless: true });
const page = await browser.newPage({ viewport: { width: 1050, height: 750 } });
page.on("pageerror", error => errors.push(error.message));

try {
    await page.goto(pathToFileURL(fixture).href);
    await page.locator("input").waitFor();
    await page.addStyleTag({ content: readFileSync(resolve(project, "styles.css"), "utf8") });
    await page.evaluate(() => document.querySelector("style:last-of-type").id = "current-colors");
    for (const [theme, variables] of Object.entries(themes)) {
        await page.evaluate(variables => {
            document.body.classList.remove("light");
            document.body.removeAttribute("style");
            for (const [name, value] of Object.entries(variables)) document.body.style.setProperty(name, value || "initial");
            document.body.style.background = "var(--modal-background)";
            document.body.style.color = "var(--text-default)";
        }, variables);
        for (const state of states) {
            await page.evaluate(() => {
                document.getElementById("current-colors").disabled = true;
                window.test.reset("word user:1111 has:image tail");
            });
            await page.locator("#outside").focus();
            await page.mouse.move(0, 0);
            await page.waitForTimeout(180);
            if (state === "focus-visible") {
                await page.keyboard.press("Shift");
                await page.locator("[data-token-index='0']").focus();
                await page.waitForTimeout(40);
            }
            await page.evaluate(state => {
                const token = document.querySelector("[data-token-index='0']");
                token.classList.toggle("aegis-modal-search-token-active", state === "active");
                token.classList.toggle("aegis-modal-search-token-selected", state === "selected");
                document.querySelector(".aegis-modal-search-box").classList.toggle("aegis-modal-search-all-selected", state === "whole-selected");
            }, state);
            const before = await geometry(page);
            await page.evaluate(() => document.getElementById("current-colors").disabled = false);
            await page.waitForTimeout(40);
            const after = await geometry(page);
            const colors = await measure(page, state);
            const name = `${theme}/${state}`;
            check(`${name}: geometry unchanged`, JSON.stringify(before) === JSON.stringify(after));
            for (const [property, matches] of Object.entries(colors.originalColors)) check(`${name}: original ${property}`, matches);
            if (state === "focus-visible") check(`${name}: focus-visible applied`, colors.focusVisible);
            results.push({ theme, state, ...colors, geometryUnchanged: JSON.stringify(before) === JSON.stringify(after) });
            await page.screenshot({ path: resolve(output, `${theme}-${state}.png`) });
        }
    }
    check("no browser runtime errors", errors.length === 0);
} catch (error) {
    errors.push(String(error));
    check("browser run completed", false);
} finally {
    const failed = checks.filter(item => !item.passed);
    const minimumTextContrast = Math.min(...results.map(item => item.minimumTextContrast));
    writeFileSync(resolve(output, "results.json"), JSON.stringify({ cssStatesOnly: true, fixture, capturePath, minimumTextContrast, checks, failed, errors, results }, null, 2));
    process.stdout.write(JSON.stringify({ checks: checks.length, failed, errors, minimumTextContrast, output }) + "\n");
    process.exitCode = failed.length ? 1 : 0;
    await browser.close();
}

function geometry(page) {
    return page.locator(".aegis-modal-search-box, .aegis-modal-search-box *, .aegis-modal-filter-panel").evaluateAll(elements => elements.map(element => element.getBoundingClientRect().toJSON()));
}

function measure(page, state) {
    return page.evaluate(state => {
        const context = document.createElement("canvas").getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
        const read = value => {
            context.clearRect(0, 0, 1, 1);
            context.fillStyle = value;
            context.fillRect(0, 0, 1, 1);
            return Array.from(context.getImageData(0, 0, 1, 1).data).map(value => value / 255);
        };
        const over = (front, back) => [...front.slice(0, 3).map((value, index) => value * front[3] + back[index] * (1 - front[3])), 1];
        const background = element => {
            const layers = [];
            for (let current = element; current; current = current.parentElement) layers.unshift(current);
            return layers.reduce((color, layer) => over(read(getComputedStyle(layer).backgroundColor), color), [1, 1, 1, 1]);
        };
        const luminance = color => color.slice(0, 3).map(value => value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);
        const contrast = (a, b) => (Math.max(luminance(a), luminance(b)) + .05) / (Math.min(luminance(a), luminance(b)) + .05);
        const token = document.querySelector("[data-token-index='0']");
        const box = token.closest(".aegis-modal-search-box");
        const tokenBackground = background(token);
        const boxBackground = background(box);
        const border = over(read(getComputedStyle(token).borderTopColor), tokenBackground);
        const texts = Array.from(box.querySelectorAll("input, .aegis-modal-search-token-body > *"));
        const textContrasts = texts.map(element => contrast(over(read(getComputedStyle(element).color), background(element)), background(element)));
        const probe = document.createElement("span");
        probe.style.cssText = "display:none;color:var(--text-link,#00a8fc);border:1px solid transparent;outline-color:var(--text-link,#00a8fc)";
        probe.style.background = `color-mix(in srgb,var(--interactive-accent,#5865f2) ${state === "active" ? 25 : ["selected", "focus-visible"].includes(state) ? 30 : 15}%,transparent)`;
        document.body.append(probe);
        const expected = getComputedStyle(probe);
        const actual = getComputedStyle(token);
        const same = (a, b) => JSON.stringify(read(a)) === JSON.stringify(read(b));
        const originalColors = {
            background: same(actual.backgroundColor, expected.backgroundColor),
            text: Array.from(token.querySelectorAll(".aegis-modal-search-token-body > *")).every(element => same(getComputedStyle(element).color, expected.color)),
            border: same(actual.borderTopColor, "transparent")
        };
        if (["selected", "focus-visible"].includes(state)) originalColors.outline = same(actual.outlineColor, expected.outlineColor);
        probe.style.background = state === "whole-selected" ? "color-mix(in srgb,var(--interactive-accent,#5865f2) 30%,transparent)" : "var(--background-base-lowest,rgba(0,0,0,.05))";
        originalColors.inputBackground = same(getComputedStyle(box).backgroundColor, getComputedStyle(probe).backgroundColor);
        probe.remove();
        return {
            originalColors, minimumTextContrast: Math.min(...textContrasts), textContrasts,
            backgroundContrast: contrast(tokenBackground, boxBackground), borderContrast: contrast(border, tokenBackground),
            background: tokenBackground, inputBackground: boxBackground, border,
            color: read(getComputedStyle(token).color), focusVisible: token.matches(":focus-visible")
        };
    }, state);
}
