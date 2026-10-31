/**
 * version.mjs —— 插件版本号（唯一真相源）
 * ============================================================================
 * ⚠️ 为什么版本号要单独放一个文件，而不是读 package.json？
 *   因为手机上 DSH 加载插件的方式会让 `readFileSync(new URL('../package.json', import.meta.url))`
 *   读不到东西（各种 host 容器 / 自定义协议 / 打包方式都有可能），一旦读不到就退化成 '0.0.0'，
 *   后果有两个：① 界面上"当前版本"永远显示错的 v0.0.0；
 *              ② 自动检查更新时 `0.1.0 > 0.0.0` 成立 → 永远误报"发现新版本"（2026-10-31 实测踩到）。
 *   而 `import './lib/xxx.mjs'` 是一定能成的（index.js 本来就靠它引了一堆模块），
 *   所以版本号放在这里最稳。
 *
 * 📌 要发新版本时改这一个地方就行；顺手把 package.json 的 version 改成一样的
 *    （对外宣布用 package.json + GitHub Release；插件自己判断更新用这里）。
 * ============================================================================
 */
export const VERSION = '0.3.10'

/**
 * 包身份（= package.json 的 name），界面上会显示出来。
 * 为什么要显示：两个仓库的包长得几乎一样，装错包（比如在手机上装了电脑版）时
 * 版本号会对不上、还查不出原因。把身份亮出来，一眼就能认出装的是哪个。
 * ⚠️ 手机版必须是 dsh-bili-console-mobile，电脑版是 dsh-bili-console。
 */
export const PACKAGE = 'dsh-bili-console'

/**
 * 仓库身份：检查更新、一键自更新都认它。
 * ⚠️ 电脑版仓库 = dsh-bili-console；手机版仓库 = dsh-bili-console-mobile（两棵树只有这里和 package.json 不同）。
 *    改错对象会拿错仓库的版本号来比对 → 永远误报"有新版本"。
 */
export const REPO = 'yizhiyange/dsh-bili-console'
