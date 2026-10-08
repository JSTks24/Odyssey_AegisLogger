/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { Button } from "@components/Button";
import { Alerts, showToast, useState } from "@webpack/common";

import idb from "../db";
import { logger } from "../index";
import { t } from "../utils/i18n";

interface ClearLogsButtonProps {
    label?: string;
    onCleared?: () => void;
}

export function ClearLogsButton({ label, onCleared }: ClearLogsButtonProps) {
    const [loading, setLoading] = useState(false);
    return (
        <Button
            disabled={loading}
            variant="dangerPrimary"
            onClick={() => Alerts.show({
                title: t("clear.title"),
                body: t("clear.allBody"),
                // @ts-ignore
                confirmVariant: "critical-primary",
                confirmText: t("common.clear"),
                cancelText: t("common.cancel"),
                onConfirm: async () => {
                    setLoading(true);
                    try {
                        await idb.clearMessagesIDB();
                        onCleared?.();
                        showToast(t("clear.cleared"), "success");
                    } catch (err) {
                        logger.error("Failed to clear logs", err);
                        showToast(t("clear.failed"), "failure");
                    } finally {
                        setLoading(false);
                    }
                },
            })}
        >
            {loading ? t("clear.clearing") : label ?? t("clear.title")}
        </Button>
    );
}
