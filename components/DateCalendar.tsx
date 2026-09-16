/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { React, ReactDOM, useEffect, useMemo, useRef, useState } from "@webpack/common";

import calendar from "../utils/calendar";
import { t } from "../utils/i18n";

const cl = classNameFactory("aegis-modal-");

const CALENDAR_WIDTH = 260;
const VIEWPORT_MARGIN = 8;

interface dateCalendarProps {
    anchor: { top: number; left: number; };
    value: string;
    language: string;
    active: boolean;
    onPick: (iso: string) => void;
    onInteract: () => void;
    onClose: () => void;
}

export default function DateCalendar({ anchor, value, language, active, onPick, onInteract, onClose }: dateCalendarProps) {
    const weekStart = calendar.getWeekStart(language);
    const [view, setView] = useState(() => {
        const initial = calendar.parseISODate(value || calendar.todayISO());
        return { year: initial.year, monthIndex: initial.monthIndex };
    });
    const rootRef = useRef<HTMLDivElement | null>(null);
    const weeks = useMemo(() => calendar.buildMonthGrid(view.year, view.monthIndex, weekStart), [view, weekStart]);
    const today = calendar.todayISO();
    const left = Math.min(anchor.left, Math.max(VIEWPORT_MARGIN, window.innerWidth - CALENDAR_WIDTH - VIEWPORT_MARGIN));

    useEffect(() => {
        const onKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "Escape") return;
            event.preventDefault();
            event.stopPropagation();
            onClose();
        };
        const onMouseDown = (event: MouseEvent) => {
            if (rootRef.current?.contains(event.target as Node)) return;
            onClose();
        };

        document.addEventListener("keydown", onKeyDown, true);
        document.addEventListener("mousedown", onMouseDown, true);
        return () => {
            document.removeEventListener("keydown", onKeyDown, true);
            document.removeEventListener("mousedown", onMouseDown, true);
        };
    }, [onClose]);

    return ReactDOM.createPortal(
        <div
            ref={rootRef}
            className={cl("calendar") + (active ? "" : " " + cl("overlay-closing"))}
            style={{ top: anchor.top + 4, left, width: CALENDAR_WIDTH }}
            onMouseDown={onInteract}
            onFocus={onInteract}
        >
            <div className={cl("calendar-head")}>
                <button
                    className={cl("calendar-nav")}
                    aria-label={t("filter.calendarPrev")}
                    onClick={() => setView(v => calendar.addMonths(v.year, v.monthIndex, -1))}
                >
                    <ChevronGlyph back={true} />
                </button>
                <div className={cl("calendar-title")}>{calendar.formatMonthLabel(view.year, view.monthIndex, language)}</div>
                <button
                    className={cl("calendar-nav")}
                    aria-label={t("filter.calendarNext")}
                    onClick={() => setView(v => calendar.addMonths(v.year, v.monthIndex, 1))}
                >
                    <ChevronGlyph back={false} />
                </button>
            </div>
            <div className={cl("calendar-weekdays")}>
                {calendar.getWeekdayLabels(language, weekStart).map(label => (
                    <span key={label} className={cl("calendar-weekday")}>{label}</span>
                ))}
            </div>
            <div className={cl("calendar-grid")}>
                {weeks.flat().map(cell => (
                    <button
                        key={cell.iso}
                        className={cl("calendar-day")
                            + (cell.inMonth ? "" : " " + cl("calendar-day-outside"))
                            + (cell.iso === today ? " " + cl("calendar-day-today") : "")
                            + (cell.iso === value ? " " + cl("calendar-day-selected") : "")}
                        aria-label={calendar.formatDayLabel(cell.iso, language)}
                        onClick={() => onPick(cell.iso)}
                    >
                        {cell.day}
                    </button>
                ))}
            </div>
        </div>,
        document.querySelector(".aegis-modal-root")?.closest("[class*=\"layer\"]") ?? document.body
    );
}

function ChevronGlyph({ back }: { back: boolean; }) {
    return (
        <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor">
            {back
                ? <path d="M10.3 2.3 4.6 8l5.7 5.7 1.1-1.1L6.8 8l4.6-4.6-1.1-1.1Z" />
                : <path d="M5.7 2.3 4.6 3.4 9.2 8l-4.6 4.6 1.1 1.1L11.4 8 5.7 2.3Z" />}
        </svg>
    );
}
