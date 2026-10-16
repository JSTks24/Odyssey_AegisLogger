/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import { ClockIcon, ImageIcon, LinkIcon, PlusIcon } from "@components/Icons";
import { ChannelStore, GuildStore, React, ReactDOM, useEffect, useMemo, useRef, UserStore, useState } from "@webpack/common";

import idb, { LogEntities } from "../db";
import calendar from "../utils/calendar";
import entityPool from "../utils/entityPool";
import { getLocale, t } from "../utils/i18n";
import { matchCandidates } from "../utils/idMatch";
import { HAS_VALUES, QueryResult } from "../utils/parseQuery";
import searchBox, { type searchRange, type searchSegment } from "../utils/searchBox";
import searchIndex from "../utils/searchIndex";
import DateCalendar from "./DateCalendar";
import { resolveId } from "./settings/resolveId";

const cl = classNameFactory("aegis-modal-");

export type FilterKind = "user" | "server" | "channel" | "has" | "before" | "after" | "date";
type PickKind = FilterKind;

const LABEL_KEY: Record<string, string> = {
    user: "user",
    from: "user",
    server: "server",
    guild: "server",
    channel: "channel",
    in: "channel",
    has: "has",
    before: "before",
    after: "after",
    message: "message",
    during: "during",
    near: "during",
    around: "during",
};

const EDITABLE_KEYS = new Set(["user", "from", "server", "guild", "channel", "in", "before", "after"]);

const CANONICAL_KIND: Record<string, PickKind> = {
    user: "user",
    from: "user",
    server: "server",
    guild: "server",
    channel: "channel",
    in: "channel",
    before: "before",
    after: "after",
};

function PersonGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <circle cx="8" cy="5" r="3" />
            <path d="M8 9.5c-3 0-5.5 1.6-5.5 3.6V14h11v-.9c0-2-2.5-3.6-5.5-3.6Z" />
        </svg>
    );
}

function HashGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M9.5 2 9 5H6l.5-3h-1.6L4.4 5H2v1.6h2.1L3.6 10H1.5v1.6h1.8L2.8 15h1.6l.5-3.4H8l-.5 3.4h1.6l.5-3.4H12v-1.6H9.9l.5-3.4h2.1V5h-1.8L11.2 2H9.5ZM8.7 6.6 8.2 10H5.1l.5-3.4h3.1Z" />
        </svg>
    );
}

function ServerGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M3 2h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V3a1 1 0 0 1 1-1Zm0 7h10a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1Zm2-5.2a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Zm0 7a1.2 1.2 0 1 0 0 2.4 1.2 1.2 0 0 0 0-2.4Z" />
        </svg>
    );
}

function VideoGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M2 3.5h8a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1H2a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Zm10.5 3L15 4.8v6.4l-2.5-1.7v-3Z" />
        </svg>
    );
}

function FileGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M4 1.5h5L13 5.5v9a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1Zm4.6 1.7v2.8h2.8L8.6 3.2Z" />
        </svg>
    );
}

function SoundGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M2 6h2.5L8 3v10L4.5 10H2V6Zm8.5-.7a3.2 3.2 0 0 1 0 5.4V5.3Zm0-2.6a5.8 5.8 0 0 1 0 10.6v-1.5a4.3 4.3 0 0 0 0-7.6V2.7Z" />
        </svg>
    );
}

function EmbedGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={20} height={20} fill="currentColor">
            <path d="M5.5 3.5 1 8l4.5 4.5 1.1-1.1L3.2 8l3.4-3.4-1.1-1.1Zm5 0L9.4 4.6 12.8 8l-3.4 3.4 1.1 1.1L15 8l-4.5-4.5Z" />
        </svg>
    );
}

function hasGlyph(value: string) {
    switch (value) {
        case "image": return <ImageIcon width={20} height={20} />;
        case "video": return <VideoGlyph />;
        case "file": return <FileGlyph />;
        case "sound": return <SoundGlyph />;
        case "embed": return <EmbedGlyph />;
        case "link": return <LinkIcon width={20} height={20} />;
        default: return <FileGlyph />;
    }
}

function ChevronGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor">
            <path d="M3.3 5.7 8 10.4l4.7-4.7 1.1 1.1L8 12.6 2.2 6.8l1.1-1.1Z" />
        </svg>
    );
}

function CalendarGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={16} height={16} fill="currentColor">
            <path d="M5 1v1H3.5A1.5 1.5 0 0 0 2 3.5v9A1.5 1.5 0 0 0 3.5 14h9a1.5 1.5 0 0 0 1.5-1.5v-9A1.5 1.5 0 0 0 12.5 2H11V1H9.5v1h-3V1H5Zm-1.5 4h9v7h-9V5Z" />
        </svg>
    );
}

function TrashGlyph() {
    return (
        <svg viewBox="0 0 16 16" width={18} height={18} fill="currentColor">
            <path d="M6.5 1h3a1 1 0 0 1 1 1v1H13v1.5h-1l-.6 9a1 1 0 0 1-1 .9H5.6a1 1 0 0 1-1-.9L4 4.5H3V3h2.5V2a1 1 0 0 1 1-1Zm.5 2h2v-.5H7V3ZM5.5 4.5l.6 8.5h3.8l.6-8.5H5.5Z" />
        </svg>
    );
}

