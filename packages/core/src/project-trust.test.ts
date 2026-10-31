import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { ProjectTrustStore } from '@earendil-works/pi-coding-agent'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { prepareProjectTrust } from './project-trust.js'
import { createIsolatedPiEnv, type IsolatedPiEnv, TEST_RESOURCE_ISOLATION } from './test-support.js'

let env: IsolatedPiEnv

beforeEach(async () => {
  env = await createIsolatedPiEnv('huan-project-trust-')
})

afterEach(async () => {
  await env.cleanup()
})

/** 与模块一致的 canonical 口径，用于断言来源路径。 */
function canonical(path: string): string {
  return realpathSync(resolve(path))
}

/** 读取探针日志；文件不存在视为空。 */
async function readLines(path: string): Promise<string[]> {
  try {
    return (await readFile(path, 'utf-8')).trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

/** 在项目 `.pi/extensions` 写入执行探针；扩展工厂执行时追加标记。 */
async function writeProjectProbe(workspace: string, marker: string): Promise<string> {
  const dir = join(workspace, '.pi', 'extensions')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'probe.js')
  await writeFile(
    file,
    `import { appendFileSync } from 'node:fs'

export default function () {
  appendFileSync(${JSON.stringify(marker)}, 'project\\n')
}
`,
  )
  return file
}

/** 在临时用户空间写入用户级扩展。 */
async function writeUserExtension(agentDir: string, source: string): Promise<string> {
  const dir = join(agentDir, 'extensions')
  await mkdir(dir, { recursive: true })
  const file = join(dir, 'trust.js')
  await writeFile(file, source)
  return file
}

/** 合并写入全局设置，保留测试空间原有默认模型。 */
async function setGlobalSetting(agentDir: string, key: string, value: unknown): Promise<void> {
  const path = join(agentDir, 'settings.json')
  const settings = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>
  settings[key] = value
  await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`)
}

/** 读取 trust.json；不存在返回 undefined。 */
function readTrustFile(agentDir: string): Record<string, boolean> | undefined {
  const path = join(agentDir, 'trust.json')
  if (!existsSync(path)) return undefined
  return JSON.parse(readFileSync(path, 'utf-8')) as Record<string, boolean>
}

describe('prepareProjectTrust', () => {
  it('单次准备仅初始化一次用户扩展，拒绝仍完整加载用户模板', async () => {
    const trace = join(env.root, 'factory.trace')
    await writeUserExtension(
      env.agentDir,
      `import { appendFileSync } from 'node:fs'
export default function () { appendFileSync(${JSON.stringify(trace)}, 'factory\\n') }
`,
    )
    await mkdir(join(env.agentDir, 'prompts'), { recursive: true })
    await writeFile(join(env.agentDir, 'prompts', 'example.md'), '用户模板')
    await writeProjectProbe(env.workspace, join(env.root, 'project.marker'))
    const result = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      override: false,
      resourceLoaderOptions: { ...TEST_RESOURCE_ISOLATION, noPromptTemplates: false },
    })
    expect(await readLines(trace)).toEqual(['factory'])
    expect(result.resourceLoader.getPrompts().prompts.some((item) => item.name === 'example')).toBe(
      true,
    )
  })

  it('ask 未回答时停在 needs-trust，显式决定后才装载项目扩展', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)

    const pending = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(pending.state.cwd).toBe(canonical(env.workspace))
    expect(pending.state).toMatchObject({
      status: 'needs-trust',
      source: 'ask',
      requiresTrust: true,
      defaultProjectTrust: 'ask',
      extensionErrors: [],
    })
    expect(pending.state.savedPath).toBeUndefined()
    expect(pending.settingsManager.isProjectTrusted()).toBe(false)
    expect(pending.resourceLoader.getExtensions().extensions).toHaveLength(0)
    expect(existsSync(marker)).toBe(false)

    const denied = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      override: false,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(denied.state).toMatchObject({ status: 'untrusted', source: 'explicit' })
    expect(denied.resourceLoader.getExtensions().extensions).toHaveLength(0)
    expect(existsSync(marker)).toBe(false)

    const allowed = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      override: true,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(allowed.state).toMatchObject({ status: 'trusted', source: 'explicit' })
    expect(allowed.settingsManager.isProjectTrusted()).toBe(true)
    expect(allowed.resourceLoader.getExtensions().extensions).toHaveLength(1)
    expect(await readLines(marker)).toEqual(['project'])
    // 显式本次决定不写入 trust.json。
    expect(readTrustFile(env.agentDir)).toBeUndefined()
  })

  it('用户扩展先于项目加载决定，undecided 继续到父路径 saved 并优先于 default', async () => {
    const grandparent = join(env.root, 'grandparent')
    const parent = join(grandparent, 'parent')
    const child = join(parent, 'child')
    await mkdir(child, { recursive: true })
    const marker = join(env.root, 'project.marker')
    const trace = join(env.root, 'trust.trace')
    await writeProjectProbe(child, marker)
    await writeUserExtension(
      env.agentDir,
      `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('project_trust', (event) => {
    appendFileSync(${JSON.stringify(trace)}, 'trust:' + event.cwd + '\\n')
    return { trusted: 'undecided' }
  })
}
`,
    )
    await setGlobalSetting(env.agentDir, 'defaultProjectTrust', 'never')
    const trustStore = new ProjectTrustStore(env.agentDir)
    trustStore.set(grandparent, false)
    trustStore.set(parent, true)

    const result = await prepareProjectTrust({
      cwd: child,
      agentDir: env.agentDir,
      trustStore,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(result.state).toMatchObject({
      status: 'trusted',
      source: 'saved',
      defaultProjectTrust: 'never',
      extensionErrors: [],
    })
    expect(result.state.savedPath).toBe(canonical(parent))
    expect(await readLines(trace)).toEqual([`trust:${canonical(child)}`])
    expect(await readLines(marker)).toEqual(['project'])
  })

  it('同一扩展的 project_trust 处理器首个 yes/no 生效', async () => {
    const marker = join(env.root, 'project.marker')
    const trace = join(env.root, 'handler.trace')
    await writeProjectProbe(env.workspace, marker)
    await writeUserExtension(
      env.agentDir,
      `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('project_trust', () => {
    appendFileSync(${JSON.stringify(trace)}, 'undecided\\n')
    return { trusted: 'undecided' }
  })
  pi.on('project_trust', () => {
    appendFileSync(${JSON.stringify(trace)}, 'yes\\n')
    return { trusted: 'yes', remember: true }
  })
  pi.on('project_trust', () => {
    appendFileSync(${JSON.stringify(trace)}, 'no\\n')
    return { trusted: 'no' }
  })
}
`,
    )

    const result = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(result.state).toMatchObject({ status: 'trusted', source: 'extension' })
    expect(result.state.savedPath).toBe(canonical(env.workspace))
    expect(await readLines(trace)).toEqual(['undecided', 'yes'])
    expect(readTrustFile(env.agentDir)).toEqual({ [canonical(env.workspace)]: true })
    expect(await readLines(marker)).toEqual(['project'])
  })

  it('扩展错误继续评估，defaultProjectTrust always/never 生效', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)
    await writeUserExtension(
      env.agentDir,
      `export default function (pi) {
  pi.on('project_trust', () => {
    throw new Error('boom')
  })
}
`,
    )
    await setGlobalSetting(env.agentDir, 'defaultProjectTrust', 'never')

    const denied = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(denied.state).toMatchObject({
      status: 'untrusted',
      source: 'default',
      defaultProjectTrust: 'never',
    })
    expect(denied.state.extensionErrors).toHaveLength(1)
    expect(denied.state.extensionErrors[0]).toContain('boom')
    expect(existsSync(marker)).toBe(false)

    await setGlobalSetting(env.agentDir, 'defaultProjectTrust', 'always')
    const allowed = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(allowed.state).toMatchObject({
      status: 'trusted',
      source: 'default',
      defaultProjectTrust: 'always',
    })
    expect(allowed.state.extensionErrors).toHaveLength(1)
    expect(allowed.state.extensionErrors[0]).toContain('boom')
    expect(await readLines(marker)).toEqual(['project'])
  })

  it('扩展 remember 保存拒绝决定，下一次沿用 saved 且不装载项目', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)
    const extensionPath = await writeUserExtension(
      env.agentDir,
      `export default function (pi) {
  pi.on('project_trust', () => ({ trusted: 'no', remember: true }))
}
`,
    )

    const remembered = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(remembered.state).toMatchObject({ status: 'untrusted', source: 'extension' })
    expect(remembered.state.savedPath).toBe(canonical(env.workspace))
    expect(readTrustFile(env.agentDir)).toEqual({ [canonical(env.workspace)]: false })
    expect(existsSync(marker)).toBe(false)

    await rm(extensionPath)
    const saved = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(saved.state).toMatchObject({ status: 'untrusted', source: 'saved' })
    expect(saved.state.savedPath).toBe(canonical(env.workspace))
    expect(existsSync(marker)).toBe(false)
  })

  it('ask 回答后才装载，remember 写入并供下一次使用', async () => {
    const marker = join(env.root, 'project.marker')
    await writeProjectProbe(env.workspace, marker)

    const answered = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      ask: () => ({ trusted: true }),
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(answered.state).toMatchObject({ status: 'trusted', source: 'ask' })
    expect(answered.state.savedPath).toBeUndefined()
    expect(await readLines(marker)).toEqual(['project'])
    expect(readTrustFile(env.agentDir)).toBeUndefined()

    const remembered = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      ask: () => ({ trusted: true, remember: true }),
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(remembered.state).toMatchObject({ status: 'trusted', source: 'ask' })
    expect(remembered.state.savedPath).toBe(canonical(env.workspace))
    expect(readTrustFile(env.agentDir)).toEqual({ [canonical(env.workspace)]: true })
    expect(await readLines(marker)).toEqual(['project', 'project'])

    const saved = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(saved.state).toMatchObject({ status: 'trusted', source: 'saved' })
    expect(saved.state.savedPath).toBe(canonical(env.workspace))
    expect(await readLines(marker)).toEqual(['project', 'project', 'project'])
  })

  it('显式本次决定优先于扩展、saved 与 default，且不咨询扩展', async () => {
    const marker = join(env.root, 'project.marker')
    const trace = join(env.root, 'trust.trace')
    await writeProjectProbe(env.workspace, marker)
    await writeUserExtension(
      env.agentDir,
      `import { appendFileSync } from 'node:fs'

export default function (pi) {
  pi.on('project_trust', () => {
    appendFileSync(${JSON.stringify(trace)}, 'consulted\\n')
    return { trusted: 'no' }
  })
}
`,
    )
    await setGlobalSetting(env.agentDir, 'defaultProjectTrust', 'never')
    const trustStore = new ProjectTrustStore(env.agentDir)
    trustStore.set(env.workspace, false)

    const result = await prepareProjectTrust({
      cwd: env.workspace,
      agentDir: env.agentDir,
      override: true,
      trustStore,
      resourceLoaderOptions: TEST_RESOURCE_ISOLATION,
    })
    expect(result.state).toMatchObject({ status: 'trusted', source: 'explicit' })
    expect(result.state.savedPath).toBeUndefined()
    expect(result.state.extensionErrors).toEqual([])
    expect(await readLines(trace)).toEqual([])
    expect(await readLines(marker)).toEqual(['project'])
    expect(readTrustFile(env.agentDir)).toEqual({ [canonical(env.workspace)]: false })
  })
})
