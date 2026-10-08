/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { vi } from "vitest";

export const findLazy = (_filter: unknown): any => undefined;
export const findByCodeLazy = (..._args: unknown[]): any => vi.fn();
export const findStoreLazy = (_name: string): any => ({
    isMuted: () => false,
    isCategoryMuted: () => false,
    isChannelMuted: () => false
});
export const findByPropsLazy = (..._args: unknown[]): any => ({});
export const waitFor = vi.fn();
export const filters = { byProps: (..._args: unknown[]) => () => false, byCode: (..._args: unknown[]) => () => false };
export const findCssClassesLazy = (...names: string[]): Record<string, string> =>
    Object.fromEntries(names.map(name => [name, name]));
