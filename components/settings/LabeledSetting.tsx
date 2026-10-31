/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Text } from "@components/Text";
import { classNameFactory } from "@utils/css";
import type { ReactNode } from "react";

const cl = classNameFactory("aegis-setting-");

interface LabeledOption {
    displayName?: string;
    description?: string;
}

export function LabeledSetting({ option, children }: { option?: LabeledOption; children: ReactNode; }) {
    const name = option?.displayName;
    const description = option?.description;

    return (
        <div className={cl("wrap")}>
            {name && (
                <div className={cl("label")}>
                    <Text size="md" weight="medium" className={cl("title")}>{name}</Text>
                    {description && <Text size="sm" weight="normal" className={cl("description")}>{description}</Text>}
                </div>
            )}
            {children}
        </div>
    );
}

export function labeled(component: () => ReactNode) {
    return function LabeledComponent({ option }: { option?: LabeledOption; }) {
        return <LabeledSetting option={option}>{component()}</LabeledSetting>;
    };
}
