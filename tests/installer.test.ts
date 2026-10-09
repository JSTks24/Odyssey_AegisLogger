import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import installer from '../scripts/install.mjs'

type ProcessCall = { command: string; args: string[]; options: { cwd: string; env: Record<string, string>; interactive?: boolean } }
type ProcessResult = { ok: boolean; stdout?: string; stderr?: string; error?: string; message?: string }

let root: string
let sourceRoot: string
let hostRoot: string
let target: string
let calls: ProcessCall[]
let head: string
let counts: string
let dirty: string
let branch: string | null
let upstream: string | null
let fetchFails: boolean
let dependencyFails: boolean
let buildFails: boolean
let cloneFails: boolean

const put = (path: string, content: string) => {
    mkdirSync(resolve(path, '..'), { recursive: true })
    writeFileSync(path, content)
}

const makeHost = (path: string) => {
    mkdirSync(join(path, '.git'), { recursive: true })
    put(join(path, 'package.json'), JSON.stringify({ name: 'vencord', packageManager: 'pnpm@11.9.0' }))
    put(join(path, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    put(join(path, 'src/main/utils/constants.ts'), '')
    put(join(path, 'packages/discord-types/src/index.d.ts'), '')
    put(join(path, '.aegislogger-tools/node_modules/pnpm/package.json'), '{"version":"11.9.0"}')
    put(join(path, '.aegislogger-tools/node_modules/pnpm/bin/pnpm.cjs'), '')
    put(join(path, 'dist/renderer.js'), 'old-runtime')
    put(join(path, 'src/userplugins/argus-sentinel/index.ts'), 'other-plugin')
}

const record = (builtCommit = 'h1') => {
    put(join(hostRoot, '.aegislogger-install.json'), JSON.stringify({ schemaVersion: 1, sourceRoot, hostRoot, builtCommit }))
}

const result = (stdout = ''): ProcessResult => ({ ok: true, stdout, stderr: '' })
const failed = (message: string): ProcessResult => ({ ok: false, error: 'process_failed', message })
const expectResult = (value: unknown) => expect(value, JSON.stringify(value))

const run = async (command: string, args: string[], options: ProcessCall['options']): Promise<ProcessResult> => {
    calls.push({ command, args, options })
    if (command !== 'git') {
        if (args.includes('--frozen-lockfile')) return dependencyFails ? failed('dependency download failed') : result()
        if (args[1] === 'build') {
            put(join(hostRoot, 'dist/renderer.js'), buildFails ? 'broken-runtime' : 'new-runtime')
            return buildFails ? failed('compiler failed') : result()
        }
        return result()
    }
    if (args[0] === 'clone') {
        if (cloneFails) {
            put(join(args[2], 'partial.txt'), 'interrupted')
            return failed('clone interrupted')
        }
        makeHost(args[2])
        return result()
    }
    if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return result(options.cwd)
    if (args[0] === 'remote') return result(options.cwd === sourceRoot ? 'https://github.com/JSTks24/Odyssey_AegisLogger.git' : 'https://github.com/Vendicated/Vencord.git')
    if (args[0] === 'rev-parse' && args[1] === 'HEAD') return result(head)
    if (args[0] === 'symbolic-ref') return branch ? result(branch) : failed('detached')
    if (args[0] === 'status') return result(dirty)
    if (args[0] === 'rev-parse') return upstream ? result(upstream) : failed('no upstream')
    if (args[0] === 'config') return result('my-fork')
    if (args[0] === 'fetch') return fetchFails ? failed('network failed') : result()
    if (args[0] === 'rev-list') return result(counts)
    if (args[0] === 'log') return result('h2;Example Author;Fix build; safely')
    if (args[0] === 'merge') {
        head = 'h2'
        counts = '0 0'
        return result()
    }
    return failed(`unexpected git: ${args.join(' ')}`)
}

const install = () => installer.install({ sourceRoot, hostRoot, noInject: true }, { run })
const update = () => installer.update({ sourceRoot, hostRoot }, { run })
const check = () => installer.check({ sourceRoot, hostRoot }, { run })

beforeEach(() => {
    const temporary = new URL('../node_modules/.tmp/', import.meta.url)
    mkdirSync(temporary, { recursive: true })
    root = mkdtempSync(new URL('installer-', temporary))
    sourceRoot = join(root, '源码 with space ! & (test)')
    hostRoot = join(root, 'Vencord 宿主 ! &')
    target = join(hostRoot, 'src/userplugins/odyssey-aegis-logger')
    mkdirSync(join(sourceRoot, '.git'), { recursive: true })
    put(join(sourceRoot, 'package.json'), '{"name":"odyssey-aegis-logger"}')
    put(join(sourceRoot, 'pnpm-lock.yaml'), 'lockfileVersion: 9')
    put(join(sourceRoot, 'index.tsx'), 'export default {}')
    put(join(sourceRoot, 'settings.tsx'), 'export default {}')
    put(join(sourceRoot, 'native/index.ts'), 'export default {}')
    put(join(sourceRoot, 'utils/adapter.js'), 'export default {}')
    put(join(sourceRoot, 'utils/LICENSE'), 'license')
    put(join(sourceRoot, 'scripts/secrets.mjs'), 'never copy')
    put(join(sourceRoot, 'tests/private.test.ts'), 'never copy')
    put(join(sourceRoot, 'tsconfig.json'), '{"compilerOptions":{"noEmit":true}}')
    put(join(sourceRoot, 'vitest.config.ts'), 'never copy')
    makeHost(hostRoot)
    calls = []
    head = 'h1'
    counts = '0 0'
    dirty = ''
    branch = 'main'
    upstream = 'my-fork/main'
    fetchFails = false
    dependencyFails = false
    buildFails = false
    cloneFails = false
})

afterEach(() => {
    vi.restoreAllMocks()
    rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

describe('managed installation', () => {
    it('copies runtime files, generates local config, keeps sibling plugins and records successful commit', async () => {
        expectResult(await install()).toMatchObject({ ok: true, value: { built: true, restartRequired: true } })
        expect(readFileSync(join(target, 'index.tsx'), 'utf8')).toBe('export default {}')
        expect(existsSync(join(target, 'native/index.ts'))).toBe(true)
        expect(existsSync(join(target, 'utils/adapter.js'))).toBe(true)
        for (const excluded of ['tsconfig.json', 'vitest.config.ts', 'package.json', 'scripts', 'tests', '.git', 'node_modules']) expect(existsSync(join(target, excluded))).toBe(false)
        expect(lstatSync(target).isSymbolicLink()).toBe(false)
        expect(JSON.parse(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8'))).toMatchObject({ sourceRoot, hostRoot, builtCommit: 'h1' })
        expect(existsSync(join(sourceRoot, 'tsconfig.host.json'))).toBe(true)
        expect(readFileSync(join(hostRoot, 'src/userplugins/argus-sentinel/index.ts'), 'utf8')).toBe('other-plugin')
        expect(calls.some(call => call.args.includes('--frozen-lockfile'))).toBe(true)
        expect(calls.filter(call => call.command === 'git').every(call => !['reset', 'clean', 'pull'].includes(call.args[0]))).toBe(true)
    })

    it('clones a fresh default host under the installer repository', async () => {
        rmSync(hostRoot, { recursive: true })
        hostRoot = join(sourceRoot, 'Vencord')
        target = join(hostRoot, 'src/userplugins/odyssey-aegis-logger')
        expect(await installer.install({ sourceRoot, noInject: true }, { run })).toMatchObject({ ok: true })
        expect(calls.find(call => call.args[0] === 'clone')?.args[2]).toBe(hostRoot)
    })

    it('preserves partial download directories so a failed clone never deletes user content', async () => {
        rmSync(hostRoot, { recursive: true })
        cloneFails = true
        expectResult(await install()).toMatchObject({ ok: false, error: 'host_clone_failed' })
        expect(readFileSync(join(hostRoot, 'partial.txt'), 'utf8')).toBe('interrupted')
    })

    it('rejects ZIPs and a parent git repository before any download', async () => {
        rmSync(join(sourceRoot, '.git'), { recursive: true })
        expectResult(await install()).toMatchObject({ ok: false, error: 'not_a_git_clone' })
        expect(calls).toEqual([])
        mkdirSync(join(sourceRoot, '.git'))
        const parentRunner = async (command: string, args: string[], options: ProcessCall['options']) => args.includes('--show-toplevel') ? result(root) : run(command, args, options)
        expect(await installer.install({ sourceRoot, hostRoot, noInject: true }, { run: parentRunner })).toMatchObject({ ok: false, error: 'not_repository_root' })
        expect(calls.some(call => call.args[0] === 'clone')).toBe(false)
    })

    it('refuses unrelated hosts and occupied unmanaged plugin directories', async () => {
        put(join(hostRoot, 'package.json'), '{"name":"unrelated","packageManager":"pnpm@11.9.0"}')
        expectResult(await install()).toMatchObject({ ok: false, error: 'repository_identity_invalid' })
        makeHost(hostRoot)
        put(join(target, 'mine.txt'), 'retain')
        expectResult(await install()).toMatchObject({ ok: false, error: 'plugin_target_occupied' })
        expect(readFileSync(join(target, 'mine.txt'), 'utf8')).toBe('retain')
    })

    it('refuses a host that equals or contains the source checkout', async () => {
        expect(await installer.install({ sourceRoot, hostRoot: sourceRoot, noInject: true }, { run })).toMatchObject({ ok: false, error: 'host_contains_plugin_source' })
        expect(await installer.install({ sourceRoot, hostRoot: root, noInject: true }, { run })).toMatchObject({ ok: false, error: 'host_contains_plugin_source' })
        expect(await installer.install({ sourceRoot, hostRoot: join(sourceRoot, 'utils/Vencord'), noInject: true }, { run })).toMatchObject({ ok: false, error: 'host_inside_runtime_source' })
    })

    it('migrates the old junction without deleting or modifying its source', async () => {
        symlinkSync(sourceRoot, target, 'junction')
        expectResult(await install()).toMatchObject({ ok: true })
        expect(lstatSync(target).isSymbolicLink()).toBe(false)
        expect(readFileSync(join(sourceRoot, 'scripts/secrets.mjs'), 'utf8')).toBe('never copy')
    })

    it('keeps node_modules and old runtime when dependency preparation fails', async () => {
        put(join(hostRoot, 'node_modules/keep.txt'), 'keep')
        dependencyFails = true
        expectResult(await install()).toMatchObject({ ok: false, error: 'dependency_install_failed' })
        expect(readFileSync(join(hostRoot, 'node_modules/keep.txt'), 'utf8')).toBe('keep')
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('old-runtime')
        expect(existsSync(target)).toBe(false)
    })

    it('removes a first-time failed plugin copy and restores the prior host runtime', async () => {
        buildFails = true
        expectResult(await install()).toMatchObject({ ok: false, error: 'build_failed', restored: true })
        expect(existsSync(target)).toBe(false)
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('old-runtime')
        expect(existsSync(join(hostRoot, '.aegislogger-install.json'))).toBe(false)
    })

    it('restores a legacy junction when its replacement fails to build', async () => {
        symlinkSync(sourceRoot, target, 'junction')
        buildFails = true
        expectResult(await install()).toMatchObject({ ok: false, restored: true })
        expect(lstatSync(target).isSymbolicLink()).toBe(true)
        expect(existsSync(join(sourceRoot, 'index.tsx'))).toBe(true)
    })

    it('completes installation after transient Windows staging and record move locks', async () => {
        const move = installer.movePath.bind(installer)
        const blocks = new Map<string, number>()
        vi.spyOn(installer, 'movePath').mockImplementation((from, to) => move(from, to, {
            renameSync: (source: string, destination: string) => {
                if (basename(from) === 'plugin' || to.endsWith('.aegislogger-install.json')) {
                    const count = blocks.get(to) || 0
                    blocks.set(to, count + 1)
                    if (count < 2) throw Object.assign(new Error('Temporary Windows file lock'), { code: count ? 'EBUSY' : 'EPERM' })
                }
                renameSync(source, destination)
            },
            wait: async () => {}
        }))
        expectResult(await install()).toMatchObject({ ok: true })
        expect(blocks.get(target)).toBe(3)
        expect(blocks.get(join(hostRoot, '.aegislogger-install.json'))).toBe(3)
        expect(JSON.parse(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')).builtCommit).toBe('h1')
    })

    it('bounds permanent staging move failures and restores the previous installation', async () => {
        expectResult(await install()).toMatchObject({ ok: true })
        const move = installer.movePath.bind(installer)
        let attempts = 0
        vi.spyOn(installer, 'movePath').mockImplementation((from, to) => move(from, to, {
            renameSync: (source: string, destination: string) => {
                if (basename(from) === 'plugin' && to === target) {
                    attempts++
                    throw Object.assign(new Error('Permanent Windows file lock'), { code: 'EPERM' })
                }
                renameSync(source, destination)
            },
            wait: async () => {}
        }))
        head = 'h2'
        expectResult(await update()).toMatchObject({ ok: false, error: 'path_move_failed', filesystemCode: 'EPERM', restored: true })
        expect(attempts).toBe(6)
        expect(readFileSync(join(target, 'index.tsx'), 'utf8')).toBe('export default {}')
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('new-runtime')
        expect(JSON.parse(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')).builtCommit).toBe('h1')
    })

    it('retains usable backups when an old plugin cannot be restored after a build failure', async () => {
        expectResult(await install()).toMatchObject({ ok: true })
        const move = installer.movePath.bind(installer)
        vi.spyOn(installer, 'movePath').mockImplementation((from, to) => move(from, to, {
            renameSync: (source: string, destination: string) => {
                if (from.endsWith('old-plugin') && to === target) throw Object.assign(new Error('Restore target remains locked'), { code: 'EPERM' })
                renameSync(source, destination)
            },
            wait: async () => {}
        }))
        buildFails = true
        head = 'h2'
        const restored = await update()
        expectResult(restored).toMatchObject({ ok: false, error: 'restore_failed', restored: false })
        expect(readFileSync(join(restored.backupRoot, 'old-plugin/index.tsx'), 'utf8')).toBe('export default {}')
        expect(readFileSync(join(restored.backupRoot, 'dist/renderer.js'), 'utf8')).toBe('new-runtime')
        expect(existsSync(join(hostRoot, '.vencord-userplugins-install.lock'))).toBe(true)
    })
})

describe('safe source updates', () => {
    it('fetches the configured tracking remote and updates the plugin source using ff-only', async () => {
        expectResult(await install()).toMatchObject({ ok: true })
        counts = '0 1'
        expectResult(await check()).toMatchObject({ ok: true, value: { state: 'behind', changes: [{ hash: 'h2', author: 'Example Author', message: 'Fix build; safely' }] } })
        const updated = await update()
        expect(updated, JSON.stringify(updated)).toMatchObject({ ok: true, value: { info: { gitHash: 'h2', installedHash: 'h2' } } })
        expect(calls.some(call => call.args.join(' ') === 'fetch my-fork')).toBe(true)
        expect(calls.some(call => call.args.join(' ') === 'merge --ff-only @{upstream}')).toBe(true)
        expect(calls.filter(call => call.command === 'git' && call.args[0] === 'merge').every(call => call.options.cwd === sourceRoot)).toBe(true)
    })

    it.each([
        ['ahead', '1 0', '', 'main', 'my-fork/main'],
        ['diverged', '1 1', '', 'main', 'my-fork/main'],
        ['dirty', '0 0', ' M index.tsx', 'main', 'my-fork/main'],
        ['detached', '0 0', '', null, 'my-fork/main'],
        ['missing_upstream', '0 0', '', 'main', null]
    ])('reports and blocks %s without discarding user modifications', async (state, count, modifications, currentBranch, tracking) => {
        record()
        counts = count as string
        dirty = modifications as string
        branch = currentBranch as string | null
        upstream = tracking as string | null
        expectResult(await check()).toMatchObject({ ok: true, value: { state } })
        expectResult(await update()).toMatchObject({ ok: false, error: `source_${state}` })
        expect(calls.some(call => call.args[0] === 'merge' || call.args.includes('--frozen-lockfile'))).toBe(false)
    })

    it('retains builtCommit and old runtime on failure, then retries even with no new source commit', async () => {
        expectResult(await install()).toMatchObject({ ok: true })
        const oldPlugin = readFileSync(join(target, 'index.tsx'), 'utf8')
        counts = '0 1'
        buildFails = true
        expectResult(await update()).toMatchObject({ ok: false, error: 'build_failed', pendingBuild: true })
        expect(head).toBe('h2')
        expect(JSON.parse(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')).builtCommit).toBe('h1')
        expect(readFileSync(join(target, 'index.tsx'), 'utf8')).toBe(oldPlugin)
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('new-runtime')
        expectResult(await check()).toMatchObject({ ok: true, value: { state: 'current', pendingBuild: true } })
        buildFails = false
        expectResult(await update()).toMatchObject({ ok: true, value: { pendingBuild: false, info: { installedHash: 'h2' } } })
    })

    it('fails a fetch before dependencies or runtime are changed', async () => {
        record()
        fetchFails = true
        expectResult(await update()).toMatchObject({ ok: false, error: 'fetch_failed' })
        expect(calls.some(call => call.args.includes('--frozen-lockfile'))).toBe(false)
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('old-runtime')
    })

    it('rejects missing or foreign installation records', async () => {
        expectResult(await update()).toMatchObject({ ok: false })
        record()
        const path = join(hostRoot, '.aegislogger-install.json')
        const foreign = JSON.parse(readFileSync(path, 'utf8'))
        foreign.sourceRoot = root
        put(path, JSON.stringify(foreign))
        expectResult(await check()).toMatchObject({ ok: false, error: 'installation_record_invalid' })
    })

    it('allows only one installer per host and releases its lock after completion', async () => {
        put(join(hostRoot, '.vencord-userplugins-install.lock'), JSON.stringify({ pid: process.pid }))
        expectResult(await install()).toMatchObject({ ok: false, error: 'update_busy' })
        expect(existsSync(join(hostRoot, '.vencord-userplugins-install.lock'))).toBe(true)
        rmSync(join(hostRoot, '.vencord-userplugins-install.lock'))
        expectResult(await install()).toMatchObject({ ok: true })
        expect(existsSync(join(hostRoot, '.vencord-userplugins-install.lock'))).toBe(false)
    })

    it('recovers a lock only after its owning process has exited', async () => {
        put(join(hostRoot, '.vencord-userplugins-install.lock'), JSON.stringify({ pid: 2147483646, nonce: 'interrupted', plugin: 'odyssey-aegis-logger' }))
        expectResult(await install()).toMatchObject({ ok: true })
        expect(existsSync(join(hostRoot, '.vencord-userplugins-install.lock'))).toBe(false)
    })

    it('recovers old plugin, runtime and record after an interrupted build before retrying', async () => {
        expectResult(await install()).toMatchObject({ ok: true })
        const workRoot = join(hostRoot, '.aegislogger-work-interrupted')
        installer.copyRuntime(sourceRoot, join(workRoot, 'old-plugin'))
        put(join(workRoot, 'dist/renderer.js'), 'previous-runtime')
        put(join(target, 'index.tsx'), 'interrupted-plugin')
        put(join(hostRoot, 'dist/renderer.js'), 'interrupted-runtime')
        put(join(workRoot, 'transaction.json'), JSON.stringify({ sourceRoot, hostRoot, target, hadDist: true, hadPlugin: true, pluginMoved: true, replacementMoved: true, snapshotReady: true, committed: false, oldRecord: readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8') }))
        put(join(hostRoot, '.vencord-userplugins-install.lock'), JSON.stringify({ pid: 2147483646, nonce: 'interrupted', plugin: 'odyssey-aegis-logger', workRoot }))
        dependencyFails = true
        expectResult(await update()).toMatchObject({ ok: false, error: 'dependency_install_failed' })
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('previous-runtime')
        expect(readFileSync(join(target, 'index.tsx'), 'utf8')).toBe('export default {}')
        expect(existsSync(workRoot)).toBe(false)
    })

    it.each(['old-plugin', 'replacement'])('recovers physical %s moves before their journal flags were written', async stage => {
        expectResult(await install()).toMatchObject({ ok: true })
        const workRoot = join(hostRoot, '.aegislogger-work-stale-journal')
        const oldRecord = readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')
        put(join(workRoot, 'dist/renderer.js'), 'previous-runtime')
        renameSync(target, join(workRoot, 'old-plugin'))
        if (stage === 'replacement') {
            installer.copyRuntime(sourceRoot, join(workRoot, 'plugin'))
            put(join(workRoot, 'plugin/index.tsx'), 'interrupted-plugin')
            renameSync(join(workRoot, 'plugin'), target)
        }
        put(join(hostRoot, 'dist/renderer.js'), 'interrupted-runtime')
        put(join(workRoot, 'transaction.json'), JSON.stringify({ sourceRoot, hostRoot, target, hadDist: true, hadPlugin: true, pluginMoved: false, replacementMoved: false, snapshotReady: true, committed: false, oldRecord }))
        put(join(hostRoot, '.vencord-userplugins-install.lock'), JSON.stringify({ pid: 2147483646, nonce: 'interrupted', plugin: 'odyssey-aegis-logger', workRoot }))
        dependencyFails = true
        expectResult(await update()).toMatchObject({ ok: false, error: 'dependency_install_failed' })
        expect(readFileSync(join(target, 'index.tsx'), 'utf8')).toBe('export default {}')
        expect(readFileSync(join(hostRoot, 'dist/renderer.js'), 'utf8')).toBe('previous-runtime')
        expect(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')).toBe(oldRecord)
        expect(existsSync(workRoot)).toBe(false)
    })

    it('retains backups and its lock if process tree cleanup cannot be confirmed', async () => {
        const unsafeRunner = async (command: string, args: string[], options: ProcessCall['options']) => args[1] === 'build' ? { ...failed('process still running'), cleanupComplete: false } : run(command, args, options)
        const applied = await installer.install({ sourceRoot, hostRoot, noInject: true }, { run: unsafeRunner })
        expect(applied).toMatchObject({ ok: false, error: 'process_cleanup_failed', restored: false })
        expect(existsSync(applied.backupRoot)).toBe(true)
        expect(JSON.parse(readFileSync(join(hostRoot, '.vencord-userplugins-install.lock'), 'utf8')).cleanupUnconfirmed).toBe(true)
    })
})

describe('network and process boundaries', () => {
    it('does not claim builds during checks and exposes retained backup locations', () => {
        for (const state of ['current', 'dirty', 'behind']) {
            const output = installer.formatResult({ ok: true, value: { state, pendingBuild: true } }, 'check')
            expect(output).toContain(state)
            expect(output).toContain('build retry required')
            expect(output).not.toContain('Build complete')
        }
        expect(installer.formatResult({ ok: false, error: 'restore_failed', message: 'recovery incomplete', backupRoot: hostRoot }, 'update')).toContain(hostRoot)
    })

    it('propagates an explicit proxy to Git, pnpm and saved update context', async () => {
        const proxy = 'http://127.0.0.1:7890'
        expect(await installer.install({ sourceRoot, hostRoot, proxy, noInject: true }, { run })).toMatchObject({ ok: true })
        for (const call of calls) {
            expect(call.options.env.HTTPS_PROXY).toBe(proxy)
            expect(call.options.env.npm_config_https_proxy).toBe(proxy)
            expect(call.options.env.GIT_CONFIG_VALUE_0).toBe(proxy)
        }
        calls = []
        await check()
        expect(calls.filter(call => call.args[0] === 'fetch')[0].options.env.HTTPS_PROXY).toBe(proxy)
    })

    it('uses the host packageManager version and refuses unspecified pnpm versions', async () => {
        expect(await installer.prepareTools({ hostRoot }, {})).toMatchObject({ ok: false, error: 'host_package_manager_invalid' })
        expect(await installer.prepareTools({ hostRoot }, { packageManager: 'pnpm@latest' })).toMatchObject({ ok: false, error: 'host_package_manager_invalid' })
        expect(await installer.prepareTools({ hostRoot }, { packageManager: 'pnpm@11.9.0' })).toMatchObject({ ok: true, pnpm: join(hostRoot, '.aegislogger-tools/node_modules/pnpm/bin/pnpm.cjs') })
    })

    it('checks precise source and host Node version requirements', () => {
        const range = '^22.20.0 || ^24.12.0 || >=25.0.0'
        for (const version of ['22.20.0', '22.25.1', '24.12.0', '25.0.0', '26.0.0']) expect(installer.nodeSupported(version, range)).toBe(true)
        for (const version of ['20.20.0', '22.19.9', '23.0.0', '24.11.9']) expect(installer.nodeSupported(version, range)).toBe(false)
        expect(installer.nodeSupported('22.20.0', '>=24')).toBe(false)
    })

    it('bounds a hung subprocess and reports launch failures', async () => {
        expect(await installer.run(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { timeout: 30 })).toMatchObject({ ok: false, error: 'operation_timed_out' })
        expect(await installer.run('missing-aegislogger-command', [], { timeout: 1000 })).toMatchObject({ ok: false, error: 'process_failed' })
    })

    it('passes punctuation through argv without shell interpretation', async () => {
        const payload = '中文 ! & (path) "quoted"'
        expect(await installer.run(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', payload])).toMatchObject({ ok: true, stdout: payload })
    })

    it('preserves named and legacy positional options and rejects malformed requests', () => {
        expect(installer.parseArgs(['', hostRoot, '--no-inject'])).toMatchObject({ ok: true, mode: 'install', options: { hostRoot, noInject: true } })
        expect(installer.parseArgs(['--check', '--vencord-dir', hostRoot, '--json'])).toMatchObject({ ok: true, mode: 'check', json: true, options: { hostRoot, noInject: true } })
        expect(installer.parseArgs(['--vencord-dir', '--json'])).toMatchObject({ ok: false, error: 'argument_missing' })
        expect(installer.parseArgs(['--check', '--update'])).toMatchObject({ ok: false, error: 'argument_conflict' })
        expect(installer.parseArgs(['--unknown'])).toMatchObject({ ok: false, error: 'argument_unknown' })
    })

    it.runIf(process.platform === 'win32')('executes the CMD entry in a special-character directory and preserves argv and exit code', async () => {
        put(join(sourceRoot, 'install.cmd'), readFileSync(new URL('../install.cmd', import.meta.url), 'ascii'))
        put(join(sourceRoot, 'scripts/install.mjs'), 'process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 7')
        const entry = join(sourceRoot, 'install.cmd')
        const response = await installer.run('cmd.exe', ['/d', '/v:off', '/s', '/c', `""${entry}" --vencord-dir "${hostRoot}" --no-inject"`], { windowsVerbatimArguments: true })
        expect(response.ok).toBe(false)
        expect(response.stdout).toContain(JSON.stringify(['--vencord-dir', hostRoot, '--no-inject']))
        expect(response.message).toContain('exited 7')
    })

    it('downloads the official installer with proxy then invokes it with the host environment', async () => {
        record()
        const injectedRun = async (command: string, args: string[], options: ProcessCall['options']) => {
            calls.push({ command, args, options })
            if (command === 'curl') {
                const body = Buffer.alloc(5000)
                body.write('MZ')
                const temporary = args[args.indexOf('--output') + 1]
                mkdirSync(resolve(temporary, '..'), { recursive: true })
                writeFileSync(temporary, body)
            }
            return result()
        }
        expect(await installer.inject({ sourceRoot, hostRoot, proxy: 'http://127.0.0.1:7890' }, { run: injectedRun })).toMatchObject({ ok: true, injected: true })
        const download = calls.find(call => call.command === 'curl')
        expect(download?.args).toContain('--proxy')
        expect(download?.args.some(arg => arg.startsWith('https://github.com/Vencord/Installer/releases/'))).toBe(true)
        const injection = calls.find(call => call.options.interactive)
        expect(injection?.options.env.VENCORD_DEV_INSTALL).toBe('1')
        expect(injection?.options.env.VENCORD_USER_DATA_DIR).toBe(hostRoot)
        expect(injection?.args).toEqual(['-install'])
        expect(calls.some(call => ['taskkill', 'Discord.exe'].includes(call.command))).toBe(false)
    })

    it('keeps download failure separate from completed builds and never publishes partial installer bytes', async () => {
        record()
        const interruptedRun = async (command: string, args: string[]) => {
            if (command === 'curl') put(args[args.indexOf('--output') + 1], 'incomplete')
            return failed('download interrupted')
        }
        expect(await installer.inject({ sourceRoot, hostRoot }, { run: interruptedRun })).toMatchObject({ ok: false, error: 'installer_download_failed' })
        expect(existsSync(join(hostRoot, 'dist/Installer/VencordInstallerCli.exe'))).toBe(false)
        expect(JSON.parse(readFileSync(join(hostRoot, '.aegislogger-install.json'), 'utf8')).builtCommit).toBe('h1')
    })
})
