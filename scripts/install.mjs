import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import hostConfig from './prepare-host.mjs'

const SOURCE_ROOT = fileURLToPath(new URL('..', import.meta.url))
const PLUGIN_NAME = 'odyssey-aegis-logger'
const RECORD_NAME = '.aegislogger-install.json'
const MARKER_NAME = '.aegislogger-managed.json'
const LOCK_NAME = '.vencord-userplugins-install.lock'
const RUNTIME_DIRS = ['components', 'native', 'utils']
const RUNTIME_FILE = /\.(?:tsx?|jsx?|css|json|wasm)$/
const failure = (error, message = error, extra = {}) => ({ ok: false, error, message: String(message).replace(/(https?:\/\/)[^@\s/]+@/gi, '$1[redacted]@'), ...extra })
const canonical = value => process.platform === 'win32' ? resolve(value).toLowerCase() : resolve(value)
const samePath = (left, right) => canonical(left) === canonical(right)
const entryExists = path => {
    try {
        lstatSync(path)
        return true
    } catch (error) {
        if (error.code === 'ENOENT') return false
        return true
    }
}
const inside = (parent, child) => {
    const remainder = relative(parent, child)
    return remainder !== '' && remainder !== '..' && !remainder.startsWith('../') && !remainder.startsWith('..\\') && !isAbsolute(remainder)
}
const versionAtLeast = (version, required) => {
    const current = version.split('.').map(Number)
    const minimum = required.split('.').map(Number)
    for (let index = 0; index < 3; index++) {
        if ((current[index] || 0) !== (minimum[index] || 0)) return (current[index] || 0) > (minimum[index] || 0)
    }
    return true
}

