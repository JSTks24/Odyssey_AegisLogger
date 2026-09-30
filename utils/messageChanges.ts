/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { LimitedMap } from "./LimitedMap";

const CHANGE_HISTORY_LIMIT = 5000;

export interface messageChangeEvent {
    ids: string[];
    cleared: boolean;
}

type messageChangeListener = (event: messageChangeEvent) => void;

const listeners = new Set<messageChangeListener>();

let epoch = 1;
let clearedEpoch = 0;
let historyLostThrough = 0;

const changedIds = new LimitedMap<string, number>(CHANGE_HISTORY_LIMIT, (_id, changedEpoch) => {
    if (changedEpoch > historyLostThrough) historyLostThrough = changedEpoch;
});

function emit(event: messageChangeEvent) {
    for (const listener of [...listeners]) listener(event);
}

function notifyChanged(ids: Iterable<string>) {
    const list = [...ids];
    if (list.length === 0) return;

    epoch++;
    for (const id of list) changedIds.set(id, epoch);

    emit({ ids: list, cleared: false });
}

function notifyCleared() {
    epoch++;
    clearedEpoch = epoch;
    changedIds.clear();

    emit({ ids: [], cleared: true });
}

function subscribe(listener: messageChangeListener) {
    listeners.add(listener);

    return () => {
        listeners.delete(listener);
    };
}

function currentEpoch() {
    return epoch;
}

function clearedSince(value: number) {
    return clearedEpoch > value;
}

function changedSince(id: string, value: number) {
    return (changedIds.get(id) ?? 0) > value;
}

function historyCovers(value: number) {
    return value >= historyLostThrough;
}

function lostThrough() {
    return historyLostThrough;
}

function setHistoryLimit(limit: number) {
    changedIds.limit = Math.max(1, Math.floor(limit));
    changedIds.trim();
}

function resetForTests() {
    changedIds.clear();
    changedIds.limit = CHANGE_HISTORY_LIMIT;
    clearedEpoch = 0;
    historyLostThrough = 0;
}

const messageChanges = {
    notifyChanged,
    notifyCleared,
    subscribe,
    epoch: currentEpoch,
    clearedSince,
    changedSince,
    historyCovers,
    lostThrough,
    setHistoryLimit,
    resetForTests
};

export default messageChanges;
