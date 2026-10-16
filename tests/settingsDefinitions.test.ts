/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

import { JsxEmit, ModuleKind, transpileModule } from "typescript";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStore } = vi.hoisted(() => ({ mockStore: { language: "en" } }));

vi.mock("../settings", () => ({ settings: { store: mockStore } }));

import { t } from "../utils/i18n";

function loadDefinitions() {
    const source = readFileSync(new URL("../settings.tsx", import.meta.url), "utf8");
    const { outputText } = transpileModule(source, {
        fileName: "settings.tsx",
        compilerOptions: { module: ModuleKind.CommonJS, jsx: JsxEmit.React }
    });
    const refreshStyle = vi.fn();
    const exports: Record<string, any> = {};
    const dependencies: Record<string, any> = {
        "@api/Settings": {
            definePluginSettings: (definition: Record<string, any>) => ({
                definition,
                withPrivateSettings() { return this; }
            })
        },
        "@utils/types": { OptionType: { BOOLEAN: "boolean", SELECT: "select", COMPONENT: "component", STRING: "string" } },
        "./utils/i18n": { t },
        "./utils/messageLoggerSettings": { default: { refreshStyle } },
        "./components/settings/LabeledSetting": { labeled: (component: unknown) => component }
    };
    runInNewContext(outputText, {
        exports,
        require: (name: string) => dependencies[name] ?? {}
    });
    return { definition: exports.settings.definition as Record<string, any>, refreshStyle };
}

describe("MessageLogger settings definitions", () => {
    beforeEach(() => {
        mockStore.language = "en";
    });

    it("provides the six capture and display controls with the intended defaults", () => {
        const { definition } = loadDefinitions();
        expect(definition.deleteStyle.options).toEqual([
            { label: "Red text", value: "text", default: true },
            { label: "Red background", value: "overlay" }
        ]);
        for (const key of ["inlineEdits", "logDeletes", "logEdits", "logDeletedAttachments"]) {
            expect(definition[key].type).toBe("boolean");
            expect(definition[key].default).toBe(true);
        }
        expect(definition.collapseDeleted.default).toBe(false);
        expect(definition.collapseDeleted.restartNeeded).toBe(true);
        expect(definition.logDeletedAttachments.restartNeeded).toBe(true);
        expect(definition.inlineEdits.restartNeeded).not.toBe(true);
    });

    it("groups the display and capture controls without adding duplicate ignore lists", () => {
        const { definition } = loadDefinitions();
        const keys = Object.keys(definition);
        for (const key of ["deleteStyle", "collapseDeleted", "inlineEdits"]) {
            expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf("sectionInterface"));
            expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("sectionCapture"));
        }
        for (const key of ["logDeletes", "logEdits", "logDeletedAttachments"]) {
            expect(keys.indexOf(key)).toBeGreaterThan(keys.indexOf("sectionCapture"));
            expect(keys.indexOf(key)).toBeLessThan(keys.indexOf("sectionFilter"));
        }
        for (const key of ["ignoreUsers", "ignoreChannels", "ignoreGuilds"]) expect(definition).not.toHaveProperty(key);
    });

    it("refreshes MessageLogger styling when the deletion style changes", () => {
        const { definition, refreshStyle } = loadDefinitions();
        definition.deleteStyle.onChange("overlay");
        expect(refreshStyle).toHaveBeenCalledOnce();
    });

    it("localizes the new controls and style choices when language changes", () => {
        const { definition } = loadDefinitions();
        for (const language of ["en", "zh-CN"]) {
            mockStore.language = language;
            for (const key of ["deleteStyle", "collapseDeleted", "inlineEdits", "logDeletes", "logEdits", "logDeletedAttachments"]) {
                expect(definition[key].displayName).not.toMatch(/^settings\./);
                expect(definition[key].description).not.toMatch(/^settings\./);
            }
        }
        expect(definition.deleteStyle.options.map((option: { label: string; }) => option.label)).toEqual(["红色文字", "红色背景"]);
        expect(definition.logDeletedAttachments.description).toContain("不负责下载文件");
        expect(definition.saveImages.displayName).toBe("下载附件文件");
        expect(definition.saveImages.description).toContain("附件元数据");
        expect(t("settings.messageLoggerAdapterFailed")).toContain("未启动");
    });
});
