/**
 * restore-dsh.mjs —— 一键撤销：把 dsh-bili-console 从 DSH 桌面端移除
 * 用途：万一重启 DSH 后打不开 / 异常，双击 restore-dsh.bat 即恢复原状。
 * 做两件事：① 还原 desktop/package.json 到安装前备份 ② 删 node_modules 软链。
 */
import { copyFileSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const dir = join(homedir(), '.dsh', 'profiles', 'desktop')
const pkg = join(dir, 'package.json')
const nmLink = join(dir, 'node_modules', 'dsh-bili-console')

// 安装脚本会在装之前自动备份 package.json，命名如 package.json.bak-<日期>-bili-console。
// 不同机器日期不同，所以这里扫描目录、挑最新的一份，而不是写死名字。
function findBackup() {
  if (!existsSync(dir)) return null
  const hits = readdirSync(dir)
    .filter((n) => /^package\.json\.bak-.*bili-console$/.test(n))
    .map((n) => ({ n, t: statSync(join(dir, n)).mtimeMs }))
    .sort((a, b) => b.t - a.t)
  return hits.length ? join(dir, hits[0].n) : null
}

const bak = findBackup()

if (bak) {
  copyFileSync(bak, pkg)
  console.log('OK 已还原 desktop/package.json（移除 dsh-bili-console 登记）')
  console.log('   来源备份：' + bak)
} else {
  console.log('! 没找到安装前备份（package.json.bak-*-bili-console），package.json 未动')
}
try {
  rmSync(nmLink, { force: true })
  console.log('OK 已删除 node_modules/dsh-bili-console 软链')
} catch (e) {
  console.log('删软链提示：' + (e && e.message))
}
console.log('撤销完成 —— 现在重启 DSH 就是原来的样子。')
