/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export type ButtonVariant =
    | "primary" | "secondary" | "dangerPrimary" | "dangerSecondary" | "overlayPrimary" | "positive" | "link" | "none";
export type ButtonSize = "min" | "xs" | "small" | "medium" | "iconOnly";

export interface ButtonProps {
    variant?: ButtonVariant;
    size?: ButtonSize;
    onClick?: (event: unknown) => void;
    children?: unknown;
    [key: string]: unknown;
}

export function Button({ variant = "primary", size = "medium", ...restProps }: ButtonProps) {
    return { $$kind: "button", variant, size, ...restProps };
}

export function LinkButton({ variant = "link", size = "medium", ...restProps }: ButtonProps) {
    return { $$kind: "link", variant, size, ...restProps };
}

export function TextButton({ variant = "primary", ...restProps }: { variant?: string; [key: string]: unknown; }) {
    return { $$kind: "text-button", variant, ...restProps };
}

export const ButtonCompat: any = function ButtonCompat({ look, color = "BRAND", size = "medium", ...restProps }: any) {
    return { $$kind: look === "LINK" ? "text-button" : "button", color, size, ...restProps };
};

ButtonCompat.Looks = {
    FILLED: "",
    LINK: "LINK"
} as const;

ButtonCompat.Colors = {
    BRAND: "BRAND",
    PRIMARY: "PRIMARY",
    RED: "RED",
    TRANSPARENT: "TRANSPARENT",
    CUSTOM: "CUSTOM",
    GREEN: "GREEN",
    LINK: "LINK",
    WHITE: "WHITE"
} as const;

ButtonCompat.Sizes = {
    SMALL: "small",
    MEDIUM: "medium",
    LARGE: "medium",
    XLARGE: "medium",
    NONE: "min",
    MIN: "min"
} as const;
