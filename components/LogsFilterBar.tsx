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
import { HAS_VALUES, parseQuery, QueryResult, removeQueryToken, tokenizeQuery, upsertQueryToken } from "../utils/parseQuery";
import searchBox from "../utils/searchBox";
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
    placeholder: string;
    active: boolean;
}

export default function FilterBar({ query, onChange, placeholder, active }: FilterBarProps) {
    const [panelOpen, setPanelOpen] = useState(false);
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
    queryRef.current = query;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const editRawRef = useRef<string | null>(null);
    const activeNegateRef = useRef(false);
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const highlightRef = useRef(-1);
    const itemsRef = useRef<PanelItem[]>([]);
    const boxRef = useRef<HTMLDivElement | null>(null);
    const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; } | null>(null);
    const keepPanelOpen = () => {
        if (closeTimer.current != null) clearTimeout(closeTimer.current);
    };

    useEffect(() => {
        idb.getDistinctLogEntities().then(setLogged).catch(() => setLogged(null));
    }, []);

    useEffect(() => {
        const input = areaRef.current?.querySelector("input");
        if (input && document.activeElement === input)
            input.blur();
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
                cancelActivePick();
                setCalendarOpen(false);
                setPanelOpen(false);
                setActiveKind(null);
                activeKindRef.current = null;
            }, 150);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const inArea = target != null && area.contains(target);
            const inPanel = target != null && panelRef.current?.contains(target);
            if (!inArea && !inPanel) return;

            if (e.key === "Escape") {
                if (dateTypeRef.current) {
                    e.preventDefault();
                    setDateTypeOpen(false);
                    setHighlightIndex(-1);
                    highlightRef.current = -1;
                } else if (activeKind != null) {
                    e.preventDefault();
                    cancelActivePick();
                    changeKind(null);
                } else {
                    setPanelOpen(false);
                }
                return;
            }

            if (activeKind === "date" && !dateTypeRef.current) return;

            const items = itemsRef.current;
            if (!items.length) return;

            if (e.key === "ArrowDown") {
                e.preventDefault();
                const next = (highlightRef.current + 1) % items.length;
                highlightRef.current = next;
                setHighlightIndex(next);
            } else if (e.key === "ArrowUp") {
                e.preventDefault();
                const next = (highlightRef.current - 1 + items.length) % items.length;
                highlightRef.current = next;
                setHighlightIndex(next);
            } else if (e.key === "Enter") {
                if (highlightRef.current < 0) return;
                e.preventDefault();
                items[highlightRef.current]?.action();
            }
        };

        area.addEventListener("focusin", handleFocus);
        area.addEventListener("focusout", handleBlur);
        document.addEventListener("keydown", handleKeyDown);

        return () => {
            area.removeEventListener("focusin", handleFocus);
            area.removeEventListener("focusout", handleBlur);
            document.removeEventListener("keydown", handleKeyDown);
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

    const applyToken = (kind: FilterKind, value: string, negate = false) =>
        onChange(upsertQueryToken(query, kind, `${negate ? "!" : ""}${kind}:${value}`, negate, kind === "has"));

    const cancelActivePick = () => {
        const kind = activeKindRef.current;
        let base = queryRef.current;
        if (kind === "user" || kind === "server" || kind === "channel") {
            base = searchBox.cancelPick(queryRef.current, kind, editRawRef.current);
            if (base !== queryRef.current) onChangeRef.current(base);
        }
        editRawRef.current = null;
        return base;
    };
    const applyPick = (kind: PickKind, value: string) => {
        const negate = activeNegateRef.current;
        const split = searchBox.splitActiveToken(query, kind);
        const cleaned = split != null ? split.head.trimEnd() : query;
        onChange(upsertQueryToken(cleaned, kind, `${negate ? "!" : ""}${kind}:${value}`, negate, kind === "has"));
        changeKind(null);
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
        const current = tokenizeQuery(queryRef.current).queries.find(q => (CANONICAL_KIND[q.key] ?? q.key) === kind && !q.negate);
        editRawRef.current = current?.raw ?? null;
        activeNegateRef.current = false;
        setActiveNegate(false);
        onChangeRef.current(upsertQueryToken(queryRef.current, kind, `${kind}:`));
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
        const base = dateScope != null ? searchBox.removeTokens(query, [dateScope]) : query;
        onChange(upsertQueryToken(base, kind, `${kind}:${value}`));
    };

    const addDate = () => commitDate(dateKind, calendar.todayISO());

    const removeDate = () => {
        setDateValue("");
        setCalendarOpen(false);
        onChange(searchBox.removeTokens(query, [dateScope ?? dateKind]));
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

    const editToken = (kind: PickKind, current?: QueryResult) => {
        const base = cancelActivePick();
        if (kind === "before" || kind === "after") {
            openDateEditor(current);
            return;
        }
        const value = current?.value ?? "";
        const negate = current?.negate ?? false;
        const stripped = current ? removeQueryToken(base, current.raw) : base;
        onChange((stripped ? stripped + " " : "") + `${negate ? "!" : ""}${kind}:${value}`);
        editRawRef.current = current?.raw ?? null;
        activeNegateRef.current = negate;
        setActiveNegate(negate);
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
    const activeSplit = isEntity ? searchBox.splitActiveToken(query, activeKind!) : null;
    const { tokens, rest } = searchBox.splitLeadingTokens(activeSplit != null ? activeSplit.head : query);
    const boxRest = activeSplit != null ? activeSplit.rest : rest;
    const setRest = (value: string) => onChange(activeSplit != null
        ? activeSplit.head + activeSplit.prefix + value
        : searchBox.composeSearchBox(tokens, value));
    const filterText = activeSplit != null ? activeSplit.rest : "";
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
            action: () => applyPick(activeKind!, candidate.id),
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
            action: () => applyPick(activeKind!, rawId!),
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

    return (
        <div ref={areaRef} className={cl("filter-area")}>
            <div
                ref={boxRef}
                className={cl("search-box")}
                onMouseDown={e => {
                    if (!(e.target as HTMLElement).closest("input")) e.preventDefault();
                    boxRef.current?.querySelector("input")?.focus();
                }}
            >
                {tokens.map((seg, i) => {
                    const parsed = parseQuery(seg);
                    if (typeof parsed === "string")
                        return null;
                    const kind = CANONICAL_KIND[parsed.key];
                    const editable = kind != null && EDITABLE_KEYS.has(parsed.key);
                    return (
                        <span
                            key={`${i}-${seg}`}
                            className={cl("search-token") + (editable ? " " + cl("search-token-editable") : "")}
                        >
                            <span
                                className={cl("search-token-body")}
                                onClick={() => editable && kind && editToken(kind, parsed)}
                            >
                                <b>{chipLabel(parsed.key, parsed.negate)}:</b>
                                <span>{chipValue(parsed)}</span>
                            </span>
                            <button
                                type="button"
                                className={cl("search-token-remove")}
                                onClick={() => onChange(removeQueryToken(query, parsed.raw))}
                            >
                                ×
                            </button>
                        </span>
                    );
                })}
                {activeSplit != null && (
                    <span className={cl("search-token", "search-token-active")}>
                        <b>{chipLabel(activeKind!, activeNegate)}:</b>
                    </span>
                )}
                <input
                    className={cl("search-input")}
                    value={boxRest}
                    placeholder={tokens.length === 0 && activeSplit == null ? placeholder : ""}
                    onChange={e => setRest(e.currentTarget.value)}
                    onKeyDown={e => {
                        const input = e.currentTarget;
                        if (e.key !== "Backspace" || input.value !== "" || input.selectionStart !== 0) return;
                        if (activeSplit != null) {
                            e.preventDefault();
                            onChange(activeSplit.head.trimEnd());
                            changeKind(null);
                        } else if (tokens.length > 0) {
                            e.preventDefault();
                            onChange(searchBox.composeSearchBox(tokens.slice(0, -1), ""));
                        }
                    }}
                />
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
