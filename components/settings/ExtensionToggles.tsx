/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { TextInput, useState } from "@webpack/common";

import { settings } from "../../settings";
import { t } from "../../utils/i18n";

const cl = classNameFactory("aegis-ext-");

const COMMON_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "mp4", "webm", "mp3", "ogg", "wav", "txt", "pdf", "zip"];

export function ExtensionToggles() {
    const store = settings.use(["attachmentFileExtensions"]);
    const current = (store.attachmentFileExtensions ?? "")
        .split(",")
        .map(x => x.trim().toLowerCase())
        .filter(Boolean);
    const all = [...new Set([...COMMON_EXTENSIONS, ...current])];
    const [custom, setCustom] = useState("");

    const toggle = (ext: string) => {
        const next = current.includes(ext)
            ? current.filter(e => e !== ext)
            : [...current, ext];
        settings.store.attachmentFileExtensions = next.join(",");
    };

    return (
        <div>
            <div className={cl("chips")}>
                {all.map(ext => (
                    <button
                        key={ext}
                        className={cl("chip") + (current.includes(ext) ? " " + cl("chip-active") : "")}
                        onClick={() => toggle(ext)}
                    >
                        {ext}
                    </button>
                ))}
            </div>
            <div className={cl("custom")}>
                <TextInput
                    value={custom}
                    onChange={v => setCustom(v.replace(/[^a-z0-9]/gi, "").toLowerCase())}
                    placeholder={t("settings.customExtension")}
                />
                {custom && (
                    <button className={cl("chip") + " " + cl("chip-active")} onClick={() => {
                        toggle(custom);
                        setCustom("");
                    }}>
                        +
                    </button>
                )}
            </div>
        </div>
    );
}
