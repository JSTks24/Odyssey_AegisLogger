import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const INSTALL_SCRIPT = join(ROOT, 'install.cmd')
const MACHINE_PATH = ['MY_PROGRAM', 'PROJECT'].join('_')
const SKIP_DIRS = new Set(['.git', '.playwright-mcp', 'Vencord', 'dist', 'idb', 'native-file-system-adapter', 'node_modules', 'streamparser-json'])
const TEXT_FILE = /\.(cmd|css|json|md|mjs|ts|tsx|ya?ml)$/

function* walkTextFiles(dir: string): Generator<string> {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name)
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue
            yield* walkTextFiles(full)
        } else if (TEXT_FILE.test(entry.name) && !entry.name.startsWith('.aegislogger-') && entry.name !== 'tsconfig.host.json') yield full
    }
}

describe('Windows entry packaging', () => {
    const source = readFileSync(INSTALL_SCRIPT, 'ascii')

    it('uses portable ASCII, CRLF and forwards arguments without delayed expansion', () => {
        expect(source).toContain('DisableDelayedExpansion')
        expect(source).toContain('node "%~dp0scripts\\install.mjs" %*')
        expect(source).toContain('\r\n')
        expect(/[^\r]\n/.test(source)).toBe(false)
        expect([...readFileSync(INSTALL_SCRIPT)].every(byte => byte < 128)).toBe(true)
    })

    it('defines CRLF checkout rules for both Windows script types', () => {
        const attributes = readFileSync(join(ROOT, '.gitattributes'), 'utf8')
        expect(attributes).toContain('*.cmd text eol=crlf')
        expect(attributes).toContain('*.bat text eol=crlf')
    })
})

describe('published file set', () => {
    it('does not ship a machine-local deploy script', () => {
        expect(existsSync(join(ROOT, 'scripts', 'deploy.cmd'))).toBe(false)
    })

    it('keeps machine-local paths out of published text files', () => {
        const offenders = [...walkTextFiles(ROOT)].filter(file => readFileSync(file, 'utf8').includes(MACHINE_PATH)).map(file => relative(ROOT, file).split(sep).join('/'))
        expect(offenders).toEqual([])
    })
})
