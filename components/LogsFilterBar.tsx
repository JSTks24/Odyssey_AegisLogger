/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { ClockIcon, ImageIcon, LinkIcon } from "@components/Icons";
import { ChannelStore, GuildStore, React, ReactDOM, RelationshipStore, TextInput, UserStore, useEffect, useMemo, useRef, useState } from "@webpack/common";

import { getDistinctLogEntities, LogEntities } from "../db";
import { MatchCandidate, matchCandidates } from "../utils/idMatch";
import { t } from "../utils/i18n";
import { QueryResult, removeQueryToken, tokenizeQuery, upsertQueryToken } from "../utils/parseQuery";

const cl = classNameFactory("aegis-modal-");

export type FilterKind = "user" | "server" | "channel" | "has" | "before" | "after";
type PickKind = FilterKind;

const HAS_VALUES = ["attachment", "image", "video", "file", "sound", "embed", "link"];

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
        case "in":
            return ChannelStore.getChannel?.(q.value)?.name ?? q.value;
        case "has":
            return t(`has.${q.value}`);
        default:
            return q.value;
    }
}

function buildEntityPool(kind: "user" | "server" | "channel", logged: LogEntities | null): MatchCandidate[] {
    const entries = new Map<string, MatchCandidate>();
    const push = (id: string, name: string | undefined, type: string) => {
        if (!id || entries.has(id)) return;
        entries.set(id, { id, name: name ?? id, typeLabel: t(`settings.type${type === "server" ? "Server" : type === "channel" ? "Channel" : "User"}`) });
    };

    if (kind === "user") {
        for (const author of logged?.authors ?? [])
            push(author.id, author.globalName ?? author.username, "user");

        for (const friendId of (RelationshipStore.getFriendIDs?.() ?? [])) {
            const user = UserStore.getUsers()[friendId];
            if (user) push(friendId, user.globalName ?? user.username, "user");
        }

        for (const dmUserId of (ChannelStore.getDMUserIds?.() ?? [])) {
            const user = UserStore.getUsers()[dmUserId];
            if (user) push(dmUserId, user.globalName ?? user.username, "user");
        }
    }

    if (kind === "server") {
        for (const guildId of logged?.guildIds ?? [])
            push(guildId, GuildStore.getGuild?.(guildId)?.name ?? guildId, "server");

        for (const guild of Object.values(GuildStore.getGuilds?.() ?? {}))
            push(guild.id, guild.name, "server");
    }

    if (kind === "channel") {
        for (const channelId of logged?.channelIds ?? [])
            push(channelId, ChannelStore.getChannel?.(channelId)?.name ?? channelId, "channel");

        for (const channelId of (ChannelStore.getChannelIds?.() ?? [])) {
            const channel = ChannelStore.getBasicChannel(channelId);
            if (channel?.name) push(channelId, channel.name, "channel");
        }
    }

    return [...entries.values()];
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
}