const installer = {
    networkEnv(proxy, env = process.env) {
        if (!proxy) return { ...env }
        const count = Number(env.GIT_CONFIG_COUNT || 0)
        return {
            ...env,
            HTTP_PROXY: proxy,
            HTTPS_PROXY: proxy,
            ALL_PROXY: proxy,
            http_proxy: proxy,
            https_proxy: proxy,
            npm_config_proxy: proxy,
            npm_config_https_proxy: proxy,
            GIT_CONFIG_COUNT: String(count + 2),
            [`GIT_CONFIG_KEY_${count}`]: 'http.proxy',
            [`GIT_CONFIG_VALUE_${count}`]: proxy,
            [`GIT_CONFIG_KEY_${count + 1}`]: 'https.proxy',
            [`GIT_CONFIG_VALUE_${count + 1}`]: proxy
        }
    },

    run(command, args, options = {}) {
        return new Promise(resolveResult => {
            let stdout = ''
            let stderr = ''
            let termination
            let childClosed = false
            let treeStopped = false
            let terminationTimer
            let finished = false
            const child = spawn(command, args, { cwd: options.cwd, env: options.env, windowsHide: true, windowsVerbatimArguments: options.windowsVerbatimArguments, detached: process.platform !== 'win32', stdio: options.interactive ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
            const finish = result => {
                if (finished) return
                finished = true
                clearTimeout(timer)
                clearTimeout(terminationTimer)
                resolveResult(result)
            }
            const stop = result => {
                if (termination) return
                termination = result
                terminationTimer = setTimeout(() => finish(failure('process_cleanup_failed', 'Process tree termination was not confirmed', { cleanupComplete: false, stdout, stderr })), 5000)
                if (process.platform === 'win32' && child.pid) {
                    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
                    killer.on('error', () => {
                        child.kill()
                        finish(failure('process_cleanup_failed', 'Could not stop the process tree', { cleanupComplete: false, stdout, stderr }))
                    })
                    killer.on('close', code => {
                        if (code === 0) {
                            treeStopped = true
                            if (childClosed) finish({ ...termination, cleanupComplete: true })
                        } else if (!finished) {
                            child.kill()
                            finish(failure('process_cleanup_failed', 'Could not confirm process tree termination', { cleanupComplete: false, stdout, stderr }))
                        }
                    })
                } else {
                    try {
                        process.kill(-child.pid, 'SIGKILL')
                        treeStopped = true
                    } catch {
                        child.kill('SIGKILL')
                    }
                }
            }
            const timer = setTimeout(() => stop(failure('operation_timed_out', `${command} timed out`, { stdout, stderr })), options.timeout || 120000)
            const collect = (stream, key) => stream?.on('data', chunk => {
                const remaining = 2 * 1024 * 1024 - stdout.length - stderr.length
                if (key === 'stdout') stdout += String(chunk).slice(0, remaining)
                else stderr += String(chunk).slice(0, remaining)
                if (String(chunk).length > remaining) {
                    stop(failure('output_limit_exceeded'))
                }
            })
            collect(child.stdout, 'stdout')
            collect(child.stderr, 'stderr')
            child.on('error', error => finish(failure('process_failed', error.message, { stdout, stderr })))
            child.on('close', code => {
                childClosed = true
                if (termination && !treeStopped) return
                finish(termination ? { ...termination, cleanupComplete: true } : code === 0 ? { ok: true, stdout, stderr } : failure('process_failed', stderr.trim() || `${command} exited ${code}`, { stdout, stderr }))
            })
        })
    },

    context(options = {}, deps = {}) {
        const sourceRoot = resolve(options.sourceRoot || SOURCE_ROOT)
        const hostRoot = resolve(options.hostRoot || join(sourceRoot, 'Vencord'))
        return { sourceRoot, hostRoot, proxy: options.proxy, deadline: Date.now() + 780000, run: this.run, ...deps }
    },

    timeout(context, maximum) {
        return Math.max(1, Math.min(maximum, (context.deadline || Date.now() + maximum) - Date.now()))
    },

    nodeSupported(version, range) {
        if (!range) return true
        return range.split('||').some(part => {
            const constraint = part.trim()
            const match = /^(>=|\^)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/.exec(constraint)
            if (!match) return false
            const minimum = `${match[2]}.${match[3] || 0}.${match[4] || 0}`
            if (!versionAtLeast(version, minimum)) return false
            return match[1] === '>=' || Number(version.split('.')[0]) === Number(match[2])
        })
    },

    async git(context, args, root = context.sourceRoot) {
        const result = await context.run('git', args, { cwd: root, env: this.networkEnv(context.proxy), timeout: this.timeout(context, 120000) })
        if (result.cleanupComplete === false) this.retainUnconfirmedLock(context)
        return result
    },

    retainUnconfirmedLock(context) {
        if (!context.lock) return
        context.retainLock = true
        const owner = JSON.parse(readFileSync(context.lock, 'utf8'))
        writeFileSync(context.lock, JSON.stringify({ ...owner, cleanupUnconfirmed: true }))
    },

    async assertRepository(root, name, context) {
        if (!existsSync(join(root, '.git'))) return failure('not_a_git_clone', `Clone the repository first: git clone https://github.com/${name === PLUGIN_NAME ? 'JSTks24/Odyssey_AegisLogger' : 'Vendicated/Vencord'}.git`)
        const top = await this.git(context, ['rev-parse', '--show-toplevel'], root)
        if (!top.ok || !samePath(realpathSync(root), top.stdout.trim())) return failure('not_repository_root')
        const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
        const remote = await this.git(context, ['remote', 'get-url', 'origin'], root)
        const repoName = name === PLUGIN_NAME ? 'Odyssey_AegisLogger' : 'Vencord'
        if (pkg.name !== name || !remote.ok || !new RegExp(`(?:[:/])[^/]+/${repoName}(?:\\.git)?/?$`, 'i').test(remote.stdout.trim())) return failure('repository_identity_invalid')
        if (name === 'vencord') {
            const checked = hostConfig.assertHost(root)
            if (!checked.ok) return checked
        } else if (!existsSync(join(root, 'index.tsx')) || !existsSync(join(root, 'pnpm-lock.yaml'))) return failure('source_checkout_incomplete')
        return { ok: true, package: pkg, remote: remote.stdout.trim() }
    },

    readRecord(context, required = false) {
        const target = join(context.hostRoot, RECORD_NAME)
        if (!existsSync(target)) return required ? failure('installation_record_missing; run install.cmd') : { ok: true, record: undefined }
        try {
            const record = JSON.parse(readFileSync(target, 'utf8'))
            if (record.schemaVersion !== 1 || typeof record.builtCommit !== 'string'
                || typeof record.sourceRoot !== 'string' || typeof record.hostRoot !== 'string'
                || !isAbsolute(record.sourceRoot) || !isAbsolute(record.hostRoot)
                || !samePath(realpathSync(record.sourceRoot), context.sourceRoot)
                || !samePath(realpathSync(record.hostRoot), context.hostRoot)) return failure('installation_record_invalid')
            return { ok: true, record }
        } catch (error) {
            return failure('installation_record_invalid', error.message)
        }
    },

    async status(context, record, fetch = true) {
        const source = await this.assertRepository(context.sourceRoot, PLUGIN_NAME, context)
        if (!source.ok) return source
        const head = await this.git(context, ['rev-parse', 'HEAD'])
        const branch = await this.git(context, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
        if (!head.ok) return head
        const hash = head.stdout.trim()
        const remoteMatch = /github\.com[:/]([^/]+)\/([^/?#]+?)(?:\.git)?\/?$/.exec(source.remote)
        const info = { repo: remoteMatch ? `https://github.com/${remoteMatch[1]}/${remoteMatch[2]}` : '', branch: branch.ok ? branch.stdout.trim() : '', gitHash: hash, installedHash: record?.builtCommit }
        const pendingBuild = Boolean(record && record.builtCommit !== hash)
        const result = (state, changes = []) => ({ ok: true, value: { info: { ...info, state, pendingBuild }, changes, state, pendingBuild } })
        const dirty = await this.git(context, ['status', '--porcelain', '--untracked-files=normal'])
        if (!dirty.ok) return dirty
        if (dirty.stdout.trim()) return result('dirty')
        if (!branch.ok) return result('detached')
        const upstream = await this.git(context, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}'])
        if (!upstream.ok) return result('missing_upstream')
        if (fetch) {
            const trackingRemote = await this.git(context, ['config', '--get', `branch.${info.branch}.remote`])
            if (!trackingRemote.ok || !trackingRemote.stdout.trim()) return result('missing_upstream')
            const fetched = await this.git(context, ['fetch', trackingRemote.stdout.trim()])
            if (!fetched.ok) return failure('fetch_failed', fetched.message)
        }
        const counts = await this.git(context, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])
        if (!counts.ok) return counts
        const [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number)
        if (!Number.isFinite(ahead) || !Number.isFinite(behind)) return failure('git_status_invalid')
        let changes = []
        if (behind) {
            const log = await this.git(context, ['log', '--format=%H;%an;%s', 'HEAD..@{upstream}'])
            if (!log.ok) return log
            changes = log.stdout.trim().split('\n').filter(Boolean).map(line => {
                const [hash, author, ...message] = line.split(';')
                return { hash, author, message: message.join(';') }
            })
        }
        return result(ahead && behind ? 'diverged' : ahead ? 'ahead' : behind ? 'behind' : 'current', changes)
    },

    async check(options = {}, deps = {}) {
        const context = this.context(options, deps)
        context.deadline = Date.now() + 90000
        try {
            const host = await this.assertRepository(context.hostRoot, 'vencord', context)
            if (!host.ok) return host
            const read = this.readRecord(context, true)
            if (!read.ok) return read
            context.proxy ||= read.record.proxy
            return await this.status(context, read.record)
        } catch (error) {
            return failure('check_failed', error.message)
        }
    },

    async prepareTools(context, pkg) {
        const version = /^pnpm@(\d+\.\d+\.\d+)(?:\+.*)?$/.exec(pkg.packageManager || '')?.[1]
        if (!version) return failure('host_package_manager_invalid')
        const toolsRoot = join(context.hostRoot, '.aegislogger-tools')
        const pnpm = join(toolsRoot, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs')
        const installed = join(toolsRoot, 'node_modules', 'pnpm', 'package.json')
        if (!existsSync(installed) || JSON.parse(readFileSync(installed, 'utf8')).version !== version) {
            const npmCandidate = process.env.npm_execpath
            const pathDirectories = (process.env.PATH || process.env.Path || '').split(process.platform === 'win32' ? ';' : ':').filter(Boolean)
            const candidates = [npmCandidate, join(dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js'), join(dirname(process.execPath), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js'), ...pathDirectories.map(directory => join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js'))]
            const npm = candidates.find(candidate => candidate && existsSync(candidate) && candidate.endsWith('npm-cli.js'))
            if (!npm) return failure('npm_cli_missing', 'Install Node.js with npm included')
            mkdirSync(toolsRoot, { recursive: true })
            const prepared = await context.run(process.execPath, [npm, 'install', '--prefix', toolsRoot, '--cache', join(toolsRoot, 'npm-cache'), '--ignore-scripts', '--no-audit', '--no-fund', '--package-lock=false', `pnpm@${version}`], { cwd: toolsRoot, env: this.networkEnv(context.proxy), timeout: this.timeout(context, 120000) })
            if (prepared.cleanupComplete === false) this.retainUnconfirmedLock(context)
            if (!prepared.ok) return failure('pnpm_prepare_failed', prepared.message)
        }
        if (!existsSync(pnpm) || !existsSync(installed) || JSON.parse(readFileSync(installed, 'utf8')).version !== version) return failure('pnpm_cli_missing')
        return { ok: true, pnpm }
    },

    copyRuntime(sourceRoot, target) {
        mkdirSync(target, { recursive: true })
        const copyDirectory = (source, destination) => {
            mkdirSync(destination, { recursive: true })
            for (const entry of readdirSync(source, { withFileTypes: true })) {
                if (entry.isSymbolicLink()) return failure('runtime_symlink_not_supported')
                const from = join(source, entry.name)
                const to = join(destination, entry.name)
                if (entry.isDirectory()) {
                    const copied = copyDirectory(from, to)
                    if (!copied.ok) return copied
                } else if (RUNTIME_FILE.test(entry.name) || entry.name === 'LICENSE') copyFileSync(from, to)
            }
            return { ok: true }
        }
        for (const entry of readdirSync(sourceRoot, { withFileTypes: true })) {
            if (entry.isSymbolicLink() && /\.(?:tsx?|css)$/.test(entry.name)) return failure('runtime_symlink_not_supported')
            if (entry.isFile() && /\.(?:tsx?|css)$/.test(entry.name) && entry.name !== 'vitest.config.ts') copyFileSync(join(sourceRoot, entry.name), join(target, entry.name))
        }
        for (const directory of RUNTIME_DIRS) {
            if (!existsSync(join(sourceRoot, directory))) continue
            if (lstatSync(join(sourceRoot, directory)).isSymbolicLink()) return failure('runtime_symlink_not_supported')
            const copied = copyDirectory(join(sourceRoot, directory), join(target, directory))
            if (!copied.ok) return copied
        }
        writeFileSync(join(target, MARKER_NAME), JSON.stringify({ plugin: PLUGIN_NAME, sourceRoot }, null, 4) + '\n')
        return { ok: true }
    },

    validateTarget(context) {
        const target = join(context.hostRoot, 'src', 'userplugins', PLUGIN_NAME)
        const parent = dirname(target)
        for (const candidate of [join(context.hostRoot, 'src'), parent]) {
            if (existsSync(candidate) && !samePath(realpathSync(candidate), candidate)) return failure('plugin_parent_is_link')
        }
        if (!entryExists(target)) return { ok: true, target }
        const stat = lstatSync(target)
        if (stat.isSymbolicLink()) return existsSync(target) && samePath(realpathSync(target), context.sourceRoot) ? { ok: true, target, legacyLink: true } : failure('plugin_target_occupied')
        const marker = join(target, MARKER_NAME)
        if (!existsSync(marker)) return failure('plugin_target_occupied', 'Existing plugin directory is unmanaged; move it aside before installation')
        const ownership = JSON.parse(readFileSync(marker, 'utf8'))
        return ownership.plugin === PLUGIN_NAME && samePath(ownership.sourceRoot, context.sourceRoot) ? { ok: true, target } : failure('plugin_target_occupied')
    },

    snapshotDirectory(source, target) {
        mkdirSync(target, { recursive: true })
        for (const entry of readdirSync(source, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) return failure('dist_contains_link')
            const from = join(source, entry.name)
            const to = join(target, entry.name)
            if (entry.isDirectory()) {
                const copied = this.snapshotDirectory(from, to)
                if (!copied.ok) return copied
            } else copyFileSync(from, to)
        }
        return { ok: true }
    },

    async movePath(source, target, deps = {}) {
        const move = deps.renameSync || renameSync
        const wait = deps.wait || (duration => new Promise(resolveWait => setTimeout(resolveWait, duration)))
        for (let attempt = 0; attempt < 6; attempt++) {
            try {
                move(source, target)
                return { ok: true }
            } catch (error) {
                if (!['EPERM', 'EBUSY', 'EACCES'].includes(error.code) || attempt === 5) return failure('path_move_failed', error.message, { filesystemCode: error.code })
                await wait(50 * (attempt + 1))
            }
        }
        return failure('path_move_failed')
    },

    async recoverTransaction(context, work) {
        if (!inside(context.hostRoot, work) || dirname(work) !== context.hostRoot || !work.startsWith(join(context.hostRoot, '.aegislogger-work-'))) return failure('recovery_record_invalid')
        if (!samePath(realpathSync(work), work)) return failure('recovery_work_is_link')
        const journalPath = join(work, 'transaction.json')
        if (!existsSync(journalPath)) return failure('recovery_record_missing', `Inspect retained backups: ${work}`)
        const journal = JSON.parse(readFileSync(journalPath, 'utf8'))
        const target = join(context.hostRoot, 'src', 'userplugins', PLUGIN_NAME)
        if (!samePath(journal.sourceRoot, context.sourceRoot) || !samePath(journal.hostRoot, context.hostRoot) || !samePath(journal.target, target)) return failure('recovery_record_invalid')
        const oldPlugin = join(work, 'old-plugin')
        const oldDist = join(work, 'dist')
        if (entryExists(oldDist) && lstatSync(oldDist).isSymbolicLink()) return failure('recovery_backup_is_link')
        if (!journal.committed && journal.snapshotReady) {
            if (entryExists(oldPlugin) || !journal.hadPlugin && entryExists(target)) {
                const owned = this.validateTarget(context)
                if (!owned.ok) return owned
                rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                if (entryExists(oldPlugin)) {
                    const moved = await this.movePath(oldPlugin, target)
                    if (!moved.ok) return moved
                }
            }
            if (journal.hadDist && !existsSync(oldDist)) return failure('recovery_backup_missing')
            rmSync(join(context.hostRoot, 'dist'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
            if (journal.hadDist) {
                const moved = await this.movePath(oldDist, join(context.hostRoot, 'dist'))
                if (!moved.ok) return moved
            }
            if (journal.oldRecord === null) rmSync(join(context.hostRoot, RECORD_NAME), { force: true })
            else writeFileSync(join(context.hostRoot, RECORD_NAME), journal.oldRecord)
        }
        if (entryExists(oldPlugin) && lstatSync(oldPlugin).isSymbolicLink()) unlinkSync(oldPlugin)
        rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
        return { ok: true }
    },

    async acquireLock(context) {
        const lock = join(context.hostRoot, LOCK_NAME)
        const recoveryLock = `${lock}.recovery`
        if (entryExists(recoveryLock)) return failure('lock_recovery_in_progress', `Recovery is active or was interrupted; inspect ${recoveryLock}`)
        const nonce = randomUUID()
        const create = () => writeFileSync(lock, JSON.stringify({ pid: process.pid, nonce, plugin: PLUGIN_NAME }), { flag: 'wx' })
        try {
            create()
            return { ok: true, lock, nonce }
        } catch (error) {
            if (error.code !== 'EEXIST') return failure('lock_failed', error.message)
        }
        let recovering = false
        try {
            const content = readFileSync(lock, 'utf8')
            const owner = JSON.parse(content)
            if (!Number.isInteger(owner.pid) || owner.pid <= 0) return failure('installation_lock_invalid', lock)
            try {
                process.kill(owner.pid, 0)
                return failure('update_busy')
            } catch (error) {
                if (error.code !== 'ESRCH') return failure('update_busy')
            }
            writeFileSync(recoveryLock, String(process.pid), { flag: 'wx' })
            recovering = true
            if (readFileSync(lock, 'utf8') !== content) return failure('update_busy')
            if (owner.cleanupUnconfirmed) return failure('process_cleanup_unconfirmed', `Stop the retained build process before recovering ${lock}`)
            if (owner.workRoot) {
                if (owner.plugin !== PLUGIN_NAME) return failure('stale_foreign_install_lock', 'Rerun the installer that created the interrupted transaction')
                const recovered = await this.recoverTransaction(context, owner.workRoot)
                if (!recovered.ok) return recovered
            }
            unlinkSync(lock)
            create()
            return { ok: true, lock, nonce }
        } catch (error) {
            return failure(error.code === 'EEXIST' ? 'update_busy' : 'lock_recovery_failed', error.message)
        } finally {
            if (recovering) unlinkSync(recoveryLock)
        }
    },

    async buildTransaction(context, status, pnpm, target) {
        const work = join(context.hostRoot, `.aegislogger-work-${randomUUID()}`)
        const stage = join(work, 'plugin')
        const oldPlugin = join(work, 'old-plugin')
        const oldDist = join(work, 'dist')
        const dist = join(context.hostRoot, 'dist')
        const hadDist = existsSync(dist)
        if (hadDist && lstatSync(dist).isSymbolicLink()) return failure('dist_is_link')
        const hadPlugin = entryExists(target)
        let pluginMoved = false
        let replacementMoved = false
        let snapshotReady = false
        let committed = false
        let result
        let cleanupSafe = true
        const recordPath = join(context.hostRoot, RECORD_NAME)
        const oldRecord = existsSync(recordPath) ? readFileSync(recordPath, 'utf8') : null
        const journalPath = join(work, 'transaction.json')
        const journal = () => writeFileSync(journalPath, JSON.stringify({ sourceRoot: context.sourceRoot, hostRoot: context.hostRoot, target, hadDist, hadPlugin, pluginMoved, replacementMoved, snapshotReady, committed, oldRecord }, null, 4) + '\n')
        try {
            mkdirSync(work, { recursive: true })
            if (context.lock) writeFileSync(context.lock, JSON.stringify({ pid: process.pid, nonce: context.lockNonce, plugin: PLUGIN_NAME, workRoot: work }))
            journal()
            const copied = this.copyRuntime(context.sourceRoot, stage)
            if (!copied.ok) result = copied
            if (hadDist) {
                const snapshot = this.snapshotDirectory(dist, oldDist)
                if (!snapshot.ok) result = snapshot
            }
            if (result) return result
            snapshotReady = true
            journal()
            mkdirSync(dirname(target), { recursive: true })
            if (hadPlugin) {
                const moved = await this.movePath(target, oldPlugin)
                if (!moved.ok) result = moved
                else pluginMoved = true
                journal()
            }
            if (!result) {
                const moved = await this.movePath(stage, target)
                if (!moved.ok) result = moved
                else replacementMoved = true
                journal()
            }
            if (!result) {
                const built = await context.run(process.execPath, [pnpm, 'build'], { cwd: context.hostRoot, env: this.networkEnv(context.proxy), timeout: this.timeout(context, 300000) })
                cleanupSafe = built.cleanupComplete !== false
                if (!built.ok) result = failure('build_failed', built.message, { pendingBuild: true })
                else {
                    const record = { schemaVersion: 1, sourceRoot: context.sourceRoot, hostRoot: context.hostRoot, builtCommit: status.value.info.gitHash, ...(context.proxy ? { proxy: context.proxy } : {}) }
                    const recordStage = join(work, 'record.json')
                    writeFileSync(recordStage, JSON.stringify(record, null, 4) + '\n')
                    const moved = await this.movePath(recordStage, recordPath)
                    if (!moved.ok) result = moved
                    else {
                        committed = true
                        journal()
                        result = { ok: true, value: { ...status.value, info: { ...status.value.info, installedHash: record.builtCommit, pendingBuild: false }, pendingBuild: false, built: true, restartRequired: true } }
                    }
                }
            }
        } catch (error) {
            result = failure('build_transaction_failed', error.message, { pendingBuild: true })
        } finally {
            if (!cleanupSafe) {
                context.retainLock = true
                if (context.lock) writeFileSync(context.lock, JSON.stringify({ pid: process.pid, nonce: context.lockNonce, plugin: PLUGIN_NAME, workRoot: work, cleanupUnconfirmed: true }))
                return failure('process_cleanup_failed', 'Runtime backups were retained; stop the build process before retrying', { restored: false, backupRoot: work, pendingBuild: true })
            }
            try {
                if (!committed && snapshotReady) {
                    if (replacementMoved) rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                    if (pluginMoved) {
                        const moved = await this.movePath(oldPlugin, target)
                        if (!moved.ok) {
                            context.retainLock = true
                            return failure('restore_failed', moved.message, { restored: false, backupRoot: work, pendingBuild: true })
                        }
                    }
                    rmSync(dist, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
                    if (hadDist) {
                        const moved = await this.movePath(oldDist, dist)
                        if (!moved.ok) {
                            context.retainLock = true
                            return failure('restore_failed', moved.message, { restored: false, backupRoot: work, pendingBuild: true })
                        }
                    }
                    if (oldRecord === null) rmSync(recordPath, { force: true })
                    else writeFileSync(recordPath, oldRecord)
                    result = { ...result, restored: true }
                }
                if (existsSync(oldPlugin) && lstatSync(oldPlugin).isSymbolicLink()) unlinkSync(oldPlugin)
                rmSync(work, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
            } catch (error) {
                context.retainLock = true
                return failure('restore_failed', error.message, { restored: false, backupRoot: work, pendingBuild: true })
            }
        }
        return result
    },

    async apply(options = {}, deps = {}, initial = false) {
        const context = this.context(options, deps)
        let lock
        try {
            const source = await this.assertRepository(context.sourceRoot, PLUGIN_NAME, context)
            if (!source.ok) return source
            if (!this.nodeSupported(process.versions.node, source.package.engines?.node || '>=22')) return failure('node_version_unsupported', `Required Node.js: ${source.package.engines?.node || '>=22'}`)
            if (samePath(context.sourceRoot, context.hostRoot) || inside(context.hostRoot, context.sourceRoot)) return failure('host_contains_plugin_source')
            if (inside(context.sourceRoot, context.hostRoot) && !samePath(context.hostRoot, join(context.sourceRoot, 'Vencord'))) return failure('host_inside_runtime_source')
            if (!existsSync(context.hostRoot)) {
                if (!initial) return failure('host_missing')
                const clone = await this.git(context, ['clone', 'https://github.com/Vendicated/Vencord.git', context.hostRoot])
                if (!clone.ok) return failure('host_clone_failed', clone.message)
            }
            context.hostRoot = realpathSync(context.hostRoot)
            context.sourceRoot = realpathSync(context.sourceRoot)
            if (samePath(context.sourceRoot, context.hostRoot) || inside(context.hostRoot, context.sourceRoot)) return failure('host_contains_plugin_source')
            if (inside(context.sourceRoot, context.hostRoot) && !samePath(context.hostRoot, join(context.sourceRoot, 'Vencord'))) return failure('host_inside_runtime_source')
            const host = await this.assertRepository(context.hostRoot, 'vencord', context)
            if (!host.ok) return host
            if (!this.nodeSupported(process.versions.node, host.package.engines?.node || '>=22')) return failure('host_node_version_unsupported', `Required Node.js: ${host.package.engines?.node || '>=22'}`)
            const acquired = await this.acquireLock(context)
            if (!acquired.ok) return acquired
            lock = acquired.lock
            context.lock = lock
            context.lockNonce = acquired.nonce
            const read = this.readRecord(context, !initial)
            if (!read.ok) return read
            context.proxy ||= read.record?.proxy
            const validated = this.validateTarget(context)
            if (!validated.ok) return validated
            let status = await this.status(context, read.record)
            if (!status.ok) return status
            if (!['current', 'behind'].includes(status.value.state)) return failure(`source_${status.value.state}`, `Source repository state: ${status.value.state}`)
            if (status.value.state === 'behind') {
                const advanced = await this.git(context, ['merge', '--ff-only', '@{upstream}'])
                if (!advanced.ok) return failure('fast_forward_failed', advanced.message)
                status = await this.status(context, read.record, false)
                if (!status.ok) return status
                if (status.value.state !== 'current') return failure('source_changed_during_update')
            }
            const tools = await this.prepareTools(context, host.package)
            if (!tools.ok) return tools
            const dependencies = await context.run(process.execPath, [tools.pnpm, 'install', '--frozen-lockfile', '--store-dir', join(context.hostRoot, '.aegislogger-tools', 'pnpm-store')], { cwd: context.hostRoot, env: this.networkEnv(context.proxy), timeout: this.timeout(context, 300000) })
            if (dependencies.cleanupComplete === false) this.retainUnconfirmedLock(context)
            if (!dependencies.ok) return failure('dependency_install_failed', dependencies.message, { pendingBuild: status.value.pendingBuild })
            const config = hostConfig.prepareHost(context.hostRoot, { repoRoot: context.sourceRoot })
            if (!config.ok) return config
            return await this.buildTransaction(context, status, tools.pnpm, validated.target)
        } catch (error) {
            return failure('install_failed', error.message)
        } finally {
            if (lock && !context.retainLock) unlinkSync(lock)
        }
    },

    update(options = {}, deps = {}) {
        return this.apply(options, deps, false)
    },

    async inject(options = {}, deps = {}) {
        const context = this.context(options, deps)
        const filenames = { win32: 'VencordInstallerCli.exe', linux: 'VencordInstallerCli-linux', darwin: 'VencordInstallerCli-darwin' }
        const filename = filenames[process.platform]
        if (!filename) return failure('installer_platform_unsupported')
        const target = join(context.hostRoot, 'dist', 'Installer', filename)
        const temporary = `${target}.${randomUUID()}.download`
        const validBinary = path => {
            if (!existsSync(path) || lstatSync(path).isSymbolicLink()) return false
            const body = readFileSync(path)
            return body.length > 4096 && (process.platform !== 'win32' || body.subarray(0, 2).toString() === 'MZ')
        }
        try {
            const acquired = await this.acquireLock(context)
            if (!acquired.ok) return acquired
            context.lock = acquired.lock
            context.lockNonce = acquired.nonce
            const read = this.readRecord(context, true)
            if (!read.ok) return read
            context.proxy ||= read.record.proxy
            if (!validBinary(target)) {
                mkdirSync(dirname(target), { recursive: true })
                const args = ['--fail', '--location', '--retry', '2', '--max-time', '120', '--output', temporary]
                if (context.proxy) args.push('--proxy', context.proxy)
                args.push(`https://github.com/Vencord/Installer/releases/latest/download/${filename}`)
                const downloaded = await context.run('curl', args, { cwd: context.hostRoot, env: this.networkEnv(context.proxy), timeout: this.timeout(context, 150000) })
                if (downloaded.cleanupComplete === false) this.retainUnconfirmedLock(context)
                if (!downloaded.ok) return failure('installer_download_failed', downloaded.message)
                if (!validBinary(temporary)) return failure('installer_binary_invalid')
                const moved = await this.movePath(temporary, target)
                if (!moved.ok) return moved
            }
            if (process.platform !== 'win32') {
                const { chmodSync } = await import('node:fs')
                chmodSync(target, 0o755)
            }
            const injected = await context.run(target, ['-install'], { cwd: context.hostRoot, env: { ...this.networkEnv(context.proxy), VENCORD_DEV_INSTALL: '1', VENCORD_USER_DATA_DIR: context.hostRoot }, interactive: true, timeout: this.timeout(context, 300000) })
            if (injected.cleanupComplete === false) this.retainUnconfirmedLock(context)
            return injected.ok ? { ok: true, injected: true } : failure('injection_failed', injected.message, { built: true })
        } catch (error) {
            return failure('injection_failed', error.message, { built: true })
        } finally {
            if (!context.retainLock) rmSync(temporary, { force: true })
            if (context.lock && !context.retainLock) unlinkSync(context.lock)
        }
    },

    async install(options = {}, deps = {}) {
        const result = await this.apply(options, deps, true)
        if (!result.ok || options.noInject) return result
        const injected = await this.inject(options, deps)
        return injected.ok ? { ...result, value: { ...result.value, injected: true } } : injected
    },

    formatResult(result, mode, json = false) {
        if (json) return JSON.stringify(result) + '\n'
        if (!result.ok) return `${result.error}: ${result.message}${result.backupRoot ? `; backup: ${result.backupRoot}` : ''}\n`
        if (mode === 'check') return `Source state: ${result.value.state}${result.value.pendingBuild ? '; build retry required' : ''}\n`
        return 'Build complete. Restart Discord to use the new version.\n'
    },

    parseArgs(args) {
        const options = {}
        const positional = []
        let mode = 'install'
        let json = false
        for (let index = 0; index < args.length; index++) {
            const arg = args[index]
            if (['--vencord-dir', '--proxy'].includes(arg)) {
                const value = args[++index]
                if (!value || value.startsWith('--')) return failure('argument_missing', `Missing value: ${arg}`)
                options[arg === '--proxy' ? 'proxy' : 'hostRoot'] = value
            } else if (['--check', '--update'].includes(arg)) {
                if (mode !== 'install') return failure('argument_conflict')
                mode = arg.slice(2)
            } else if (arg === '--json') json = true
            else if (arg === '--no-inject') options.noInject = true
            else if (arg.startsWith('--')) return failure('argument_unknown', `Unknown option: ${arg}`)
            else positional.push(arg)
        }
        if (positional.length > 2) return failure('argument_extra')
        options.proxy ||= positional[0]
        options.hostRoot ||= positional[1]
        options.noInject ||= json
        return { ok: true, mode, json, options }
    }
}

export default installer

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2)
    const parsed = installer.parseArgs(args)
    const result = parsed.ok ? await installer[parsed.mode](parsed.options) : parsed
    process.stdout.write(installer.formatResult(result, parsed.mode, args.includes('--json')))
    process.exitCode = result.ok ? 0 : 1
}
