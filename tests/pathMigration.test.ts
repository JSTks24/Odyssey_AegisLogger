import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { buildTsconfigDocument, prepareHost } = await import('../scripts/prepare-host.mjs')

let root: string
let outside: string
let counter = 0
const outsideDirs: string[] = []

const buildFakeHost = (directory: string) => {
    mkdirSync(join(directory, '.git'), { recursive: true })
    mkdirSync(join(directory, 'src', 'main', 'utils'), { recursive: true })
    mkdirSync(join(directory, 'packages', 'discord-types', 'src'), { recursive: true })
    writeFileSync(join(directory, 'package.json'), '{"name":"fake-vencord"}')
    writeFileSync(join(directory, 'src', 'main', 'utils', 'constants.ts'), 'export const DATA_DIR = "x"')
    writeFileSync(join(directory, 'packages', 'discord-types', 'src', 'index.d.ts'), 'export {}')
}

const fakeHostOutside = () => {
    const directory = join(outside, `fake-host-${counter++} with space`)
    buildFakeHost(directory)
    return directory
}

beforeEach(() => {
    const temporary = new URL('../node_modules/.tmp/', import.meta.url)
    mkdirSync(temporary, { recursive: true })
    root = mkdtempSync(new URL('path-migration-', temporary))
    outside = resolve(root, '..', '..', '..', '..')
})

afterEach(() => {
    rmSync(root, { recursive: true, force: true })
    for (const directory of outsideDirs.splice(0)) rmSync(directory, { recursive: true, force: true })
})


const track = (directory: string) => {
    outsideDirs.push(directory)
    return directory
}

describe('host path migration H01', () => {
    it('builds relative alias paths from an explicit validated host', () => {
        const host = track(fakeHostOutside())
        const built = buildTsconfigDocument(host)
        if (!built.ok) throw new Error(built.error)
        expect(built.prefix.startsWith('../')).toBe(true)
        const paths = built.document.compilerOptions.paths
        expect(paths['@main/*']).toEqual([`${built.prefix}/src/main/*`])
        expect(paths['@vencord/discord-types']).toEqual([`${built.prefix}/packages/discord-types/src/index.d.ts`])
        expect(JSON.stringify(paths)).not.toMatch(/[A-Za-z]:[\\/]/)
    })

    it('regenerates tsconfig idempotently without absolute machine paths', () => {
        const host = track(fakeHostOutside())
        const written: Record<string, string> = {}
        const deps = {
            existsSync: () => true,
            realpathSync: (path: string) => path,
            readFileSync: (path: string) => written[path] ?? '',
            writeFileSync: (path: string, content: string) => { written[path] = content },
        }
        const first = prepareHost(host, deps)
        if (!first.ok) throw new Error(first.error)
        expect(first.changed).toBe(true)
        expect(written[first.tsconfig]).not.toMatch(/[A-Za-z]:[\\/]/)
        const second = prepareHost(host, deps)
        if (!second.ok) throw new Error(second.error)
        expect(second.changed).toBe(false)
    })

    it('accepts a host checked out inside the repository layout', () => {
        const host = join(root, 'VencordInside')
        buildFakeHost(host)
        const built = buildTsconfigDocument(host)
        if (!built.ok) throw new Error(built.error)
        expect(built.prefix.startsWith('node_modules/.tmp/')).toBe(true)
        expect(built.prefix.endsWith('/VencordInside')).toBe(true)
    })

    it('rejects invalid hosts and cross-volume hosts explicitly', () => {
        const incomplete = track(join(outside, `incomplete-${counter++}`))
        mkdirSync(incomplete, { recursive: true })
        expect(buildTsconfigDocument(incomplete)).toMatchObject({ ok: false, error: 'invalid_host_checkout' })
        const crossVolume = buildTsconfigDocument('D:\\elsewhere\\Vencord', { existsSync: () => true })
        if (crossVolume.ok) throw new Error('expected cross-volume rejection')
        expect(crossVolume.error).toBe('host_cross_volume')
        const absent = prepareHost(join(root, 'absent'), { existsSync: () => false, realpathSync: (path: string) => path })
        if (absent.ok) throw new Error('expected missing-host rejection')
        expect(absent.error).toBe('host_missing')
    })
})
