/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("../utils/i18n", () => ({ t: (key: string) => key }));

import { Button } from "@components/Button";

import LogsErrorState from "../components/LogsErrorState";

describe("LogsErrorState", () => {
    it("renders the load failure text with a small retry button bound to retry", () => {
        const retry = vi.fn();

        const tree = LogsErrorState({ retry }) as any;

        expect(tree.type).toBe("div");
        expect(tree.props.className).toBe("aegis-modal-error-state");

        const [text, button] = tree.props.children;
        expect(text.type).toBe("span");
        expect(text.props.children).toBe("modal.error.loadFailed");

        expect(button.type).toBe(Button);
        expect(button.props.size).toBe("small");
        expect(button.props.onClick).toBe(retry);
        expect(button.props.children).toBe("modal.error.retry");
    });
});
