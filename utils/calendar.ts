/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

const WEEK_LENGTH = 7;
const GRID_WEEKS = 6;

interface calendarCell {
    year: number;
    monthIndex: number;
    day: number;
    iso: string;
    inMonth: boolean;
}

function toISODate(year: number, monthIndex: number, day: number) {
    return `${String(year).padStart(4, "0")}-${String(monthIndex + 1).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function parseISODate(iso: string) {
    const [year, month, day] = iso.split("-").map(Number);
    return { year, monthIndex: month - 1, day };
}

function todayISO() {
    const now = new Date();
    return toISODate(now.getFullYear(), now.getMonth(), now.getDate());
}

function addMonths(year: number, monthIndex: number, delta: number) {
    const total = year * 12 + monthIndex + delta;
    return { year: Math.floor(total / 12), monthIndex: ((total % 12) + 12) % 12 };
}

function getWeekStart(language: string): 0 | 1 {
    return language.toLowerCase().startsWith("zh") ? 1 : 0;
}

function buildMonthGrid(year: number, monthIndex: number, weekStart: number) {
    const first = new Date(year, monthIndex, 1);
    const offset = (first.getDay() - weekStart + WEEK_LENGTH) % WEEK_LENGTH;
    const cursor = new Date(year, monthIndex, 1 - offset);
    const weeks: calendarCell[][] = [];

    for (let week = 0; week < GRID_WEEKS; week++) {
        const days: calendarCell[] = [];

        for (let weekday = 0; weekday < WEEK_LENGTH; weekday++) {
            const cellYear = cursor.getFullYear();
            const cellMonth = cursor.getMonth();
            const cellDay = cursor.getDate();

            days.push({
                year: cellYear,
                monthIndex: cellMonth,
                day: cellDay,
                iso: toISODate(cellYear, cellMonth, cellDay),
                inMonth: cellYear === year && cellMonth === monthIndex
            });

            cursor.setDate(cellDay + 1);
        }

        weeks.push(days);
    }

    return weeks;
}

function formatDayLabel(iso: string, language: string) {
    const { year, monthIndex, day } = parseISODate(iso);
    return new Intl.DateTimeFormat(language, { year: "numeric", month: "long", day: "numeric" })
        .format(new Date(year, monthIndex, day));
}

function formatMonthLabel(year: number, monthIndex: number, language: string) {
    const month = new Intl.DateTimeFormat(language, { month: "long" }).format(new Date(year, monthIndex, 1));
    return `${month} ${year}`;
}

function getWeekdayLabels(language: string, weekStart: number) {
    const weekday = language.toLowerCase().startsWith("zh") ? "narrow" : "short";
    const formatter = new Intl.DateTimeFormat(language, { weekday });
    const labels: string[] = [];

    for (let i = 0; i < WEEK_LENGTH; i++) {
        labels.push(formatter.format(new Date(2024, 0, 7 + ((weekStart + i) % WEEK_LENGTH))));
    }

    return labels;
}

const calendar = {
    WEEK_LENGTH,
    GRID_WEEKS,
    toISODate,
    parseISODate,
    todayISO,
    addMonths,
    getWeekStart,
    buildMonthGrid,
    formatDayLabel,
    formatMonthLabel,
    getWeekdayLabels
};

export default calendar;
