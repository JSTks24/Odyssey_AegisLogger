/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { classNameFactory } from "@api/Styles";
import { Button } from "@components/Button";
import { ErrorCard } from "@components/ErrorCard";
import { Link } from "@components/Link";
import { ModalContent, ModalFooter, ModalHeader, ModalRoot, ModalSize, openModal } from "@utils/modal";
import type { RenderModalProps } from "@vencord/discord-types";
import { showToast, useEffect, useState } from "@webpack/common";

import { Commit, GitError, GitInfo } from "../types";
import { t } from "../utils/i18n";
import updater from "../utils/updater";

const cl = classNameFactory("aegis-updater-");

function HashLink({ repo, hash }: { repo?: string; hash: string; }) {
    if (repo == null) return <code className={cl("hash")}>{hash.slice(0, 7)}</code>;

    return (
        <Link className={cl("hash")} href={`${repo}/commit/${hash}`}>
            {hash.slice(0, 7)}
        </Link>
    );
}

function UpdaterModal({ modalProps }: { modalProps: RenderModalProps; }) {
    const [busy, setBusy] = useState(false);
    const [commits, setCommits] = useState<Commit[]>(updater.changes);
    const [outdated, setOutdated] = useState(updater.isOutdated);
    const [info, setInfo] = useState<GitInfo | undefined>(updater.repoInfo);
    const [error, setError] = useState<GitError | undefined>(updater.lastError);

    const runCheck = async () => {
        setBusy(true);
        try {
            const updateAvailable = await updater.checkForUpdates();
            if (!updateAvailable && updater.lastError == null) {
                showToast(t("updater.noUpdates"), "message");
            }
            setCommits([...updater.changes]);
            setOutdated(updater.isOutdated);
            setInfo(updater.repoInfo);
            setError(updater.lastError);
        } finally {
            setBusy(false);
        }
    };

    useEffect(() => {
        if (updater.repoInfo == null && updater.lastError == null) void runCheck();
    }, []);

    const runUpdate = async () => {
        setBusy(true);
        try {
            await updater.update();
        } finally {
            setBusy(false);
        }
    };

    return (
        <ModalRoot {...modalProps} size={ModalSize.SMALL}>
            <ModalHeader>
                <div className={cl("title")}>
                    AegisLogger
                    {info?.repo && <span className={cl("repo")}> · {info.repo.split("/").slice(-2).join("/")}</span>}
                </div>
            </ModalHeader>
            <ModalContent className={cl("content")}>
                {info && (
                    <div className={cl("current")}>
                        {t("updater.currentVersion")} <HashLink repo={info.repo} hash={info.gitHash} />
                    </div>
                )}
                {error != null && (
                    <ErrorCard className={cl("error")}>
                        <h3 className={cl("error-title")}>{t("updater.checkFailed")}</h3>
                        {updater.isNotGitRepoError(error)
                            ? <p>{t("updater.notGitRepo")}</p>
                            : (
                                <>
                                    <p className={cl("error-cmd")}>{error.cmd}</p>
                                    <code className={cl("error-message")}>{error.message}</code>
                                </>
                            )}
                    </ErrorCard>
                )}
                <h3 className={cl("updates-title")}>
                    {commits.length === 0
                        ? t("updater.upToDate")
                        : commits.length === 1
                            ? t("updater.oneUpdate")
                            : t("updater.updatesAvailable", { count: commits.length })}
                </h3>
                {commits.map(commit => (
                    <div key={commit.hash} className={cl("commit")}>
                        <HashLink repo={info?.repo} hash={commit.hash} />
                        <span className={cl("commit-message")}>{commit.message}</span>
                        <span className={cl("commit-author")}>- {commit.author}</span>
                    </div>
                ))}
            </ModalContent>
            <ModalFooter className={cl("footer")}>
                <Button variant="secondary" onClick={modalProps.onClose}>
                    {t("common.cancel")}
                </Button>
                <Button disabled={busy} onClick={() => void runCheck()}>
                    {t("updater.checkButton")}
                </Button>
                {outdated && (
                    <Button disabled={busy} onClick={() => void runUpdate()}>
                        {t("updater.updateButton")}
                    </Button>
                )}
            </ModalFooter>
        </ModalRoot>
    );
}

const openUpdaterModal = () => openModal(modalProps => <UpdaterModal modalProps={modalProps} />);

const updaterModal = {
    UpdaterModal,
    openUpdaterModal,
};

export default updaterModal;
