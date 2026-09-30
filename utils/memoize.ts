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

type MemoizedFunction<T extends (...args: any[]) => any> = {
    (...args: Parameters<T>): ReturnType<T>;
    delete(...args: Parameters<T>): void;
    clear(): void;
};

const isThenable = (value: unknown): value is PromiseLike<unknown> =>
    value != null && typeof (value as PromiseLike<unknown>).then === "function";

export function memoize<T extends (...args: any[]) => any>(func: T, limit = 0): MemoizedFunction<T> {
    const cache = new Map<string, ReturnType<T>>();

    const memoizedFunc = (...args: Parameters<T>): ReturnType<T> => {
        const key = JSON.stringify(args);
        if (cache.has(key)) {
            return cache.get(key)!;
        }

        if (limit > 0 && cache.size >= limit) {
            cache.delete(cache.keys().next().value!);
        }

        const result = func(...args);

        if (isThenable(result)) {
            Promise.resolve(result).catch(() => cache.delete(key));
        }

        cache.set(key, result);
        return result;
    };

    memoizedFunc.delete = (...args: Parameters<T>) => {
        cache.delete(JSON.stringify(args));
    };

    memoizedFunc.clear = () => cache.clear();

    return memoizedFunc;
}
