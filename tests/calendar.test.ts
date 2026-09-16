/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it } from "vitest";

import calendar from "../utils/calendar";

describe("toISODate", () => {
    it("pads month and day", () => {
        expect(calendar.toISODate(2026, 8, 16)).toBe("2026-09-16");
        expect(calendar.toISODate(2026, 0, 1)).toBe("2026-01-01");
        expect(calendar.toISODate(2026, 11, 31)).toBe("2026-12-31");
    });
});

describe("parseISODate", () => {
    it("round trips with toISODate", () => {
        expect(calendar.parseISODate("2026-09-16")).toEqual({ year: 2026, monthIndex: 8, day: 16 });
        expect(calendar.toISODate(...Object.values(calendar.parseISODate("2024-02-29")) as [number, number, number])).toBe("2024-02-29");
    });
});

describe("todayISO", () => {
    it("matches the local calendar day", () => {
        const now = new Date();
        expect(calendar.todayISO()).toBe(calendar.toISODate(now.getFullYear(), now.getMonth(), now.getDate()));
        expect(calendar.todayISO()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
});

describe("addMonths", () => {
    it("wraps across years in both directions", () => {
        expect(calendar.addMonths(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 });
        expect(calendar.addMonths(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 });
        expect(calendar.addMonths(2026, 8, -12)).toEqual({ year: 2025, monthIndex: 8 });
        expect(calendar.addMonths(2026, 8, 0)).toEqual({ year: 2026, monthIndex: 8 });
    });
});

describe("getWeekStart", () => {
    it("follows the language", () => {
        expect(calendar.getWeekStart("zh-CN")).toBe(1);
        expect(calendar.getWeekStart("en")).toBe(0);
    });
});

describe("buildMonthGrid", () => {
    it("is always 6 weeks of 7 days", () => {
        for (const monthIndex of [0, 1, 4, 8, 11]) {
            const weeks = calendar.buildMonthGrid(2026, monthIndex, 1);
            expect(weeks).toHaveLength(calendar.GRID_WEEKS);
            weeks.forEach(week => expect(week).toHaveLength(calendar.WEEK_LENGTH));
        }
    });

    it("starts on the configured week day", () => {
        const mondayFirst = calendar.buildMonthGrid(2026, 8, 1);
        expect(mondayFirst[0][0].iso).toBe("2026-08-31");
        expect(mondayFirst[0][0].inMonth).toBe(false);
        expect(mondayFirst[1][0].iso).toBe("2026-09-07");

        const sundayFirst = calendar.buildMonthGrid(2026, 8, 0);
        expect(sundayFirst[0][0].iso).toBe("2026-08-30");
    });

    it("marks in-month cells and their day count", () => {
        const september = calendar.buildMonthGrid(2026, 8, 1).flat();
        expect(september.filter(cell => cell.inMonth)).toHaveLength(30);
        expect(september.filter(cell => cell.inMonth)[0].iso).toBe("2026-09-01");

        expect(calendar.buildMonthGrid(2026, 1, 1).flat().filter(c => c.inMonth)).toHaveLength(28);
        expect(calendar.buildMonthGrid(2024, 1, 1).flat().filter(c => c.inMonth)).toHaveLength(29);
        expect(calendar.buildMonthGrid(2026, 6, 1).flat().filter(c => c.inMonth)).toHaveLength(31);
    });

    it("keeps iso consistent with the cell parts", () => {
        calendar.buildMonthGrid(2026, 8, 1).flat().forEach(cell => {
            expect(cell.iso).toBe(calendar.toISODate(cell.year, cell.monthIndex, cell.day));
        });
    });
});

describe("labels", () => {
    it("formats a day the way the native field does", () => {
        expect(calendar.formatDayLabel("2026-09-16", "zh-CN")).toBe("2026年9月16日");
    });

    it("formats a month label the way the native header does", () => {
        expect(calendar.formatMonthLabel(2026, 8, "zh-CN")).toBe("九月 2026");
        expect(calendar.formatMonthLabel(2026, 8, "en")).toBe("September 2026");
        expect(calendar.formatMonthLabel(2025, 11, "zh-CN")).toBe("十二月 2025");
    });

    it("returns 7 weekday labels starting at weekStart", () => {
        const zh = calendar.getWeekdayLabels("zh-CN", 1);
        expect(zh).toHaveLength(calendar.WEEK_LENGTH);
        expect(zh[0]).toBe("一");
        expect(zh[6]).toBe("日");

        const en = calendar.getWeekdayLabels("en", 0);
        expect(en).toHaveLength(calendar.WEEK_LENGTH);
        expect(en[0]).toBe("Sun");
    });
});
