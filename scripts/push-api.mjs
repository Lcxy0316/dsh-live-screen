// 用 GitHub Git Data API 把本地提交推上去。
// 场景：本机到 github.com:443 的直连被重置（git push 会 Recv failure），
// 但 api.github.com 可达 —— 那就绕开 git 的传输层，直接走 REST。
//
// 用法：node scripts/push-api.mjs <owner/repo> [branch]
// 凭据来源：git credential fill（Windows 凭据管理器里的 GitHub token）。
import { readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import path from 'node:path'

const repo = process.argv[2]
const branch = process.argv[3] ?? 'main'
if (!repo) {
  console.error('用法: node scripts/push-api.mjs <owner/repo> [branch]')
  process.exit(2)
}
const root = path.resolve(import.meta.dirname, '..')

const token = (() => {
  const out = execSync('git credential fill', {
    input: 'protocol=https\nhost=github.com\n\n',
    encoding: 'utf8',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' }
  })
  const line = out.split('\n').find((l) => l.startsWith('password='))
  if (!line) throw new Error('没拿到 GitHub 凭据（git credential fill 返回空）')
  return line.slice('password='.length).trim()
})()

const api = async (method, url, body) => {
  const res = await fetch(`https://api.github.com${url}`, {
    method,
    headers: {
      authorization: `token ${token}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'dsh-live-screen-push',
      ...(body ? { 'content-type': 'application/json' } : {})
    },
    body: body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`${method} ${url} -> ${res.status} ${text.slice(0, 400)}`)
  return text ? JSON.parse(text) : null
}

// 1) 定位当前 head；空仓库先用 Contents API 落一个种子提交。
let headSha = null
try {
  const existing = await api('GET', `/repos/${repo}/git/ref/heads/${branch}`)
  headSha = existing.object.sha
  console.log(`[push] 已有分支 ${branch} -> ${headSha}`)
} catch {
  const seed = await api('PUT', `/repos/${repo}/contents/.github-seed`, {
    message: 'chore: seed repository',
    content: Buffer.from('seed\n').toString('base64')
  })
  headSha = seed.commit.sha
  console.log(`[push] 空仓库，已落种子提交 ${headSha}`)
}

// 2) 按 git 索引收集文件（自动遵守 .gitignore）。
const files = execSync('git ls-files', { cwd: root, encoding: 'utf8' })
  .split('\n')
  .map((s) => s.trim())
  .filter(Boolean)
console.log(`[push] ${files.length} 个文件`)

// 3) 逐个建 blob —— base64 保证二进制（PNG 等）不被破坏。
const tree = []
for (const rel of files) {
  const buffer = readFileSync(path.join(root, rel))
  const blob = await api('POST', `/repos/${repo}/git/blobs`, {
    content: buffer.toString('base64'),
    encoding: 'base64'
  })
  tree.push({ path: rel, mode: '100644', type: 'blob', sha: blob.sha })
}

// 4) 建 tree 与 commit。
const treeRes = await api('POST', `/repos/${repo}/git/trees`, { tree })
const message = execSync('git log -1 --pretty=%B', { cwd: root, encoding: 'utf8' }).trim()
const commit = await api('POST', `/repos/${repo}/git/commits`, {
  message,
  tree: treeRes.sha,
  parents: [headSha]
})

// 5) 更新分支引用。
try {
  await api('POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha })
} catch {
  await api('PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit.sha, force: true })
}

console.log(`[push] tree    ${treeRes.sha}`)
console.log(`[push] commit  ${commit.sha}`)
console.log(`[push] refs/heads/${branch} 已更新`)
console.log(`[push] https://github.com/${repo}`)
