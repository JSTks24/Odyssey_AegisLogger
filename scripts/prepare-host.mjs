import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const REPO_ROOT = fileURLToPath(new URL('..', import.meta.url))
const DEFAULT_HOST = resolve(REPO_ROOT, '..', '..', '..', 'SourceCode', 'Vencord')
const HOST_MARKERS = ['.git', 'package.json', join('src', 'main', 'utils', 'constants.ts'), join('packages', 'discord-types', 'src', 'index.d.ts')]
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
    '@vencord/discord-types': 'packages/discord-types/src/index.d.ts',
}
const BASE_COMPILER_OPTIONS = {
    jsx: 'react',
    lib: ['ESNext', 'DOM'],
    module: 'ESNext',
    moduleResolution: 'bundler',
    noEmit: true,
    allowJs: true,
    skipLibCheck: true,
    strict: true,
    target: 'ESNext',
    types: ['vite/client'],
}
const INCLUDE = ['./**/*.ts', './**/*.tsx', './**/*.mjs']

/** @returns {{ok: false, error: string, missing?: string} | {ok: true}} */
export function assertHost(hostRoot, deps = {}) {
    const d = { existsSync, ...deps }
    for (const marker of HOST_MARKERS) {
        if (!d.existsSync(join(hostRoot, marker))) return { ok: false, error: 'invalid_host_checkout', missing: marker }
    }
    return { ok: true }
}

/** @returns {{ok: false, error: string, missing?: string} | {ok: true, document: {compilerOptions: Record<string, unknown>, include: string[]}, prefix: string}} */
export function buildTsconfigDocument(hostRoot, deps = {}) {
    const d = { existsSync, sep, ...deps }
    const checked = assertHost(hostRoot, d)
    if (!checked.ok) return checked
    const prefix = relative(REPO_ROOT, hostRoot).split(d.sep).join('/')
    if (!prefix || prefix === '.') return { ok: false, error: 'host_is_plugin_repo' }
    if (/^[A-Za-z]:[\\/]/.test(prefix) || prefix.startsWith('//')) return { ok: false, error: 'host_cross_volume' }
    const paths = {}
    for (const alias of Object.keys(PATH_TARGETS)) {
        paths[alias] = [`${prefix}/${PATH_TARGETS[alias]}`]
    }
    return { ok: true, document: { compilerOptions: { baseUrl: '.', paths, ...BASE_COMPILER_OPTIONS }, include: INCLUDE }, prefix }
}

const serializeTsconfig = document => {
    const options = document.compilerOptions
    const pathLines = Object.entries(options.paths).map(([alias, targets]) => `            ${JSON.stringify(alias)}: [${targets.map(target => JSON.stringify(target)).join(', ')}]`).join(',\n')
    const inlineArray = items => `[${items.map(item => JSON.stringify(item)).join(', ')}]`
    return `{
    "compilerOptions": {
        "baseUrl": ${JSON.stringify(options.baseUrl)},
        "paths": {
${pathLines}
        },
        "jsx": ${JSON.stringify(options.jsx)},
        "lib": ${inlineArray(options.lib)},
        "module": ${JSON.stringify(options.module)},
        "moduleResolution": ${JSON.stringify(options.moduleResolution)},
        "noEmit": ${options.noEmit},
        "allowJs": ${options.allowJs},
        "skipLibCheck": ${options.skipLibCheck},
        "strict": ${options.strict},
        "target": ${JSON.stringify(options.target)},
        "types": ${inlineArray(options.types)}
    },
    "include": ${inlineArray(document.include)}
}
`
}

/** @returns {{ok: false, error: string} | {ok: true, changed: boolean, hostRoot: string, prefix: string, tsconfig: string}} */
export function prepareHost(vencordDir, deps = {}) {
    const d = { existsSync, readFileSync, realpathSync, writeFileSync, ...deps }
    if (!vencordDir || !d.existsSync(vencordDir)) return { ok: false, error: 'host_missing' }
    let hostRoot
    try {
        hostRoot = d.realpathSync(vencordDir)
    } catch (_) {
        return { ok: false, error: 'host_missing' }
    }
    const built = buildTsconfigDocument(hostRoot, d)
    if (!built.ok) return built
    const target = join(REPO_ROOT, 'tsconfig.json')
    const serialized = serializeTsconfig(built.document)
    const previous = d.existsSync(target) ? d.readFileSync(target, 'utf8') : null
    const changed = previous !== serialized
    if (changed) d.writeFileSync(target, serialized)
    return { ok: true, changed, hostRoot, prefix: built.prefix, tsconfig: target }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2)
    const option = name => {
        const index = args.indexOf(name)
        return index >= 0 ? args[index + 1] : undefined
    }
    const result = prepareHost(option('--vencord-dir') || DEFAULT_HOST)
    process.stdout.write(JSON.stringify(result, null, 4) + '\n')
    process.exitCode = result.ok ? 0 : 1
}