export function FilterBar({ query, onChange, placeholder }: FilterBarProps) {
    const { queries } = useMemo(() => tokenizeQuery(query), [query]);
    const [panelOpen, setPanelOpen] = useState(false);
    const [activeKind, setActiveKind] = useState<PickKind | null>(null);
    const [pickInput, setPickInput] = useState("");
    const [dateInitial, setDateInitial] = useState("");
    const [logged, setLogged] = useState<LogEntities | null>(null);
    const [highlightIndex, setHighlightIndex] = useState(0);
    const [editSeq, setEditSeq] = useState(0);
    const areaRef = useRef<HTMLDivElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const pickInputRef = useRef<HTMLInputElement | null>(null);
    const dateRef = useRef<HTMLInputElement | null>(null);
    const activeKindRef = useRef<PickKind | null>(null);
    const queryRef = useRef(query);
    queryRef.current = query;
    const onChangeRef = useRef(onChange);
    onChangeRef.current = onChange;
    const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
    const highlightRef = useRef(0);
    const itemsRef = useRef<PanelItem[]>([]);
    const [anchor, setAnchor] = useState<{ top: number; left: number; width: number; } | null>(null);

    useEffect(() => {
        getDistinctLogEntities().then(setLogged).catch(() => setLogged(null));
    }, []);

    useEffect(() => {
        const input = areaRef.current?.querySelector("input");
        if (input && document.activeElement === input)
            input.blur();
    }, []);

    useEffect(() => {
        const area = areaRef.current;
        if (!area) return;

        const focusInput = area.querySelector("input");

        const handleFocus = () => {
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
            if (focusInput) {
                const r = focusInput.getBoundingClientRect();
                setAnchor({ top: r.bottom, left: r.left, width: r.width });
            }
            setPanelOpen(true);
        };
        const handleBlur = () => {
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
            closeTimer.current = setTimeout(() => {
                setPanelOpen(false);
                setActiveKind(null);
            }, 150);
        };
        const handleKeyDown = (e: KeyboardEvent) => {
            const target = e.target as HTMLElement | null;
            const inArea = target != null && area.contains(target);
            const inPanel = target != null && panelRef.current?.contains(target);
            if (!inArea && !inPanel) return;

            if (e.key === "Escape") {
                if (activeKind != null) {
                    e.preventDefault();
                    setActiveKind(null);
                    setHighlightIndex(0);
                    highlightRef.current = 0;
                } else {
                    setPanelOpen(false);
                }
                return;
            }

            if (activeKind === "before" || activeKind === "after") return;

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
                e.preventDefault();
                items[highlightRef.current]?.action();
            }
        };

        area.addEventListener("focusin", handleFocus);
        area.addEventListener("focusout", handleBlur);
        document.addEventListener("keydown", handleKeyDown);

        const handleChipRemove = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const btn = target.closest?.(".aegis-modal-query-chip-remove");
            if (!btn) return;
            const raw = btn.getAttribute("data-raw") ?? "";
            onChangeRef.current(removeQueryToken(queryRef.current, raw));
        };
        area.addEventListener("click", handleChipRemove);
        return () => {
            area.removeEventListener("focusin", handleFocus);
            area.removeEventListener("focusout", handleBlur);
            document.removeEventListener("keydown", handleKeyDown);
            area.removeEventListener("click", handleChipRemove);
        };
    }, [activeKind]);

    useEffect(() => {
        const panel = panelRef.current;
        if (!panel || !panelOpen) return;

        const cancelClose = () => {
            if (closeTimer.current != null) clearTimeout(closeTimer.current);
        };
        const blockMousedown = (e: MouseEvent) => e.preventDefault();
        const onClick = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            const itemEl = target.closest?.("[data-idx]");
            if (itemEl) {
                itemsRef.current[Number(itemEl.getAttribute("data-idx"))]?.action();
                return;
            }
            const btn = target.closest?.("[data-action]");
            const action = btn?.getAttribute("data-action");
            if (action === "applyDate") {
                const value = dateRef.current?.value ?? "";
                if (value) applyPickRef.current?.(activeKindRef.current as PickKind, value);
            } else if (action === "cancelDate") {
                changeKindRef.current?.(null);
            }
        };
        const onInput = (e: Event) => {
            const target = e.target as HTMLInputElement;
            if (target.classList.contains("aegis-modal-pick-input")) {
                setPickInput(target.value);
                setHighlightIndex(0);
                highlightRef.current = 0;
            }
        };

        panel.addEventListener("focusin", cancelClose);
        panel.addEventListener("mousedown", blockMousedown);
        panel.addEventListener("click", onClick);
        panel.addEventListener("input", onInput);
        return () => {
            panel.removeEventListener("focusin", cancelClose);
            panel.removeEventListener("mousedown", blockMousedown);
            panel.removeEventListener("click", onClick);
            panel.removeEventListener("input", onInput);
        };
    }, [panelOpen]);

    const applyToken = (kind: FilterKind, value: string, negate = false) =>
        onChange(upsertQueryToken(query, kind, `${negate ? "!" : ""}${kind}:${value}`, negate, kind === "has"));

    const applyPick = (kind: PickKind, value: string) => {
        applyToken(kind, value, queries.find(q => q.key === kind)?.negate ?? false);
        changeKind(null);
    };
    const applyPickRef = useRef(applyPick);
    applyPickRef.current = applyPick;

    const changeKind = (kind: PickKind | null, dateInit?: string) => {
        setActiveKind(kind);
        activeKindRef.current = kind;
        setPickInput("");
        setDateInitial(dateInit ?? "");
        setEditSeq(s => s + 1);
        setHighlightIndex(0);
        highlightRef.current = 0;
    };
    const changeKindRef = useRef(changeKind);
    changeKindRef.current = changeKind;

    const editToken = (kind: PickKind, current?: QueryResult) => {
        const dateInit = current && /^\d{4}-\d{2}-\d{2}$/.test(current.value) ? current.value : undefined;
        changeKind(kind, dateInit);
    };

    const pool = useMemo(
        () => (activeKind === "user" || activeKind === "server" || activeKind === "channel"
            ? buildEntityPool(activeKind, logged)
            : []),
        [activeKind, logged]
    );
    const candidates = useMemo(
        () => (pickInput.trim() ? matchCandidates(pickInput, pool, 8) : pool.slice(0, 8)),
        [pickInput, pool]
    );
    const rawId = /^\d+$/.test(pickInput.trim()) ? pickInput.trim() : null;
    const rawIdMissing = rawId != null && candidates.length === 0;
    const isDate = activeKind === "before" || activeKind === "after";
    const isEntity = activeKind === "user" || activeKind === "server" || activeKind === "channel";

    const mainItems: PanelItem[] = [
        {
            key: "user",
            action: () => editToken("user"),
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
            action: () => editToken("channel"),
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
            action: () => editToken("server"),
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
                setActiveKind("has");
                setHighlightIndex(0);
                highlightRef.current = 0;
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
            key: "before",
            action: () => editToken("before"),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<ClockIcon width={20} height={20} />}
                    main={t("filter.main.before")}
                    sub={"before: " + t("filter.dateWord")}
                />
            )
        },
        {
            key: "after",
            action: () => editToken("after"),
            render: active => (
                <FilterRow
                    active={active}
                    icon={<ClockIcon width={20} height={20} />}
                    main={t("filter.main.after")}
                    sub={"after: " + t("filter.dateWord")}
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

    const entityItems: PanelItem[] = [
        ...candidates.map(candidate => ({
            key: `c-${candidate.id}`,
            action: () => applyPick(activeKind!, candidate.id),
            render: (active: boolean) => (
                <FilterRow active={active} main={candidate.name} sub={`${candidate.typeLabel} · ${candidate.id}`} />
            )
        })),
        ...(rawIdMissing ? [{
            key: "raw-id",
            action: () => applyPick(activeKind!, rawId!),
            render: (active: boolean) => (
                <FilterRow active={active} main={rawId!} sub={t("settings.unknownId")} />
            )
        }] : []),
        {
            key: "back",
            action: () => {
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
            : isEntity ? entityItems : [];

    itemsRef.current = panelItems;

    return (
        <div ref={areaRef} className={cl("filter-area")}>
            <TextInput
                value={query}
                onChange={onChange}
                style={{ width: "100%" }}
                placeholder={placeholder}
            />
            {panelOpen && anchor != null && ReactDOM.createPortal(
                <div
                    ref={panelRef}
                    className={cl("filter-panel")}
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
                            <input
                                ref={pickInputRef}
                                key={`pick-${editSeq}`}
                                className={cl("pick-input")}
                                placeholder={t("filter.candidatePlaceholder")}
                                defaultValue=""
                            />
                            {entityItems.map((item, i) => (
                                <div key={item.key} data-idx={i}>{item.render(i === highlightIndex)}</div>
                            ))}
                        </>
                    )}
                    {isDate && (
                        <>
                            <input
                                ref={dateRef}
                                key={`date-${editSeq}`}
                                type="date"
                                className={cl("date-input")}
                                style={{ colorScheme: document.querySelector(".theme-dark") ? "dark" : "light" } as React.CSSProperties}
                                defaultValue={dateInitial}
                            />
                            <div className={cl("filter-actions")}>
                                <button className={cl("filter-btn")} data-action="applyDate">
                                    {t("filter.apply")}
                                </button>
                                <button className={cl("filter-btn", "filter-btn-secondary")} data-action="cancelDate">
                                    {t("common.cancel")}
                                </button>
                            </div>
                        </>
                    )}
                </div>,
                document.querySelector(".aegis-modal-root")?.closest("[class*=\"layer\"]") ?? document.body
            )}
            {queries.length > 0 && (
                <div className={cl("query-chips")}>
                    {queries.map((q, i) => {
                        const kind = CANONICAL_KIND[q.key];
                        const editable = kind != null && EDITABLE_KEYS.has(q.key);

                        return (
                            <span key={`${q.key}:${q.value}:${i}`} className={cl("query-chip")}>
                                <span className={cl("filter-chip-key")}>{chipLabel(q.key, q.negate)}:</span>
                                <span
                                    className={editable ? cl("filter-chip-value", "filter-chip-editable") : cl("filter-chip-value")}
                                    onClick={() => editable && kind && editToken(kind, q)}
                                >
                                    {chipValue(q)}
                                </span>
                                <button
                                    className={cl("query-chip-remove")}
                                    data-raw={q.raw}
                                >
                                    ×
                                </button>
                            </span>
                        );
                    })}
                </div>
            )}
        </div>
    );
}

function FilterRow({ active, icon, main, sub, subOnly }: {
    active: boolean;
    icon?: React.ReactNode;
    main: string;
    sub?: string;
    subOnly?: boolean;
}) {
    return (
        <div className={cl("filter-item") + (active ? " " + cl("filter-item-active") : "")}>
            {icon != null && <span className={cl("filter-panel-icon")}>{icon}</span>}
            <span className={cl("filter-item-text")}>
                <span className={subOnly ? cl("filter-item-sub") : cl("filter-item-main")}>{main}</span>
                {sub && <span className={cl("filter-item-sub")}><b>{sub.split(":")[0]}:</b>{sub.split(":").slice(1).join(":")}</span>}
            </span>
        </div>
    );
}