function chipLabel(key: string, negate: boolean) {
    if (negate) return t("filter.exclude");
    const labelKey = LABEL_KEY[key];
    return labelKey ? t(`filter.${labelKey}`) : key;
}

function chipValue(q: QueryResult) {
    switch (q.key) {
        case "user":
        case "from": {
            const user = UserStore.getUser?.(q.value);
            return user?.globalName ?? user?.username ?? q.value;
        }
        case "server":
        case "guild":
            return GuildStore.getGuild?.(q.value)?.name ?? q.value;
        case "channel":
        case "in": {
            const channel: any = ChannelStore.getChannel?.(q.value);
            return channel?.name ?? entityPool.dmChannelLabel(channel) ?? q.value;
        }
        case "has":
            return t(`has.${q.value}`);
        case "before":
        case "after":
            return /^\d{4}-\d{2}-\d{2}$/.test(q.value) ? calendar.formatDayLabel(q.value, getLocale()) : q.value;
        default:
            return q.value;
    }
}

interface PanelItem {
    key: string;
    render: (active: boolean) => React.ReactNode;
    action: () => void;
}

interface FilterBarProps {
    query: string;
    onChange: (query: string) => void;
    onSubmit: (query: string) => void;
    placeholder: string;
    active: boolean;
}

export default function FilterBar({ query, onChange, onSubmit, placeholder, active }: FilterBarProps) {
    const [panelOpen, setPanelOpen] = useState(false);
    const panelOpenRef = useRef(false);
    panelOpenRef.current = panelOpen;
    const [activeKind, setActiveKind] = useState<PickKind | null>(null);
    const [dateKind, setDateKind] = useState<"before" | "after">("before");
    const [dateValue, setDateValue] = useState("");
    const [dateAnchor, setDateAnchor] = useState<{ top: number; left: number; } | null>(null);
    const [calendarOpen, setCalendarOpen] = useState(false);
    const [dateTypeOpen, setDateTypeOpen] = useState(false);
    const dateTypeRef = useRef(false);
    dateTypeRef.current = dateTypeOpen;
    const [logged, setLogged] = useState<LogEntities | null>(null);
    const [activeNegate, setActiveNegate] = useState(false);
    const [dateScope, setDateScope] = useState<"before" | "after" | null>(null);
    const [highlightIndex, setHighlightIndex] = useState(-1);
    const areaRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const dateFieldRef = useRef<HTMLDivElement | null>(null);
    const activeKindRef = useRef<PickKind | null>(null);
    const queryRef = useRef(query);
    const externalChange = queryRef.current !== query;
    queryRef.current = query;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const onSubmitRef = useRef(onSubmit);
    onSubmitRef.current = onSubmit;
    const composingRef = useRef(false);
    const composingInputRef = useRef<{ key: string; value: string; } | null>(null);
    const [typingRange, setTypingRange] = useState<searchRange | null>(null);
    const pickRangeRef = useRef<(searchRange & { prefix: string }) | null>(null);
    const pendingCaretRef = useRef<number | null>(null);
    const caretRef = useRef(query.length);
    const [allSelected, setAllSelected] = useState(false);
    const allSelectedRef = useRef(false);
    const [selectedToken, setSelectedToken] = useState<number | null>(null);
    const selectedTokenRef = useRef<number | null>(null);
    const editRawRef = useRef<string | null>(null);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const highlightRef = useRef(-1);
    const itemsRef = useRef<PanelItem[]>([]);
    const boxRef = useRef<HTMLDivElement | null>(null);
    const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; } | null>(null);
    const keepPanelOpen = () => {
        if (closeTimer.current != null) clearTimeout(closeTimer.current);
    };
    const clearSelection = () => {
        selectedTokenRef.current = null;
        setSelectedToken(null);
        allSelectedRef.current = false;
        setAllSelected(false);
    };
    const focusAt = (offset: number) => {
        const inputs = boxRef.current?.querySelectorAll<HTMLInputElement>("input[data-text-start]");
        if (!inputs?.length) return;
        const input = Array.from(inputs).find(input => Number(input.dataset.textStart) <= offset && Number(input.dataset.textEnd) >= offset) ?? inputs[inputs.length - 1];
        const position = Math.max(0, Math.min(input.value.length, offset - Number(input.dataset.textStart)));
        input.focus();
        input.setSelectionRange(position, position);
        caretRef.current = Number(input.dataset.textStart) + position;
    };
    const updateQuery = (next: string, caret: number, editing: searchRange | null = null) => {
        clearSelection();
        pendingCaretRef.current = caret;
        caretRef.current = caret;
        setTypingRange(editing);
        queryRef.current = next;
        onChangeRef.current(next);
    };

    useEffect(() => {
        if (pendingCaretRef.current == null || composingRef.current || externalChange) return;
        const offset = pendingCaretRef.current;
        pendingCaretRef.current = null;
        focusAt(offset);
    });

    useEffect(() => {
        let cancelled = false;
        let request = 0;
        const refresh = () => {
            const current = ++request;
            if (!searchIndex.isReady()) {
                setLogged(null);
                return;
            }
            idb.getDistinctLogEntities().then(entities => {
                if (!cancelled && current === request && searchIndex.isReady()) setLogged(entities);
            }).catch(() => {
                if (!cancelled && current === request) setLogged(null);
            });
        };
        const unsubscribe = searchIndex.subscribeReady(refresh);
        refresh();

        return () => {
            cancelled = true;
            unsubscribe();
        };
    }, []);

    useEffect(() => {
        selectedTokenRef.current = null;
        setSelectedToken(null);
        if (externalChange) {
            composingRef.current = false;
            composingInputRef.current = null;
            pendingCaretRef.current = null;
            pickRangeRef.current = null;
            editRawRef.current = null;
            setTypingRange(null);
            changeKind(null);
            clearSelection();
        }
    }, [query]);

    useEffect(() => {
        const input = document.activeElement;
        if (input?.tagName === "INPUT" && areaRef.current?.contains(input)) (input as HTMLInputElement).blur();
    }, []);

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return;

        const handleFocus = () => {
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
            const box = boxRef.current;
            if (box) {
                const r = box.getBoundingClientRect();
                setAnchor({ top: r.bottom, left: r.left, width: r.width });
            }
            setPanelOpen(true);
        };
        const handleBlur = () => {
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
            closeTimer.current = setTimeout(() => {
                if (area.contains(document.activeElement) || panelRef.current?.contains(document.activeElement)) return;
                cancelActivePick(false);
                setTypingRange(null);
                setCalendarOpen(false);
                setPanelOpen(false);
                changeKind(null);
            }, 150);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const inArea = target != null && area.contains(target);
            const inPanel = target != null && panelRef.current?.contains(target);
            if (!inArea && !inPanel) return;
            if (e.isComposing || e.keyCode === 229 || composingRef.current) return;

            if (inArea && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "a") {
                e.preventDefault();
                allSelectedRef.current = true;
                setAllSelected(true);
                if (target?.tagName === "INPUT") (target as HTMLInputElement).select();
                return;
            }
            if (allSelectedRef.current && (e.key === "Backspace" || e.key === "Delete")) {
                e.preventDefault();
                pickRangeRef.current = null;
                changeKind(null);
                updateQuery("", 0);
                return;
            }

            const token = target?.closest<HTMLElement>("[data-token-index]");
            if (token != null && (e.key === "Enter" || e.key === " ")) {
                e.preventDefault();
                e.stopPropagation();
                token.click();
                return;
            }

            if (e.key === "Backspace" || e.key === "Delete") {
                const selected = token != null ? Number(token.dataset.tokenIndex) : selectedTokenRef.current;
                if (selected != null) {
                    e.preventDefault();
                    const segment = searchBox.segments(queryRef.current).filter(segment => segment.token)[selected];
                    if (segment) deleteSegment(segment);
                    return;
                }
                const input = target as HTMLInputElement;
                if (input.tagName !== "INPUT" || input.selectionStart !== input.selectionEnd) return;
                const start = Number(input.dataset.textStart);
                const end = Number(input.dataset.textEnd);
                const backward = e.key === "Backspace";
                if (backward ? input.selectionStart !== 0 : input.selectionEnd !== input.value.length) return;
                const adjacent = searchBox.segments(queryRef.current).find(segment => segment.token && (backward ? segment.end === start : segment.start === end));
                if (adjacent) {
                    e.preventDefault();
                    deleteSegment(adjacent);
                }
                return;
            }

            if (e.key === "ArrowLeft" || e.key === "ArrowRight") {
                const backward = e.key === "ArrowLeft";
                if (token != null) {
                    e.preventDefault();
                    const segment = searchBox.segments(queryRef.current).filter(segment => segment.token)[Number(token.dataset.tokenIndex)];
                    if (segment) focusAt(backward ? segment.start : segment.end);
                    clearSelection();
                    return;
                }
                const input = target as HTMLInputElement;
                if (input.tagName !== "INPUT" || input.selectionStart !== input.selectionEnd || e.shiftKey) return;
                if (backward ? input.selectionStart !== 0 : input.selectionEnd !== input.value.length) return;
                const offset = Number(backward ? input.dataset.textStart : input.dataset.textEnd);
                const adjacent = searchBox.segments(queryRef.current).find(segment => segment.token && (backward ? segment.end === offset : segment.start === offset));
                if (adjacent) {
                    e.preventDefault();
                    boxRef.current?.querySelector<HTMLElement>(`[data-token-start="${adjacent.start}"]`)?.focus();
                }
                return;
            }

            if (e.key === "Escape") {
                if (!panelOpenRef.current) return;
                e.preventDefault();
                e.stopPropagation();
                if (dateTypeRef.current) {
                    setDateTypeOpen(false);
                    setHighlightIndex(-1);
                    highlightRef.current = -1;
                } else if (activeKind != null) {
                    cancelActivePick();
                    changeKind(null);
                } else {
                    setPanelOpen(false);
                }
                return;
            }

            const items = panelOpenRef.current ? itemsRef.current : [];
            if (e.key === "Enter") {
                if (!inArea && items.length === 0) return;
                e.preventDefault();
                e.stopPropagation();
                const item = items[highlightRef.current];
                if (item != null) {
                    item.action();
                    return;
                }
                const value = searchBox.prepareSubmission(queryRef.current);
                if (value !== queryRef.current) onChangeRef.current(value);
                if (closeTimer.current != null) clearTimeout(closeTimer.current);
                editRawRef.current = null;
                pickRangeRef.current = null;
                setTypingRange(null);
                changeKind(null);
                setPanelOpen(false);
                pendingCaretRef.current = value.length;
                onSubmitRef.current(value);
                return;
            }

            if (!items.length || (activeKind === "date" && !dateTypeRef.current)) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = (highlightRef.current + 1) % items.length;
                highlightRef.current = next;
                setHighlightIndex(next);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = highlightRef.current < 0 ? items.length - 1 : (highlightRef.current - 1 + items.length) % items.length;
                highlightRef.current = next;
                setHighlightIndex(next);
            }
        };

        area.addEventListener("focusin", handleFocus);
        area.addEventListener("focusout", handleBlur);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            area.removeEventListener("focusin", handleFocus);
            area.removeEventListener("focusout", handleBlur);
            document.removeEventListener("keydown", handleKeyDown);
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
        };
    }, [activeKind]);

    useEffect(() => {
        const panel = panelRef.current;
        if (!panel || !panelOpen) return;

        const cancelClose = keepPanelOpen;
        const blockMousedown = (e: MouseEvent) => {
            e.preventDefault();
            const target = e.target as HTMLElement | null;
            const input = target?.closest?.("input, textarea");
            if (input) (input as HTMLElement).focus();
        };
        const onClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const itemEl = target.closest?.("[data-idx]");
            if (itemEl) itemsRef.current[Number(itemEl.getAttribute("data-idx"))]?.action();
        };
        panel.addEventListener("focusin", cancelClose);
        panel.addEventListener("mousedown", blockMousedown);
        panel.addEventListener("click", onClick);
        return () => {
            panel.removeEventListener("focusin", cancelClose);
            panel.removeEventListener("mousedown", blockMousedown);
            panel.removeEventListener("click", onClick);
        };
    }, [panelOpen]);

    useEffect(() => {
        if (!panelOpen) return;
        const box = boxRef.current;
        if (!box) return;
        const updateAnchor = () => {
            const rect = box.getBoundingClientRect();
            setAnchor(previous => previous?.top === rect.bottom && previous.left === rect.left && previous.width === rect.width ? previous : { top: rect.bottom, left: rect.left, width: rect.width });
        };
        const observer = new ResizeObserver(updateAnchor);
        observer.observe(box);
        window.addEventListener("resize", updateAnchor);
        window.addEventListener("scroll", updateAnchor, true);
        return () => {
            observer.disconnect();
            window.removeEventListener("resize", updateAnchor);
            window.removeEventListener("scroll", updateAnchor, true);
        };
    }, [panelOpen]);

    const placeToken = (kind: FilterKind, raw: string, negate = false, existing?: searchSegment) => {
        const base = queryRef.current;
        const current = existing ?? (kind === "has" ? undefined : searchBox.segments(base).find(segment => segment.token && (CANONICAL_KIND[segment.token.key] ?? segment.token.key) === kind && segment.token.negate === negate));
        const position = Math.max(0, Math.min(caretRef.current, base.length));
        const range = current ?? { start: position, end: position };
        const before = !current && position > 0 && base[position - 1] !== " " ? " " : "";
        const after = !current && position < base.length && base[position] !== " " ? " " : "";
        const next = searchBox.replaceRange(base, range, before + raw + after);
        const start = range.start + before.length;
        return { next, start, end: start + raw.length };
    };
    const applyToken = (kind: FilterKind, value: string, negate = false) => {
        const placed = placeToken(kind, `${negate ? "!" : ""}${kind}:${value}`, negate);
        updateQuery(placed.next, placed.end);
        changeKind(null);
    };

    const cancelActivePick = (restoreFocus = true) => {
        let base = queryRef.current;
        const range = pickRangeRef.current;
        if (range) {
            base = editRawRef.current == null ? searchBox.removeRange(base, range) : searchBox.replaceRange(base, range, editRawRef.current);
            pickRangeRef.current = null;
            updateQuery(base, Math.min(range.start, base.length));
            if (!restoreFocus) pendingCaretRef.current = null;
        }
        editRawRef.current = null;
        return base;
    };
    const applyPick = (value: string) => {
        const range = pickRangeRef.current;
        if (!range) return;
        const raw = range.prefix + value;
        const next = searchBox.replaceRange(queryRef.current, range, raw);
        pickRangeRef.current = null;
        editRawRef.current = null;
        updateQuery(next, range.start + raw.length);
        changeKind(null);
    };
    const deleteSegment = (segment: searchSegment) => {
        const pick = pickRangeRef.current;
        const distance = pick && segment.start >= pick.end ? queryRef.current.length - segment.start : null;
        if (pick && segment.start < pick.end && segment.end > pick.start) {
            pickRangeRef.current = null;
            editRawRef.current = null;
        } else cancelActivePick(false);
        if (distance != null) {
            const start = queryRef.current.length - distance;
            segment = { ...segment, start, end: start + segment.raw.length };
        }
        changeKind(null);
        const next = searchBox.removeRange(queryRef.current, segment);
        updateQuery(next, Math.min(segment.start, next.length));
    };
    const changeKind = (kind: PickKind | null) => {
        setActiveKind(kind);
        activeKindRef.current = kind;
        setCalendarOpen(false);
        setDateTypeOpen(false);
        setHighlightIndex(-1);
        highlightRef.current = -1;
    };
    const startPick = (kind: "user" | "server" | "channel") => {
        cancelActivePick();
        const current = searchBox.segments(queryRef.current).find(segment => segment.token && (CANONICAL_KIND[segment.token.key] ?? segment.token.key) === kind && !segment.token.negate);
        editRawRef.current = current?.raw ?? null;
        setActiveNegate(false);
        const prefix = `${kind}:`;
        const placed = placeToken(kind, prefix, false, current);
        pickRangeRef.current = { start: placed.start, end: placed.end, prefix };
        updateQuery(placed.next, placed.end, pickRangeRef.current);
        changeKind(kind);
    };

    const openDateEditor = (current?: QueryResult) => {
        setDateScope(current?.key === "before" || current?.key === "after" ? current.key : null);
        setDateKind(current?.key === "after" ? "after" : "before");
        setDateValue(current?.value ?? "");
        changeKind("date");
    };

    const commitDate = (kind: "before" | "after", value: string) => {
        setDateKind(kind);
        setDateValue(value);
        const existing = searchBox.segments(queryRef.current).find(segment => segment.token?.key === (dateScope ?? kind));
        const placed = placeToken(kind, `${kind}:${value}`, false, existing);
        let { next } = placed;
        let caret = placed.end;
        const duplicates = searchBox.segments(next).filter(segment => segment.token?.key === kind && !segment.token.negate && segment.start !== placed.start).reverse();
        for (const duplicate of duplicates) {
            const reduced = searchBox.removeRange(next, duplicate);
            if (duplicate.start < placed.start) caret -= next.length - reduced.length;
            next = reduced;
        }
        updateQuery(next, caret);
        setDateScope(kind);
    };

    const addDate = () => commitDate(dateKind, calendar.todayISO());

    const removeDate = () => {
        setDateValue("");
        setCalendarOpen(false);
        const next = searchBox.removeTokens(queryRef.current, [dateScope ?? dateKind]);
        updateQuery(next, next.length);
    };

    const toggleCalendar = () => {
        if (calendarOpen) {
            setCalendarOpen(false);
            return;
        }

        const field = dateFieldRef.current;
        if (!field) return;
        const rect = field.getBoundingClientRect();
        setDateAnchor({ top: rect.bottom, left: rect.left });
        setCalendarOpen(true);
    };

    const selectDateType = (kind: "before" | "after") => {
        commitDate(kind, dateValue);
        setDateTypeOpen(false);
        setHighlightIndex(-1);
        highlightRef.current = -1;
    };

    const typeItems: PanelItem[] = [
        {
            key: "date-before",
            action: () => selectDateType("before"),
            render: active => <FilterRow active={active} main={t("filter.dateType.before")} subOnly />
        },
        {
            key: "date-after",
            action: () => selectDateType("after"),
            render: active => <FilterRow active={active} main={t("filter.dateType.after")} subOnly />
        }
    ];

    const editToken = (kind: PickKind, segment: searchSegment) => {
        const previous = pickRangeRef.current;
        const distance = previous && segment.start >= previous.end ? queryRef.current.length - segment.start : null;
        cancelActivePick();
        if (distance != null) {
            const start = queryRef.current.length - distance;
            segment = { ...segment, start, end: start + segment.raw.length };
        }
        const current = segment.token!;
        if (kind === "before" || kind === "after") {
            openDateEditor(current);
            return;
        }
        const negate = current?.negate ?? false;
        const prefix = `${negate ? "!" : ""}${current.key}:`;
        pickRangeRef.current = { start: segment.start, end: segment.end, prefix };
        editRawRef.current = current.raw;
        setActiveNegate(negate);
        updateQuery(queryRef.current, segment.end, pickRangeRef.current);
        changeKind(kind);
    };

    const pool = useMemo(
        () => (activeKind === "user" || activeKind === "server" || activeKind === "channel"
            ? entityPool.buildEntityPool(activeKind, logged)
            : []),
        [activeKind, logged]
    );
    const isDate = activeKind === "date";
    const isEntity = activeKind === "user" || activeKind === "server" || activeKind === "channel";
    const activeRange = isEntity ? pickRangeRef.current : null;
    const segments = searchBox.segments(query, activeRange ?? typingRange);
    const tokens = searchBox.segments(query).filter(segment => segment.token);
    const adjustPick = (range: searchRange, difference: number, insidePick = false) => {
        const pick = pickRangeRef.current;
        if (!pick || !insidePick && range.start >= pick.end) return;
        if (insidePick) { pick.end += difference; return; }
        if (range.end <= pick.start) pick.start += difference;
        pick.end += difference;
    };
    const replaceText = (range: searchRange, value: string, caret: number, insidePick: boolean) => {
        const boundaries: searchRange[] = segments.filter(segment => segment.token);
        if (activeRange && !insidePick) boundaries.push(activeRange);
        return searchBox.replaceText(queryRef.current, range, value, caret, boundaries);
    };
    const setText = (segment: searchSegment, input: HTMLInputElement) => {
        const { value } = input;
        const range = allSelectedRef.current ? { start: 0, end: queryRef.current.length } : segment;
        const replaced = replaceText(range, value, input.selectionStart ?? value.length, input.dataset.pickInput === "true");
        const next = replaced.query;
        const { caret } = replaced;
        if (composingInputRef.current) composingInputRef.current.value = value;
        if (allSelectedRef.current) {
            pickRangeRef.current = null;
            editRawRef.current = null;
            changeKind(null);
        } else adjustPick(range, replaced.length - (range.end - range.start), input.dataset.pickInput === "true");
        const active = pickRangeRef.current;
        highlightRef.current = -1;
        setHighlightIndex(-1);
        const word = searchBox.wordAt(next, caret);
        updateQuery(next, caret, active ?? { start: Math.max(range.start, word.start), end: Math.min(range.start + replaced.length, word.end) });
    };
    const filterText = activeRange ? query.slice(activeRange.start + activeRange.prefix.length, activeRange.end) : "";
    const candidates = useMemo(
        () => (filterText.trim() ? matchCandidates(filterText, pool, 8) : pool.slice(0, 8)),
        [filterText, pool]
    );
    const rawId = /^\d{17,21}$/.test(filterText.trim()) ? filterText.trim() : null;
    const rawIdMissing = rawId != null && candidates.length === 0;

    const mainItems: PanelItem[] = [
        {
            key: "user",
            action: () => startPick("user"),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<PersonGlyph />}
                    main={t("filter.main.user")}
                    sub={"user: " + t("settings.typeUser")}
                />
            )
        },
        {
            key: "channel",
            action: () => startPick("channel"),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<HashGlyph />}
                    main={t("filter.main.channel")}
                    sub={"channel: " + t("settings.typeChannel")}
                />
            )
        },
        {
            key: "server",
            action: () => startPick("server"),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<ServerGlyph />}
                    main={t("filter.main.server")}
                    sub={"server: " + t("settings.typeServer")}
                />
            )
        },
        {
            key: "has",
            action: () => {
                changeKind("has");
            },
            render: active => (
                <FilterRow
                    active={active}
                    icon={<LinkIcon width={20} height={20} />}
                    main={t("filter.main.has")}
                    sub={"has: " + t("filter.hasExamples")}
                />
            )
        },
        {
            key: "date",
            action: () => openDateEditor(),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<ClockIcon width={20} height={20} />}
                    main={t("filter.main.date")}
                    sub={t("filter.dateHint")}
                    plainSub
                />
            )
        },
    ];

    const hasItems: PanelItem[] = HAS_VALUES.map(value => ({
        key: `has-${value}`,
        action: () => applyToken("has", value),
        render: active => (
            <FilterRow active={active} icon={hasGlyph(value)} main={t(`has.${value}`)} />
        )
    }));

    const entityIcon = (id: string) => {
        const info = resolveId(id);
        if (info.iconUrl) return <img className={cl("panel-entity-icon")} src={info.iconUrl} alt="" />;
        return activeKind === "channel" ? <HashGlyph /> : activeKind === "server" ? <ServerGlyph /> : <PersonGlyph />;
    };

    const entityItems: PanelItem[] = [
        ...candidates.map(candidate => ({
            key: `c-${candidate.id}`,
            action: () => applyPick(candidate.id),
            render: (active: boolean) => (
                <FilterRow
                    active={active}
                    icon={entityIcon(candidate.id)}
                    main={candidate.name}
                    sub={activeKind === "user" ? candidate.username ?? `${candidate.typeLabel} · ${candidate.id}` : candidate.sub}
                    plainSub
                />
            )
        })),
        ...(rawIdMissing ? [{
            key: "raw-id",
            action: () => applyPick(rawId!),
            render: (active: boolean) => (
                <FilterRow active={active} icon={entityIcon(rawId!)} main={rawId!} sub={t("settings.unknownId")} plainSub />
            )
        }] : []),
        {
            key: "back",
            action: () => {
                cancelActivePick();
                changeKind(null);
            },
            render: (active: boolean) => (
                <FilterRow active={active} main={t("filter.back")} subOnly />
            )
        }
    ];

    const panelItems = activeKind == null
        ? mainItems
        : activeKind === "has"
            ? hasItems
            : activeKind === "date" ? (dateTypeOpen ? typeItems : []) : isEntity ? entityItems : [];

    itemsRef.current = panelItems;

    const rememberCaret = (event: React.SyntheticEvent<HTMLInputElement>) => {
        const input = event.currentTarget;
        caretRef.current = Number(input.dataset.textStart) + (input.selectionStart ?? 0);
    };
    const renderInput = (segment: searchSegment, key: string, last = false) => (
        <input
            key={key}
            className={cl("search-input")}
            data-text-start={segment.start}
            data-text-end={segment.end}
            data-pick-input={key === "pick" ? "true" : undefined}
            value={!externalChange && composingInputRef.current?.key === key ? composingInputRef.current.value : segment.raw}
            size={Math.max(1, segment.raw.replace(/[^\x00-\x7f]/g, "aa").length)}
            style={{ flexGrow: last ? 1 : 0, width: segment.raw === "" ? 1 : undefined, position: segment.raw === "" && !last ? "absolute" : undefined }}
            placeholder={query === "" ? placeholder : ""}
            onChange={e => setText(segment, e.currentTarget)}
            onSelect={rememberCaret}
            onFocus={rememberCaret}
            onCompositionStart={event => {
                composingRef.current = true;
                composingInputRef.current = { key, value: event.currentTarget.value };
            }}
            onCompositionEnd={() => {
                composingRef.current = false;
                composingInputRef.current = null;
                const word = searchBox.wordAt(queryRef.current, caretRef.current);
                setTypingRange({ start: Math.max(segment.start, word.start), end: Math.min(segment.end, word.end) });
            }}
            onClick={event => {
                rememberCaret(event);
                clearSelection();
            }}
        />
    );

    return (
        <div ref={areaRef} className={cl("filter-area")}>
            <div
                ref={boxRef}
                className={cl("search-box") + (allSelected ? " " + cl("search-all-selected") : "")}
                onMouseDown={e => {
                    if ((e.target as HTMLElement).closest("input, [data-token-index]")) return;
                    e.preventDefault();
                    const firstToken = boxRef.current?.querySelector<HTMLElement>("[data-token-index], .aegis-modal-search-token-active");
                    focusAt(firstToken && e.clientX < firstToken.getBoundingClientRect().left ? 0 : query.length);
                }}
                onCopy={event => {
                    const selected = selectedTokenRef.current;
                    const raw = allSelectedRef.current ? queryRef.current : selected != null ? tokens[selected]?.raw : null;
                    if (raw == null) return;
                    event.preventDefault();
                    event.clipboardData.setData("text/plain", raw);
                }}
                onCut={event => {
                    if (!allSelectedRef.current) return;
                    event.preventDefault();
                    event.clipboardData.setData("text/plain", queryRef.current);
                    pickRangeRef.current = null;
                    changeKind(null);
                    updateQuery("", 0);
                }}
                onPaste={event => {
                    const input = event.target as HTMLInputElement;
                    const token = input.closest<HTMLElement>("[data-token-index]");
                    if (input.tagName !== "INPUT" && token == null && !allSelectedRef.current) return;
                    event.preventDefault();
                    const start = Number(input.dataset.textStart);
                    const range = allSelectedRef.current ? { start: 0, end: queryRef.current.length } : token ? tokens[Number(token.dataset.tokenIndex)] : { start: start + (input.selectionStart ?? 0), end: start + (input.selectionEnd ?? 0) };
                    const text = event.clipboardData.getData("text/plain").replace(/[\r\n]+/g, " ");
                    const replaced = replaceText(range, text, text.length, input.dataset.pickInput === "true");
                    if (allSelectedRef.current) {
                        pickRangeRef.current = null;
                        editRawRef.current = null;
                        changeKind(null);
                    } else adjustPick(range, replaced.length - (range.end - range.start), input.dataset.pickInput === "true");
                    updateQuery(replaced.query, replaced.caret, pickRangeRef.current);
                }}
            >
                {segments.map((segment, index) => {
                    const parsed = segment.token;
                    if (!parsed) {
                        if (activeRange && segment.start <= activeRange.start && segment.end >= activeRange.end) {
                            const start = activeRange.start + activeRange.prefix.length;
                            return <React.Fragment key={`text-${index}`}>
                                {renderInput({ start: segment.start, end: activeRange.start, raw: query.slice(segment.start, activeRange.start) }, "before")}
                                <span className={cl("search-token", "search-token-active")}><b>{chipLabel(activeKind!, activeNegate)}:</b></span>
                                {renderInput({ start, end: activeRange.end, raw: query.slice(start, activeRange.end) }, "pick", activeRange.end === query.length)}
                                {activeRange.end < segment.end && renderInput({ start: activeRange.end, end: segment.end, raw: query.slice(activeRange.end, segment.end) }, "after", index === segments.length - 1)}
                            </React.Fragment>;
                        }
                        return renderInput(segment, `text-${index}`, index === segments.length - 1);
                    }
                    const i = tokens.findIndex(token => token.start === segment.start);
                    const kind = CANONICAL_KIND[parsed.key];
                    const editable = kind != null && EDITABLE_KEYS.has(parsed.key);
                    return (
                        <span
                            key={`token-${index}`}
                            className={cl("search-token") + (editable ? " " + cl("search-token-editable") : "") + (selectedToken === i ? " " + cl("search-token-selected") : "")}
                            role="button"
                            tabIndex={0}
                            data-token-index={i}
                            data-token-start={segment.start}
                            aria-pressed={selectedToken === i}
                            onFocus={() => {
                                selectedTokenRef.current = i;
                                setSelectedToken(i);
                            }}
                            onClick={() => {
                                if (editable && kind) {
                                    selectedTokenRef.current = null;
                                    setSelectedToken(null);
                                    editToken(kind, segment);
                                } else {
                                    selectedTokenRef.current = i;
                                    setSelectedToken(i);
                                }
                            }}
                        >
                            <span className={cl("search-token-body")}>
                                <b>{chipLabel(parsed.key, parsed.negate)}:</b>
                                <span>{chipValue(parsed)}</span>
                            </span>
                        </span>
                    );
                })}
            </div>
            {panelOpen && anchor != null && ReactDOM.createPortal(
                <div
                    ref={panelRef}
                    className={cl("filter-panel") + (active ? "" : " " + cl("overlay-closing"))}
                    style={{ top: anchor.top + 4, left: anchor.left, width: anchor.width }}
                >
                    {activeKind == null && (
                        <>
                            <div className={cl("filter-panel-title")}>{t("filter.panelTitle")}</div>
                            {mainItems.map((item, i) => (
                                <div key={item.key} data-idx={i}>{item.render(i === highlightIndex)}</div>
                            ))}
                        </>
                    )}
                    {activeKind === "has" && (
                        <>
                            <div className={cl("filter-panel-title")}>{t("filter.has")}</div>
                            {hasItems.map((item, i) => (
                                <div key={item.key} data-idx={i}>{item.render(i === highlightIndex)}</div>
                            ))}
                        </>
                    )}
                    {isEntity && (
                        <>
                            <div className={cl("filter-panel-title")}>{t(`filter.pickGroup.${activeKind}`)}</div>
                            {entityItems.map((item, i) => (
                                <div key={item.key} data-idx={i}>{item.render(i === highlightIndex)}</div>
                            ))}
                        </>
                    )}
                    {isDate && (dateTypeOpen ? (
                        <>
                            <div className={cl("filter-panel-title")}>{t("filter.changeDateType")}</div>
                            {typeItems.map((item, i) => (
                                <div key={item.key} data-idx={i}>{item.render(i === highlightIndex)}</div>
                            ))}
                        </>
                    ) : (
                        <div className={cl("date-section")}>
                            <div className={cl("date-label")}>{t("filter.main.date")}</div>
                            <div className={cl("date-hint")}>{t("filter.dateHint")}</div>
                            {dateValue === "" ? (
                                <Button variant="secondary" className={cl("date-add")} onClick={addDate}>
                                    <PlusIcon width={18} height={18} />
                                    <span>{t("filter.addDate")}</span>
                                </Button>
                            ) : (
                                <div className={cl("date-row")}>
                                    <div
                                        className={cl("date-type")}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={t("filter.changeDateType")}
                                        onClick={() => setDateTypeOpen(true)}
                                    >
                                        <span className={cl("date-type-value")}>{t(`filter.dateType.${dateKind}`)}</span>
                                        <ChevronGlyph />
                                    </div>
                                    <div
                                        ref={dateFieldRef}
                                        className={cl("date-field")}
                                        role="button"
                                        tabIndex={0}
                                        aria-label={t("filter.changeDateType")}
                                        onClick={toggleCalendar}
                                    >
                                        <span className={cl("date-field-value")}>{calendar.formatDayLabel(dateValue, getLocale())}</span>
                                        <CalendarGlyph />
                                    </div>
                                    <Button
                                        variant="secondary"
                                        size="iconOnly"
                                        className={cl("date-remove")}
                                        aria-label={t("filter.removeDate")}
                                        onClick={removeDate}
                                    >
                                        <TrashGlyph />
                                    </Button>
                                </div>
                            )}
                        </div>
                    ))}
                </div>,
                document.querySelector(".aegis-modal-root")?.closest("[class*=\"layer\"]") ?? document.body
            )}
            {calendarOpen && dateAnchor != null && (
                <DateCalendar
                    anchor={dateAnchor}
                    value={dateValue}
                    language={getLocale()}
                    active={active}
                    onInteract={keepPanelOpen}
                    onPick={iso => {
                        commitDate(dateKind, iso);
                        setCalendarOpen(false);
                    }}
                    onClose={() => setCalendarOpen(false)}
                />
            )}
        </div>
    );
}

function FilterRow({ active, icon, main, sub, subOnly, plainSub }: {
    active: boolean;
    icon?: React.ReactNode;
    main: string;
    sub?: string;
    subOnly?: boolean;
    plainSub?: boolean;
}) {
    return (
        <div className={cl("filter-item") + (active ? " " + cl("filter-item-active") : "")}>
            {icon != null && <span className={cl("filter-panel-icon")}>{icon}</span>}
            <span className={cl("filter-item-text")}>
                <span className={subOnly ? cl("filter-item-sub") : cl("filter-item-main")}>{main}</span>
                {sub && <span className={cl("filter-item-sub")}>{plainSub ? sub : <><b>{sub.split(":")[0]}:</b>{sub.split(":").slice(1).join(":")}</>}</span>}
            </span>
        </div>
    );
}
