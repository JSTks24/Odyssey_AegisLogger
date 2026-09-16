/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@utils/css";
import { Text } from "@webpack/common";
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
                    <Text variant="text-md/medium" className={cl("title")}>{name}</Text>
                    {description && <Text variant="text-sm/normal" className={cl("description")}>{description}</Text>}
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
