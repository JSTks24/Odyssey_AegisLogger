/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { React } from "@webpack/common";

import { t } from "../utils/i18n";

export default function LogsErrorState({ retry }: { retry: () => void; }) {
    return (
        <div className="aegis-modal-error-state">
            <span>{t("modal.error.loadFailed")}</span>
            <Button onClick={retry} size="small">
                {t("modal.error.retry")}
            </Button>
        </div>
    );
}
