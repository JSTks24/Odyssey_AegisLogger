import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockStore } = vi.hoisted(() => ({ mockStore: { language: "auto" } as Record<string, string> }));

vi.mock("../settings", () => ({
    settings: { store: mockStore }
}));

import { getLocale, t, tabDisplayName } from "../utils/i18n";

describe("i18n", () => {
    beforeEach(() => {
        mockStore.language = "auto";
        vi.stubGlobal("navigator", { language: "en-US" });
    });

    it("falls back to English for non-Chinese locales", () => {
        expect(getLocale()).toBe("en");
        expect(t("modal.tab.deleted")).toBe("Deleted");
    });

    it("detects Chinese from navigator", () => {
        vi.stubGlobal("navigator", { language: "zh-CN" });
        expect(getLocale()).toBe("zh-CN");
        expect(t("modal.tab.deleted")).toBe("已删除");
    });

    it("explicit setting overrides navigator", () => {
        vi.stubGlobal("navigator", { language: "zh-CN" });
        mockStore.language = "en";
        expect(getLocale()).toBe("en");

        vi.stubGlobal("navigator", { language: "en-US" });
        mockStore.language = "zh-CN";
        expect(t("common.cancel")).toBe("取消");
    });

    it("interpolates params", () => {
        vi.stubGlobal("navigator", { language: "zh-CN" });
        expect(t("modal.clearLogs.body", { count: 5 })).toBe("确定要清空 5 条日志吗");
        expect(t("import.success", { count: 12 })).toBe("成功导入 12 条日志");
    });

    it("returns the key itself when missing", () => {
        expect(t("nonexistent.key")).toBe("nonexistent.key");
    });

    it("maps tab enum values to display names", () => {
        vi.stubGlobal("navigator", { language: "zh-CN" });
        expect(tabDisplayName("Deleted")).toBe("已删除");
        expect(tabDisplayName("Ghost Pinged")).toBe("幽灵Ping");
    });
});
