import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOST_MARKERS = ['.git', 'package.json', 'pnpm-lock.yaml', 'src/main/utils/constants.ts', 'packages/discord-types/src/index.d.ts']
const PATH_TARGETS = {
    '@api/*': 'src/api/*',
    '@components/*': 'src/components/*',
    '@main/*': 'src/main/*',
    '@shared/*': 'src/shared/*',
    '@utils/*': 'src/utils/*',
    '@webpack': 'src/webpack/webpack',
    '@webpack/common': 'src/webpack/common',
    '@webpack/common/*': 'src/webpack/common/*',
    '@webpack/patcher': 'src/webpack/patchWebpack',
    '@vencord/discord-types': 'packages/discord-types/src/index.d.ts'
}

const hostConfig = {
    assertHost(hostRoot, deps = {}) {
        const d = { existsSync, ...deps }
        for (const marker of HOST_MARKERS) {
            if (!d.existsSync(join(hostRoot, marker))) return { ok: false, error: 'invalid_host_checkout', missing: marker }
        }
        return { ok: true }
    },

    buildTsconfigDocument(hostRoot, deps = {}) {
        const d = { relative, isAbsolute, repoRoot: REPO_ROOT, ...deps }
        const checked = this.assertHost(hostRoot, d)
        if (!checked.ok) return checked
        const prefix = d.relative(d.repoRoot, hostRoot).replaceAll('\\', '/')
        if (!prefix || prefix === '.') return { ok: false, error: 'host_is_plugin_repo' }
        const base = d.isAbsolute(prefix) || /^[A-Za-z]:\//.test(prefix) ? hostRoot.replaceAll('\\', '/') : prefix
        const paths = Object.fromEntries(Object.entries(PATH_TARGETS).map(([alias, target]) => [alias, [`${base}/${target}`]]))
        return { ok: true, prefix: base, document: { extends: './tsconfig.json', compilerOptions: { baseUrl: '.', paths, types: ['node', 'react', 'vite/client'] }, include: ['./**/*.ts', './**/*.tsx', `${base}/src/globals.d.ts`] } }
    },

    prepareHost(vencordDir, deps = {}) {
        const d = { existsSync, readFileSync, realpathSync, writeFileSync, repoRoot: REPO_ROOT, ...deps }
        if (!vencordDir || !d.existsSync(vencordDir)) return { ok: false, error: 'host_missing' }
        try {
            const hostRoot = d.realpathSync(vencordDir)
            const built = this.buildTsconfigDocument(hostRoot, d)
            if (!built.ok) return built
            const target = join(d.repoRoot, 'tsconfig.host.json')
            const serialized = JSON.stringify(built.document, null, 4) + '\n'
            const previous = d.existsSync(target) ? d.readFileSync(target, 'utf8') : null
            const changed = previous !== serialized
            if (changed) d.writeFileSync(target, serialized)
            return { ok: true, changed, hostRoot, prefix: built.prefix, tsconfig: target }
        } catch (error) {
            return { ok: false, error: 'host_config_failed', message: error.message }
        }
    }
}

export default hostConfig

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2)
    const index = args.indexOf('--vencord-dir')
    const result = hostConfig.prepareHost(index >= 0 ? args[index + 1] : undefined)
    process.stdout.write(JSON.stringify(result, null, 4) + '\n')
    process.exitCode = result.ok ? 0 : 1
}
