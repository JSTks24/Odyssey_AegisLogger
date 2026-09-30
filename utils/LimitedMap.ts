/*
 * Vencord, a modification for Discord's desktop app
 * Copyright (c) 2023 Vendicated and contributors
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
*/

export class LimitedMap<K, V> {
    public map: Map<K, V> = new Map();
    constructor(public limit = 0, public onEvict?: (key: K, value: V) => void) { }

    set(key: K, value: V) {
        const { limit } = this;
        if (limit > 0 && !this.map.has(key)) {
            while (this.map.size >= limit) {
                const oldest = this.map.keys().next();
                if (oldest.done) break;
                const evicted = this.map.get(oldest.value);
                this.map.delete(oldest.value);
                if (evicted !== undefined) this.onEvict?.(oldest.value, evicted);
            }
        }
        this.map.set(key, value);
    }

    get(key: K) {
        return this.map.get(key);
    }

    has(key: K) {
        return this.map.has(key);
    }

    delete(key: K) {
        return this.map.delete(key);
    }

    trim() {
        const { limit } = this;
        if (limit <= 0) return;

        while (this.map.size > limit) {
            const oldest = this.map.keys().next();
            if (oldest.done) break;
            const evicted = this.map.get(oldest.value);
            this.map.delete(oldest.value);
            if (evicted !== undefined) this.onEvict?.(oldest.value, evicted);
        }
    }

    clear() {
        this.map.clear();
    }

    get size() {
        return this.map.size;
    }
}
