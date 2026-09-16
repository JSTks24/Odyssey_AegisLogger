/*
 * Vencord, a Discord client mod
 * Copyright (c) 2025 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { TextInput,useEffect, useState } from "@webpack/common";

interface NumberInputProps {
    value: number;
    min: number;
    max: number;
    onChange: (value: number) => void;
}

export function NumberInput({ value, min, max, onChange }: NumberInputProps) {
    const [text, setText] = useState(String(value));

    useEffect(() => {
        setText(String(value));
    }, [value]);

    const commit = (raw: string) => {
        const parsed = parseInt(raw, 10);
        if (Number.isNaN(parsed)) {
            setText(String(value));
            return;
        }

        const clamped = Math.min(max, Math.max(min, parsed));
        setText(String(clamped));
        if (clamped !== value) onChange(clamped);
    };

    return (
        <TextInput
            value={text}
            onChange={setText}
            onBlur={e => commit(e.currentTarget.value)}
            placeholder={`${min}-${max}`}
        />
    );
}
