/*
 * Vencord, a Discord client mod
 * Copyright (c) 2024 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { definePluginSettings, Settings } from "@api/Settings";
import { Button } from "@components/Button";
import ErrorBoundary from "@components/ErrorBoundary";
import { OptionType } from "@utils/types";
import { Alerts, Toasts, useState } from "@webpack/common";

import { logger, Native } from ".";
import { ClearLogsButton } from "./components/ClearLogsButton";
import logsModal from "./components/LogsModal";
import { ExclusionRulesEditor } from "./components/settings/ExclusionRulesEditor";
import { ExtensionToggles } from "./components/settings/ExtensionToggles";
import { ImageCacheDir, LogsDir } from "./components/settings/FolderSelectInput";
import { IdListEditor } from "./components/settings/IdListEditor";
import { labeled } from "./components/settings/LabeledSetting";
import { NumberInput } from "./components/settings/NumberInput";
import { SectionHeader } from "./components/settings/SectionHeader";
import { DEFAULT_IMAGE_CACHE_DIR } from "./utils/constants";
import { t } from "./utils/i18n";
import { clearLegacyLogs, countLegacyRemaining, isLegacyDbCleared, legacyDbExists, migrateLegacyImages, migrateLegacyLogs } from "./utils/migration";
import { exportLogs, importLogs } from "./utils/settingsUtils";

function ImportLogsButton() {
    const [loading, setLoading] = useState(false);

    return (
        <Button
            disabled={loading}
            onClick={async () => {
                setLoading(true);
                try {
                    await importLogs();
                } finally {
                    setLoading(false);
                }
            }}
        >
            {loading ? t("importLogs.importing") : t("importLogs.button")}
        </Button>
    );
}

function ExportLogsButton() {
    const [loading, setLoading] = useState(false);

    return (
        <Button
            disabled={loading}
            onClick={async () => {
                setLoading(true);
                try {
                    await exportLogs();
                } finally {
                    setLoading(false);
                }
            }}
        >
            {loading ? t("exportLogs.exporting") : t("exportLogs.button")}
        </Button>
    );
}

function showClearResult() {
    return isLegacyDbCleared().then(cleared => {
        Toasts.show({
            id: Toasts.genId(),
            message: cleared ? t("migrate.clearSuccess") : t("migrate.clearFailed"),
            type: cleared ? Toasts.Type.SUCCESS : Toasts.Type.FAILURE
        });
    });
}

function confirmLegacyDeletion({ migrated, duplicates, invalid, images }: { migrated: number; duplicates: number; invalid: number; images: number; }) {
    return Alerts.show({
        title: t("migrate.verifyTitle"),
        body: t("migrate.verifyBody", { migrated, duplicates, invalid, images }),
        confirmText: t("migrate.deleteLegacy"),
        cancelText: t("migrate.keepLegacy"),
        // @ts-ignore
        confirmVariant: "critical-primary",
        onConfirm: async () => {
            try {
                await clearLegacyLogs();
                await showClearResult();
            } catch (err) {
                logger.error("Failed to clear legacy database", err);
                Toasts.show({
                    id: Toasts.genId(),
                    message: t("migrate.clearBlocked"),
                    type: Toasts.Type.FAILURE
                });
            }
        }
    });
}

function MigrateLegacyButton() {
    const [loading, setLoading] = useState(false);

    return (
        <Button
            disabled={loading}
            onClick={() => Alerts.show({
                title: t("migrate.confirmTitle"),
                body: t("migrate.confirmBody"),
                confirmText: t("migrate.confirm"),
                cancelText: t("common.cancel"),
                onConfirm: async () => {
                    setLoading(true);
                    try {
                        const { migrated, duplicates, invalid } = await migrateLegacyLogs();
                        const images = await migrateLegacyImages();
                        const remaining = await countLegacyRemaining();

                        if (migrated > 0) {
                            Toasts.show({
                                id: Toasts.genId(),
                                message: t("migrate.success", { count: migrated }),
                                type: Toasts.Type.SUCCESS
                            });
                        } else if (remaining === 0) {
                            Toasts.show({
                                id: Toasts.genId(),
                                message: t("migrate.none"),
                                type: Toasts.Type.SUCCESS
                            });
                        }

                        if (remaining > 0) {
                            logger.error(`Legacy migration left ${remaining} unmigrated records`);
                            Alerts.show({
                                title: t("migrate.verifyTitle"),
                                body: t("migrate.remainingWarning", { remaining }),
                                confirmText: t("common.ok"),
                                cancelText: t("common.cancel"),
                                onConfirm: () => { }
                            });
                        } else if (await legacyDbExists()) {
                            await confirmLegacyDeletion({ migrated, duplicates, invalid, images });
                        }
                    } catch (err) {
                        logger.error("Legacy migration failed", err);
                        Toasts.show({
                            id: Toasts.genId(),
                            message: t("migrate.failed"),
                            type: Toasts.Type.FAILURE
                        });
                    } finally {
                        setLoading(false);
                    }
                }
            })}
        >
            {loading ? "..." : t("migrate.button")}
        </Button>
    );
}

function ClearLegacyButton() {
    return (
        <Button
            variant="dangerSecondary"
            onClick={() => Alerts.show({
                title: t("migrate.clearConfirmTitle"),
                body: t("migrate.clearConfirmBody"),
                confirmText: t("migrate.clearConfirm"),
                cancelText: t("common.cancel"),
                // @ts-ignore
                confirmVariant: "critical-primary",
                onConfirm: async () => {
                    try {
                        await clearLegacyLogs();
                        await showClearResult();
                    } catch (err) {
                        logger.error("Failed to clear legacy database", err);
                        Toasts.show({
                            id: Toasts.genId(),
                            message: t("migrate.clearBlocked"),
                            type: Toasts.Type.FAILURE
                        });
                    }
                }
            })}
        >
            {t("migrate.clearLegacy")}
        </Button>
    );
}

function AttachmentSizeInput() {
    return (
        <div className="aegis-setting-number">
            <NumberInput
                value={settings.store.attachmentSizeLimitInMegabytes}
                min={1}
                max={500}
                onChange={value => settings.store.attachmentSizeLimitInMegabytes = value}
            />
        </div>
    );
}

const SIZE_LADDER = [0, 100, 200, 300, 500, 800, 1000, 1500, 2000, 3000, 5000, 8000, 10000, 15000, 20000, 50000];

function unlimitedOption(value: number) {
    return { label: value === 0 ? t("settings.unlimited") : String(value), value };
}

function numberOptions(values: number[], fallback: number) {
    return values.map(value => ({ ...unlimitedOption(value), default: value === fallback }));
}

export const settings = definePluginSettings({
    sectionInterface: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.interface" hintKey="settings.group.interfaceHint" first />
    },

    language: {
        get displayName() { return t("settings.title.language"); },
        type: OptionType.SELECT,
        get description() { return t("settings.language"); },
        options: [
            { label: "Auto", value: "auto", default: true },
            { label: "中文", value: "zh-CN" },
            { label: "English", value: "en" },
        ],
    },

    ShowLogsButton: {
        get displayName() { return t("settings.title.ShowLogsButton"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.showLogsButton"); },
        default: true,
        restartNeeded: true,
    },

    messagesToDisplayAtOnceInLogs: {
        get displayName() { return t("settings.title.messagesToDisplayAtOnceInLogs"); },
        type: OptionType.SELECT,
        get description() { return t("settings.displayCount"); },
        get options() { return numberOptions([25, 50, 100, 200, 500, 1000], 100); },
    },

    sortNewest: {
        get displayName() { return t("settings.title.sortNewest"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.sortNewest"); },
        default: true,
    },

    openLogs: {
        get displayName() { return t("settings.title.openLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.openLogsDesc"); },
        component: labeled(() => (
            <Button onClick={() => logsModal.openLogModal()}>
                {t("settings.openLogs")}
            </Button>
        ))
    },

    sectionCapture: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.capture" hintKey="settings.group.captureHint" />
    },

    saveImages: {
        get displayName() { return t("settings.title.saveImages"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.saveImages"); },
        default: false
    },

    attachmentSizeLimitInMegabytes: {
        get displayName() { return t("settings.title.attachmentSizeLimitInMegabytes"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.attachmentSizeLimit"); },
        component: labeled(() => <AttachmentSizeInput />)
    },

    attachmentFileExtensions: {
        get displayName() { return t("settings.title.attachmentFileExtensions"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.attachmentExtensions"); },
        component: labeled(() => <ExtensionToggles />)
    },

    messageLimit: {
        get displayName() { return t("settings.title.messageLimit"); },
        type: OptionType.SELECT,
        get description() { return t("settings.messageLimit"); },
        get options() { return numberOptions(SIZE_LADDER, 200); },
    },

    cacheLimit: {
        get displayName() { return t("settings.title.cacheLimit"); },
        type: OptionType.SELECT,
        get description() { return t("settings.cacheLimit"); },
        get options() { return numberOptions(SIZE_LADDER, 1000); },
    },

    alwaysLogDirectMessages: {
        get displayName() { return t("settings.title.alwaysLogDirectMessages"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.alwaysLogDMs"); },
        default: true,
    },

    alwaysLogCurrentChannel: {
        get displayName() { return t("settings.title.alwaysLogCurrentChannel"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.alwaysLogCurrentChannel"); },
        default: true,
    },

    permanentlyRemoveLogByDefault: {
        get displayName() { return t("settings.title.permanentlyRemoveLogByDefault"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.permanentlyRemove"); },
        default: false,
    },

    hideMessageFromMessageLoggers: {
        get displayName() { return t("settings.title.hideMessageFromMessageLoggers"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.hideFromLoggers"); },
        default: false,
    },

    hideMessageFromMessageLoggersDeletedMessage: {
        get displayName() { return t("settings.title.hideMessageFromMessageLoggersDeletedMessage"); },
        type: OptionType.STRING,
        get description() { return t("settings.hideReplacementText"); },
        default: "redacted eh"
    },

    sectionFilter: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.filter" hintKey="settings.group.filterHint" />
    },

    ignoreBots: {
        get displayName() { return t("settings.title.ignoreBots"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.ignoreBots"); },
        default: false,
        onChange() {
            Settings.plugins.MessageLogger.ignoreBots = false;
        }
    },

    ignoreSelf: {
        get displayName() { return t("settings.title.ignoreSelf"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.ignoreSelf"); },
        default: false,
        onChange() {
            Settings.plugins.MessageLogger.ignoreSelf = false;
        }
    },

    ignoreMutedGuilds: {
        get displayName() { return t("settings.title.ignoreMutedGuilds"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.ignoreMutedGuilds"); },
        default: false,
    },

    ignoreMutedCategories: {
        get displayName() { return t("settings.title.ignoreMutedCategories"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.ignoreMutedCategories"); },
        default: false,
    },

    ignoreMutedChannels: {
        get displayName() { return t("settings.title.ignoreMutedChannels"); },
        type: OptionType.BOOLEAN,
        get description() { return t("settings.ignoreMutedChannels"); },
        default: false,
    },

    whitelistedIds: {
        get displayName() { return t("settings.title.whitelistedIds"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.whitelistedIds"); },
        component: labeled(() => <IdListEditor listKey="whitelistedIds" />)
    },

    blacklistedIds: {
        get displayName() { return t("settings.title.blacklistedIds"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.blacklistedIds"); },
        component: labeled(() => <IdListEditor listKey="blacklistedIds" />)
    },

    exclusionRules: {
        get displayName() { return t("settings.title.exclusionRules"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.exclusionRules"); },
        component: labeled(() => <ExclusionRulesEditor />)
    },

    sectionStorage: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.storage" hintKey="settings.group.storageHint" />
    },

    logsDir: {
        get displayName() { return t("settings.title.logsDir"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.logsDir"); },
        component: labeled(() => <LogsDir />)
    },

    imageCacheDir: {
        get displayName() { return t("settings.title.imageCacheDir"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.imageCacheDir"); },
        component: labeled(() => <ImageCacheDir />)
    },

    openImageCacheFolder: {
        get displayName() { return t("settings.title.openImageCacheFolder"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.openImageCacheFolderDesc"); },
        component: labeled(() => (
            <ErrorBoundary>
                <Button onClick={async () => {
                    await Native.showItemInFolder(settings.store.imageCacheDir || DEFAULT_IMAGE_CACHE_DIR);
                }}>
                    {t("folder.openImageCache")}
                </Button>
            </ErrorBoundary>
        ))
    },

    sectionData: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.data" hintKey="settings.group.dataHint" />
    },

    importLogs: {
        get displayName() { return t("settings.title.importLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.importLogs"); },
        component: labeled(() => <ImportLogsButton />)
    },

    exportLogs: {
        get displayName() { return t("settings.title.exportLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.exportLogs"); },
        component: labeled(() => <ExportLogsButton />)
    },

    migrateLegacyLogs: {
        get displayName() { return t("settings.title.migrateLegacyLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("migrate.desc"); },
        component: labeled(() => <MigrateLegacyButton />)
    },

    clearLegacyLogs: {
        get displayName() { return t("settings.title.clearLegacyLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("migrate.clearDesc"); },
        component: labeled(() => <ClearLegacyButton />)
    },

    sectionDanger: {
        type: OptionType.COMPONENT,
        component: () => <SectionHeader titleKey="settings.group.danger" danger />
    },

    clearLogs: {
        get displayName() { return t("settings.title.clearLogs"); },
        type: OptionType.COMPONENT,
        get description() { return t("settings.clearLogs"); },
        component: labeled(() => <ClearLogsButton onCleared={() => { }} />)
    },
});
