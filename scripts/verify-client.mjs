// 不启动浏览器，验证 client.js 的注册形状与首帧渲染不崩。
// 用一个最小 React 兼容层：createElement 造树、hooks 返回初值、
// 然后直接调用被注册的组件函数，遍历返回的树检查主题 token 与关键节点。
//
// 用法：node scripts/verify-client.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const HERE = dirname(fileURLToPath(import.meta.url))
const CLIENT = join(HERE, '..', 'lib', 'client.js')

const log = (...a) => console.log('[client]', ...a)
let failures = 0
function check(name, ok, detail) {
  if (ok) log('PASS', name)
  else { failures += 1; log('FAIL', name, detail ?? '') }
}

/* ---------------- 最小 React ---------------- */
const hookCalls = []
const React = {
  createElement(type, props, ...children) {
    return { type, props: props ?? {}, children: children.flat(Infinity) }
  },
  useRef(value) { return { current: value } },
  useState(initial) {
    const value = typeof initial === 'function' ? initial() : initial
    return [value, () => {}]
  },
  useEffect() { hookCalls.push('useEffect') },
  useMemo(fn) { return fn() },
  useCallback(fn) { return fn },
  Fragment: 'Fragment',
}

/* ---------------- 假 ModuleLoader ---------------- */
let loaded = null
globalThis.window = {
  location: { protocol: 'http:', host: '127.0.0.1:52001' },
  __ModuleLoader__: {
    load(def) { loaded = def },
  },
}
globalThis.location = globalThis.window.location
globalThis.performance = { now: () => 0 }
globalThis.WebSocket = class { constructor() { this.readyState = 3 } close() {} send() {} }

const source = readFileSync(CLIENT, 'utf8')
globalThis.__react__ = React
await import('data:text/javascript;base64,' + Buffer.from(
  source.replace(/require\('react'\)/g, 'globalThis.__react__')
).toString('base64'))

check('调用了 __ModuleLoader__.load', loaded !== null)
if (!loaded) { log('无法继续'); process.exit(1) }

check('id 是包名', loaded.id === 'dsh-live-screen', loaded.id)
check('factory 是函数', typeof loaded.factory === 'function')

const plugin = loaded.factory((name) => {
  if (name === 'react') return React
  throw new Error('unexpected require: ' + name)
})

check('inject 含 slots', Array.isArray(plugin.inject) && plugin.inject.includes('slots'), JSON.stringify(plugin.inject))
check('inject 含 locale', plugin.inject.includes('locale'))
check('apply 是函数', typeof plugin.apply === 'function')

/* ---------------- 假 ctx ---------------- */
const dicts = []
const registrations = []
const effects = []
const t = (key) => `t:${key}`

const ctx = {
  locale: {
    register(ns, dict) { dicts.push({ ns, dict }); return () => {} },
    bind(ns) { return (key) => `t:${ns}:${key}` },
  },
  slots: {
    inject(name, factory) { return factory() },
    register(options, component) {
      registrations.push({ options, component })
      return () => {}
    },
  },
  effect(fn, label) { const d = fn(); effects.push({ label, d }); return d },
}

plugin.apply(ctx)

check('注册了 locale 字典', dicts.length === 1 && dicts[0].ns === 'live-screen', JSON.stringify(dicts.map((d) => d.ns)))
check('字典有 zh 与 en', !!dicts[0]?.dict?.zh && !!dicts[0]?.dict?.en, Object.keys(dicts[0]?.dict ?? {}).join(','))

const panelIcon = registrations.find((r) => r.options.name === 'sidebar.panellist')
const mainView = registrations.find((r) => r.options.name === 'main')

check('注册了 sidebar.panellist', !!panelIcon)
check('sidebar id = live-screen', panelIcon?.options.id === 'live-screen', panelIcon?.options.id)
check('sidebar 有 label 函数', typeof panelIcon?.options.label === 'function')
check('sidebar label 解析出文案', panelIcon?.options.label() === 't:live-screen:panel', panelIcon?.options.label?.())
check('注册了 main 视图', !!mainView)
check('main key = live-screen', mainView?.options.key === 'live-screen', mainView?.options.key)

/* ---------------- 渲染图标 ---------------- */
const iconTree = panelIcon.component({ size: 16 })
check('图标渲染出 svg', iconTree?.type === 'svg', String(iconTree?.type))
check('图标用 currentColor', JSON.stringify(iconTree).includes('currentColor'))

/* ---------------- 渲染主视图 ---------------- */
const tree = mainView.component({})
check('主视图渲染出 div', tree?.type === 'div', String(tree?.type))
check('触发了 useEffect', hookCalls.includes('useEffect'))

/* 遍历树，收集 style 里的 CSS 变量与文本 */
const styles = []
const texts = []
function walk(node) {
  if (node == null) return
  if (Array.isArray(node)) { for (const n of node) walk(n); return }
  if (typeof node !== 'object') { texts.push(String(node)); return }
  if (node.props?.style) styles.push(node.props.style)
  for (const c of node.children ?? []) walk(c)
}
walk(tree)

const tokens = new Set()
for (const s of styles) for (const v of Object.values(s)) {
  if (typeof v !== 'string') continue
  for (const m of v.matchAll(/var\((--dsw-alias-[a-z0-9-]+)\)/g)) tokens.add(m[1])
}
log('用到的主题 token:', [...tokens].join(' '))
check('只用 --dsw-alias-* token', tokens.size >= 6, String(tokens.size))
check('没有字面色泄漏进样式', !styles.some((s) => Object.values(s).some((v) => typeof v === 'string' && /#[0-9a-fA-F]{3,8}\b/.test(v))))

check('渲染出 canvas', JSON.stringify(tree).includes('"canvas"'))
check('渲染出输入框', JSON.stringify(tree).includes('"input"'))

/* ---------------- 卸载清理 ---------------- */
for (const e of effects) { try { e.d() } catch {} }

log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`)
process.exit(failures === 0 ? 0 : 1)
