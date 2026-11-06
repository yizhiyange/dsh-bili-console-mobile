import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { extractDshModels, readCredentialRefs } from './lib/dshcfg.mjs'

const YAML = `- id: llm-ai
  config:
    providers:
      glm-test:
        displayName: 智谱测试
        apiKeyEnv: TEST_KEY
        baseURL: https://open.bigmodel.cn/api/paas/v4
        models:
          - id: glm-4-flash
            name: GLM Flash
`
const CRED = `version: 1
refs:
  TEST_KEY: 0b65abcdef0123456789abcdef0123.abcdef0123456789
`

function caseRun(name, profileName, yamlText, withCred = true) {
  const home = join(tmpdir(), 'dshtest-' + Math.random().toString(36).slice(2))
  mkdirSync(join(home, 'profiles', profileName), { recursive: true })
  writeFileSync(join(home, 'profiles', profileName, 'cordis.patch.yml'), yamlText, 'utf8')
  if (withCred) writeFileSync(join(home, '.credentials.yaml'), CRED, 'utf8')
  const refs = readCredentialRefs(home)
  const out = extractDshModels(home)
  console.log(`【${name}】profile="${profileName}" 读到 refs=${Object.keys(refs).length} 个 → 提取到模型 ${out.length} 个`)
  if (out.length) console.log('        ', out.map((x) => x.modelId).join(', '))
  rmSync(home, { recursive: true, force: true })
  return out.length
}

console.log('=== 实验：profile 名字对提取结果的影响 ===\n')
const a = caseRun('A 标准 desktop', 'desktop', YAML)
const b = caseRun('B 标准 headless', 'headless', YAML)
const c = caseRun('C 目录叫 default', 'default', YAML)
const d = caseRun('D 目录叫 main', 'main', YAML)
const e = caseRun('E 没写 baseURL', 'desktop', YAML.replace(/^ *baseURL:.*\n/m, ''))
const f = caseRun('F 没有 .credentials.yaml', 'desktop', YAML, false)

console.log('\n=== 结论 ===')
console.log('desktop 可提取:', a > 0 ? '是' : '否')
console.log('headless 可提取:', b > 0 ? '是' : '否')
console.log('default 可提取:', c > 0 ? '是' : '否  ← 硬编码坑')
console.log('main 可提取:', d > 0 ? '是' : '否  ← 硬编码坑')
console.log('缺 baseURL 可提取:', e > 0 ? '是' : '否  ← 静默跳过')
console.log('缺凭证文件可提取:', f > 0 ? '是' : '否')
