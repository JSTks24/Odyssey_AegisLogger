/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 JST
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

let running = false;
let generation = 1;

function start() {
    running = true;
    generation++;

    return generation;
}

function stop() {
    running = false;
    generation++;
}

function isRunning() {
    return running;
}

function currentGeneration() {
    return generation;
}

function isCurrent(value: number) {
    return running && generation === value;
}

const pluginRuntime = {
    start,
    stop,
    isRunning,
    generation: currentGeneration,
    isCurrent
};

export default pluginRuntime;
