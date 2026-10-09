import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, win32 } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import hostConfig from '../scripts/prepare-host.mjs'

let root: string
let source: string
let host: string

beforeEach(() => {
    const temporary = new URL('../node_modules/.tmp/', import.meta.url)
    mkdirSync(temporary, { recursive: true })
    root = mkdtempSync(new URL('path-migration-', temporary))
    source = join(root, '插件 source ! &')
    host = join(root, 'Vencord 宿主')
    mkdirSync(source, { recursive: true })
    for (const marker of ['.git', 'src/main/utils', 'packages/discord-types/src']) mkdirSync(join(host, marker), { recursive: true })
    writeFileSync(join(host, 'package.json'), '{"name":"vencord"}')
    writeFileSync(join(host, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    writeFileSync(join(host, 'src/main/utils/constants.ts'), '')
    writeFileSync(join(host, 'packages/discord-types/src/index.d.ts'), '')
    writeFileSync(join(source, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}\n')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('host development configuration', () => {
    it('generates ignored configuration without modifying the tracked base', () => {
        const original = readFileSync(join(source, 'tsconfig.json'), 'utf8')
        const first = hostConfig.prepareHost(host, { repoRoot: source })
        expect(first).toMatchObject({ ok: true, changed: true, tsconfig: join(source, 'tsconfig.host.json') })
        const document = JSON.parse(readFileSync(join(source, 'tsconfig.host.json'), 'utf8'))
        expect(document.extends).toBe('./tsconfig.json')
        expect(document.compilerOptions.paths['@main/*']).toEqual(['../Vencord 宿主/src/main/*'])
        expect(document.compilerOptions.types).toEqual(['node', 'react', 'vite/client'])
        expect(readFileSync(join(source, 'tsconfig.json'), 'utf8')).toBe(original)
        expect(hostConfig.prepareHost(host, { repoRoot: source })).toMatchObject({ ok: true, changed: false })
    })

    it('supports cross-volume aliases only in the generated local configuration', () => {
        const built = hostConfig.buildTsconfigDocument('D:\\宿主\\Vencord', {
            repoRoot: 'C:\\plugin', existsSync: () => true, relative: win32.relative, isAbsolute: win32.isAbsolute
        })
        expect(built).toMatchObject({ ok: true, prefix: 'D:/宿主/Vencord' })
        if (!built.ok) return
        expect(built.document.compilerOptions.paths['@api/*']).toEqual(['D:/宿主/Vencord/src/api/*'])
    })

    it('accepts the default nested host without a machine-specific fallback', () => {
        const built = hostConfig.buildTsconfigDocument(join(source, 'Vencord'), { repoRoot: source, existsSync: () => true })
        expect(built).toMatchObject({ ok: true, prefix: 'Vencord' })
    })

    it('requires an explicit complete host and never writes when invalid', () => {
        expect(hostConfig.prepareHost(undefined, { repoRoot: source })).toMatchObject({ ok: false, error: 'host_missing' })
        rmSync(join(host, 'pnpm-lock.yaml'))
        expect(hostConfig.prepareHost(host, { repoRoot: source })).toMatchObject({ ok: false, error: 'invalid_host_checkout', missing: 'pnpm-lock.yaml' })
        expect(existsSync(join(source, 'tsconfig.host.json'))).toBe(false)
    })

    it('rejects using the plugin as its own host', () => {
        expect(hostConfig.buildTsconfigDocument(source, { repoRoot: source, existsSync: () => true })).toMatchObject({ ok: false, error: 'host_is_plugin_repo' })
    })
})
