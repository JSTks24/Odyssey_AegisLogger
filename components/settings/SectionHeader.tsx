/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Divider } from "@components/Divider";
import { Heading } from "@components/Heading";
import { classNameFactory } from "@utils/css";

import { t } from "../../utils/i18n";

const cl = classNameFactory("aegis-settings-");

export function SectionHeader({ titleKey, hintKey, first, danger }: { titleKey: string; hintKey?: string; first?: boolean; danger?: boolean; }) {
    const hint = hintKey ? t(hintKey) : null;
    const sectionClass = first ? cl("section") + " " + cl("section-first") : cl("section");
    const titleClass = cl("section-title") + (danger ? " " + cl("section-danger") : "");

    return (
        <div className={sectionClass}>
            {!first && <Divider />}
            <Heading tag="h2" className={titleClass}>{t(titleKey)}</Heading>
            {hint && <div className={cl("section-hint")}>{hint}</div>}
        </div>
    );
}
