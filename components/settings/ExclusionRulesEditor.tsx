/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";

import { settings } from "../../settings";
import { parseExclusionRule } from "../../utils/exclusionRules";
import { t } from "../../utils/i18n";
import { resolveId } from "./resolveId";

const cl = classNameFactory("aegis-rules-");

function scopeLabels(rule: NonNullable<ReturnType<typeof parseExclusionRule>>) {
    const labels: string[] = [];
    for (const id of rule.serverIds) {
        const info = resolveId(id);
        labels.push(`${t("settings.typeServer")}:${info.type === "unknown" ? id : info.name}`);
    }
    for (const id of rule.channelIds) {
        const info = resolveId(id);
        labels.push(`${t("settings.typeChannel")}:${info.type === "unknown" ? id : info.name}`);
    }
    for (const id of rule.userIds) {
        const info = resolveId(id);
        labels.push(`${t("settings.typeUser")}:${info.type === "unknown" ? id : info.name}`);
    }
    return labels;
}

export function ExclusionRulesEditor() {
    const store = settings.use(["exclusionRules"]);
    const value = store.exclusionRules ?? "";
    const lines = value.split("\n");

    return (
        <div className={cl("editor")}>
            <textarea
                className={cl("textarea")}
                rows={6}
                spellCheck={false}
                value={value}
                onChange={e => {
                    settings.store.exclusionRules = e.currentTarget.value;
                }}
            />
            <div className={cl("validation")}>
                {lines.map((line, index) => {
                    if (!line.trim()) return null;
                    const rule = parseExclusionRule(line);
                    if (!rule)
                        return (
                            <div key={index} className={cl("rule-invalid")}>
                                #{index + 1} {line} — regex invalid
                            </div>
                        );
                    const labels = scopeLabels(rule);
                    return (
                        <div key={index} className={cl("rule-valid")}>
                            #{index + 1}{labels.length ? ` [${labels.join(", ")}]` : ""} /{rule.source}/
                        </div>
                    );
                })}
            </div>
        </div>
    );
}
