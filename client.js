/**
 * dsh-bili-console —— 浏览器半端（「设置」里的一个 section）
 * ============================================================================
 * ⭐ 这一版**直接搬运我们自己的 web/console.html（刷B站观测台）**：7 个页面、UI、功能
 *    全部对齐自研控制台，不是抄第三方插件（dsh-bili-scroll 那套骨架已经扔了）。
 *
 * 适配 DSH 的固定注册写法（这是 DSH API 约定，不是照抄某个插件）：
 *     window.__ModuleLoader__.load({ id, factory })
 *     factory 里用 ctx.get('slots').inject('settings.section', …)
 *
 * 后端契约（index.js 真实存在的接口，不臆造）：
 *     GET  /state        → 账号/进度/降级链/安全防护/AI活动流/日报/人设/配置
 *     POST /settings     → 改配置（saveConfig）
 *     GET  /rawlog       → duty.log 原始行
 *     GET  /report       → 今日日报 markdown
 *     POST /login/start  → 出二维码
 *     POST /login/check  → 扫/确认/完成/超时
 *     POST /run/now      → 立即跑一轮
 *     POST /dm/check     → 私信监察
 *     POST /open         → 调系统浏览器打开网页版控制台
 *     GET  /chain        → 降级链端点（与 /state.chain 同形）
 * ============================================================================
 */
window.__ModuleLoader__.load({
  id: 'dsh-bili-console',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    /* 页面顺序：左右滑动切页、顶部 tab 条都按这个排 */
    /* 页面顺序：左右滑动切页、顶部 tab 条都按这个排。
       2026-11-07 拆页：以前「设置」里塞了 12 张卡（找视频、环境、更新、排障全在里面），
       找个开关要划半天。现在把「找视频」和「环境与更新」提成独立页签，设置只留零散开关。 */
    const PAGE_ORDER = [
      ['overview', '总览'], ['find', '找视频'], ['models', '模型与密钥'], ['logs', '专业日志'],
      ['persona', '人设'], ['chain', '降级链'], ['safety', '安全防护'],
      ['comments', '评论'], ['publish', '发布'], ['qq', 'QQ 接入'], ['wild', '为所欲为'], ['settings', '设置'], ['env', '环境与更新'],
    ]

    const API = '/api/bili-console'
    const asJson = async (res) => {
      if (res.ok) return res.json()
      const why = res.status === 401 ? '（未登录 / 没权限）' : res.status === 403 ? '（被宿主拦了）' : ''
      throw new Error('HTTP ' + res.status + why)
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) => asJson(await fetch(API + p, {
      method: 'POST', credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    }))

    /* ────────────── 设计令牌 + 深色/浅色（跟随系统）────────────── */
    const CSS = `
    :root{
      --canvas:#F7F8FC; --card:#FFFFFF; --line:#E5E7EB; --sidebar:#EEF1F8;
      --surface:#FFFFFF; --off:#D4D4D4; --gray-bg:#F1F3F4;
      --blue:#1A73E8; --green:#34A853; --amber:#FBBC04; --red:#EA4335;
      --t1:#111111; --t2:#6B6B6B; --t3:#9AA0A6;
      --green-bg:#E6F4EA; --green-tx:#137333;
      --blue-bg:#E8F0FE;
      --amber-bg:#FEF6E0; --amber-tx:#B06000;
      --red-bg:#FCE8E6; --red-tx:#C5221F;
    }
    *{margin:0;padding:0;box-sizing:border-box;}
    [data-bd-page]{color-scheme:light dark;font-family:"Noto Sans SC","PingFang SC","Microsoft YaHei",sans-serif;background:var(--canvas);
      color:var(--t1);font-size:15px;width:100%;max-width:1440px;margin:0 auto;padding:14px;
      display:flex;flex-direction:column;gap:12px;}
    button{cursor:pointer;border:none;background:none;font-family:inherit;}
    input,select,textarea{font-family:inherit;}

    [data-bd-topbar]{background:var(--card);border:1px solid var(--line);border-radius:8px;height:48px;
      display:flex;align-items:center;padding:0 16px;gap:12px;}
    [data-bd-brand]{display:flex;align-items:center;gap:8px;font-weight:600;font-size:14px;}
    [data-bd-dot]{width:18px;height:18px;border-radius:50%;background:var(--blue);}
    [data-bd-search]{background:var(--canvas);border-radius:14px;height:28px;width:240px;display:flex;align-items:center;padding:0 12px;}
    [data-bd-search] input{border:none;outline:none;background:none;font-size:12px;width:100%;color:var(--t1);}
    [data-bd-spill]{display:inline-flex;align-items:center;gap:7px;margin-left:auto;font-size:12px;font-weight:600;
      padding:5px 12px;border-radius:999px;background:var(--gray-bg);color:var(--t2);}
    [data-bd-spill] .sd{width:8px;height:8px;border-radius:50%;background:var(--t3);}
    [data-bd-spill].run{background:var(--blue-bg);color:var(--blue);} [data-bd-spill].run .sd{background:var(--blue);animation:pulse 1.1s infinite;}
    [data-bd-spill].ok{background:var(--green-bg);color:var(--green-tx);} [data-bd-spill].ok .sd{background:var(--green);}
    [data-bd-spill].err{background:var(--red-bg);color:var(--red-tx);} [data-bd-spill].err .sd{background:var(--red);}
    [data-bd-spill].warn{background:var(--amber-bg);color:var(--amber-tx);} [data-bd-spill].warn .sd{background:var(--amber);}
    @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(26,115,232,.5)}70%{box-shadow:0 0 0 7px rgba(26,115,232,0)}100%{box-shadow:0 0 0 0 rgba(26,115,232,0)}}
    [data-bd-exit]{color:var(--t2);font-size:12px;} [data-bd-exit]:hover{color:var(--t1);}

    [data-bd-banner]{background:var(--amber-bg);border-radius:6px;min-height:40px;display:flex;align-items:center;
      padding:8px 12px;gap:10px;font-size:12px;}
    [data-bd-banner].err{background:var(--red-bg);} [data-bd-banner] button{color:var(--blue);font-weight:600;margin-left:auto;white-space:nowrap;font-size:12px;}
    [data-bd-banner].login{background:var(--blue-bg);border:1px solid var(--blue);font-weight:600;color:var(--t1);gap:10px;}
    [data-bd-banner].login .ic{width:20px;height:20px;border-radius:50%;background:var(--blue);color:#fff;font-size:13px;
      font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;}
    .narrow [data-bd-banner].login{flex-wrap:wrap;} .narrow [data-bd-banner].login button{margin-left:0;width:100%;justify-content:center;}

    [data-bd-main]{display:flex;gap:14px;flex:1;min-height:0;}
    [data-bd-sidebar]{width:196px;flex-shrink:0;background:var(--sidebar);border-radius:8px;padding:12px;
      display:flex;flex-direction:column;gap:4px;align-self:flex-start;position:sticky;top:16px;}
    [data-bd-pill]{display:flex;align-items:center;gap:8px;height:34px;padding:0 12px;border-radius:17px;
      font-size:13px;color:var(--t1);width:100%;text-align:left;transition:background .12s;}
    [data-bd-pill]:hover{background:rgba(26,115,232,.08);}
    [data-bd-pill].active{background:var(--blue);color:#fff;font-weight:600;}
    [data-bd-pill].switch{color:var(--blue);font-weight:600;} [data-bd-pill].switch:hover{background:rgba(26,115,232,.12);}
    [data-bd-spacer]{flex:1;min-height:8px;}
    [data-bd-modecard]{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:12px;
      display:flex;flex-direction:column;gap:6px;font-size:12px;}

    [data-bd-content]{flex:1;min-width:0;display:flex;flex-direction:column;gap:12px;}
    [data-bd-pagewrap]{display:flex;flex-direction:column;gap:12px;}
    [data-bd-pagetitle]{display:flex;align-items:baseline;gap:10px;padding:0 2px;flex-wrap:wrap;}
    [data-bd-pagetitle] .t{font-size:18px;font-weight:700;} [data-bd-pagetitle] .s{font-size:12px;color:var(--t2);}
    /* 排障信息（给开发者看的接口清单/原始报错）默认收进一个可展开的小框 */
    [data-bd-tech]{font-size:11.5px;color:var(--t2);line-height:1.8;white-space:pre-wrap;word-break:break-word;
      background:var(--gray-bg);border-radius:6px;padding:10px 12px;max-height:260px;overflow:auto;}
    [data-bd-card]{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:16px;display:flex;flex-direction:column;gap:10px;}
    [data-bd-cardhead]{display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:2px;flex-wrap:wrap;}
    [data-bd-cardhead] .t{font-size:14px;font-weight:600;} [data-bd-cardhead] .sub{font-size:11px;color:var(--t2);}
    [data-bd-rowflex]{display:flex;gap:12px;align-items:stretch;} [data-bd-rowflex]>[data-bd-card]{flex:1;min-width:0;}
    [data-bd-grid2]{display:grid;grid-template-columns:1fr 1fr;gap:12px;}

    [data-bd-tag]{display:inline-flex;align-items:center;padding:2px 8px;border-radius:11px;font-size:11px;white-space:nowrap;background:var(--gray-bg);color:var(--t2);}
    [data-bd-tag].green{background:var(--green-bg);color:var(--green-tx);}
    [data-bd-tag].blue{background:var(--blue-bg);color:var(--blue);}
    [data-bd-tag].amber{background:var(--amber-bg);color:var(--amber-tx);}
    [data-bd-tag].red{background:var(--red-bg);color:var(--red-tx);}
    [data-bd-tag].gray{background:var(--gray-bg);color:var(--t2);}
    [data-bd-btn]{display:inline-flex;align-items:center;gap:6px;border-radius:6px;font-size:12px;font-weight:600;
      padding:7px 14px;white-space:nowrap;border:1px solid var(--off);background:var(--surface);color:var(--t2);}
    [data-bd-btn]:hover{border-color:var(--t2);}
    [data-bd-btn].primary{background:var(--blue);border-color:var(--blue);color:#fff;} [data-bd-btn].primary:hover{background:#1765cc;}
    [data-bd-btn].outline{background:var(--surface);border:1px solid var(--blue);color:var(--blue);} [data-bd-btn].outline:hover{background:var(--blue-bg);}
    [data-bd-btn].danger{background:var(--red);border-color:var(--red);color:#fff;} [data-bd-btn].danger:hover{background:#d33426;}
    [data-bd-btn].ghost{background:var(--surface);border:1px solid var(--off);color:var(--t2);} [data-bd-btn].ghost:hover{border-color:var(--t2);}
    [data-bd-btn].sm{padding:5px 10px;font-size:11px;}
    [data-bd-btn]:disabled{opacity:.45;cursor:not-allowed;}
    [data-bd-link]{color:var(--blue);font-size:12px;font-weight:600;background:none;} [data-bd-link]:hover{text-decoration:underline;}
    [data-bd-upbar]{height:8px;background:var(--gray-bg);border-radius:4px;overflow:hidden;flex:1;min-width:120px;} [data-bd-upbar]>i{display:block;height:100%;background:var(--blue);border-radius:4px;transition:width .4s;}
    [data-bd-weburl-link]{display:inline-block;margin:6px 0;color:var(--blue);font-weight:600;font-size:14px;word-break:break-all;}
    [data-bd-weburl-link]:hover{text-decoration:underline;}
    [data-bd-weburl]{width:100%;height:40px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--gray-bg);font-size:13px;color:var(--t1);}

    [data-bd-sw]{flex:none;width:44px;height:24px;border-radius:12px;border:0;cursor:pointer;position:relative;padding:0;background:var(--off);transition:background .15s;}
    [data-bd-sw][data-on]{background:var(--blue);} [data-bd-sw] i{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;display:block;box-shadow:0 1px 2px rgba(0,0,0,.2);}
    [data-bd-sw][data-on] i{left:23px;} [data-bd-sw]:disabled{opacity:.45;cursor:default;}
    /* 自绘下拉：原生 <select> 在 Electron / 手机 webview 里经常点不出来，
       而且弹出层永远是系统白底、不跟深色主题（2026-10-31 用户实测，全项目 8 处已换掉） */
    [data-bd-select]{position:relative;display:inline-block;min-width:130px;}
    [data-bd-selbtn]{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;width:100%;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px;color:var(--t1);cursor:pointer;font-family:inherit;}
    [data-bd-selbtn] [data-bd-selarrow]{color:var(--t2);font-size:11px;}
    [data-bd-selpop]{position:absolute;left:0;right:0;top:calc(100% + 4px);z-index:80;background:var(--surface);border:1px solid var(--line);border-radius:8px;box-shadow:0 10px 28px rgba(0,0,0,.22);padding:4px;max-height:240px;overflow:auto;}
    [data-bd-selopt]{display:block;width:100%;text-align:left;padding:8px 10px;border:0;background:transparent;color:var(--t1);font-size:13px;border-radius:6px;cursor:pointer;font-family:inherit;}
    [data-bd-selopt]:hover{background:rgba(127,127,127,.16);}
    [data-bd-selopt].on{background:rgba(127,127,127,.22);font-weight:600;}
    [data-bd-input]{display:flex;align-items:center;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px;gap:8px;color:var(--t1);}
    [data-bd-input] input{border:none;outline:none;flex:1;font-size:13px;background:none;min-width:0;color:var(--t1);}
    [data-bd-input] textarea{border:none;outline:none;flex:1;font-size:13px;background:none;min-width:0;color:var(--t1);resize:vertical;min-height:84px;line-height:1.6;font-family:inherit;}
    [data-bd-input] .ph{color:var(--t3);}
    [data-bd-stepper]{display:inline-flex;align-items:center;gap:10px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:6px;font-size:13px;min-width:110px;justify-content:space-between;color:var(--t1);}
    [data-bd-stepper] button{color:var(--t2);font-size:14px;padding:0 4px;} [data-bd-stepper] button:hover{color:var(--blue);}

    [data-bd-acct]{display:flex;align-items:center;gap:12px;margin-bottom:10px;}
    [data-bd-avatar]{width:40px;height:40px;border-radius:50%;background:var(--blue-bg);display:flex;align-items:center;justify-content:center;font-weight:600;color:var(--blue);flex:none;object-fit:cover;}
    img[data-bd-avatar]{border:1px solid var(--line);}
    [data-bd-acct] .name{font-weight:600;font-size:13px;} [data-bd-acct] .st{margin-left:auto;}
    [data-bd-note]{font-size:12px;color:var(--t2);margin-bottom:10px;line-height:1.6;}
    [data-bd-bignum]{font-size:24px;font-weight:700;margin:4px 0 2px;} [data-bd-bignum] small{font-size:13px;color:var(--t2);font-weight:400;}
    [data-bd-prog]{height:6px;background:var(--sidebar);border-radius:3px;overflow:hidden;margin-top:8px;} [data-bd-prog]>div{height:100%;background:var(--blue);border-radius:3px;}
    [data-bd-sum]{font-size:12px;color:var(--t2);line-height:1.7;}
    [data-bd-protect]{display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;}
    [data-bd-protect] .p{font-size:11px;background:var(--green-bg);color:var(--green-tx);border-radius:11px;padding:2px 9px;}
    [data-bd-protect] .p.off{background:var(--gray-bg);color:var(--t2);}

    [data-bd-feed]{max-height:300px;overflow-y:auto;display:flex;flex-direction:column;gap:2px;}
    [data-bd-feed] .row{display:flex;gap:10px;padding:7px 8px;border-radius:8px;align-items:flex-start;cursor:pointer;}
    [data-bd-feed] .row:hover{background:var(--gray-bg);}
    [data-bd-feed] .ic{width:22px;text-align:center;flex:none;font-size:15px;}
    [data-bd-feed] .tm{font-size:11px;color:var(--t3);flex:none;width:56px;padding-top:2px;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-feed] .bd{flex:1;min-width:0;}
    [data-bd-feed] .txt{font-size:13px;line-height:1.5;}
    [data-bd-feed] .raw{font-size:11px;color:var(--t3);margin-top:2px;word-break:break-all;max-height:0;overflow:hidden;transition:max-height .15s;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-feed] .row.open .raw{max-height:90px;}
    [data-bd-feed] .row.err .txt{color:var(--red-tx);font-weight:600;}
    [data-bd-feed] .row.ok .txt{color:var(--green-tx);}
    [data-bd-feed] .row.run .txt{color:var(--blue);font-weight:600;}
    [data-bd-feed] .row.warn .txt{color:var(--amber-tx);}

    [data-bd-rep]{font-size:13px;line-height:1.7;max-height:380px;overflow:auto;}
    [data-bd-rep] h2{color:var(--t1);font-size:15px;margin:14px 0 6px;} [data-bd-rep] h3{color:var(--t1);font-size:14px;margin:14px 0 4px;}
    [data-bd-collapse]{position:relative;}
    [data-bd-fade]{position:absolute;left:0;right:0;bottom:38px;height:56px;border-radius:0 0 8px 8px;
      background:linear-gradient(180deg,rgba(255,255,255,0),var(--card));pointer-events:none;}
    [data-bd-rep] h4{color:var(--blue);font-size:13px;margin:14px 0 4px;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-rep] a{color:var(--blue);text-decoration:none;border-bottom:1px dotted var(--blue);}
    [data-bd-rep] blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--blue);background:var(--blue-bg);border-radius:0 8px 8px 0;}
    [data-bd-rep] pre{background:#0f172a;color:#e2e8f0;padding:12px;border-radius:10px;overflow:auto;font-size:11.5px;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-rep] table{border-collapse:collapse;width:100%;font-size:12.5px;} [data-bd-rep] td,[data-bd-rep] th{border:1px solid var(--line);padding:5px 8px;}
    [data-bd-grade]{display:inline-block;padding:1px 9px;border-radius:999px;font-size:12px;font-weight:600;}
    .g-good{background:var(--green-bg);color:var(--green-tx);} .g-mid{background:var(--blue-bg);color:var(--blue);} .g-bad{background:var(--gray-bg);color:var(--t2);}
    [data-bd-empty]{color:var(--t2);font-size:13px;text-align:center;padding:22px 0;}

    [data-bd-logline]{display:flex;align-items:center;gap:8px;font-size:12px;padding:3px 0;}
    [data-bd-logline] .tm{color:var(--t2);width:76px;flex-shrink:0;font-size:11px;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-logline] .lv{width:48px;flex-shrink:0;font-size:10px;font-weight:700;font-family:ui-monospace,Consolas,monospace;}
    [data-bd-logline] .msg{color:var(--t1);word-break:break-all;}
    .lv.INFO{color:var(--green-tx);} .lv.WARN{color:var(--amber-tx);} .lv.ERROR{color:var(--red-tx);}
    [data-bd-logbox]{max-height:520px;overflow-y:auto;} [data-bd-logbox]::-webkit-scrollbar{width:12px;} [data-bd-logbox]::-webkit-scrollbar-thumb{background:var(--off);border:4px solid transparent;border-radius:6px;background-clip:padding-box;}
    [data-bd-filters]{display:flex;gap:6px;} [data-bd-filters] .f{padding:3px 10px;border-radius:11px;font-size:11px;background:var(--gray-bg);color:var(--t2);}
    [data-bd-filters] .f.on{background:var(--blue);color:#fff;}

    [data-bd-chip]{display:inline-flex;align-items:center;gap:4px;padding:4px 10px;border-radius:11px;font-size:12px;background:var(--blue-bg);color:var(--blue);}
    [data-bd-chip] .x{font-weight:700;opacity:.7;} [data-bd-chip] .x:hover{opacity:1;}
    [data-bd-chip].add{background:var(--surface);border:1px solid var(--blue);}
    [data-bd-chips]{display:flex;flex-wrap:wrap;gap:8px;}

    [data-bd-prov]{border:1px solid var(--line);border-radius:8px;padding:12px 14px;margin-bottom:10px;}
    [data-bd-prov] .ph{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:8px;}
    [data-bd-prov] .ph .nm{font-weight:600;font-size:13px;} [data-bd-prov] .ph .url{font-size:11px;color:var(--t3);word-break:break-all;}
    [data-bd-mchips]{display:flex;flex-wrap:wrap;gap:6px;}
    [data-bd-mchip]{display:inline-flex;align-items:center;gap:5px;padding:4px 10px;border-radius:11px;font-size:12px;background:var(--gray-bg);color:var(--t2);border:1px solid transparent;cursor:pointer;transition:all .12s;}
    [data-bd-mchip]:hover{border-color:var(--blue);} [data-bd-mchip].sel{background:var(--blue);color:#fff;}
    [data-bd-mchip] .vb{font-size:10px;background:var(--amber-bg);color:var(--amber-tx);border-radius:8px;padding:0 6px;}
    [data-bd-mchip].sel .vb{background:rgba(255,255,255,.25);color:#fff;}
    [data-bd-field]{display:flex;flex-direction:column;gap:6px;margin-bottom:12px;}
    [data-bd-field] label{font-size:12px;color:var(--t2);} [data-bd-field] .hint{font-size:11px;color:var(--t2);}
    [data-bd-formgrid]{display:grid;grid-template-columns:1fr 1fr;column-gap:18px;}
    [data-bd-page].narrow [data-bd-formgrid]{grid-template-columns:1fr;}
    /* 窄屏排版（2026-10-31）：目标是【永远不出横向滚动条】——
       标签/说明占一整行，控件换到下一行；超宽的内容一律折行，绝不给你一条又细又难滑的横条 */
    [data-bd-page].narrow [data-bd-content]{overflow-x:hidden;}
    [data-bd-page].narrow [data-bd-setrow]{flex-wrap:wrap;row-gap:8px;}
    [data-bd-page].narrow [data-bd-setrow]>[data-bd-txt]{flex:1 1 100%;}
    [data-bd-page].narrow [data-bd-setrow]>*{min-width:0;max-width:100%;}

    /* ── 低配/触摸设备（.lite）：只干三件事，专治滚动掉帧 ──────────────────
       ① 取消内嵌滚动区：手机上手指一划，浏览器要先算「滚里面还是滚外面」，
          低端 GPU 上这一步就掉帧。全并成一个滚动上下文最顺。
       ② 停掉那个无限循环的 box-shadow 动画（pulse）：它每帧都要重绘，
          而 box-shadow 无法合成到 GPU 层，低配设备会一直卡。
       ③ 侧栏 sticky 在滚动时每帧重算位置，触摸设备上直接改成普通布局。 */
    .lite [data-bd-logbox],.lite [data-bd-feed]{max-height:none !important;overflow:visible !important;}
    .lite [data-bd-sidebar]{position:static !important;top:auto !important;}
    .lite [data-bd-spill].run .sd{animation:none !important;box-shadow:0 0 0 3px rgba(26,115,232,.35) !important;}
    [data-bd-page].narrow [data-bd-setrow]>[data-bd-input],
    [data-bd-page].narrow [data-bd-setrow]>select,
    [data-bd-page].narrow [data-bd-setrow]>[data-bd-numin]{flex:1 1 100%;}
    [data-bd-page].narrow textarea{max-width:100%;}
    [data-bd-page].narrow [data-bd-chips]{flex-wrap:wrap;}
    [data-bd-page].narrow [data-bd-rep] pre,[data-bd-page].narrow [data-bd-logbox]{overflow-x:auto;}
    [data-bd-errpage]{padding:16px 0;}
    [data-bd-radio]{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--off);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;}
    [data-bd-radio].on{border-color:var(--blue);} [data-bd-radio].on::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--blue);}
    textarea[data-bd-persona]{width:100%;min-height:420px;border:1px solid var(--line);border-radius:8px;padding:14px;font-size:12.5px;line-height:1.8;resize:vertical;background:var(--surface);color:var(--t1);}
    textarea[data-bd-persona]:focus{outline:none;border-color:var(--blue);}
    [data-bd-chainitem]{display:flex;flex-direction:column;gap:8px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);}
    [data-bd-chainitem] .row1{display:flex;align-items:center;gap:10px;}
    /* 每个模型单独调思考强度：按钮做大，手机上点得准 */
    [data-bd-strength]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:8px;border-top:1px dashed var(--line);}
    [data-bd-strength] .lb{font-size:11.5px;color:var(--t3);}
    [data-bd-strength] .lvlbtn{min-width:44px;min-height:32px;padding:0 12px;border:1px solid var(--line);border-radius:8px;background:var(--canvas);color:var(--t2);font-size:12.5px;cursor:pointer;}
    [data-bd-strength] .lvlbtn.on{background:var(--blue);border-color:var(--blue);color:#fff;font-weight:600;}
    [data-bd-strength] .cur{font-size:11px;color:var(--t3);margin-left:auto;}
    [data-bd-chainitem] .idx{width:22px;height:22px;border-radius:50%;background:var(--blue-bg);color:var(--blue);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;}
    [data-bd-chainitem] .nm{font-weight:600;font-size:13px;} [data-bd-chainitem] .mdl{font-size:11px;color:var(--t3);}
    [data-bd-chainitem] .src{margin-left:auto;}
    [data-bd-chainitem] .arrows{display:flex;flex-direction:column;gap:2px;}
    [data-bd-chainitem] .arrows button{font-size:11px;color:var(--t2);padding:0 4px;line-height:1.1;} [data-bd-chainitem] .arrows button:hover{color:var(--blue);}
    [data-bd-chainitem] .arrows button:disabled{opacity:.3;cursor:not-allowed;}
    [data-bd-chainlist]{display:flex;flex-direction:column;gap:8px;}
    [data-bd-setrow]{display:flex;align-items:center;gap:12px;padding:12px 0;}
    [data-bd-setrow]+[data-bd-setrow]{border-top:1px solid var(--line);}
    [data-bd-seg]{display:flex;gap:6px;flex-wrap:wrap;justify-content:flex-end;flex:none;}
    [data-bd-seg] [data-bd-btn]{min-width:62px;justify-content:center;}
    [data-bd-setrow] .txt{flex:1;min-width:0;} [data-bd-setrow] .lb{font-size:13px;margin-bottom:2px;} [data-bd-setrow] .ds{font-size:11px;color:var(--t2);line-height:1.6;}
    [data-bd-callout]{border-left:3px solid var(--blue);background:var(--canvas);border-radius:0 6px 6px 0;padding:12px 16px;font-size:12px;line-height:1.9;}
    [data-bd-charter]{font-size:12.5px;color:var(--t2);line-height:2;padding-left:18px;}
    [data-bd-charter] li{margin-bottom:4px;}

    [data-bd-toast]{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);background:#111;color:#fff;font-size:13px;padding:10px 18px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:99;max-width:80%;}
    [data-bd-toast].show{opacity:.92;transform:translateX(-50%) translateY(0);}
    /* 右下角浮动保存条：一改配置就浮出来，点一下直接存 */
    [data-bd-floatsave]{position:fixed;right:18px;bottom:84px;z-index:98;display:flex;align-items:center;gap:10px;
      background:var(--card);border:1px solid var(--line);border-radius:24px;padding:8px 12px;
      box-shadow:0 8px 28px rgba(0,0,0,.18);animation:bdfade .18s ease-out;}
    @keyframes bdfade{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    .narrow [data-bd-floatsave]{right:10px;bottom:96px;gap:8px;padding:7px 10px;}
    /* 浮动保存条出现时，给内容底部留出空间，避免盖住最后几行设置 */
    [data-bd-page].has-floatsave [data-bd-content]{padding-bottom:80px;}
    /* ===== 电脑上更好滚（2026-10-31）：滚动条"可抓面积"加大一倍多（外观粗细不变）+ 按住内容拖动即可滚屏 ===== */
    body.bd-grabbing,body.bd-grabbing *{cursor:grabbing !important;}
    body.bd-grabbing *{user-select:none !important;}
    ::-webkit-scrollbar{width:14px;height:14px;}
    ::-webkit-scrollbar-thumb{background:rgba(127,134,147,.45);border:4px solid transparent;border-radius:7px;background-clip:padding-box;}
    ::-webkit-scrollbar-thumb:hover{background:rgba(127,134,147,.8);border:4px solid transparent;border-radius:7px;background-clip:padding-box;}
    ::-webkit-scrollbar-corner{background:transparent;}
    /* 评论记录条目 */
    [data-bd-cmt]{border:1px solid var(--line);border-radius:8px;padding:10px 12px;margin:8px 0;}
    [data-bd-cmt] .t{font-size:12.5px;font-weight:600;color:var(--t1);}
    [data-bd-cmt] .x{font-size:13px;line-height:1.7;margin:5px 0;color:var(--t1);white-space:pre-wrap;}
    [data-bd-cmt] .m{display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:11.5px;color:var(--t2);}
    [data-bd-foot]{text-align:center;font-size:11px;color:var(--t3);padding:4px 0 10px;line-height:1.8;}

    [data-bd-mask]{position:fixed;inset:0;background:rgba(17,17,17,.45);display:none;align-items:center;justify-content:center;z-index:50;}
    [data-bd-mask].show{display:flex;}
    [data-bd-modal]{background:var(--surface);border-radius:12px;padding:22px;width:360px;max-width:92vw;text-align:center;}
    [data-bd-modal] img{width:220px;height:220px;border:1px solid var(--line);border-radius:8px;margin:12px auto;display:block;}
    [data-bd-modal] .qr-url{font-size:11px;color:var(--t2);word-break:break-all;margin:8px 0;}
    [data-bd-modal] .hint{font-size:12px;color:var(--t2);margin-top:6px;}

    /* ────────────── 可读性：整体字号上调一档（DSH 设置栏里太小看不清）────────────── */
    [data-bd-pill]{height:38px;font-size:14px;border-radius:19px;}
    [data-bd-cardhead] .t{font-size:15px;} [data-bd-cardhead] .sub{font-size:12px;}
    [data-bd-pagetitle] .t{font-size:21px;} [data-bd-pagetitle] .s{font-size:12.5px;}
    [data-bd-tag]{font-size:12px;padding:3px 9px;}
    [data-bd-btn]{font-size:13px;padding:8px 15px;} [data-bd-btn].sm{font-size:12px;padding:6px 11px;}
    [data-bd-input],[data-bd-select],[data-bd-stepper]{font-size:14px;height:38px;}
    [data-bd-input] input,[data-bd-select] select{font-size:14px;}
    [data-bd-note],[data-bd-sum],[data-bd-link],[data-bd-exit]{font-size:12.5px;}
    [data-bd-feed] .txt{font-size:14px;} [data-bd-feed] .raw{font-size:12px;}
    [data-bd-feed] .tm{font-size:12px;width:60px;}
    [data-bd-logline]{font-size:13px;} [data-bd-logline] .tm{font-size:12px;width:82px;} [data-bd-logline] .lv{font-size:11px;width:52px;}
    [data-bd-rep]{font-size:14px;} [data-bd-rep] h2{font-size:17px;} [data-bd-rep] h3{font-size:15px;} [data-bd-rep] h4{font-size:14px;}
    [data-bd-rep] table{font-size:13.5px;}
    [data-bd-setrow] .lb{font-size:14px;} [data-bd-setrow] .ds{font-size:12px;}
    [data-bd-field] label{font-size:13px;} [data-bd-field] .hint{font-size:12px;}
    [data-bd-callout]{font-size:13px;} [data-bd-charter]{font-size:13.5px;}
    textarea[data-bd-persona]{font-size:13.5px;}
    [data-bd-acct] .name{font-size:14px;} [data-bd-bignum]{font-size:30px;}
    [data-bd-mchip],[data-bd-chip]{font-size:13px;} [data-bd-prov] .ph .nm{font-size:14px;} [data-bd-prov] .ph .url{font-size:12px;}
    [data-bd-chainitem] .nm{font-size:14px;} [data-bd-chainitem] .mdl{font-size:12px;}
    [data-bd-banner]{font-size:13px;padding:10px 12px;} [data-bd-banner] button{font-size:13px;}
    [data-bd-foot]{font-size:12px;}

    /* ────────────── 窄栏自适应（DSH 设置栏比窗口窄，用 JS 量宽度打 .narrow）────────────── */
    [data-bd-page].narrow{padding:10px;gap:10px;}
    .narrow [data-bd-topbar]{height:auto;flex-wrap:wrap;padding:10px 12px;gap:8px;}
    .narrow [data-bd-brand]{font-size:15px;}
    .narrow [data-bd-search]{width:100%;order:3;height:34px;}
    .narrow [data-bd-search] input{font-size:13px;}
    .narrow [data-bd-main]{flex-direction:column;gap:10px;}
    .narrow [data-bd-sidebar]{width:100%;position:static;flex-direction:row;flex-wrap:wrap;
      padding:8px;gap:6px;align-items:center;}
    .narrow [data-bd-sidebar]::-webkit-scrollbar{height:12px;}
    .narrow [data-bd-sidebar]::-webkit-scrollbar-thumb{background:var(--off);border:4px solid transparent;border-radius:6px;background-clip:padding-box;}
    .narrow [data-bd-sidebar] [data-bd-pill]{width:auto;flex:none;white-space:nowrap;padding:0 14px;}
    .narrow [data-bd-spacer],.narrow [data-bd-modecard]{display:none;}
    .narrow [data-bd-sidebar] [data-bd-pill].switch{display:none;} /* 顶栏已有「网页版 ↗」，不重复 */
    .narrow [data-bd-rowflex]{flex-direction:column;}
    .narrow [data-bd-grid2]{grid-template-columns:1fr;}
    .narrow [data-bd-card]{padding:13px;}
    .narrow [data-bd-setrow]{flex-wrap:wrap;}
    .narrow [data-bd-setrow] .txt{flex:1 1 100%;}
    .narrow [data-bd-setrow] > [data-bd-input],.narrow [data-bd-setrow] > [data-bd-select],
    .narrow [data-bd-setrow] > [data-bd-stepper]{flex:1 1 100%;}
    .narrow [data-bd-setrow] > [data-bd-sw]{margin-left:auto;}
    .narrow [data-bd-feed]{max-height:260px;}
    .narrow [data-bd-logbox]{max-height:420px;}
    .narrow [data-bd-rep]{max-height:none;}
    .narrow textarea[data-bd-persona]{min-height:280px;}
    .narrow [data-bd-modal]{width:auto;padding:18px;}

    @media (max-width:900px){
      [data-bd-grid2]{grid-template-columns:1fr;}
      [data-bd-sidebar]{width:100%;position:static;flex-direction:row;flex-wrap:wrap;}
      [data-bd-sidebar] [data-bd-pill]{width:auto;} [data-bd-spacer],[data-bd-modecard]{display:none;}
      [data-bd-main]{flex-direction:column;} [data-bd-rowflex]{flex-direction:column;}
    }
    /* ────────── 深色：跟随系统自动切换（配色重做，上一版发闷） ────────── */
    @media (prefers-color-scheme: dark){
      :root{
        --canvas:#131417; --card:#1b1d22; --line:#2b2e36; --sidebar:#171920;
        --surface:#1b1d22; --off:#3a3e47; --gray-bg:#23262d;
        --blue:#5c9bff; --green:#4cc16d; --amber:#f5c451; --red:#f27b72;
        --t1:#e9ebef; --t2:#a0a6b0; --t3:#6f7681;
        --green-bg:rgba(76,193,109,.16); --green-tx:#6fd68f;
        --blue-bg:rgba(92,155,255,.16);
        --amber-bg:rgba(245,196,81,.14); --amber-tx:#f0c765;
        --red-bg:rgba(242,123,114,.16); --red-tx:#f2a29a;
      }
      [data-bd-page]{color-scheme:dark;}
      [data-bd-sw]{background:#3a3e47;}
      [data-bd-pill]:hover{background:rgba(92,155,255,.12);}
      [data-bd-fade]{background:linear-gradient(180deg,rgba(27,29,34,0),var(--card));}
      [data-bd-logbox]{background:var(--card);}
      [data-bd-btn].primary:hover{background:#4a8bef;}
      [data-bd-btn].danger:hover{background:#e06a61;}
    }
    /* 底色仍走变量，深色由上面的媒体查询接管 */
        `

    const esc = (s) => String(s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))

    /* 极简 Markdown（日报用，对齐 console 的 renderMD） */
    const inlineMd = (s) => {
      s = esc(s)
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      s = s.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      return s
    }
    const renderMD = (md) => {
      const out = []; let inCode = false, inTable = false
      String(md || '').split(/\r?\n/).forEach((ln) => {
        if (/^\s*```/.test(ln)) { if (inCode) { out.push('</pre>'); inCode = false } else { out.push('<pre>'); inCode = true } return }
        if (inCode) { out.push(esc(ln)); return }
        const t = ln.trim(); if (t === '') return
        if (/^\|/.test(t)) {
          if (/^\|[\s:\-|]+\|?$/.test(t)) return
          if (!inTable) { out.push('<table>'); inTable = true }
          out.push('<tr>' + t.replace(/^\|/, '').replace(/\|$/, '').split('|').map((x) => '<td>' + inlineMd(x.trim()) + '</td>').join('') + '</tr>'); return
        } else if (inTable) { out.push('</table>'); inTable = false }
        const g = t.match(/(值得看|可以看|不值当)/)
        if (/^###\s+BV/.test(t)) { out.push('<h4>' + inlineMd(t.replace(/^###\s*/, '')) + '</h4>'); return }
        if (/^###\s/.test(t)) { out.push('<h3>' + inlineMd(t.replace(/^###\s*/, '')) + '</h3>'); return }
        if (/^##\s/.test(t)) { out.push('<h2>' + inlineMd(t.replace(/^##\s*/, '')) + '</h2>'); return }
        if (/^#\s/.test(t)) { out.push('<h2>' + inlineMd(t.replace(/^#\s*/, '')) + '</h2>'); return }
        if (/^>\s?/.test(t)) { out.push('<blockquote>' + inlineMd(t.replace(/^>\s?/, '')) + '</blockquote>'); return }
        if (/^[-*]\s/.test(t)) { out.push('<div style="padding-left:14px">• ' + inlineMd(t.replace(/^[-*]\s/, '')) + '</div>'); return }
        if (g) { const cls = g[1] === '值得看' ? 'g-good' : (g[1] === '可以看' ? 'g-mid' : 'g-bad'); out.push('<div>' + inlineMd(t).replace(g[1], '<span class="grade ' + cls + '">' + g[1] + '</span>') + '</div>'); return }
        out.push('<div>' + inlineMd(t) + '</div>')
      })
      if (inTable) out.push('</table>')
      if (inCode) out.push('</pre>')
      return out.join('\n')
    }

    const PROV_URLS = { deepseek: 'https://api.deepseek.com/v1', glm: 'https://open.bigmodel.cn/api/paas/v4', qwen: 'https://dashscope.aliyuncs.com/compatible-mode/v1', other: '' }

    /* ────────────── 小组件 ────────────── */
    const Switch = ({ on, onChange, disabled }) => h('button', {
      'data-bd-sw': '', 'data-on': on ? '' : undefined, disabled: Boolean(disabled),
      title: on ? '已开' : '已关', onClick: () => { if (!disabled) onChange(!on) },
    }, h('i'))

    const Tag = ({ c, children }) => h('span', { 'data-bd-tag': '', className: c || '' }, children)

    const ToggleRow = ({ label, note, on, onChange, disabled }) => h('div', { 'data-bd-setrow': '' },
      h('div', { 'data-bd-txt': '' },
        h('div', { 'data-bd-lb': '' }, label),
        note ? h('div', { 'data-bd-ds': '' }, note) : null),
      h(Switch, { on, onChange, disabled }))

    /** 三态分段选择：适合「自动 / 强制开 / 强制关」这种选项——开关表达不了"自动"，下拉又太重 */
    const SegRow = ({ label, note, value, options, onChange }) => h('div', { 'data-bd-setrow': '' },
      h('div', { 'data-bd-txt': '' },
        h('div', { 'data-bd-lb': '' }, label),
        note ? h('div', { 'data-bd-ds': '' }, note) : null),
      h('div', { 'data-bd-seg': '' }, (options || []).map((o) => h('button', {
        key: o.v, 'data-bd-btn': '',
        className: value === o.v ? 'primary sm' : 'ghost sm',
        onClick: () => onChange(o.v),
      }, o.t))))

    // 注意：下面这些组件都是「直接函数调用」用的（Card({...}, a, b)），
    // 子元素落在第 2 个起的位置参数里，**不在 props.children** —— 必须用 ...kids 收，
    // 否则卡片里只剩标题、开关/输入框/下拉/按钮全被吞掉（曾经的真实 bug）。
    const Card = (props, ...kids) => {
      const p = props || {}
      const children = [...(p.children != null ? [].concat(p.children) : []), ...kids]
      return h('div', { 'data-bd-card': '' },
        (p.title || p.right) ? h('div', { 'data-bd-cardhead': '' },
          p.title ? h('span', { className: 't' }, p.title) : null,
          p.sub ? h('span', { className: 'sub' }, p.sub) : null,
          p.right || null) : null,
        children)
    }

    /**
     * 下拉选择（自绘）——**不要用原生 <select>**：
     * Electron / 手机 webview 里原生下拉经常点不出来，而且弹出层永远是系统白底、不跟深色主题。
     * 这里用「按钮 + 绝对定位浮层」自己画，颜色全走 CSS 变量；点空白处 / 按 Esc 自动收起。
     * 注意：这里刻意不用 useState —— 这些组件是直接调用式（Select(...) 而不是 h(Select,...)），
     * hooks 会算到 Console 头上，切页时数量一变直接崩（2026-10-27 踩过）。
     */
    const Select = (props, ...kids) => {
      const p = props || {}
      const opts = [...(p.children != null ? [].concat(p.children) : []), ...kids]
        .flat().filter(Boolean)
        .map((o) => {
          const pr = (o && o.props) || {}
          return { value: String(pr.value ?? ''), label: pr.children != null ? pr.children : String(pr.value ?? '') }
        })
      const cur = opts.find((o) => o.value === String(p.value ?? ''))
      const closeAll = () => { try { document.querySelectorAll('[data-bd-selpop]').forEach((x) => { x.style.display = 'none' }) } catch { /* noop */ } }
      const onBtn = (e) => {
        e.preventDefault(); e.stopPropagation()
        const box = e.currentTarget.closest('[data-bd-select]')
        const pop = box && box.querySelector('[data-bd-selpop]')
        if (!pop) return
        const willShow = pop.style.display !== 'block'
        closeAll()
        pop.style.display = willShow ? 'block' : 'none'
        if (!globalThis.__bdSelAway) {
          globalThis.__bdSelAway = true
          document.addEventListener('mousedown', (ev) => {
            try { if (!ev.target.closest || !ev.target.closest('[data-bd-select]')) closeAll() } catch { /* noop */ }
          }, true)
          document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeAll() })
        }
      }
      const onOpt = (e) => {
        e.preventDefault(); e.stopPropagation()
        const v = String(e.currentTarget.getAttribute('data-v') ?? '')
        const box = e.currentTarget.closest('[data-bd-select]')
        try {
          if (box) {
            const pop = box.querySelector('[data-bd-selpop]')
            if (pop) pop.style.display = 'none'
            const txt = box.querySelector('[data-bd-seltext]')
            if (txt) txt.textContent = e.currentTarget.textContent
          }
        } catch { /* noop */ }
        if (p.onChange) p.onChange(v)
      }
      return h('div', { 'data-bd-select': '', style: p.minWidth ? { minWidth: p.minWidth } : undefined },
        h('button', { type: 'button', 'data-bd-selbtn': '', onClick: onBtn },
          h('span', { 'data-bd-seltext': '' }, cur ? cur.label : '请选择'),
          h('span', { 'data-bd-selarrow': '' }, '▾')),
        h('div', { 'data-bd-selpop': '', style: { display: 'none' } },
          opts.map((o, i) => h('button', {
            type: 'button', key: o.value || ('opt' + i), 'data-bd-selopt': '', 'data-v': o.value,
            className: o.value === String(p.value ?? '') ? 'on' : '', onClick: onOpt,
          }, o.label))))
    }

    const Input = ({ value, onChange, placeholder, type, onBlur, style, defaultValue, onEnter }) => {
      // 受控（有 onChange）走 value；非受控（只有 onBlur 提交）走 defaultValue，避开 2 秒轮询覆盖草稿
      const p = { type: type || 'text', placeholder: placeholder || '', onBlur }
      if (onEnter) p.onKeyDown = (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter() } }
      if (onChange) { p.value = value ?? ''; p.onChange = (e) => onChange(e.target.value) }
      else { p.defaultValue = defaultValue ?? ''; p.key = defaultValue }
      return h('div', { 'data-bd-input': '', style }, h('input', p))
    }

    const Stepper = ({ value, onStep }) => h('span', { 'data-bd-stepper': '' },
      h('button', { onClick: () => onStep(-1) }, '−'),
      h('span', { className: 'val' }, String(value)),
      h('button', { onClick: () => onStep(1) }, '+'))

    /**
     * 文本输入（失焦/回车才提交）：内部草稿，不会被 2 秒轮询冲掉。
     * 用它是因为之前吃过亏——直接绑 cfg 的输入框，每 2 秒就被服务端值覆盖。
     */
    const DraftInput = ({ value, onCommit, placeholder, type = 'text' }) => {
      const [d, setD] = React.useState(null)
      const shown = d != null ? d : String(value != null ? value : '')
      const commit = () => {
        const v = shown
        setD(null)
        if (v !== String(value != null ? value : '')) onCommit(v)
      }
      return h('div', { 'data-bd-input': '' },
        h('input', {
          type, value: shown, placeholder,
          onChange: (e) => setD(e.target.value),
          onBlur: commit,
          onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); try { e.currentTarget.blur() } catch {} } },
        }))
    }

    /**
     * 数字输入框：想填多少填多少，不用按住 + 号点半天。
     * 用本地草稿，避免 /state 每 2 秒轮询把正在输入的内容冲掉；
     * 失焦或回车才提交（提交时按 min/max 夹一次，防止填出离谱的数）。
     */
    const NumInput = ({ value, onCommit, min = 0, max = Number.MAX_SAFE_INTEGER, suffix = '', width = 92 }) => {
      const [draft, setDraft] = React.useState(null)
      const shown = draft != null ? draft : String(value != null ? value : '')
      const commit = () => {
        const n = Math.max(min, Math.min(max, Math.floor(Number(shown) || 0)))
        setDraft(null)
        if (n !== Number(value || 0)) onCommit(n)
      }
      return h('span', { 'data-bd-numin': '', style: { display: 'inline-flex', alignItems: 'center', gap: '8px' } },
        h('div', { 'data-bd-input': '', style: { width: width + 'px' } },
          h('input', {
            type: 'text', inputMode: 'numeric', value: shown,
            onChange: (e) => setDraft(String(e.target.value).replace(/[^\d]/g, '')),
            onBlur: commit,
            onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); try { e.currentTarget.blur() } catch {} } },
          })),
        suffix ? h('span', { 'data-bd-ds': '', style: { fontSize: '12px', color: 'var(--t2)' } }, suffix) : null)
    }

    const LEVEL_LABEL = { off: '关', low: '低', medium: '中', high: '高' }
    const ChainList = ({ endpoints, onReorder, strengthMap, onStrength }) => {
      if (!endpoints || !endpoints.length) return h('div', { 'data-bd-empty': '' }, '链上空：去「模型与密钥」加一个模型，或等 DSH 预设同步')
      return h('div', { 'data-bd-chainlist': '' }, endpoints.map((ep, i) => {
        const srcTag = ep.source === 'preset' ? Tag({ c: 'blue', children: 'DSH预设' }) : Tag({ c: 'gray', children: '自定义' })
        const arrows = h('div', { className: 'arrows' },
          h('button', { disabled: i === 0, onClick: () => onReorder(i, -1) }, '▲'),
          h('button', { disabled: i === endpoints.length - 1, onClick: () => onReorder(i, 1) }, '▼'))
        const cur = (strengthMap || {})[ep.id] || ''
        // 强度：手机上要好点，四个大按钮 + 明确的选中态（2026-11-1）
        const strengthRow = h('div', { 'data-bd-strength': '' },
          h('span', { className: 'lb' }, '思考'),
          ['off', 'low', 'medium', 'high'].map((lv) => h('button', {
            key: lv, 'data-bd-btn': '', 'data-bd-lvl': lv,
            className: 'lvlbtn' + (cur === lv ? ' on' : ''),
            title: lv === 'off' ? '不思考（最快最省）' : (lv === 'high' ? '高强度（最费，慢）' : LEVEL_LABEL[lv] + '强度'),
            onClick: () => onStrength && onStrength(ep.id, cur === lv ? '' : lv),
          }, LEVEL_LABEL[lv])),
          h('span', { className: 'cur' }, cur ? ('当前：' + LEVEL_LABEL[cur]) : '跟全局'))
        return h('div', { 'data-bd-chainitem': '' },
          h('div', { className: 'row1' },
            h('div', { className: 'idx' }, String(i + 1)),
            h('div', null, h('div', { className: 'nm' }, ep.label || ''), h('div', { className: 'mdl' }, ep.model || '')),
            h('div', { className: 'src' }, srcTag),
            arrows),
          strengthRow)
      }))
    }

    /* 错误边界：任何一个页面渲染炸了，就挡在这里显示报错，而不是让整个控制台白屏（白屏就得重启 DSH） */
    class PageBoundary extends React.Component {
      constructor(p) { super(p); this.state = { err: null } }
      static getDerivedStateFromError(err) { return { err: err || new Error('未知渲染错误') } }
      componentDidCatch(err, info) { try { console.error('[bili-console] 页面渲染异常，已拦截（无需重启 DSH）：', err, info) } catch (_) {} }
      render() {
        if (this.state.err) {
          return h('div', { 'data-bd-errpage': '' },
            h('div', { 'data-bd-banner': '', className: 'err' }, '这个页面渲染出错了，已自动拦住（不用重启 DSH）。错误：' + String((this.state.err && this.state.err.message) || this.state.err)),
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '10px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => this.setState({ err: null }) }, '重试这一页'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => { this.setState({ err: null }); if (this.props.onHome) this.props.onHome() } }, '回总览')))
        }
        return this.props.children
      }
    }

    // AI 助手的对话日志：放在组件外面，页面每 2 秒重渲染也不会被清掉
    const BILI_CHAT_LOG = []
    // 手机省电统计（只是给用户看的「确实省了」的证据，不影响功能）
    const BILI_SAVED = { skips: 0, polls: 0 }
    // 长任务进行中 → 轮询要快一点（不然进度条像卡住）
    const BILI_BUSY = { value: false }
    // 折叠面板的展开状态存在组件外面：页面每 2 秒重渲染、甚至切页回来，都不会把用户展开的东西关掉
    const BILI_UI_OPEN = { tts: false }
    // 自动模式的编辑草稿：用户在卡片里选档位/填数字时，2 秒轮询别把它冲掉
    // 自动模式的草稿（放组件外面：2 秒轮询重渲染不会把用户填的东西冲掉）
    const BILI_AUTO = {
      preset: 'safe',
      perDay: 6,
      commentPerRound: 3,
      roundIntervalMinutes: 30,
      scanPerRound: 30,
      scheduleMode: 'window',
      activeStart: '09:00',
      activeEnd: '23:00',
      noon: true,
      night: false,
      applyInteractions: false,   // 默认不碰「安全防护」页的互动开关
      synced: false,              // 是否已经把已保存配置灌进草稿（只灌一次）
    }

    /* ────────────── 主组件 ────────────── */
    function Console() {
      const [state, setState] = React.useState(null)
      // 窄栏自适应：DSH 设置栏比窗口窄，@media 查的是视口，所以自己量容器宽度
      const [narrow, setNarrow] = React.useState(false)
      const rootRef = React.useRef(null)
      const [rawlog, setRawlog] = React.useState([])
      const [report, setReport] = React.useState(null)
      const [page, setPage] = React.useState('overview')
      const [search, setSearch] = React.useState('')
      const [logLv, setLogLv] = React.useState('ALL')
      const [autoScroll, setAutoScroll] = React.useState(true)
      const [toast, setToast] = React.useState('')
      const [fails, setFails] = React.useState(0)
      // 登录弹窗
      const [login, setLogin] = React.useState({ open: false, qr: '', hint: '正在生成二维码…', status: '', url: '' })
      const loginOpenRef = React.useRef(false)
      const loginTimer = React.useRef(null)
      const alive = React.useRef(true)
      // 自定义模型的输入草稿（必须放在 Console 顶层！放进页面渲染函数里会改变 hook 数量，
      // 一点「发布」页就整页白屏——2026-11-1 用户手机实测踩到，血的教训）
      const videoCustDraft = React.useRef({})
      // 降级链本地草稿（拖序）
      const [chainDraft, setChainDraft] = React.useState(null)
      // DSH 预设里「展开更多模型」的 provider（262 个模型那种，默认只显示前 18 个）
      const [provOpen, setProvOpen] = React.useState({})
      // 总览里的日报默认收起，点一下才展开（不然一屏全是字）
      const [repOpen, setRepOpen] = React.useState(false)
      // 人设草稿
      const [persona, setPersona] = React.useState(null)
      // 设置页草稿
      const [kws, setKws] = React.useState(null)
      const [dirty, setDirty] = React.useState({})
      const [models, setModels] = React.useState(null)
      const [pauseBak, setPauseBak] = React.useState(null)
      // 当前登录账号（昵称/头像，来自 /me）
      const [me, setMe] = React.useState(null)
      // 表单草稿（提到顶层：保证 hook 数量恒定，切页不会触发 React 报错）
      const [mProv, setMProv] = React.useState('deepseek')
      const [mName, setMName] = React.useState('')
      const [mUrl, setMUrl] = React.useState(PROV_URLS.deepseek)
      const [mModel, setMModel] = React.useState('')
      const [mKeySrc, setMKeySrc] = React.useState('custom')
      const [mKey, setMKey] = React.useState('')
      const [mChain, setMChain] = React.useState(true)
      const [vUrl, setVUrl] = React.useState('')
      const [vModel, setVModel] = React.useState('')
      const [vKey, setVKey] = React.useState('')
      // 识图模型：用户一动过就不再被 2 秒轮询覆盖（visionTouched）；visionDirty 只用来提示"还没保存"
      const [visionTouched, setVisionTouched] = React.useState(false)
      const [visionDirty, setVisionDirty] = React.useState(false)
      // 环境自检结果 / 进行中
      const [envDiag, setEnvDiag] = React.useState(null)
      const [envBusy, setEnvBusy] = React.useState(false)
      const [asrCheck, setAsrCheck] = React.useState(null)
      const [dshTesting, setDshTesting] = React.useState(false)
      const [commentsList, setCommentsList] = React.useState(null)
      const [commentsBusy, setCommentsBusy] = React.useState(0)
      const [confirmRpid, setConfirmRpid] = React.useState(0)
      const [asrChecking, setAsrChecking] = React.useState(false)
      const [newKw, setNewKw] = React.useState('')
      // 设置页纯文本/数字输入：用本地草稿，避免被 2 秒轮询的 state 覆盖（与 keyword/persona 同策略）
      const [mentionDraft, setMentionDraft] = React.useState(null)
      const [dmUidDraft, setDmUidDraft] = React.useState(null)
      const [favDraft, setFavDraft] = React.useState(null)
      // 网页版控制台地址面板（手机端 window.prompt 不可靠，改用页面内可见面板）
      const [webUrl, setWebUrl] = React.useState('')
      const [webOpen, setWebOpen] = React.useState(false)
      // 版本自检：upRes=最近一次手动检查的结果；upMode/upCustom=加速源草稿（同样要躲开轮询覆盖）
      const [upBusy, setUpBusy] = React.useState(false)
      const [upRes, setUpRes] = React.useState(null)
      const [upMode, setUpMode] = React.useState(null)
      const [upCustom, setUpCustom] = React.useState(null)
      /* 排障技术细节默认收起（放 Console 顶层：页面每 2 秒重渲染，hook 数量不能变） */
      const [dshDetail, setDshDetail] = React.useState(false)

      React.useEffect(() => () => {
        alive.current = false
        if (loginTimer.current) clearInterval(loginTimer.current)
      }, [])

      // 量真实可用宽度：DSH 设置栏可能比窗口窄很多，不能靠 @media
      React.useEffect(() => {
        const el = rootRef.current
        const measure = (w) => setNarrow(w < 880)
        if (el) {
          const r = el.getBoundingClientRect()
          if (r.width) measure(r.width)
          if (typeof ResizeObserver === 'function') {
            const ro = new ResizeObserver((es) => { for (const e of es) measure(e.contentRect.width) })
            ro.observe(el)
            return () => ro.disconnect()
          }
        }
        const onResize = () => { const e = rootRef.current; if (e) measure(e.getBoundingClientRect().width) }
        window.addEventListener('resize', onResize)
        return () => window.removeEventListener('resize', onResize)
      }, [])

      const toast_ = (m) => { setToast(m); if (m) setTimeout(() => setToast(''), 2400) }

      // 主轮询：电脑 2s / 手机自适应（空闲 12s、任务跑着 3s）
      React.useEffect(() => {
        // 手机省电三件套（2026-11-4 加，电脑版行为一个字节不改）：
        //   ① 空闲时 12 秒才拉一次（原来是 6 秒，电脑是 2 秒）
        //   ② 内容没变化就**不 setState** —— 省掉一次整页 React 重渲染，这是手机上最吃 CPU 的一块
        //   ③ 页面在后台（锁屏/切 App）一次请求都不发
        const lowPower = !!(state?.settings?.lowPower)
        const uaMobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '')
        const mobile = uaMobile || lowPower
        const aliveNow = () => alive.current && !stopped
        let stopped = false
        let t1 = null, t2 = null, t3 = null
        let sig = ''
        const visible = () => !(typeof document !== 'undefined' && document.hidden)
        const tick = async () => {
          if (!visible()) return
          BILI_SAVED.polls++
          try {
            const s = await jget('/state')
            if (!aliveNow()) return
            if (!s || !s.ok) { setFails((n) => n + 1); return }
            setFails(0)
            BILI_BUSY.value = Boolean((s.run && s.run.running) || (s.video && s.video.running))
            if (mobile) {
              // 去掉每秒都在变的"最近更新"时间戳，再整体比对；一模一样就跳过这次渲染
              const copy = { ...s }
              delete copy.now
              let next = ''
              try { next = JSON.stringify(copy) } catch { next = '' }
              if (next && next === sig) { BILI_SAVED.skips++; return }
              sig = next
            }
            setState(s)
          } catch { if (aliveNow()) setFails((n) => n + 1) }
        }
        const loop = async () => {
          if (stopped) return
          await tick()
          if (stopped) return
          const gap = mobile ? (BILI_BUSY.value ? 3000 : 12000) : 2000
          t1 = setTimeout(loop, gap)
        }
        const tickLog = async () => {
          if (!visible()) return
          try { const l = await jget('/rawlog'); if (aliveNow()) setRawlog((l && l.lines) || []) } catch {}
        }
        const tickRep = async () => {
          if (!visible()) return
          try { const r = await jget('/report'); if (aliveNow()) setReport(r) } catch {}
        }
        loop(); tickLog(); tickRep()
        t2 = setInterval(tickLog, mobile ? 12000 : 3000)
        t3 = setInterval(tickRep, mobile ? 25000 : 5000)
        // 切回前台立刻补一次，不用等下一拍
        const onVis = () => { if (!document.hidden) { tick(); tickLog(); tickRep() } }
        try { document.addEventListener('visibilitychange', onVis) } catch {}
        return () => {
          stopped = true
          try { clearTimeout(t1) } catch {}
          try { clearInterval(t2) } catch {}
          try { clearInterval(t3) } catch {}
          try { document.removeEventListener('visibilitychange', onVis) } catch {}
        }
      }, [!!(state?.settings?.lowPower)])

      /**
       * 从手机相册/文件里选素材，直接把文件内容传给插件。
       * 为什么这么做：proot 里的目录和安卓文件管理器是两套世界，让用户"把文件放进某个路径"根本行不通；
       * 直接用系统的文件选择器拿到文件本体，就绕开了路径问题（2026-11-1）。
       */
      const pickAndUploadAssets = async () => {
        try {
          const inp = document.createElement('input')
          inp.type = 'file'
          inp.multiple = true
          inp.accept = 'image/*,audio/*'
          inp.style.display = 'none'
          document.body.appendChild(inp)
          const chosen = await new Promise((resolve) => {
            inp.onchange = () => resolve(Array.from(inp.files || []))
            inp.oncancel = () => resolve([])
            inp.click()
          })
          try { inp.remove() } catch { /* noop */ }
          if (!chosen.length) return
          toast_('正在上传 ' + chosen.length + ' 个…')
          const files = []
          const MIME_EXT = {
            'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
            'audio/mpeg': '.mp3', 'audio/mp3': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav',
            'audio/mp4': '.m4a', 'audio/x-m4a': '.m4a', 'audio/aac': '.aac', 'audio/ogg': '.ogg',
          }
          for (const f of chosen.slice(0, 20)) {
            const data = await new Promise((resolve) => {
              const fr = new FileReader()
              fr.onload = () => resolve(String(fr.result || ''))
              fr.onerror = () => resolve('')
              fr.readAsDataURL(f)
            })
            if (!data) continue
            // 安卓相册/文件选择器经常只给 MIME 不给扩展名（name 可能是一串数字），
            // 这里补上扩展名，否则后端会当成"类型不支持"直接丢掉（2026-11-06 修）
            const nm = String(f.name || ('素材' + files.length))
            const hasExt = /\.[a-z0-9]+$/i.test(nm)
            files.push({ name: hasExt ? nm : (nm + (MIME_EXT[f.type] || '')), data })
          }
          if (!files.length) return toast_('读不出文件内容')
          const r = await jpost('/assets/upload', { files })
          if (!r || !r.ok) return toast_('上传失败：' + ((r && r.error) || '未知原因'))
          const n = (r.saved || []).length
          const sk = r.skipped || []
          toast_('已加进素材库 ' + n + ' 个' + (sk.length ? ('；没成功 ' + sk.length + ' 个：' + String(sk[0]).slice(0, 40)) : ''))
          renderAssetsInto(r.items || [])
        } catch (e) { toast_('上传失败：' + String(e?.message ?? e)) }
      }
      /** 自动模式的草稿 → 请求体（只含频次/时段；互动开关单独一个勾选） */
      const autoOverrides = () => {
        const o = {
          perDay: Number(BILI_AUTO.perDay) || 8,
          commentPerRound: Number(BILI_AUTO.commentPerRound) || 4,
          roundIntervalMinutes: Number(BILI_AUTO.roundIntervalMinutes) || 20,
          scanPerRound: BILI_AUTO.scanPerRound === '' ? 0 : Number(BILI_AUTO.scanPerRound) || 0,
          scheduleMode: BILI_AUTO.scheduleMode || 'any',
          activeStart: BILI_AUTO.activeStart || '09:00',
          activeEnd: BILI_AUTO.activeEnd || '23:00',
        }
        if (o.scheduleMode === 'valley') { o.noon = !!BILI_AUTO.noon; o.night = !!BILI_AUTO.night }
        return o
      }
      /** 首次进页面：把「已保存的配置」灌进草稿，别让卡片显示成默认档位骗人 */
      const syncAutoFromCfg = () => {
        if (BILI_AUTO.synced) return
        const c = (state && state.settings) || null
        if (!c || c.perDay == null) return      // 设置还没回来，等下一次
        BILI_AUTO.synced = true
        // 已存配置不一定正好等于某个档位，标成「自定义」最诚实
        BILI_AUTO.preset = 'custom'
        BILI_AUTO.perDay = Number(c.perDay) || 8
        BILI_AUTO.commentPerRound = Number(c.commentPerRound) || 4
        BILI_AUTO.roundIntervalMinutes = Number(c.roundIntervalMinutes) || 5
        BILI_AUTO.scanPerRound = Number(c.scanPerRound) || 0
        BILI_AUTO.scheduleMode = c.scheduleMode || (c.peakValley ? 'valley' : 'any')
        BILI_AUTO.activeStart = c.activeStart || '09:00'
        BILI_AUTO.activeEnd = c.activeEnd || '23:00'
        BILI_AUTO.noon = c.noon !== false
        BILI_AUTO.night = c.night !== false
      }
      /** 把一次 /automode/plan 的结果画到卡片上：估算 + 「安全防护」冲突提示 */
      const paintPlan = (r) => {
        if (!r || !r.ok) return
        const e = r.estimate || {}
        const box = document.querySelector('[data-bd-autoplan]')
        if (box) {
          box.innerHTML = '一天约 <b>' + (e.rounds || 0) + ' 轮</b>、共 <b>' + (e.comments || 0) + ' 条</b>；'
            + '每轮最多看 ' + (e.scanPerRound ? (e.scanPerRound + ' 条视频') : '默认量') + '（一天约 ' + (e.videosPerDay || 0) + ' 条）；'
            + '间隔 ≥ ' + (e.effGapMinutes || 0) + ' 分钟；时段覆盖 ' + (e.windowHours || 0) + ' 小时'
        }
        // 风险提醒（不阻止，只是把后果讲清楚）
        const wf = document.querySelector('[data-bd-autowarn]')
        if (wf) {
          const ws = r.warnings || []
          const adj = r.adjustments || []
          const lines = []
          for (const x of adj) lines.push('ℹ️ ' + x)
          for (const x of ws) lines.push('⚠️ ' + x)
          wf.innerHTML = lines.join('<br>')
          wf.style.color = ws.length ? 'var(--amber, #d9a03f)' : 'var(--t3)'
        }
        const cf = document.querySelector('[data-bd-autoconf]')
        if (!cf) return
        const list = r.interactions || []
        if (!list.length) { cf.innerHTML = ''; return }
        const zh = { off: '关', only: '只发私信', both: '评论+私信' }
        const fmt = (k, v) => (k === 'dmMode' ? (zh[v] || v || '关') : (v ? '开' : '关'))
        const nowTxt = list.map((x) => x.label + '=' + fmt(x.key, x.current)).join('、')
        const sugTxt = list.map((x) => x.label + '=' + fmt(x.key, x.next)).join('、')
        if (BILI_AUTO.applyInteractions) {
          const df = list.filter((x) => !x.same).map((x) => x.label + ' ' + fmt(x.key, x.current) + '→' + fmt(x.key, x.next))
          cf.innerHTML = '⚠️ <b>会覆盖「安全防护」页</b>：' + (df.length ? df.join('；') : '无需改动（已经和这个档位一致）')
          cf.style.color = 'var(--red, #e35d6a)'
        } else {
          cf.innerHTML = '🛡 这几个开关归「安全防护」页管，自动模式<b>不会动</b>：' + nowTxt
            + (sugTxt ? '<br>这个档位的建议值：' + sugTxt + '（想一次设好，勾下面的框）' : '')
          cf.style.color = 'var(--t3)'
        }
      }
      const planAuto = async () => {
        try {
          const r = await jpost('/automode/plan', { preset: BILI_AUTO.preset, overrides: autoOverrides(), applyInteractions: BILI_AUTO.applyInteractions === true })
          paintPlan(r)
        } catch { /* 估算失败不影响用 */ }
      }
      /** 点档位：把预设值灌进草稿（这样输入框能立刻看见档位到底设了什么） */
      const pickPreset = async (k) => {
        BILI_AUTO.preset = k
        try {
          const r = await jpost('/automode/plan', { preset: k, overrides: {}, applyInteractions: BILI_AUTO.applyInteractions === true })
          if (r && r.ok && r.values) {
            const v = r.values
            BILI_AUTO.perDay = v.perDay
            BILI_AUTO.commentPerRound = v.commentPerRound
            BILI_AUTO.roundIntervalMinutes = v.roundIntervalMinutes
            BILI_AUTO.scanPerRound = v.scanPerRound
            BILI_AUTO.scheduleMode = v.scheduleMode
            BILI_AUTO.activeStart = v.activeStart
            BILI_AUTO.activeEnd = v.activeEnd
            if (v.scheduleMode === 'valley') { BILI_AUTO.noon = v.noon !== false; BILI_AUTO.night = v.night !== false }
          }
          paintPlan(r)
        } catch { /* 忽略 */ }
        setState((x) => (x ? { ...x } : x))
      }
      /** 草稿里一个小数字输入（改完立刻重算估算） */
      const autoNum = (key, label, min, width) => h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('span', { style: { fontSize: '12px' } }, label),
        h('input', {
          type: 'number', value: BILI_AUTO[key], min,
          style: { width: width || '72px', height: '32px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)', padding: '0 8px' },
          onChange: (e) => { BILI_AUTO[key] = e.target.value === '' ? '' : Number(e.target.value); planAuto() },
        }))
      const applyAuto = async () => {
        try {
          const inter = BILI_AUTO.applyInteractions === true
          if (!window.confirm('应用自动模式？\n\n会改：每天上限 / 每轮条数 / 每轮间隔 / 每轮看多少条 / 运行时段 / 定时值守。'
            + (inter ? '\n\n⚠️ 还会覆盖「安全防护」页的：自动评论 / 点赞 / 回评论 / 私信。' : '\n\n「安全防护」页的互动开关不会动。'))) return
          const r = await jpost('/automode/apply', { preset: BILI_AUTO.preset, overrides: autoOverrides(), applyInteractions: inter })
          if (!r || !r.ok) return toast_('应用失败：' + ((r && r.error) || ''))
          const notes = (r.notes || []).join('；')
          toast_('已应用：' + (r.summary || '') + (notes ? ('｜' + notes) : ''))
          planAuto()
        } catch (e) { toast_('应用失败：' + String(e?.message ?? e)) }
      }
      /** 撤回单条评论（精确按 bvid+rpid 删） */
      const retractOneComment = async (it) => {
        try {
          if (!window.confirm('撤回这条评论？\n「' + String(it.text || '').slice(0, 40) + '」')) return
          const r = await jpost('/posted/retract', { bvid: it.bvid, rpid: it.rpid })
          if (!r || !r.ok) return toast_('撤回失败：' + ((r && r.error) || (r && r.message) || '未知'))
          toast_('已撤回')
          loadPosted()
        } catch (e) { toast_('撤回失败：' + String(e?.message ?? e)) }
      }
      /** 我发过的动态/投稿 + 撤回 */
      const loadPublished = async () => {
        try {
          const box = document.querySelector('[data-bd-published]')
          if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">读取中…</div>'
          const r = await jget('/published')
          if (!box) return
          const items = (r && r.items) || []
          if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--t3)">还没有记录（发过动态或投稿后会出现在这里）</div>'; return }
          box.innerHTML = ''
          for (const it of items) {
            const row = document.createElement('div')
            row.style.cssText = 'padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--surface)'
            const t = document.createElement('div')
            t.style.cssText = 'font-size:12px;line-height:1.6'
            t.textContent = (it.kind === 'video' ? '🎬 投稿：' : '📝 动态：') + String(it.text || '').slice(0, 50)
            const meta = document.createElement('div')
            meta.style.cssText = 'font-size:11px;color:var(--t3);margin-top:3px'
            meta.textContent = new Date(it.at).toLocaleString('zh-CN', { hour12: false }) + (it.bvid ? (' · ' + it.bvid) : '') + (it.id ? (' · id ' + it.id) : '')
            const bar = document.createElement('div')
            bar.style.cssText = 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap'
            const b = document.createElement('button')
            b.className = 'ghost sm'; b.textContent = '↩ 撤回'
            b.style.color = 'var(--red, #e35d6a)'
            b.onclick = async () => {
              if (!window.confirm('确定撤回？这条会从 B站 上删掉，删了没法恢复。')) return
              const rr = await jpost('/published/retract', { kind: it.kind, id: it.id || it.bvid, aid: it.aid, bvid: it.bvid })
              if (rr && rr.ok) { toast_('已撤回'); loadPublished() }
              else toast_('撤回失败：' + ((rr && (rr.message || rr.error)) || 'B站 接口可能改版了'))
            }
            bar.appendChild(b)
            row.appendChild(t); row.appendChild(meta); row.appendChild(bar)
            box.appendChild(row)
          }
        } catch { /* 读不到就算了 */ }
      }
      /** 我发过的评论：带直达链接，点开就滚到那条评论 */
      const loadPosted = async () => {
        try {
          const box = document.querySelector('[data-bd-posted]')
          if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">读取中…</div>'
          const r = await jget('/posted?limit=20')
          if (!box) return
          const items = (r && r.items) || []
          if (!items.length) { box.innerHTML = '<div style="font-size:12px;color:var(--t3)">还没发过评论。</div>'; return }
          box.innerHTML = ''
          for (const it of items) {
            const row = document.createElement('div')
            row.style.cssText = 'padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--surface)'
            const t = document.createElement('div')
            t.style.cssText = 'font-size:12px;color:var(--t1);line-height:1.6'
            t.textContent = (it.text || '').slice(0, 60)
            const meta = document.createElement('div')
            meta.style.cssText = 'font-size:11px;color:var(--t3);margin-top:3px'
            meta.textContent = (it.at || '') + ' · ' + (it.title || it.bvid || '')
            const bar = document.createElement('div')
            bar.style.cssText = 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap'
            const rb = document.createElement('button')
            rb.className = 'ghost sm'; rb.textContent = '↩ 撤回'
            rb.style.color = 'var(--red, #e35d6a)'
            rb.onclick = () => retractOneComment(it)
            bar.appendChild(rb)
            if (it.link) {
              const b = document.createElement('button')
              b.className = 'ghost sm'; b.textContent = '🔎 去看这条评论'
              b.onclick = () => { jpost('/open', { what: 'url', u: it.link }).then((x) => { if (x && x.url) toast_('已打开：' + x.url) }) }
              bar.appendChild(b)
            }
            row.appendChild(t); row.appendChild(meta); row.appendChild(bar)
            box.appendChild(row)
          }
        } catch { /* 读不到就算了 */ }
      }
      /** 一键优化：放内存 + 清临时文件 */
      const runOptimize = async () => {
        try {
          toast_('正在优化…')
          const r = await jpost('/system/optimize', {})
          if (!r || !r.ok) return toast_('优化失败：' + ((r && r.error) || ''))
          const mb = Math.round((r.rssFreed || 0) / 1048576)
          const fm = Math.round((r.filesFreed || 0) / 1048576 * 10) / 10
          toast_('已优化：内存 -' + mb + 'MB，清理 ' + (r.files || 0) + ' 个临时文件（' + fm + 'MB）')
        } catch (e) { toast_('优化失败：' + String(e?.message ?? e)) }
      }
      /** 长任务期间请求屏幕常亮（保活；不支持就安静跳过） */
      let _wake = null
      const keepScreenAwake = async (on) => {
        try {
          if (on && !_wake && navigator.wakeLock && navigator.wakeLock.request) {
            _wake = await navigator.wakeLock.request('screen')
          } else if (!on && _wake) {
            try { await _wake.release() } catch { /* noop */ }
            _wake = null
          }
        } catch { /* 不支持就算了 */ }
      }
      /** AI 助手：说一句话，它输出动作、插件白名单执行（能真的改设置） */
      const renderChat = () => {
        const box = document.querySelector('[data-bd-chat]')
        if (!box) return
        box.innerHTML = ''
        for (const m of BILI_CHAT_LOG) {
          const row = document.createElement('div')
          const mine = m.role === 'me'
          row.style.cssText = 'margin-top:6px;font-size:12.5px;line-height:1.7;padding:8px 10px;border-radius:8px;'
            + (mine ? 'background:var(--blue-bg);color:var(--t1);margin-left:24px' : 'background:var(--surface);border:1px solid var(--line)')
          row.textContent = m.text
          box.appendChild(row)
          if (m.actions && m.actions.length) {
            const tip = document.createElement('div')
            tip.style.cssText = 'font-size:11px;color:var(--t3);margin-top:4px;padding-left:2px'
            tip.textContent = '执行结果：' + m.actions
            box.appendChild(tip)
          }
        }
        box.scrollTop = box.scrollHeight
      }
      const sendChat = async () => {
        try {
          const inp = document.querySelector('[data-bd-chatinput] input, [data-bd-chatinput]')
          const raw = inp && ('value' in inp ? inp.value : inp.textContent) || ''
          const text = String(raw || '').trim()
          if (!text) return
          BILI_CHAT_LOG.push({ role: 'me', text })
          if (inp && 'value' in inp) inp.value = ''
          renderChat()
          BILI_CHAT_LOG.push({ role: 'ai', text: '…' })
          renderChat()
          const r = await jpost('/assistant/chat', { text })
          BILI_CHAT_LOG.pop()
          if (!r || !r.ok) {
            BILI_CHAT_LOG.push({ role: 'ai', text: '出错了：' + ((r && r.error) || '未知') })
          } else {
            const lines = (r.results || []).map((x) => (x.ok ? ('✓ ' + (x.note || x.tool)) : ('✗ ' + (x.error || x.tool))))
            BILI_CHAT_LOG.push({ role: 'ai', text: r.say, actions: lines.join('；') })
          }
          renderChat()
        } catch (e) { toast_('发送失败：' + String(e?.message ?? e)) }
      }
      /** 运行小结：插件自己记的账（不依赖 DSH 会话，2026-11-1） */
      const loadRuns = async () => {
        try {
          const box = document.querySelector('[data-bd-runs]')
          if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">读取中…</div>'
          const r = await jget('/runs?limit=20')
          if (!box) return
          const rows = (r && r.runs) || []
          if (!rows.length) { box.innerHTML = '<div style="font-size:12px;color:var(--t3)">还没有记录。跑一轮之后这里会有一条。</div>'; return }
          const fmt = (t) => { try { const d = new Date(t); return d.getMonth() + 1 + '/' + d.getDate() + ' ' + String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0') } catch { return '—' } }
          box.innerHTML = ''
          for (const it of rows) {
            const div = document.createElement('div')
            div.style.cssText = 'padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--surface)'
            const head = document.createElement('div')
            head.style.cssText = 'font-size:12px;color:var(--t2);display:flex;gap:8px;flex-wrap:wrap;align-items:center'
            const tag = it.dryRun ? '试跑' : (it.posted > 0 ? ('发 ' + it.posted + ' 条') : '没发')
            head.innerHTML = '<b style="color:var(--t1)">' + fmt(it.at) + '</b><span>' + tag + '</span><span>挑中 ' + (it.picked || 0) + '</span>'
              + (it.why ? ('<span style="color:var(--t3)">' + String(it.why).slice(0, 40) + '</span>') : '')
            div.appendChild(head)
            if (it.items && it.items.length) {
              const ul = document.createElement('div')
              ul.style.cssText = 'font-size:11.5px;color:var(--t3);margin-top:4px;line-height:1.7'
              ul.textContent = it.items.slice(0, 4).map((x) => '· ' + (x.title || x.bvid).slice(0, 22)).join('  ')
              div.appendChild(ul)
            }
            box.appendChild(div)
          }
        } catch { /* 读不到就算了 */ }
      }
      const clearRuns = async () => {
        try {
          if (!window.confirm('清空所有运行记录？（只删这份记录，不影响配置和已发评论）')) return
          const r = await jpost('/runs/clear', {})
          if (!r || !r.ok) return toast_('清空失败')
          toast_('已清空')
          loadRuns()
        } catch (e) { toast_('清空失败：' + String(e?.message ?? e)) }
      }
      const renderAssetsInto = (items) => {
        const box = document.querySelector('[data-bd-assets]')
        if (!box) return
        box.textContent = ''
        if (!items || !items.length) {
          box.textContent = '（还没有素材。点「打开素材文件夹」，把图片/音频丢进去，再点「刷新列表」）'
          return
        }
        for (const it of items) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;gap:8px;align-items:center;margin-top:6px'
          const name = document.createElement('span')
          name.textContent = it.file + (it.kind === 'video' ? '（视频只归档，不剪进去）' : '')
          name.style.cssText = 'font-size:12px;color:var(--t2);min-width:110px;max-width:150px;flex:none;overflow:hidden;text-overflow:ellipsis;white-space:nowrap'
          const inp = document.createElement('input')
          inp.value = it.note || ''
          inp.placeholder = it.hint ? ('可直接用文件名：' + it.hint + '（改了更好）') : '这个素材什么时候用？（AI 靠它判断）'
          inp.dataset.file = it.file
          inp.dataset.hint = it.hint || ''
          inp.style.cssText = 'flex:1;min-width:100px;height:28px;padding:0 8px;border:1px solid var(--line);border-radius:6px;background:var(--surface);color:var(--t1);font-size:12px'
          row.appendChild(name)
          row.appendChild(inp)
          box.appendChild(row)
        }
        const bar = document.createElement('div')
        bar.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap'
        const fillAll = document.createElement('button')
        fillAll.textContent = '⚡ 空的全按文件名填'
        fillAll.setAttribute('data-bd-btn', '')
        fillAll.className = 'ghost sm'
        fillAll.title = '只填空着的，已经写过的不动'
        fillAll.onclick = () => {
          [...box.querySelectorAll('input[data-file]')].forEach((el) => {
            if (!el.value.trim() && el.dataset.hint) el.value = el.dataset.hint
          })
          toast_('已按文件名填好，检查一下再点保存')
        }
        bar.appendChild(fillAll)
        box.appendChild(bar)
        const save = document.createElement('button')
        save.textContent = '保存备注'
        save.setAttribute('data-bd-btn', '')
        save.className = 'primary sm'
        save.style.marginTop = '8px'
        save.onclick = async () => {
          const items2 = [...box.querySelectorAll('input[data-file]')].map((el) => ({ file: el.dataset.file, note: el.value }))
          try {
            const r = await jpost('/assets', { items: items2 })
            if (r && r.ok) { toast_('备注已保存'); renderAssetsInto(r.items || []) } else toast_('保存失败')
          } catch (e) { toast_('保存失败：' + String(e?.message ?? e)) }
        }
        box.appendChild(save)
      }
      const loadAssets = async () => {
        try { const r = await jget('/assets'); renderAssetsInto((r && r.items) || []) } catch { toast_('读素材列表失败') }
      }

      /** 纯音乐本地识别：靠快慢/明暗给 BGM 打标签（不需要任何 AI 模型） */
      const analyzeAudioAssets = async () => {
        try {
          toast_('正在本地分析音频，几秒钟就好…')
          const r = await jpost('/assets/analyze-audio', {})
          if (!r || !r.ok) return toast_('失败：' + ((r && r.error) || ''))
          toast_('写好了 ' + (r.updated || 0) + ' 条音乐备注' + (r.warn ? ('。' + r.warn) : ''))
          renderAssetsInto(r.items || [])
        } catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      /** 测一下识图模型能不能真看图（素材库里的 AI 写备注要用它） */
      const testVision = async () => {
        try {
          toast_('正在让识图模型看一眼测试图…')
          const r = await jpost('/vision/test', {})
          if (!r || !r.ok) return toast_('✗ ' + ((r && r.error) || '连不上'))
          toast_('✓ 能看图，模型回：' + (r.reply || ''))
          loadAssets()
        } catch (e) { toast_('✗ ' + String(e?.message ?? e)) }
      }
      /** 换版式后立刻渲染一张预览图（走真实渲染器，所见即所得） */
      const showLayoutPreview = (style) => {
        try {
          const box = document.querySelector('[data-bd-layoutpv]')
          if (!box) return
          const st = style == null ? ((state && state.settings && state.settings.videoLayout) || 'auto') : style
          box.innerHTML = '<div style="font-size:12px;color:var(--t3)">正在渲染预览…</div>'
          const img = document.createElement('img')
          img.src = API + '/video/preview?style=' + encodeURIComponent(st) + '&t=' + Date.now()
          img.style.cssText = 'width:100%;max-width:520px;border-radius:10px;border:1px solid var(--line);margin-top:6px'
          img.onload = () => { box.innerHTML = ''; box.appendChild(img) }
          img.onerror = () => { box.innerHTML = '<div style="font-size:12px;color:var(--t3)">预览渲染失败了（可能渲染组件还没装好）</div>' }
        } catch { /* 忽略 */ }
      }
      /** 让 AI 看图给素材写备注（懒得打字就用这个） */
      const autoNoteAssets = async () => {
        try {
          toast_('AI 正在看图写备注，稍微等一下…')
          const r = await jpost('/assets/auto-note', {})
          if (!r || !r.ok) return toast_('失败：' + ((r && r.error) || ''))
          toast_('写好了 ' + (r.updated || 0) + ' 条备注')
          renderAssetsInto(r.items || [])
        } catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      /** 把素材库导出到手机可见目录（proot 路径用户在文件管理器里看不到） */
      const exportAssets = async () => {
        try {
          const r = await jpost('/export', { what: 'assets' })
          if (!r || !r.ok) return toast_('导出失败：' + ((r && r.error) || ''))
          toast_('已导出 ' + (r.copied || 0) + ' 个到：' + r.dest)
        } catch (e) { toast_('导出失败：' + String(e?.message ?? e)) }
      }
      /** 从手机目录把文件导进素材库 */
      const importAssets = async () => {
        try {
          const r = await jpost('/import-assets', {})
          if (!r || !r.ok) return toast_('导入失败：' + ((r && r.error) || ''))
          toast_(r.copied ? ('已从手机导入 ' + r.copied + ' 个素材') : '手机目录里没找到图片/音频（先从文件管理器放进 dsh-bili-console 文件夹）')
          try { loadAssets() } catch { /* 列表稍后刷新 */ }
        } catch (e) { toast_('导入失败：' + String(e?.message ?? e)) }
      }
      /** 测一下文生视频（CogVideoX，排队较久），成功后直接在卡片里播放 */
      const testCogVideo = async () => {
        try {
          const box = document.querySelector('[data-bd-vidpv]')
          if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">已提交，排队中…免费额度可能要等 1~5 分钟，别锁屏</div>'
          toast_('已提交生成，等 1~5 分钟…')
          const r = await jpost('/video/test-cogvideo', {})
          if (!r || !r.ok) {
            if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">没生成出来：' + ((r && r.error) || '') + '</div>'
            return toast_('✗ ' + ((r && r.error) || '失败'))
          }
          toast_('✓ 生成了（' + Math.round((r.size || 0) / 1024) + 'KB）')
          if (box) {
            box.innerHTML = ''
            const v = document.createElement('video')
            v.controls = true; v.playsInline = true; v.preload = 'metadata'
            v.style.cssText = 'width:100%;max-width:420px;border-radius:10px;border:1px solid var(--line);background:#000;display:block'
            v.src = API + '/publish/video-file?n=' + encodeURIComponent(r.name)
            const tip = document.createElement('div')
            tip.style.cssText = 'font-size:11.5px;color:var(--t3);margin-top:6px'
            tip.textContent = '这就是开场片段的样子（每次不同）。生成视频时会拼在正片最前面。'
            box.appendChild(v); box.appendChild(tip)
          }
        } catch (e) { toast_('✗ ' + String(e?.message ?? e)) }
      }
      /** 测一下文生图接口（智谱 CogView-3-Flash 免费，先验通了再开） */
      const testImageGen = async () => {
        try {
          const box = document.querySelector('[data-bd-imgpv]')
          if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">正在生成…（几秒~十几秒）</div>'
          toast_('正在试生成一张图，可能要十几秒…')
          const r = await jpost('/video/test-image', {})
          if (!r || !r.ok) {
            if (box) box.innerHTML = '<div style="font-size:12px;color:var(--t3)">生成失败：' + ((r && r.error) || '') + '</div>'
            return toast_('✗ ' + ((r && r.error) || '失败'))
          }
          toast_('✓ 能生图（' + (r.model || '') + '，' + Math.round((r.size || 0) / 1024) + 'KB）')
          if (box) {
            box.innerHTML = ''
            if (r.dataUrl) {
              const img = document.createElement('img')
              img.src = r.dataUrl
              img.style.cssText = 'width:100%;max-width:420px;border-radius:10px;border:1px solid var(--line);display:block'
              const tip = document.createElement('div')
              tip.style.cssText = 'font-size:11.5px;color:var(--t3);margin-top:6px'
              tip.textContent = '这就是卡片背景会长成的样子（每次不同）。生成视频时每张卡片会各画一张。'
              box.appendChild(img); box.appendChild(tip)
            } else {
              box.innerHTML = '<div style="font-size:12px;color:var(--t3)">接口通了，但没拿到图片数据</div>'
            }
          }
        } catch (e) { toast_('✗ ' + String(e?.message ?? e)) }
      }
      /** 把已生成的视频直接投稿到 B 站（不用再填路径） */
      const publishVideoByName = async (name) => {
        try {
          const title0 = name.replace(/\.mp4$/i, '').replace(/^video-/, '')
          const title = window.prompt('投稿标题（改好再确认）：', 'AI 简报 ' + title0)
          if (title == null) return
          if (!String(title).trim()) return toast_('标题不能空')
          toast_('正在上传投稿，视频大可能要几分钟…')
          const r = await jpost('/publish/video', {
            name,
            title: String(title).trim(),
            desc: '由插件自动生成',
            tags: 'AI,短视频',
          })
          if (!r || !r.ok) return toast_('投稿失败：' + ((r && r.error) || '未知'))
          toast_('已提交投稿，等 B站审核（' + (r.bvid || '') + '）')
        } catch (e) { toast_('投稿失败：' + String(e?.message ?? e)) }
      }
      /** 删掉一个生成的视频（手机存储紧张时用） */
      const deleteVideo = async (name) => {
        try {
          if (!window.confirm('删掉这个视频？' + name + '\n（只删本地文件，已发到 B 站的不受影响）')) return
          const r = await jpost('/video/delete', { name })
          if (!r || !r.ok) return toast_('删除失败：' + ((r && r.error) || ''))
          toast_('已删除，腾出 ' + (Math.round((r.freed || 0) / 1048576 * 10) / 10) + 'MB')
          loadVideoList()
        } catch (e) { toast_('删除失败：' + String(e?.message ?? e)) }
      }
      /** 清空所有生成的视频 */
      const clearVideos = async () => {
        try {
          if (!window.confirm('把所有已生成的视频都删掉？（素材库不受影响）')) return
          const r = await jpost('/video/clear', {})
          if (!r || !r.ok) return toast_('清理失败：' + ((r && r.error) || ''))
          toast_('删了 ' + (r.deleted || 0) + ' 个，腾出 ' + Math.round((r.freed || 0) / 1048576) + 'MB')
          loadVideoList()
        } catch (e) { toast_('清理失败：' + String(e?.message ?? e)) }
      }
      /** 把某个视频导出到手机（并尝试用系统播放器打开） */
      const exportVideo = async (name) => {
        try {
          const r = await jpost('/export', { what: 'video', name })
          if (!r || !r.ok) return toast_('导出失败：' + ((r && r.error) || ''))
          toast_('已导出到：' + r.dest + (r.opened ? '（已用系统播放器打开）' : ''))
        } catch (e) { toast_('导出失败：' + String(e?.message ?? e)) }
      }
      /** 给某个模型单独设思考强度（'' 表示跟全局） */
      const setChainStrength = async (epId, lv) => {
        try {
          const cur = { ...((state && state.settings && state.settings.chainStrength) || {}) }
          if (lv) cur[epId] = lv
          else delete cur[epId]
          const r = await jpost('/settings', { chainStrength: cur })
          if (!r || !r.ok) return toast_('保存思考强度失败：' + ((r && r.error) || ''))
          toast_(lv ? ('已设为「' + lv + '」') : '已改回跟随全局')
        } catch (e) { toast_('保存失败：' + String(e?.message ?? e)) }
      }
      /** 内存状况 + 手动释放（运行内存，不是磁盘空间） */
      /** 一键套用音色预设：四个参数一起设好，然后立刻试听 */
      /** 配音试听：拿当前声线/语速/音调/音量念一句，直接播 */
      const doTtsPreview = async () => {
        try {
          const msg = document.querySelector('[data-bd-ttsmsg]')
          const btn = document.querySelector('[data-bd-ttsbtn]')
          if (msg) msg.textContent = '准备中…（没装配音组件的话会自动装一次，约 30MB，只第一次要等）'
          if (btn) btn.disabled = true
          const r = await jpost('/publish/tts-preview', {})
          if (btn) btn.disabled = false
          if (!r || !r.ok) { if (msg) msg.textContent = '试听失败：' + ((r && r.error) || '未知原因'); return }
          const aud = new Audio('data:audio/mpeg;base64,' + r.audio)
          if (msg) msg.textContent = '播放中（' + Math.round((r.size || 0) / 1024) + 'KB）'
          aud.onended = () => { if (msg) msg.textContent = '听完了，不满意就改上面的参数' }
          await aud.play().catch(() => { if (msg) msg.textContent = '浏览器不让自动播放，点一下再试试' })
        } catch (e) { toast_('试听失败：' + String(e?.message ?? e)) }
      }
      const loadMemInfo = async () => {
        try {
          const box = document.querySelector('[data-bd-meminfo]')
          if (!box) return
          const r = await jget('/system/mem')
          const mb = (b) => (Math.round((Number(b) || 0) / 1048576 * 10) / 10) + 'MB'
          const m = r && r.mem
          const p = (r && r.power) || {}
          let html = '宿主进程（DSH + 插件）现在占：' + mb(r && r.rss)
          if (m) {
            html += '<br>手机可用内存：' + mb(m.available) + ' / 共 ' + mb(m.total)
            if (m.swapTotal > 0) html += '<br>系统已在用交换内存：' + mb(m.swapTotal - m.swapFree) + ' / ' + mb(m.swapTotal) + '（不用我们再弄）'
            else html += '<br>当前没有用交换内存（手机上正常，安卓一般用 zram 压缩代替）'
          } else {
            html += '<br>电脑：只显示进程占用'
          }
          // 手机省电成绩单：让用户看得见"确实少跑了多少"
          try {
            const mobile = /android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '')
            if (mobile) {
              html += '<br><span style="color:var(--t3)">手机省电：空闲 12 秒刷新一次（电脑 2 秒）'
                + '；已跳过 ' + BILI_SAVED.skips + ' 次无变化重绘、共 ' + BILI_SAVED.polls + ' 次轮询</span>'
            }
          } catch { /* 忽略 */ }
          box.innerHTML = html
        } catch { /* 读不到就算了 */ }
      }
      const doFreeMemory = async () => {
        try {
          const r = await jpost('/system/free-memory', { aggressive: true })
          toast_(r && r.ok ? '已释放（能清的都清了）' : ('释放失败：' + ((r && r.error) || '')))
          loadMemInfo()
        } catch (e) { toast_('释放失败：' + String(e?.message ?? e)) }
      }
      /** 自定义模型的草稿：手机上输入框失去焦点经常不触发，所以先记草稿，点「保存」才落盘 */
      const draftUpd = (k, v) => { videoCustDraft.current[k] = String(v || '').trim() }
      const setCMsg = (t) => { const el = document.querySelector('[data-bd-cmsg]'); if (el) el.textContent = t }
      const saveCustomModel = async () => {
        try {
          const d = videoCustDraft.current
          if (!Object.keys(d).length) return setCMsg('你还没改任何东西')
          setCMsg('保存中…')
          const r = await jpost('/settings', d)
          if (!r || !r.ok) return setCMsg('保存失败：' + ((r && r.error) || ''))
          videoCustDraft.current = {}
          setCMsg('✓ 已保存（' + Object.keys(d).length + ' 项）')
          toast_('自定义模型已保存')
        } catch (e) { setCMsg('保存失败：' + String(e?.message ?? e)) }
      }
      /** 测一下这个自定义模型能不能真跑：让模型写一张卡片试试 */
      const testCustomModel = async () => {
        try {
          setCMsg('正在连接…')
          const d = videoCustDraft.current
          const patch = {}
          for (const k of ['videoCustomBaseUrl', 'videoCustomModel', 'videoCustomKey', 'videoCustomName']) if (d[k] !== undefined) patch[k] = d[k]
          if (Object.keys(patch).length) await jpost('/settings', patch)
          const r = await jpost('/publish/test-model', {})
          if (!r || !r.ok) return setCMsg('✗ ' + ((r && r.error) || '连不上'))
          setCMsg('✓ 连上了：' + String((r && r.reply) || '').slice(0, 40))
        } catch (e) { setCMsg('✗ ' + String(e?.message ?? e)) }
      }
      /** 直接在插件页面里看生成的视频（不用等 B 站） */
      const loadVideoList = async () => {
        try {
          const r = await jget('/publish/video-list')
          const box = document.querySelector('[data-bd-vidlist]')
          if (!box) return
          const files = (r && r.files) || []
          if (!files.length) { box.innerHTML = ''; return }
          box.innerHTML = ''
          for (const f of files) {
            const wrap = document.createElement('div')
            wrap.style.cssText = 'margin:10px 0;padding:8px;border:1px solid var(--line);border-radius:8px;background:var(--gray-bg)'
            const title = document.createElement('div')
            title.style.cssText = 'font-size:12px;color:var(--t2);margin-bottom:6px;word-break:break-all'
            title.textContent = f.name + '（' + Math.round((f.size || 0) / 1024) + 'KB）'
              const v = document.createElement('video')
              v.controls = true; v.playsInline = true; v.preload = 'metadata'
              v.style.cssText = 'width:100%;max-height:240px;border-radius:6px;background:#000'
              v.src = API + '/publish/video-file?n=' + encodeURIComponent(f.name)
              const bar = document.createElement('div')
              bar.style.cssText = 'display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;align-items:center'
              const exp = document.createElement('button')
              exp.className = 'ghost sm'
              exp.textContent = '📤 导出到手机并播放'
              exp.onclick = () => exportVideo(f.name)
              bar.appendChild(exp)
              const pub = document.createElement('button')
              pub.className = 'primary sm'
              pub.textContent = '📮 投稿到 B 站'
              pub.onclick = () => publishVideoByName(f.name)
              bar.appendChild(pub)
              const del = document.createElement('button')
              del.className = 'ghost sm'
              del.textContent = '🗑 删除'
              del.style.color = 'var(--red, #e35d6a)'
              del.onclick = () => deleteVideo(f.name)
              bar.appendChild(del)
              wrap.appendChild(title); wrap.appendChild(v); wrap.appendChild(bar)
              box.appendChild(wrap)
          }
        } catch { /* 列表拿不到就算了 */ }
      }
      // 切到「发布」页时，把已生成的视频和内存状况拉一次。
      // ⚠️ 必须放在这个位置：下面有 `if (!st) return` 的提前返回，
      //    hook 放在它后面就会「首次渲染跳过、数据回来才调用」→ hook 数量变化 → 整个面板崩成空白（2026-11-1 血案）
      React.useEffect(() => {
        if (page !== 'publish') return
        try { loadVideoList(); loadMemInfo() } catch { /* 页面还没挂上就算了 */ }
      }, [page])

      const st = state
      const cfg = st?.settings || {}

      // 识图模型草稿：仅在未手动改过时从服务端同步
      // ⚠️ 之前漏了「用户改过」这个标记，导致刚打几个字就被 2 秒轮询重置回空值（2026-10-31 修）
      React.useEffect(() => {
        if (st && !visionTouched) { const v = cfg.visionModel || {}; setVUrl(v.apiUrl || ''); setVModel(v.modelName || ''); setVKey(v.apiKey || '') }
      }, [st, visionTouched])

      // 人设草稿：仅在未手动改过时从服务端同步
      React.useEffect(() => {
        if (st && persona === null && !dirty.persona) setPersona(cfg.personaPrompt || '')
      }, [st, persona, dirty.persona])
      // 关键词草稿
      React.useEffect(() => {
        if (st && kws === null && !dirty.keywords) setKws((cfg.keywords || []).join('\n'))
      }, [st, kws, dirty.keywords])
      // 设置页纯文本/数字输入草稿（mentionName / dmUid / favFolderId）：仅在未手动改过时从服务端同步
      React.useEffect(() => {
        if (st && mentionDraft === null && !dirty.mentionName) setMentionDraft(cfg.mentionName || '')
      }, [st, mentionDraft, dirty.mentionName])
      React.useEffect(() => {
        if (st && dmUidDraft === null && !dirty.dmUid) setDmUidDraft(cfg.dmUid != null ? String(cfg.dmUid) : '0')
      }, [st, dmUidDraft, dirty.dmUid])
      React.useEffect(() => {
        if (st && favDraft === null && !dirty.favFolderId) setFavDraft(cfg.favFolderId != null ? String(cfg.favFolderId) : '0')
      }, [st, favDraft, dirty.favFolderId])
      // 降级链草稿
      React.useEffect(() => {
        if (st && chainDraft === null) setChainDraft((st.chain && st.chain.endpoints) || [])
      }, [st, chainDraft])
      // 自定义模型
      React.useEffect(() => { if (st && models === null) setModels(cfg.models || []) }, [st, models])
      // 暂停备份（localStorage，webview 里可能不可用 → try/catch）
      React.useEffect(() => {
        try { const bk = JSON.parse(localStorage.getItem('obs-pause-backup') || 'null'); if (bk) setPauseBak(bk) } catch {}
      }, [])
      // 登录后拉一次账号信息（昵称/头像/UID）；退出登录就清掉
      React.useEffect(() => {
        let stop = false
        const on = Boolean(st && st.login && st.login.loggedIn)
        if (!on) { setMe(null); return }
        if (me) return
        jget('/me').then((r) => { if (!stop && r && r.ok && r.me) setMe(r.me) }).catch(() => {})
        return () => { stop = true }
      }, [st && st.login && st.login.loggedIn, me])

      /* ── 写配置 ── */
      const saveOne = async (key, val, label) => {
        const body = {}; body[key] = val
        try { const r = await jpost('/settings', body); toast_(r.ok ? ((label || key) + ' 已保存') : ('保存失败：' + (r.error || ''))); if (r.ok) { /* state 会在下次轮询刷新 */ } }
        catch (e) { toast_('保存失败：' + String(e?.message ?? e)) }
      }
      const step = (key, d, unit) => {
        const cur = Number((cfg[key] || 0))
        const n = Math.max(0, cur + d)
        saveOne(key, n).then(() => toast_(key + ' → ' + n + (unit || '')))
      }
      const toggleChip = (key, on) => saveOne(key, on)
      const saveChainOrder = async () => {
        try {
          const ids = (chainDraft || []).map((e) => e.id)
          const r = await jpost('/settings', { chainOrder: ids })
          toast_(r.ok ? '顺序已保存（下一轮生效）' : ('失败：' + (r.error || '')))
        } catch (e) { toast_('保存失败：' + String(e?.message ?? e)) }
      }
      /** 直接把一串端点 id 存成新的链顺序（点模型 chip 时用） */
      const saveChainIds = async (ids) => {
        try {
          const r = await jpost('/settings', { chainOrder: ids })
          if (!r.ok) toast_('失败：' + (r.error || ''))
        } catch (e) { toast_('保存失败：' + String(e?.message ?? e)) }
      }
      /** 点一个 DSH 预设模型：在链里就移出，不在就加到链尾 */
      const togglePreset = (g, m) => {
        const id = 'preset:' + g.provider + ':' + m.id
        const cur = (chainDraft || []).slice()
        const at = cur.findIndex((e) => e.id === id)
        let next
        if (at >= 0) next = cur.filter((e) => e.id !== id)
        else next = cur.concat([{ id, label: m.name || m.id, model: m.id, source: 'preset', provider: g.provider }])
        setChainDraft(next)
        saveChainIds(next.map((e) => e.id))
        toast_(at >= 0 ? ('移出降级链：' + (m.name || m.id)) : ('加入降级链：' + (m.name || m.id)))
      }
      /** 批量加模型（一个 key 一次加多个模型名） */
      const addModels = async (list) => {
        if (!list || !list.length) return
        const next = (models || []).concat(list)
        const chainIds = (chainDraft || []).map((e) => e.id)
        for (const m of list) if (m.addToChain && chainIds.indexOf(m.id) < 0) chainIds.push(m.id)
        try {
          const r = await jpost('/settings', { models: next, chainOrder: chainIds })
          if (r.ok) {
            setModels(next)
            const extra = list.filter((m) => m.addToChain).map((m) => ({ id: m.id, label: m.displayName, model: m.modelName, source: 'custom' }))
            if (extra.length) setChainDraft((chainDraft || []).concat(extra))
            toast_('已加入 ' + list.length + ' 个模型' + (extra.length ? ('，' + extra.length + ' 个进链') : ''))
          } else toast_('失败：' + (r.error || ''))
        } catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      const saveVision = async (v) => {
        try {
          const r = await jpost('/settings', { visionModel: v })
          toast_(r.ok ? '识图模型已保存' : ('失败：' + (r.error || '')))
          if (r.ok) setVisionDirty(false)
        } catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      const savePersona = async () => {
        try { const r = await jpost('/settings', { personaPrompt: String(persona || '').trim() }); toast_(r.ok ? '人设已保存，下一轮生效' : ('失败：' + (r.error || ''))); if (r.ok) setDirty((d) => ({ ...d, persona: false })) }
        catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      const saveSettings = async () => {
        const list = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        const body = {
          keywords: list, autoComment: cfg.autoComment, mentionName: mentionDraft != null ? mentionDraft : (cfg.mentionName || ''),
          commentPerRound: Number(cfg.commentPerRound || 0), replyToComments: cfg.replyToComments,
          replyPerRound: Number(cfg.replyPerRound || 0), transcribe: cfg.transcribe, asrModel: cfg.asrModel,
          perDay: Number(cfg.perDay || 0), dmMode: cfg.dmMode, dmUid: Number(dmUidDraft != null ? dmUidDraft : (cfg.dmUid || 0)),
          dmWatch: cfg.dmWatch, dmWatchMinutes: Number(cfg.dmWatchMinutes || 0), dmReplyPerDay: Number(cfg.dmReplyPerDay || 0),
          reportLevel: cfg.reportLevel, favFolderId: Number(favDraft != null ? favDraft : (cfg.favFolderId || 0)),
        }
        // 人设是「脏」的也要一起存——否则点「保存配置」会把 dirty 清掉，但人设其实没存进去（静默丢改动，2026-10-31 修）
        if (dirty.persona && persona != null) body.personaPrompt = String(persona).trim()
        try { const r = await jpost('/settings', body); toast_(r.ok ? ('已保存：' + ((r.changed || []).join('、')) + '（下一轮生效）') : ('失败：' + (r.error || ''))); if (r.ok) setDirty({}) }
        catch (e) { toast_('失败：' + String(e?.message ?? e)) }
      }
      const pauseAll = async () => {
        try {
          const curDm = cfg.dmMode
          const r = await jpost('/settings', { autoComment: false, dmMode: 'off' })
          if (r.ok) { setPauseBak({ autoComment: true, dmMode: curDm }); try { localStorage.setItem('obs-pause-backup', JSON.stringify({ autoComment: true, dmMode: curDm })) } catch {} toast_('已暂停全部对外动作（手头这轮跑完即停）') }
          else toast_('暂停失败：' + (r.error || ''))
        } catch (e) { toast_('暂停失败：' + String(e?.message ?? e)) }
      }
      const resumeAll = async () => {
        if (!pauseBak) { toast_('没有可恢复的记录'); return }
        try { const r = await jpost('/settings', pauseBak); if (r.ok) { setPauseBak(null); try { localStorage.removeItem('obs-pause-backup') } catch {} toast_('已恢复运行') } else toast_('恢复失败：' + (r.error || '')) }
        catch (e) { toast_('恢复失败：' + String(e?.message ?? e)) }
      }

      /* ── 打开网页版控制台（系统浏览器）── */
      const copyWebUrl = async () => {
        try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(webUrl); toast_('已复制地址'); return } } catch {}
        // 回退：聚焦并全选只读输入框，让用户长按复制
        try { const el = document.getElementById('bd-weburl'); if (el) { el.focus(); el.select() } } catch {}
        toast_('已选中地址，长按即可复制')
      }
      /**
       * 【手机版】把地址交给「系统默认浏览器」打开，而不是 DSH 自带的内嵌网页窗口。
       * 做法：拼一个安卓 Intent URI，`intent://<host><path>#Intent;scheme=http;action=...VIEW;end`
       *       —— 它会去问系统"谁能看 http"，也就是用户在设置里选的默认浏览器。
       * ⚠️ 千万不要用 `window.location.href = intent://…`！一旦系统不认这个协议，
       *    会把 DSH 整个界面顶掉、变成一片空白（用户最烦的那个"界面消失"就是这么来的）。
       *    用 <a target="_blank"> 点一下：认不出来就悄悄失败，当前页面分毫不动。
       * @returns {Promise<boolean>} 是不是成功跳出去了
       */
      const launchMobileIntent = (url) => {
        try {
          const m = String(url).match(/^https?:\/\/([^/]+)(\/.*)?$/)
          if (!m) return false
          const intent = 'intent://' + m[1] + (m[2] || '/')
            + '#Intent;scheme=http;action=android.intent.action.VIEW'
            + ';category=android.intent.category.BROWSABLE'
            + ';S.browser_fallback_url=' + encodeURIComponent(url) + ';end'
          const a = document.createElement('a')
          a.href = intent; a.target = '_blank'; a.rel = 'noopener'
          a.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden'
          document.body.appendChild(a)
          a.click()
          setTimeout(() => { try { a.remove() } catch {} }, 1000)
          return true
        } catch { return false }
      }
      /** 点了以后有没有真的跳出去？——页面被切到后台就说明浏览器接管了 */
      const waitedForLeave = (ms) => new Promise((res) => {
        let done = false
        const finish = (v) => { if (!done) { done = true; try { document.removeEventListener('visibilitychange', onVis) } catch {}; res(v) } }
        const onVis = () => { if (document.visibilityState === 'hidden') finish(true) }
        try { document.addEventListener('visibilitychange', onVis) } catch {}
        setTimeout(() => finish(false), ms || 1200)
      })
      const openConsole = async () => {
        try {
          const r = await jpost('/open', { what: 'url', u: '/bili-console' })
          const url = (r && (r.url || r.opened)) || ''
          if (!url) { toast_('打开失败：服务器没返回地址，请手动访问 /bili-console'); return }
          // ── 电脑（Windows / 桌面版）：服务器已经用 start / open 帮你开了系统浏览器，这里一个字都不改 ──
          if (r && r.platform === 'win32') { toast_('已用系统浏览器打开：' + url); return }
          const isAndroid = /android/i.test(navigator.userAgent || '')
          if (!isAndroid) { toast_('已请系统打开：' + url); return }   // macOS / 桌面 Linux
          // ── 手机版：真把默认浏览器拉起来 ──
          if (r && r.launched) { toast_('已用手机默认浏览器打开'); return }  // 后端 am start / xdg-open 成功了
          if (launchMobileIntent(url) && await waitedForLeave(1400)) { toast_('已用手机默认浏览器打开'); return }
          // 实在拉不起才把地址摆出来（兜底，正常情况下你根本看不到这步）
          setWebUrl(url); setWebOpen(true)
        } catch { toast_('打开失败，请手动在浏览器打开 /bili-console') }
      }

      /** 打开评论所在的视频：手机先试 B站 App（没装自动落网页版），电脑直接系统浏览器进网页版 */
      const openVideo = async (bvid) => {
        const web = 'https://www.bilibili.com/video/' + bvid
        try {
          // ① 手机上先让后端用「深链 + 显式包名」唤起 B站 App —— 不经过系统"用哪个应用打开"
          //    选择器，避免用户顺手把 B站 设成默认浏览器（之后所有网页都被 B站 接管，又卡又丑）
          const app = await jpost('/open', { what: 'biliapp', bvid })
          if (app && app.launched) { toast_('已用哔哩哔哩打开'); return }
          // ② 电脑：系统浏览器开网页版
          if (app && app.platform === 'win32') {
            const r = await jpost('/open', { what: 'url', u: web })
            toast_(r && r.launched ? '已在系统浏览器打开视频' : '已把网址交给系统')
            return
          }
          // ③ 手机上没装 B站 App（或深链失败）→ 不再把 https 丢给系统（那正是弹选择器的原因），
          //    直接在插件面板里把网页地址摆出来，想开就点
          setWebUrl(web); setWebOpen(true)
        } catch { toast_('打不开，手动访问 bilibili.com/video/' + bvid) }
      }
      const openFolder = async (what) => {
        try { const r = await jpost('/open', { what }); toast_(r && r.ok ? ('已请系统打开：' + (r.opened || '')) : ('打不开：' + ((r && r.error) || ''))) }
        catch (e) { toast_('打不开：' + String(e?.message ?? e)) }
      }

      /* ── 版本自检 ─────────────────────────────────────────────
         DSH 自带的「检查更新」管的是 DSH 软件本身，不会管我们的插件，
         所以由插件自己去 GitHub 问版本号。查不到时可以换 CDN / 加速代理 / 自己填。 */
      const saveUpOption = async (patch) => {
        try { const r = await jpost('/update/option', patch); if (r && r.ok) setUpRes((p) => ({ ...(p || {}), ...r })) }
        catch (e) { toast_('没存上：' + String(e?.message ?? e)) }
      }
      const doUpdateCheck = async (patch) => {
        setUpBusy(true)
        try {
          const upNow = upRes || st.update || {}
          const body = {
            force: true,
            mode: (patch && patch.mode) || upMode || upNow.mode || 'auto',
            custom: (patch && patch.custom) !== undefined ? patch.custom : (upCustom != null ? upCustom : (upNow.custom || '')),
          }
          const r = await jpost('/update/check', body)
          setUpRes(r)
          if (r && r.hasUpdate) toast_('有新版本 v' + r.latest + '（就在上面这张卡片里，点「一键更新」即可）')
          else if (r && r.ok) toast_('已经是最新版 v' + r.latest)
          else toast_('没查到版本，试试换个加速源')
        } catch (e) { toast_('检查失败：' + String(e?.message ?? e)) } finally { setUpBusy(false) }
      }
      /** 一键自更新：让插件自己下载新版并替换文件（进度走 /state 的 selfUpdate，2 秒一刷） */
      const applyUpdate = async () => {
        try {
          const r = await jpost('/update/apply', { custom: upCustom != null ? upCustom : ((st.update || {}).custom || '') })
          if (r && r.ok && !r.error) toast_('开始更新了，看下面的进度条')
          else toast_('没启动成：' + ((r && r.error) || '未知原因'))
        } catch (e) { toast_('启动更新失败：' + String(e?.message ?? e)) }
      }
      /** 重新检测 Python 环境：把探测细节摊出来（真没装 vs 没找到，一眼分辨） */
      const recheckEnv = async () => {
        setEnvBusy(true)
        try {
          const r = await jget('/env/diag')
          setEnvDiag(r || null)
          if (r && r.found) toast_('找到 Python：' + r.found.cmd + '（' + r.found.ver + '）')
          else toast_('还是没找到 Python，下面列出了试过的每个路径')
        } catch (e) { toast_('检测失败：' + String(e?.message ?? e)) } finally { setEnvBusy(false) }
      }
      /** 评论记录：看发过什么 */
      const loadComments = async () => {
        try { const r = await jget('/comments'); setCommentsList((r && r.items) || []) } catch { setCommentsList([]) }
      }
      /** 只撤指定的那一条（两段确认：先点「撤回这条」，再点「确认删除」） */
      const delComment = async (rpid) => {
        if (commentsBusy) return
        setCommentsBusy(rpid)
        try {
          const r = await jpost('/comments/delete', { rpid })
          if (r && r.ok) {
            toast_(r.already ? '那条其实早就删过了，本地记录已清理' : '已撤回这一条')
            setCommentsList((l) => (l || []).filter((x) => Number(x.rpid) !== rpid))
          } else toast_('没删成：' + ((r && r.error) || '未知'))
        } catch (e) { toast_('失败：' + String(e?.message ?? e)) } finally { setCommentsBusy(0); setConfirmRpid(0) }
      }
      React.useEffect(() => {
        if (page === 'comments' && commentsList === null) loadComments()
      }, [page, commentsList])

      /** 手动发一条测试消息进 DSH 会话 */
      const testDshPush = async () => {
        setDshTesting(true)
        try {
          const r = await jpost('/dsh/push', {})
          if (r && r.ok) toast_('已发进 DSH 会话（去会话列表找「刷B站」）')
          else toast_('没发出去：' + ((r && r.error) || '未知'))
        } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) } finally { setDshTesting(false) }
      }
      /** 转写自检：真 import 一次，把版本号亮出来 */
      const checkAsr = async () => {
        setAsrChecking(true)
        try {
          const r = await jget('/env/asr-check')
          setAsrCheck(r || null)
          toast_(r && r.ok ? ('可用：' + (r.backend || '') + ' ' + (r.version || '')) : ('不可用：' + ((r && r.error) || '未知')))
        } catch (e) { toast_('自检失败：' + String(e?.message ?? e)) } finally { setAsrChecking(false) }
      }
      /** 一键安装运行环境：auto=Python+依赖 / deps=只装依赖 / asr=转写后端 */
      const installEnv = async (what) => {
        try {
          const r = await jpost('/env/install', { what })
          if (r && r.ok && !r.error) toast_(what === 'asr' ? '开始装转写后端，进度在卡片里' : '开始安装，进度在卡片里（别退出这一页）')
          else toast_('没启动成：' + ((r && r.error) || '未知原因'))
        } catch (e) { toast_('启动失败：' + String(e?.message ?? e)) }
      }
      /** 没关键词就别跑：直接把人带到设置页去填（以前只弹个红字错误，看不出该干嘛） */
      const needKeywords = () => {
        if ((cfg.keywords || []).length) return false
        toast_('还没设关键词：去「找视频」填几个方向（比如 AI、数码），它才知道去哪找视频')
        setPage('find')
        return true
      }
      const runNow = async () => {
        if (needKeywords()) return
        try { const r = await jpost('/run/now', { force: true }); toast_(r.message || (r.ok ? '已开始' : '失败')) } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) }
      }
      /** 清空所有视频的对话上下文（thread 模式产物） */
      const clearMemory = async () => {
        try { const r = await jpost('/memory/clear', {}); toast_(r.ok ? '已清空所有对话上下文' : '清空失败') }
        catch (e) { toast_('清空失败：' + String(e?.message ?? e)) }
      }
      /** 撤回：把 AI 刚发出去的那条评论从 B站 删掉（只能删自己发的） */
      /** 重置今日额度（不想改上限、就是想清零重来） */
      const resetQuota = async () => {
        try {
          const r = await jpost('/quota/reset', {})
          if (!r || !r.ok) return toast_('重置失败：' + ((r && r.error) || ''))
          const b = (r && r.before) || {}
          toast_('已重置：原来挑了 ' + (b.picked || 0) + ' 条、发了 ' + (b.count || 0) + ' 条，现在都是 0')
        } catch (e) { toast_('重置失败：' + String(e?.message ?? e)) }
      }
      const retractLastOne = async () => {
        const cnt = (st.posted && st.posted.count) || 0
        if (!cnt) return toast_('账本是空的：没有可撤回的内容')
        const last = (st.posted && st.posted.last) || {}
        if (!window.confirm('撤回最近 1 条？\n\n' + (last.at || '') + ' · ' + (last.bvid || '') + '\n' + (last.text || '') + '\n\n会在 B站 上把它删掉，不可恢复。')) return
        try {
          const r = await jpost('/retract', { count: 1 })
          toast_(r.message || '已开始撤回')
          setTimeout(() => refresh(), 1500)
        } catch (e) { toast_('撤回失败：' + String(e?.message ?? e)) }
      }
      /** 停止当前轮次（不掐进程，让它在检查点收手） */
      const stopRun = async () => {
        try { const r = await jpost('/run/stop', {}); toast_(r.message || (r.stopped ? '已请求停止' : '当前没有在跑')) }
        catch (e) { toast_('请求失败：' + String(e?.message ?? e)) }
      }
      /** 某个 key 下的模型整组进链 / 整组移出 */
      const setProviderChain = (g, add) => {
        const list = g.models.map((m) => ({ id: 'preset:' + g.provider + ':' + m.id, label: m.name || m.id, model: m.id, source: 'preset', provider: g.provider }))
        if (add && list.length > 50) { toast_('这个 key 下有 ' + list.length + ' 个模型，整组加太多了，挑几个吧'); return }
        let cur = (chainDraft || []).slice()
        if (add) { for (const x of list) if (!cur.find((e) => e.id === x.id)) cur.push(x) }
        else { const ids = list.map((x) => x.id); cur = cur.filter((e) => ids.indexOf(e.id) < 0) }
        setChainDraft(cur)
        saveChainIds(cur.map((e) => e.id))
        toast_((add ? '整组加入 ' + list.length + ' 个' : '整组移出 ' + list.length + ' 个') + '：' + g.label)
      }
      /** 试跑：真搜、真让 AI 挑、写日报，但绝不发评论/私信 */
      const runDry = async () => {
        if (needKeywords()) return
        try { const r = await jpost('/run/now', { force: true, dryRun: true }); toast_(r.message || (r.ok ? '已开始试跑' : '失败')) } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) }
      }
      const dmCheck = async () => { try { const r = await jpost('/dm/check', {}); toast_(r.message || '已发起私信检查') } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) } }

      /* ── 登录流程 ── */
      const openLogin = async () => {
        const FIRST_HINT = '正在准备二维码…首次使用会自动搭环境 + 下载依赖（约 2-5 分钟，属正常现象，可在「日志」页看实时进度），之后每次都是秒开。请保持本页开着别关。'
        setLogin({ open: true, qr: '', hint: FIRST_HINT, status: '首次准备中，请耐心等一会儿…', url: '' })
        loginOpenRef.current = true
        try {
          const r = await jpost('/login/start', {})
          if (!r.ok) { setLogin((l) => ({ ...l, hint: '生成失败：' + (r.error || '') })); return }
          if (r.status === 'already_logged_in') { setLogin((l) => ({ ...l, hint: '已经登录了，无需重复扫码' })); return }
          setLogin((l) => ({ ...l, qr: r.qrcode_image || '', url: r.qrcode_url || '', hint: '二维码已生成，用 B站 App 扫一扫（180 秒内有效）', status: '用 B站 App 扫码' }))
          pollLogin()
        } catch (e) { setLogin((l) => ({ ...l, hint: '生成失败：' + String(e?.message ?? e) })) }
      }
      /** 退出登录：删本机凭证，之后可以扫码换别的账号（2026-10-30 加） */
      const doLogout = async () => {
        if (!window.confirm('退出当前 B站 账号？\n退出后想再刷就要重新扫码（正好可以换别的号扫）。')) return
        try {
          const r = await jpost('/logout', {})
          toast_(r && r.ok ? '已退出登录，现在可以扫码换账号了' : '退出失败：' + ((r && r.error) || ''))
        } catch (e) { toast_('退出失败：' + String(e?.message ?? e)) }
      }
      const pollLogin = () => {
        if (loginTimer.current) clearInterval(loginTimer.current)
        loginTimer.current = setInterval(async () => {
          if (!loginOpenRef.current || !alive.current) { clearInterval(loginTimer.current); return }
          try {
            const r = await jpost('/login/check', {})
            const s = r.status
            if (s === 'done') { clearInterval(loginTimer.current); loginOpenRef.current = false; setLogin((l) => ({ ...l, status: '登录成功！', open: false })); setState((o) => o ? ({ ...o, login: { ...o.login, loggedIn: true } }) : o); toast_('登录成功') }
            else if (s === 'scanning') setLogin((l) => ({ ...l, status: '已扫码，等待确认…' }))
            else if (s === 'confirming') setLogin((l) => ({ ...l, status: '已确认，处理中…' }))
            else if (s === 'timeout') { clearInterval(loginTimer.current); loginOpenRef.current = false; setLogin((l) => ({ ...l, open: false, status: '二维码过期，请重新打开登录' })); toast_('二维码过期，请重新打开登录') }
            else setLogin((l) => ({ ...l, status: '等扫码…' }))
          } catch {}
        }, 3000)
      }
      const closeLogin = () => { if (loginTimer.current) clearInterval(loginTimer.current); loginOpenRef.current = false; setLogin((l) => ({ ...l, open: false })) }

      const guard = st?.guardian || {}
      const lg = st?.login || {}
      const q = st?.quota || {}
      const running = Boolean(st?.run && st.run.running)
      // 长任务（跑轮 / 生成视频）时请求屏幕常亮：安卓会杀后台，屏幕亮着能显著提高存活率
      try { keepScreenAwake(running || Boolean(st?.video && st.video.running)) } catch { /* noop */ }
      const pillTone = guard.active ? 'warn' : (lg.loggedIn ? 'run' : 'ok')

      if (!st) {
        return h('div', { 'data-bd-page': '', ref: rootRef, className: narrow ? 'narrow' : '' },
          h('div', { 'data-bd-note': '' }, fails >= 3
            ? '读不到插件配置（已经试了 ' + fails + ' 次）。可能插件刚装完没重启、或加载失败。'
            : '读设置中…'))
      }

      /* ── 顶部条 ── */
      const topbar = h('header', { 'data-bd-topbar': '' },
        h('div', { 'data-bd-brand': '' }, h('span', { 'data-bd-dot': '' }), '刷B站观测台'),
        h('div', { 'data-bd-search': '' }, h('input', { placeholder: '搜索日志…', value: search, onChange: (e) => setSearch(e.target.value) })),
        h('span', { 'data-bd-spill': '', className: pillTone },
          h('span', { className: 'sd' }),
          h('span', null, guard.active ? '风控冷却中' : (lg.loggedIn ? '控制台在线' : '未登录'))),
        h('button', { 'data-bd-exit': '', onClick: openConsole }, '网页版 ↗'))

      /* ── 登录提示条：未登录时常驻在所有页面顶部 ── */
      const loginBar = lg.loggedIn ? null : h('div', { 'data-bd-banner': '', className: 'login' },
        h('span', { className: 'ic' }, '!'),
        h('span', { style: { flex: 1, minWidth: 0 } }, '还没登录 B站 —— 现在只能看数据，不能真的去刷。扫码一次就行。'),
        h('button', { 'data-bd-btn': '', className: 'primary', onClick: openLogin, style: { marginLeft: 'auto' } }, '扫码登录'))

      /* ── 横幅 ── */
      let banner = null
      if (st.noAdapter) banner = h('div', { 'data-bd-banner': '', className: 'err' }, 'AI 起不来：模型没配对（NO_ADAPTER）。去「降级链」或「模型与密钥」里手动换一个已注册的模型，再手动跑一轮。')
      else if (!(cfg.keywords || []).length) banner = h('div', { 'data-bd-banner': '' },
        h('span', null, '还没设关键词 —— 填几个你感兴趣的方向（比如 AI、数码），它才知道去哪找视频'),
        h('button', { onClick: () => setPage('find') }, '去找视频 →'))
      else if (st.safeMode) banner = h('div', { 'data-bd-banner': '' }, '安全模式：当前不会自动发评论、不会发私信。想真发时，到「设置」把「自动评论并 @」和「投递方式」打开。')

      /* ── 侧边导航 ── */
      const PAGES = PAGE_ORDER
      const sidebar = h('aside', { 'data-bd-sidebar': '' },
        PAGES.map(([v, label]) => h('button', { key: v, 'data-bd-pill': '', className: page === v ? 'active' : '', onClick: () => setPage(v) }, label)),
        h('button', { 'data-bd-pill': '', className: 'switch', onClick: openConsole }, '网页版控制台 ↗'),
        h('div', { 'data-bd-spacer': '' }),
        h('div', { 'data-bd-modecard': '' }, h('b', null, 'dsh-bili-console'), h('span', { style: { color: 'var(--t2)', fontSize: '11px' } }, 'DSH 内置控制台 · 与网页版共用同一份配置')))

      /* ── 各页面 ── */
      const renderComments = () => {
        const list = commentsList || []
        const fmtT = (iso) => {
          try {
            const d = new Date(iso)
            return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0') + ' ' +
              String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
          } catch { return '' }
        }
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' },
            h('span', { className: 't' }, '评论记录'),
            h('span', { className: 's' }, '它发过的每一条都在这；撤哪条删哪条，不牵连别的')),
          Card({
            title: '已发出去的', sub: list.length + ' 条',
            right: h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadComments }, '刷新'),
          },
            list.length ? list.map((it, i) => h('div', { key: i, 'data-bd-cmt': '' },
              h('div', { className: 't' }, (it.kind === 'reply' ? '回复' : '评论') + ' · ' + String(it.title || it.bvid || '').slice(0, 30)),
              h('div', { className: 'x' }, String(it.text || '')),
              h('div', { className: 'm' },
                h('span', null, fmtT(it.at)),
                h('span', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
                  h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => openVideo(it.bvid) }, '看视频 ↗'),
                  ...(confirmRpid === Number(it.rpid)
                    ? [
                        h('button', { key: 'y', 'data-bd-btn': '', className: 'sm', style: { color: 'var(--red-tx)', fontWeight: 600 }, disabled: !!commentsBusy, onClick: () => delComment(Number(it.rpid)) }, '确认删除'),
                        h('button', { key: 'n', 'data-bd-btn': '', className: 'ghost sm', onClick: () => setConfirmRpid(0) }, '算了'),
                      ]
                    : [h('button', { key: 'r', 'data-bd-btn': '', className: 'ghost sm', disabled: !!commentsBusy, onClick: () => setConfirmRpid(Number(it.rpid)) }, commentsBusy === Number(it.rpid) ? '删除中…' : '撤回这条')])))))
              : h('div', { 'data-bd-empty': '' }, '还没有记录——跑一轮并且真的发出评论/回复后，这里就有了。')))
      }

      const renderOverview = () => {
        const ep = (st.chain && st.chain.endpoints) || []
        const on = []; if (cfg.autoComment) on.push('自动评论'); if (cfg.dmMode && cfg.dmMode !== 'off') on.push('私信投递'); if (cfg.dmWatch) on.push('私信监察')
        const protect = [
          { t: '随机间隔 1-2 分钟', ok: true }, { t: '每日上限 ' + (cfg.perDay || 0) + ' 条', ok: (cfg.perDay || 0) > 0 },
          { t: '每周强制休息 1 天', ok: true }, { t: '风控码自动停 10 分钟', ok: true }, { t: '验证码来了立刻暂停', ok: true },
          { t: '私信默认关', ok: !(cfg.dmMode && cfg.dmMode !== 'off') }, { t: '不登录 / 不支付 / 不转发私信', ok: true },
        ]
        const NOISE = /已就绪并挂载|使用系统 Python|已挂载（网页控制台在线）|^手动轮次|^定时轮次|^设置页手动轮次|\{"ran":/;
        const activity = (st.activity || []).filter((x) => !NOISE.test(String((x && (x.text || x.raw)) || '')))
        const repHtml = (report && report.exists && (report.markdown || '').trim())
          ? renderMD(report.markdown)
          : '<div class="data-bd-empty">今天还没有报告<br>（跑出一轮后这里会出现挑中的视频）</div>'
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '总览'), h('span', { className: 's' }, '账号、进度、降级链、安全防护、AI 在干嘛——一页看全')),
          h('div', { 'data-bd-rowflex': '' },
            Card({ title: null },
              h('div', { 'data-bd-acct': '' },
                me && me.face
                  ? h('img', { 'data-bd-avatar': '', src: me.face, alt: '头像', referrerPolicy: 'no-referrer' })
                  : h('div', { 'data-bd-avatar': '' }, (me && me.uname ? me.uname.slice(0, 1) : 'B')),
                h('div', { className: 'name' }, (me && me.uname) || (lg.loggedIn ? 'B站 账号' : '还没登录')),
                Tag({ c: lg.loggedIn ? 'green' : 'red', children: lg.loggedIn ? '登录正常' : '未登录' })),
              h('div', { 'data-bd-note': '' }, lg.loggedIn
                ? ('UID ' + (me && me.mid ? me.mid : '—') + (me && me.level ? (' · Lv' + me.level) : '') + ' · 凭证更新于 ' + (lg.at || '—'))
                : '还没登录，点下面扫码，登录后这里会显示你的头像和昵称'),
              running ? h('div', { 'data-bd-note': '', style: { color: 'var(--blue)', fontWeight: 600 } },
                '正在跑：' + ((st.run && st.run.label) || '轮次') + '（点「停止这一轮」会在下一条之前收手，不会发半句）') : null,
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
                h('button', { 'data-bd-btn': '', className: lg.loggedIn ? 'ghost sm' : 'primary', onClick: openLogin }, lg.loggedIn ? '重新登录' : '扫码登录'),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: dmCheck }, '查私信'),
                lg.loggedIn ? h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: doLogout }, '退出登录') : null),
              h('div', { 'data-bd-sum': '', style: { marginTop: '10px', fontSize: '11.5px' } },
                '今天最多 ' + (cfg.perDay || 0) + ' 条 · 评论' + (cfg.autoComment ? '开' : '关') + ' · 私信' + ((cfg.dmMode && cfg.dmMode !== 'off') ? '开' : '关'))),
            Card({ title: null }, h('div', { 'data-bd-note': '' }, '今日进度'),
              h('div', { 'data-bd-bignum': '' }, h('span', null, String(q.picked || 0)), h('small', null, ' / ' + (q.perDay || 0) + ' 条已挑中')),
              h('div', { 'data-bd-note': '' }, '评论 ' + ((st.seen || {}).comments || 0) + ' 条 · 上一轮 ' + ((st.lastRun || {}).at || '—') + '（' + ((st.lastRun || {}).why || '—') + '）'),
              h('div', { 'data-bd-prog': '' }, h('div', { style: { width: Math.min(100, ((q.perDay || 0) ? (q.picked / q.perDay * 100) : 0)) + '%' } })),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '12px', flexWrap: 'wrap' } },
                running
                  ? h('button', {
                    'data-bd-btn': '', className: 'danger sm', onClick: stopRun,
                    disabled: Boolean(st.run && st.run.stopRequested),
                  }, (st.run && st.run.stopRequested) ? '正在停止…' : '停止这一轮')
                  : h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: runDry }, '试跑（只挑不发）'),
                running ? null : h('button', {
                  'data-bd-btn': '', className: cfg.autoComment ? 'danger sm' : 'outline sm', onClick: runNow,
                }, cfg.autoComment ? '立即跑（会真发）' : '立即跑一轮'),
                running ? null : h('button', {
                  'data-bd-btn': '', className: 'ghost sm', onClick: stopRun, disabled: true,
                  title: '当前没有在跑的轮次',
                }, '停止（没在跑）'),
                h('button', {
                  'data-bd-btn': '', className: 'ghost sm', onClick: retractLastOne,
                  disabled: !((st.posted && st.posted.count) || 0),
                  title: '把 AI 刚发出去的那条评论删掉（只删自己发的）',
                }, '撤回上一条' + (((st.posted && st.posted.count) || 0) ? ('（' + st.posted.count + '）') : '')),
                h('button', {
                  'data-bd-btn': '', className: 'outline sm', onClick: resetQuota,
                  title: '把「今天已挑中」清零，上限不用改，等于重新给你今天的额度',
                }, '重置今日额度')))),
          Card({ title: '自动模式（挂机）', sub: '档位只是起点：每天几条、隔多久、每轮看多少条视频、跑哪个时段，下面全都能自己改' },
            // 挂机总开关（2026-11-9 加）：关了值守轮次完全不跑；与网页版共用 autoDutyOn 键
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '自动值守总开关'),
                h('div', { 'data-bd-ds': '' }, (state?.settings?.autoDutyOn === false)
                  ? '已关闭：到点也不跑轮次；群里喊它「去刷一轮」和手动跑不受影响'
                  : '已开启：到点自动值守（「自动评论」关着时只挑不发）')),
              h('button', {
                'data-bd-btn': '', className: (state?.settings?.autoDutyOn === false) ? 'primary sm' : 'ghost sm',
                onClick: () => { jpost('/settings', { autoDutyOn: state?.settings?.autoDutyOn === false }).catch(() => {}); toast_(state?.settings?.autoDutyOn === false ? '正在打开…' : '正在关闭…') },
              }, (state?.settings?.autoDutyOn === false) ? '打开自动值守' : '关掉自动值守')),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              ...[['safe', '稳妥'], ['balanced', '平衡'], ['aggressive', '激进'], ['custom', '自定义']].map(([k, label]) => h('button', {
                key: k, 'data-bd-btn': '',
                className: 'sm ' + (BILI_AUTO.preset === k ? 'primary' : 'ghost'),
                onClick: () => pickPreset(k),
              }, label))),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '运行时段'),
                h('div', { 'data-bd-ds': '' }, '全天 7×24 = 不停；自定义时段 = 每天只在起止之间跑（跨夜也行，比如 22:00→06:00）；官方谷时 = 只跑午间和夜间两段')),
              Select({
                value: BILI_AUTO.scheduleMode || 'any',
                onChange: (v) => { BILI_AUTO.scheduleMode = v; planAuto(); setState((x) => (x ? { ...x } : x)) },
                minWidth: 150,
              },
                h('option', { value: 'any' }, '全天 7×24'),
                h('option', { value: 'window' }, '自定义时段'),
                h('option', { value: 'valley' }, '只在官方谷时'))),
            (BILI_AUTO.scheduleMode === 'window') && h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
              h('span', { style: { fontSize: '12px' } }, '从'),
              h('input', {
                type: 'time', value: BILI_AUTO.activeStart || '09:00',
                style: { height: '32px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)', padding: '0 8px' },
                onChange: (e) => { BILI_AUTO.activeStart = e.target.value; planAuto() },
              }),
              h('span', { style: { fontSize: '12px' } }, '到'),
              h('input', {
                type: 'time', value: BILI_AUTO.activeEnd || '23:00',
                style: { height: '32px', borderRadius: '6px', border: '1px solid var(--line)', background: 'var(--surface)', color: 'var(--t1)', padding: '0 8px' },
                onChange: (e) => { BILI_AUTO.activeEnd = e.target.value; planAuto() },
              }),
              h('span', { style: { fontSize: '11px', color: 'var(--t3)' } }, '到点自动停、到点自动开')),
            (BILI_AUTO.scheduleMode === 'valley') && h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
              h('span', { style: { fontSize: '12px' } }, '谷时窗口：'),
              ...[['noon', '午间 12:00–14:00'], ['night', '夜间 18:00–09:00']].map(([k, label]) => h('span', {
                key: k, 'data-bd-chip': '', style: { cursor: 'pointer', background: BILI_AUTO[k] ? 'var(--blue)' : 'var(--blue-bg)', color: BILI_AUTO[k] ? '#fff' : 'var(--blue)' },
                onClick: () => { BILI_AUTO[k] = !BILI_AUTO[k]; planAuto(); setState((x) => (x ? { ...x } : x)) },
              }, label))),
            h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', marginTop: '10px', alignItems: 'center' } },
              autoNum('perDay', '每天上限', 1, '96px'),
              autoNum('commentPerRound', '每轮发', 1, '92px'),
              autoNum('roundIntervalMinutes', '间隔(分)', 1, '92px'),
              autoNum('scanPerRound', '每轮看(条视频)', 0, '100px')),
            h('div', { style: { fontSize: '11px', color: 'var(--t3)', marginTop: '4px', lineHeight: 1.7 } },
              '「每轮看」= 一轮最多翻多少条候选视频，0 = 按默认量（首页 30 条 + 每个关键词 20 条）。翻得越多越不容易重复，但更慢更费 token。数字随便填，没有硬上限。'),
            // 这两块内容由 paintPlan() 直接写 DOM（空节点，React 不托管子元素，轮询重渲染也不会被冲掉）
            h('div', { style: { fontSize: '11.5px', color: 'var(--t3)', marginTop: '8px', lineHeight: 1.8 } },
              h('div', { 'data-bd-autoplan': '' }, '点档位或改数字，这里会算出一天大概跑多少'),
              h('div', { 'data-bd-autowarn': '', style: { marginTop: '4px' } }, ''),
              h('div', { 'data-bd-autoconf': '', style: { marginTop: '4px' } }, '')),
            h('label', { style: { display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '10px', lineHeight: 1.6 } },
              h('input', {
                type: 'checkbox', checked: BILI_AUTO.applyInteractions === true,
                style: { marginTop: '2px' },
                onChange: (e) => { BILI_AUTO.applyInteractions = e.target.checked; planAuto(); setState((x) => (x ? { ...x } : x)) },
              }),
              h('span', null, '顺便按这个档位设置「互动开关」（自动评论 / 点赞 / 回评论 / 私信）',
                h('span', { style: { color: 'var(--t3)' } }, '　不勾就完全不动「安全防护」页的设置'))),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: applyAuto }, '应用这套配置'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: planAuto }, '重新估算')),
            h('div', { style: { fontSize: '11px', color: 'var(--t3)', marginTop: '8px', lineHeight: 1.8 } },
              '提醒：这套只改频率和时段，不动模型、人格卡、素材、配音，也不动「风控冷却」（那还是 24 小时）。上限基本不设——一天填 5000 条也行，只是风险自己担（上面会给出警告）。')),
          Card({ title: 'AI 助手', sub: '直接用大白话说，它帮你改设置（"思考强度都调到低""把额度清零"）' },
            h('div', { 'data-bd-chat': '', style: { maxHeight: '260px', overflowY: 'auto', padding: '4px 0' } },
              h('div', { style: { fontSize: '12px', color: 'var(--t3)' } }, '试试：「把每日上限改成 5」「思考强度全部调低」「看看我现在设置」「把今天额度清零」')),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px', alignItems: 'center' } },
              Input({ 'data-bd-chatinput': '', placeholder: '跟它说你想改什么…', onEnter: () => sendChat() }),
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: sendChat }, '发送'))),
          Card({ title: '我发过的动态 / 投稿', sub: '每条都能撤回（B站 网页接口，属于实验性：改版可能失效，失败会如实提示）' },
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadPublished }, '刷新')),
            h('div', { 'data-bd-published': '' }, h('div', { style: { fontSize: '12px', color: 'var(--t3)' } }, '点「刷新」看发过的动态和投稿'))),
          Card({ title: '我发过的评论', sub: '每条都能点开直达 B站 那条评论（滚过去就能看到）' },
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadPosted }, '刷新')),
            h('div', { 'data-bd-posted': '' }, h('div', { style: { fontSize: '12px', color: 'var(--t3)' } }, '点「刷新」看最近发过的评论'))),
          Card({ title: '运行小结', sub: '插件自己记的时间线（不依赖 DSH 会话，跑几轮都不会丢）' },
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadRuns }, '刷新'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: clearRuns }, '清空记录')),
            h('div', { 'data-bd-runs': '' }, h('div', { style: { fontSize: '12px', color: 'var(--t3)' } }, '点「刷新」看最近几轮'))),
          h('div', { 'data-bd-rowflex': '' },
            Card({ title: '降级链', sub: null, right: Tag({ c: ep.length ? 'green' : 'red', children: ep.length ? (ep.length + ' 节') : '空' }) },
              h('div', { 'data-bd-sum': '' }, ep.length ? ('当前生效：' + (ep[0] ? ep[0].label : '—') + '；出问题自动切下一节' + ((st.chain && st.chain.hostPresets) ? ('（含 ' + st.chain.hostPresets + ' 个 DSH 预设）') : '')) : '还没加模型：去「模型与密钥」加一个并加入降级链。'),
              h('button', { 'data-bd-link': '', onClick: () => setPage('chain') }, '查看降级链 →')),
            Card({ title: '安全防护', sub: null, right: Tag({ c: on.length ? 'blue' : 'gray', children: on.length ? (on.length + ' 项对外动作开着') : '全关 · 安全模式' }) },
              h('div', { 'data-bd-sum': '' }, on.length ? ('当前会对外：' + on.join('、') + '；想收一收就去「安全防护」') : '现在只挑不发，任何对外动作都没开'),
              h('div', { 'data-bd-protect': '' }, protect.map((p, i) => h('span', { key: i, className: 'p' + (p.ok ? '' : ' off') }, p.t))),
              h('button', { 'data-bd-link': '', onClick: () => setPage('safety') }, '去设置 →'))),
          Card({ title: 'AI 实时日志（大白话）', sub: '点一行看原始日志' },
            h('div', { 'data-bd-feed': '' },
              activity.length ? activity.map((it, i) => h('div', { key: i, className: 'row ' + (it.level || ''), onClick: (e) => { const r = e.currentTarget; r.classList.toggle('open') } },
                h('span', { className: 'ic' }, it.icon || 'ℹ️'),
                h('span', { className: 'tm' }, it.t || '—'),
                h('div', { className: 'bd' }, h('div', { className: 'txt' }, it.text || ''), h('div', { className: 'raw' }, it.raw || ''))))
                : h('div', { 'data-bd-empty': '' }, '还没有动态'))),
          Card({
            title: '今日日报 · ' + ((report && report.date) || '今天'),
            sub: (report && report.exists) ? (repOpen ? '已展开全部' : '默认收起 · 下面是摘要') : null,
            right: Tag({ c: 'green', children: '挑中 ' + ((report && report.picked) || 0) + ' 条' }),
          },
            h('div', { 'data-bd-collapse': '' },
              h('div', { 'data-bd-rep': '', style: repOpen ? undefined : { maxHeight: '150px', overflow: 'hidden' },
                dangerouslySetInnerHTML: { __html: repHtml } }),
              !repOpen ? h('div', { 'data-bd-fade': '' }) : null,
              (report && report.exists)
                ? h('button', { 'data-bd-btn': '', className: 'ghost sm', style: { alignSelf: 'flex-start', marginTop: '8px' }, onClick: () => setRepOpen(!repOpen) }, repOpen ? '收起' : ('展开全部 ' + ((report && report.picked) || 0) + ' 条'))
                : null)))
      }

      const renderModels = () => {
        const presets = (st.chain && st.chain.presets) || []
        const diag = (st.chain && st.chain.dshDiag) || null
        const inChain = new Set((chainDraft || []).map((e) => e.id))
        const presetCard = Card({ title: 'DSH 里的模型（自动提取）', sub: '只列有密钥的 · 点一下进/出降级链' },
          presets.length
            ? presets.map((g) => {
              const open = !!provOpen[g.provider]
              const shown = open ? g.models : g.models.slice(0, 18)
              const rest = g.models.length - shown.length
              return h('div', { key: g.provider, 'data-bd-prov': '' },
                h('div', { className: 'ph' },
                  h('span', { className: 'nm' }, g.label),
                  h('span', { className: 'url' }, g.apiUrl),
                  (() => {
                    const total = g.models.length
                    const inn = g.models.filter((m) => inChain.has('preset:' + g.provider + ':' + m.id)).length
                    return Tag({ c: inn ? 'green' : 'gray', children: '进链 ' + inn + ' / ' + total })
                  })(),
                  h('button', {
                    'data-bd-btn': '', className: 'ghost sm', style: { marginLeft: 'auto' },
                    onClick: () => setProviderChain(g, true),
                    title: '把这个 key 下的模型全部加入降级链',
                  }, '整组加入'),
                  h('button', {
                    'data-bd-btn': '', className: 'ghost sm',
                    onClick: () => setProviderChain(g, false),
                  }, '整组移出')),
                h('div', { 'data-bd-mchips': '' },
                  shown.map((m) => {
                    const id = 'preset:' + g.provider + ':' + m.id
                    const sel = inChain.has(id)
                    return h('button', {
                      key: id, 'data-bd-mchip': '', className: sel ? 'sel' : '',
                      title: sel ? '点一下移出降级链' : '点一下加入降级链',
                      onClick: () => togglePreset(g, m),
                    }, m.name || m.id, sel ? h('span', { className: 'vb' }, '链') : null)
                  }),
                  rest > 0 ? h('button', { 'data-bd-mchip': '', onClick: () => setProvOpen((o) => ({ ...o, [g.provider]: true })) }, '还有 ' + rest + ' 个 ▾') : null,
                  open && g.models.length > 18 ? h('button', { 'data-bd-mchip': '', onClick: () => setProvOpen((o) => ({ ...o, [g.provider]: false })) }, '收起 ▴') : null))
            })
            : h('div', { 'data-bd-callout': '', style: { lineHeight: 1.8 } },
              h('div', { style: { fontWeight: 600, marginBottom: '6px' } }, '没从 DSH 里提取到带密钥的模型——下面是体检结果'),
              diag
                ? h('div', { style: { fontSize: '12px' } },
                  h('div', null, '配置目录：' + (diag.home || '?') + (diag.homeExists ? ' ✓ 存在' : ' ✗ 不存在')),
                  h('div', null, '密钥文件：' + (diag.refs && diag.refs.length
                    ? (diag.refs.length + ' 个（' + diag.refs.join('、') + '）')
                    : '0 个（.credentials.yaml 没读到）')),
                  h('div', { style: { marginTop: '6px' } }, '扫了 ' + (((diag.files || []).length) || 0) + ' 个配置文件：'),
                  (diag.files || []).slice(0, 8).map((f, i2) => h('div', {
                    key: 'f' + i2,
                    style: { color: f.providers ? 'var(--green, #2e7d32)' : 'var(--t3)' },
                  }, '· ' + f.file + '（' + f.bytes + 'B，' + f.providers + ' 个 provider）')),
                  ((diag.files || []).length > 8
                    ? h('div', { style: { color: 'var(--t3)' } }, '…还有 ' + ((diag.files || []).length - 8) + ' 个没列出来')
                    : null),
                  h('div', { style: { marginTop: '6px' } }, '目录树（~/.dsh）：'),
                  h('div', { style: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '11px', color: 'var(--t3)', lineHeight: 1.6 } },
                    (diag.tree || []).slice(0, 16).map((t, i2) => h('div', { key: 't' + i2 },
                      t.dir ? t.path : (t.path + '   ' + (t.size || 0) + 'B')))),
                  ((diag.problems && diag.problems.length)
                    ? h('div', { style: { marginTop: '8px', color: 'var(--amber, #d9a03f)' } },
                      h('div', { style: { fontWeight: 600 } }, '卡在哪：'),
                      diag.problems.slice(0, 6).map((t, i2) => h('div', { key: i2 }, '· ' + t)))
                    : null),
                  h('div', { style: { marginTop: '8px', color: 'var(--t3)' } }, '这张体检单截图发给作者，就能定位；不用重装、重启也没用'))
                : h('div', { style: { fontSize: '12px' } }, '检查 DSH 的 cordis.patch.yml 里 providers 有没有配 apiKeyEnv。')))
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' },
            h('span', { className: 't' }, '模型与密钥'),
            h('span', { className: 's' }, '一个 API key 下挂多个模型；点模型名就能进出降级链')),
          Card({ title: '降级链（模型排队）', sub: '越靠上越先用，出问题往下切' },
            ChainList({ endpoints: chainDraft || [], strengthMap: cfg.chainStrength || {}, onStrength: setChainStrength, onReorder: (i, d) => { const arr = (chainDraft || []).slice(); const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; setChainDraft(arr) } }),
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: saveChainOrder }, '保存顺序'))),
          presetCard,
          Card({ title: '省 token', sub: '默认开着 · 省的是你的额度' },
            ToggleRow({
              label: '关掉模型思考',
              note: '能关的直接关（DeepSeek 这类），关不掉的那就自动降到最低档（GLM 5.x 属于这种：实测一条判断 428 → 43 tokens，省 90%）。判断质量基本不受影响，但速度会快很多',
              on: cfg.thinkingOff !== false,
              onChange: (v) => saveOne('thinkingOff', v),
            })),
          Card({ title: '自己加一个模型', sub: '供应商会自动填好 API 地址' }, renderAddModel()))
        // 识图模型：插件里没有任何地方调用它，先不占位
      }

      const renderAddModel = () => {
        const provs = [['deepseek', 'DeepSeek'], ['glm', '智谱 GLM'], ['qwen', '通义千问'], ['other', '其他 / 自建']]
        const onAdd = () => {
          const url = String(mUrl || '').trim().replace(/\/+$/, '')
          const names = String(mModel || '').split(/[,，\n、]+/).map((s) => s.trim()).filter(Boolean)
          if (!url || !names.length) { toast_('API 地址和模型名都要填'); return }
          if (mKeySrc === 'custom' && !mKey) { toast_('选了「自己填 key」就得填 key'); return }
          const list = names.map((n, idx) => ({
            id: 'm' + Date.now() + '_' + idx,
            provider: mProv || 'deepseek',
            displayName: names.length > 1 ? ((mName || mProv || 'model') + ' · ' + n) : (mName || n),
            apiUrl: url,
            modelName: n,
            apiKeySource: mKeySrc || 'custom',
            customKey: mKeySrc === 'custom' ? mKey : '',
            addToChain: mChain,
          }))
          addModels(list).then(() => { setMModel(''); setMKey(''); setMName('') })
        }
        return h('div', { 'data-bd-addmodel': '' },
          h('div', { 'data-bd-formgrid': '' },
            h('div', { 'data-bd-field': '' }, h('label', null, '供应商'),
              Select({ value: mProv, onChange: (v) => { setMProv(v); setMUrl(PROV_URLS[v] != null ? PROV_URLS[v] : '') } },
                provs.map(([v, label]) => h('option', { value: v, key: v }, label)))),
            h('div', { 'data-bd-field': '' }, h('label', null, 'API 地址'),
              Input({ value: mUrl || '', onChange: setMUrl, placeholder: 'https://…/v1' })),
            h('div', { 'data-bd-field': '' }, h('label', null, '显示名称'),
              Input({ value: mName || '', onChange: setMName, placeholder: '我的主模型' })),
            h('div', { 'data-bd-field': '' }, h('label', null, '模型名（可多个）'),
              Input({ value: mModel || '', onChange: setMModel, placeholder: 'deepseek-v4-pro, deepseek-v4.1-flash' }),
              h('span', { className: 'hint' }, '同一个 key 下多个模型用逗号或换行分开')),
            h('div', { 'data-bd-field': '' }, h('label', null, '密钥来源'),
              Select({ value: mKeySrc, onChange: setMKeySrc },
                [['custom', '自己填 key'], ['preset', '用 DSH 里已有的 key（同供应商）']].map(([v, label]) => h('option', { value: v, key: v }, label)))),
            h('div', { 'data-bd-field': '' }, h('label', null, 'API Key'),
              Input({ value: mKey || '', onChange: setMKey, placeholder: 'sk-…', type: 'password' }))),
          h('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', color: 'var(--t2)', marginTop: '4px' } },
            h('input', { type: 'checkbox', checked: mChain, onChange: (e) => setMChain(Boolean(e.target.checked)) }), '同时加入降级链'),
          h('div', { style: { marginTop: '12px' } },
            h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: onAdd }, '加入模型')))
      }

      const renderLogs = () => {
        const items = (rawlog || []).filter((l) => (logLv === 'ALL' || l.lv === logLv) && (!search.trim() || (l.msg || '').toLowerCase().indexOf(search.trim().toLowerCase()) >= 0))
        const box = h('div', { 'data-bd-logbox': '' }, items.length
          ? items.map((l, i) => h('div', { key: i, 'data-bd-logline': '' }, h('span', { className: 'tm' }, l.t || ''), h('span', { className: 'lv ' + (l.lv || '') }, l.lv || ''), h('span', { className: 'msg' }, l.msg || '')))
          : h('div', { 'data-bd-empty': '' }, '没有匹配的日志行'))
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '专业日志'), h('span', { className: 's' }, '原始日志，不加工；总览看大白话，这里看细节')),
          Card({ title: 'duty.log', sub: '只读' },
            h('div', { 'data-bd-cardhead': '' },
              h('div', { 'data-bd-filters': '' }, ['ALL', 'ERROR', 'WARN'].map((lv) => h('button', { key: lv, className: 'f' + (logLv === lv ? ' on' : ''), onClick: () => setLogLv(lv) }, lv === 'ALL' ? '全部' : (lv === 'ERROR' ? '错误' : '警告')))),
              h('div', { 'data-bd-cardhead': '' }, h('div', { style: { display: 'flex', alignItems: 'center', gap: '8px' } },
                h('button', { 'data-bd-sw': '', 'data-on': autoScroll ? '' : undefined, onClick: () => setAutoScroll((v) => !v) }), h('span', { style: { fontSize: '12px', color: 'var(--t2)' } }, '自动滚屏')),
                h('span', { className: 'sub' }, '共 ' + items.length + ' 行')))),
          Card({ title: null }, box))
      }

      const renderPersona = () => {
        const pmax = Math.max(100, Math.min(10000000, Number(cfg.personaMaxLen) || 8000))
        const used = (persona || '').length
        const over = used > pmax
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '人设'), h('span', { className: 's' }, 'AI 挑视频、写评论时按这张角色卡说话；改完下一轮生效')),
          Card({
            title: '角色卡（personaPrompt）',
            sub: used + ' / ' + pmax + ' 字' + (over ? '（超了，超出部分不生效）' : ''),
            right: over ? Tag({ c: 'amber', children: '超上限' }) : null,
          },
            h('textarea', { 'data-bd-persona': '', spellcheck: false, value: persona || '', onChange: (e) => { setPersona(e.target.value); setDirty((d) => ({ ...d, persona: true })) } }),
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'primary', onClick: savePersona }, '保存人设'),
              h('button', { 'data-bd-btn': '', className: 'ghost', onClick: () => { setDirty((d) => ({ ...d, persona: false })); setPersona(cfg.personaPrompt || '') } }, '撤销改动，重新载入')),
            h('div', { 'data-bd-setrow': '', style: { marginTop: '14px' } },
              h('div', { 'data-bd-txt': '' },
                h('div', { 'data-bd-lb': '' }, '字数上限（可自己调）'),
                h('div', { 'data-bd-ds': '' }, '默认 8000 字。下限 100、上限一千万——想写多长都行，填完立刻保存、下一轮生效。⚠️ 写太长可能超出模型上下文（很多模型 128k token ≈ 6 万字），那时接口会报错，这是模型那边的限制，插件不会替你砍')),
              h(NumInput, { value: pmax, min: 100, suffix: '字', width: 122, onCommit: (n) => saveOne('personaMaxLen', n) }),
              (used > 0 && used !== pmax)
                ? h('button', { 'data-bd-btn': '', className: 'ghost sm', style: { marginLeft: '10px' }, onClick: () => saveOne('personaMaxLen', Math.max(100, used)) }, '一把调到当前字数（' + used + '）')
                : null),
            pmax > 60000 ? h('div', { style: { fontSize: '11px', color: 'var(--amber, #d9a03f)', marginTop: '6px' } }, '当前上限 ' + pmax + ' 字，很可能超出模型上下文（模型那边会报错，插件不会替你砍）') : null,
            over ? h('div', { 'data-bd-callout': '', style: { marginTop: '8px', color: 'var(--amber, #d9a03f)' } },
              '⚠️ 你写了 ' + used + ' 字，但上限是 ' + pmax + ' 字：超出部分不会进入提示词。这是唯一会砍你内容的地方，而且明着写在这里——代码里原来那句 .slice(0, 8000) 已经删掉，别处不会再偷偷截断。') : null),
            h('div', { 'data-bd-callout': '' }, '上面文本框里就是插件实际使用的完整人格卡——没有摘要、没有截断，你写多少字就用多少字（当前上限 ' + pmax + ' 字，已用 ' + used + ' 字）。这个框也收文件路径：填一个 AGENTS.md 的路径，插件就会去读那个文件当人设。人设存在插件目录的 config.json 里，和 DSH 共用同一份；在这里改完，DSH 那边也是新的。'))
      }

      const renderChain = () => {
        const ep = chainDraft || []
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '降级链'), h('span', { className: 's' }, '越靠上越先用：没钱 / 没资源包 / 适配器没注册，自动往下切')),
          Card({ title: '模型排队', sub: '↑↓ 调顺序 · 点模型名去「模型与密钥」里加减' },
            ChainList({ endpoints: ep, strengthMap: cfg.chainStrength || {}, onStrength: setChainStrength, onReorder: (i, d) => { const arr = ep.slice(); const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; setChainDraft(arr) } }),
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: saveChainOrder }, '保存顺序'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => setPage('models') }, '去模型与密钥 ←'))))
      }

      const renderSafety = () => {
        const on = [cfg.autoComment, cfg.dmMode && cfg.dmMode !== 'off', cfg.replyToComments, cfg.transcribe, cfg.dmWatch].filter(Boolean).length
        const chips = [['noon', '午间 12:00–14:00'], ['night', '夜间 18:00–09:00']]
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '安全防护'), h('span', { className: 's' }, '防的是封号；改动和「设置」页实时同步')),
          Card({ title: '五道闸', sub: on + ' / 5 开着' },
            ToggleRow({ label: '自动评论并 @', note: '开着才会在别人视频下留评论；关了就只挑不发，不打扰任何人', on: !!cfg.autoComment, onChange: (v) => saveOne('autoComment', v) }),
            h('div', { 'data-bd-setrow': '' }, h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '私信投递'), h('div', { 'data-bd-ds': '' }, '关 = 不发私信；only = 只发私信不评论；both = 评论私信都发。私信有 500 字上限，超了会被接口拒')),
              Select({ value: cfg.dmMode || 'off', onChange: (v) => saveOne('dmMode', v) }, h('option', { value: 'off' }, '关闭'), h('option', { value: 'only' }, '只发私信'), h('option', { value: 'both' }, '评论 + 私信'))),
            ToggleRow({ label: '回复评论', note: '别人回复你的评论时，它接一句（每轮最多「每轮回复几条」条）。不保存上下文时它只看到对方那一句；想让它记得来龙去脉，到「设置 → 上下文与记忆」打开保留上下文', on: !!cfg.replyToComments, onChange: (v) => saveOne('replyToComments', v) }),
            ToggleRow({ label: '私信监察', note: '盯着有没有人私信你；查到新消息才回一句，平时不花 token', on: !!cfg.dmWatch, onChange: (v) => saveOne('dmWatch', v) })),
          Card({ title: '节奏控制（防机器纹身）', sub: null },
            ToggleRow({
              label: '定时值守（每 5 分钟看一次）',
              note: '关着 = 只在你点「立即跑一轮 / 试跑」时才动；开着 = 每 5 分钟自己跑一轮（还没到上限、在开启时段内才会真干活）。注意：打开「自动评论」不会顺带打开它',
              on: !!cfg.schedulerOn,
              onChange: (v) => saveOne('schedulerOn', v),
            }),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '跑哪些时段'),
                h('div', { 'data-bd-ds': '' }, '全天 7×24 = 不停；自定义时段 = 每天只在起止之间跑（跨夜也行，如 22:00→06:00）；官方谷时 = 只跑午间和夜间两个低谷段')),
              Select({ value: cfg.scheduleMode || (cfg.peakValley ? 'valley' : 'any'), onChange: (v) => saveOne('scheduleMode', v), minWidth: 150 },
                h('option', { value: 'any' }, '全天 7×24'),
                h('option', { value: 'window' }, '自定义时段'),
                h('option', { value: 'valley' }, '只在官方谷时'))),
            ((cfg.scheduleMode || (cfg.peakValley ? 'valley' : 'any')) === 'window') && h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '起止时间'), h('div', { 'data-bd-ds': '' }, '北京时间。到点自动停，到点自动开；跨夜会自己算，不用管日期')),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                Input({ type: 'time', defaultValue: cfg.activeStart || '09:00', onBlur: (e) => saveOne('activeStart', String(e.target.value || '09:00'), '开始时间') }),
                h('span', { style: { fontSize: '12px', color: 'var(--t3)' } }, '到'),
                Input({ type: 'time', defaultValue: cfg.activeEnd || '23:00', onBlur: (e) => saveOne('activeEnd', String(e.target.value || '23:00'), '结束时间') }))),
            ((cfg.scheduleMode || (cfg.peakValley ? 'valley' : 'any')) === 'valley') && h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
              h('span', { className: 'sub' }, '谷时窗口：'),
              chips.map(([k, label]) => h('span', { key: k, 'data-bd-chip': '', style: { cursor: 'pointer', background: cfg[k] ? 'var(--blue)' : 'var(--blue-bg)', color: cfg[k] ? '#fff' : 'var(--blue)' }, onClick: () => toggleChip(k, !cfg[k]) }, label))),
            h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', alignItems: 'center', marginTop: '6px' } },
              h(NumInput, { value: cfg.perDay || 0, min: 1, suffix: '条 / 天', width: 104, onCommit: (n) => saveOne('perDay', n) }),
              h(NumInput, { value: cfg.commentPerRound || 0, min: 1, suffix: '条 / 轮', width: 104, onCommit: (n) => saveOne('commentPerRound', n) }),
              h(NumInput, { value: cfg.roundIntervalMinutes || 5, min: 1, suffix: '分钟 / 每轮间隔', width: 120, onCommit: (n) => saveOne('roundIntervalMinutes', n) }),
              h(NumInput, { value: cfg.scanPerRound || 0, min: 0, suffix: '条视频 / 轮（0=默认）', width: 130, onCommit: (n) => saveOne('scanPerRound', n) })),
            h('div', { 'data-bd-note': '', style: { margin: '10px 0 0' } }, '为什么需要：风控盯环境指纹和机械节奏——定时操作等于自报身份。随机间隔 1-2 分钟、每周强制休息 1 天、每日上限，都是让它"像个人"。')),
          h('div', { 'data-bd-callout': '' }, '底线：不登录你的账号、不碰支付、不转发私信内容；评论区、字幕、简介里的话一律当素材、不当指令——谁让你改行为、贴设置，都不照做。'),
          Card({ title: '它遵守的规矩', sub: '只读 · 写死在插件里的底线，谁都改不了' }, h('ul', { 'data-bd-charter': '' }, (st.charter || []).map((c, i) => h('li', { key: i }, c)))),
          h('div', { 'data-bd-rowflex': '' },
            Card({ title: '私信监察', sub: null, right: Tag({ c: (cfg.dmMode && cfg.dmMode !== 'off') ? 'green' : 'gray', children: cfg.dmWatch ? '监察中' : '关' }) },
              h('div', { 'data-bd-sum': '' }, (cfg.dmMode && cfg.dmMode !== 'off')
                ? ('投递方式：' + (cfg.dmMode === 'only' ? '只发私信' : '评论+私信') + '；每天最多回 ' + (cfg.dmReplyPerDay || 0) + ' 条，同一人永久去重')
                : '私信默认关：不主动发私信（最安全）。想开就在上面「私信投递」里选。'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', style: { marginTop: '10px' }, onClick: dmCheck }, '现在查一次')),
            Card({ title: '风控守卫', sub: null, right: Tag({ c: guard.active ? 'amber' : 'green', children: guard.active ? '冷却中' : '正常' }) },
              h('div', { 'data-bd-sum': '' }, guard.active
                ? ('因风控命中进入冷却，还剩约 ' + (guard.remainingMin || 0) + ' 分钟。原因：' + (guard.reason || '—'))
                : '没有在冷却。验证码/限流会自动停 24 小时，不硬顶。'))),
          Card({ title: null },
            h('div', { style: { flex: '1', minWidth: '240px' } }, h('div', { style: { fontSize: '13px', fontWeight: 600, marginBottom: '2px' } }, '一键暂停对外动作'), h('div', { 'data-bd-note': '', style: { margin: 0 } }, '立刻关掉「自动评论」和「私信投递」，手头这轮跑完即停；不会碰账号里的任何东西')),
            h('div', { style: { display: 'flex', gap: '10px' } },
              pauseBak ? h('button', { 'data-bd-btn': '', className: 'ghost', onClick: resumeAll }, '恢复运行') : h('button', { 'data-bd-btn': '', className: 'danger', onClick: pauseAll }, '一键暂停'))))
      }

      /**
       * 设置类卡片池（2026-11-07 拆页）。
       * 所有卡片还是只写一份，入列时打一个「归哪个页面」的标签，末尾按当前页面挑出来。
       * 以前全堆在「设置」一页里 12 张卡，划半天；现在分到「找视频 / 设置 / 环境与更新」。
       */
      const renderSettings = (which) => {
        const kwList = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        // 关键词是"标签"型配置：加/删就**立刻保存**，不让用户再去找保存按钮
        // （以前要回车添加 + 滚到底部点保存，用户打了字以为加上了，实际没生效 → 跑轮被拒，2026-10-31 修）
        const kwSave = (arr) => {
          const clean = arr.map((x) => String(x || '').trim()).filter(Boolean)
          setKws(clean.join('\n'))
          setDirty((d) => ({ ...d, keywords: false }))
          saveOne('keywords', clean, '关键词')
        }
        const kwAdd = (v) => {
          const t = String(v || '').trim()
          if (!t) return false
          if (kwList.includes(t)) { toast_('「' + t + '」已经在列表里了'); return false }
          kwSave(kwList.concat([t]))
          return true
        }
        const kwDel = (i) => {
          const arr = kwList.slice(); arr.splice(i, 1); kwSave(arr)
        }
        const kwChips = h('div', { 'data-bd-chips': '' },
          kwList.map((k, i) => h('span', { key: i, 'data-bd-chip': '' }, k,
            h('button', { className: 'x', onClick: () => kwDel(i) }, '×'))))
        /* head = 每个页面都要带的窄栏提示；tail = 每个页面底部都能直接保存 */
        const blocks = []
        let curGroup = 'head'
        const _push = Array.prototype.push.bind(blocks)
        const put = (g, el) => _push({ g, el })
        if (narrow) put('head', h('div', { 'data-bd-banner': '' },
          h('span', null, '这个面板被 DSH 挤得比较窄。想看得舒服，点右边在浏览器里全宽打开'),
          h('button', { onClick: openConsole }, '全宽打开')))

        /* 安装任务的进度视图：进度条 + 当前阶段 + 最近日志（只显示指定 kind 的） */
        const ej = st.envJob || {}
        const envRunning = Boolean(ej.running && ['auto', 'deps', 'python'].includes(ej.kind))
        const asrRunning = Boolean(ej.running && ej.kind === 'asr')
        const envJobView = (kinds) => {
          if (!ej.phase || ej.phase === 'idle' || !kinds.includes(ej.kind)) return null
          const bad = Boolean(ej.error)
          const tint = bad ? 'var(--red-tx)' : (ej.done ? 'var(--green-tx)' : undefined)
          return h('div', { 'data-bd-envjob': '', style: { marginTop: '12px' } },
            h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
              h('div', { 'data-bd-upbar': '' }, h('i', { style: { width: (ej.pct || 0) + '%', background: tint } })),
              h('span', { 'data-bd-ds': '', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, (ej.pct || 0) + '%')),
            h('div', { 'data-bd-ds': '', style: { marginTop: '6px', color: bad ? 'var(--red-tx)' : (ej.done ? 'var(--green-tx)' : 'var(--t2)') } },
              bad ? ('✖ ' + ej.error) : (ej.done ? '✔ 装好了（重启 DSH 后状态会刷新）' : ej.phase)),
            (ej.log || []).length ? h('div', {
              'data-bd-envlog': '',
              style: { marginTop: '8px', fontSize: '11.5px', color: 'var(--t2)', whiteSpace: 'pre-wrap', lineHeight: 1.7, maxHeight: '170px', overflow: 'auto', background: 'var(--gray-bg)', borderRadius: '6px', padding: '8px 10px' },
            }, ej.log.join('\n')) : null)
        }

        curGroup = 'find'   // ① 找视频
        /* 监听关键词 */
        put(curGroup, Card({
          title: '监听关键词', sub: '加完立刻生效，点 × 删掉',
          right: kwList.length ? Tag({ c: 'gray', children: kwList.length + ' 个' }) : Tag({ c: 'amber', children: '还没填 · 跑不了' }),
        },
          kwChips,
          h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center' } },
            h('div', { 'data-bd-input': '', style: { flex: 1 } }, h('input', {
              placeholder: '输入关键词，比如「一只炎鸽」', value: newKw,
              onChange: (e) => setNewKw(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); if (kwAdd(newKw)) setNewKw('') } },
              // 失焦也自动加上：避免"打了字但没回车，以为已经加上了"（用户就踩过这个坑）
              onBlur: () => { if (String(newKw || '').trim() && kwAdd(newKw)) setNewKw('') },
            })),
            h('button', {
              'data-bd-btn': '', className: 'primary sm', disabled: !String(newKw || '').trim(),
              onClick: () => { if (kwAdd(newKw)) setNewKw('') },
            }, '添加')),
          h('div', { 'data-bd-note': '', style: { margin: '10px 0 0' } },
            kwList.length
              ? 'AI 拿这些词去 B站 搜视频。加/删都立刻保存，不用再点别的按钮。'
              : '⚠️ 一个都没填的话，「跑一轮」会被直接拒绝（它不知道该搜什么）。在上面输入一个词，按回车或点「添加」。')))

        /* 视频从哪来（2026-10-31 加：固定关键词会一直捞同一个池子） */
        put(curGroup, Card({ title: '视频从哪来', sub: '固定关键词会一直捞同一个池子，推荐流是活水' },
          ToggleRow({ label: '首页个性化推荐流', note: 'B站按你这个账号的口味实时推的视频，最新最相关。它和关键词是互补的：关键词决定你「搜什么」，推荐流反映你「平时爱看什么」', on: cfg.useHomeFeed !== false, onChange: (v) => saveOne('useHomeFeed', v) }),
          ToggleRow({ label: '关键词搜索', note: '用上面填的关键词去搜。可以关掉、只用推荐流。注意：关键词本身也会慢慢培养账号的推荐口味——你常搜什么、常看什么，首页推荐就越贴近什么', on: cfg.useKeywordSearch !== false, onChange: (v) => saveOne('useKeywordSearch', v) }),
          ToggleRow({ label: '两级筛选（省 token）', note: '先把一批视频的标题/时长/播放一次性粗筛，只对最值得的几条取字幕深判——省掉约 80% 的字幕请求和模型调用', on: cfg.triage !== false, onChange: (v) => saveOne('triage', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '细看几条'), h('div', { 'data-bd-ds': '' }, '粗筛之后真正取字幕深判的条数；越大越不容易漏，但越费 token')),
            Stepper({ value: (cfg.triageTop || 5) + ' 条', onStep: (d) => step('triageTop', d, ' 条') }))))

        curGroup = 'social' // ② 评论·私信
        /* 评论与互动 */
        put(curGroup, Card({ title: '评论与互动', sub: null },
          ToggleRow({ label: '自动评论并 @', note: '开着才会发评论；关了就只挑不发，不打扰任何人', on: !!cfg.autoComment, onChange: (v) => saveOne('autoComment', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '@ 谁'), h('div', { 'data-bd-ds': '' }, '要 @ 的人（不填就不 @）。注意：@ 也是"通知"，刷太多会被当成骚扰')),
            Input({ value: mentionDraft != null ? mentionDraft : (cfg.mentionName || ''), onChange: (v) => { setMentionDraft(v); setDirty((d) => ({ ...d, mentionName: true })) }, placeholder: '@某人' })),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '什么时候 @'),
              h('div', { 'data-bd-ds': '' }, '默认交给模型自己判断：它觉得该叫人（真的在跟对方说话、想提醒对方看）才写 @，纯吐槽就不写。程序不插手，也不用你定规则')),
            Select({ value: cfg.mentionMode || 'model', onChange: (v) => saveOne('mentionMode', v), minWidth: 160 },
              h('option', { value: 'model' }, '模型自己判断（推荐）'),
              h('option', { value: 'auto' }, '按关键词兜底（出现"你/回复"才 @）'),
              h('option', { value: 'always' }, '每条都 @'),
              h('option', { value: 'never' }, '从不 @'))),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每轮最多评论'), h('div', { 'data-bd-ds': '' }, '一轮里最多发几条；超出自动暂停，防止刷太猛被盯上')),
            Stepper({ value: (cfg.commentPerRound || 0) + ' 条', onStep: (d) => step('commentPerRound', d, ' 条') })),
          ToggleRow({ label: '点赞（值得看）', note: '发完评论后，评级是「值得看」就顺手点个赞。不增加评论数，但让账号更像真人', on: !!cfg.autoLike, onChange: (v) => saveOne('autoLike', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '投币：不代投，只记提醒'),
              h('div', { 'data-bd-ds': '' }, 'B站对「投币」这个动作要二级人机验证（-401 非法访问 / -403 账号异常），插件过不了也不该去绕。所以投币改成了提醒：群友点名「投币 BV号」只会在下面记一笔，你自己在 B站 App 投完，回来点「我投好了」',  ))),
          ToggleRow({ label: '回复评论', note: '别人回复你的评论时，它接一句（每轮最多「每轮回复几条」条）。不保存上下文时它只看到对方那一句；想让它记得来龙去脉，到「设置 → 上下文与记忆」打开保留上下文', on: !!cfg.replyToComments, onChange: (v) => saveOne('replyToComments', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每轮回复几条'), h('div', { 'data-bd-ds': '' }, '回评论的轮次上限；每条 100 字以内')),
            Stepper({ value: (cfg.replyPerRound || 0) + ' 条', onStep: (d) => step('replyPerRound', d, ' 条') }))))

        /* 待手动投币：投币被 B站风控拦住之后，改成"记提醒、人来投" */
        {
          const box = h('div', { 'data-bd-coinlist': '', style: { fontSize: '12px', color: 'var(--t2)' } }, '点右边「刷新」看看有没有群友点名的投币提醒')
          const refreshCoin = async () => {
            box.textContent = '正在读…'
            try {
              const d = await jpost('/coin/pending', {})
              const items = (d && d.items) || []
              box.textContent = ''
              if (!items.length) { box.textContent = '现在没有待投的，干净'; return }
              for (const it of items) {
                const when = String(it.at || '').replace('T', ' ').slice(0, 16)
                box.appendChild(h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', padding: '6px 0', borderTop: '1px solid var(--line, #eee)' } },
                  h('a', { href: 'https://www.bilibili.com/video/' + it.bvid, target: '_blank', rel: 'noreferrer', style: { fontWeight: '600' } }, it.bvid),
                  h('span', {}, '来自 ' + (it.from || 'qq') + '，' + when),
                  h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: async () => {
                    try { await jpost('/coin/done', { bvid: it.bvid }); toast_('已划掉 ' + it.bvid); refreshCoin() }
                    catch (e) { toast_('划不掉：' + (e && e.message ? e.message : e)) }
                  } }, '我投好了')))
              }
            } catch (e) { box.textContent = '读不到：' + (e && e.message ? e.message : e) }
          }
          put(curGroup, Card({ title: '待手动投币（插件不代投）',
            sub: '群友在 QQ 里点名「投币 BV号」时会记到这里。B站投币要人机验证，只能你自己在 App 里投，投完点一下划掉。',
            right: h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: refreshCoin }, '刷新') }, box))
        }

        curGroup = 'find'   // 回到「找视频」：挑几条、要不要转写都属于怎么找片
        /* 每天挑与转写 */
        {
          const asr = st.asr || {}
          const cloud = asr.cloud || {}
          const mode = asr.mode === 'cloud' ? 'cloud' : 'local'
          put(curGroup, Card({
            title: '每天挑与转写', sub: null,
            right: Tag({
              c: asr.ready ? 'green' : 'gray',
              children: asr.ready ? ('转写就绪 · ' + (asr.backend || '')) : (mode === 'cloud' ? '云端还没配好' : '可选功能 · 未装'),
            }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每天最多挑几条'), h('div', { 'data-bd-ds': '' }, '全天总量：AI 一轮里从候选视频里挑出值得看的条数。挑满就收工，不贪多')),
              h(NumInput, { value: cfg.perDay || 0, min: 0, max: 999, suffix: '条 / 天', onCommit: (n) => saveOne('perDay', n) })),
            ToggleRow({
              label: '没字幕时转写',
              note: asr.ready
                ? ('没字幕的视频会先下载音频转成文字再看；当前走 ' + (asr.backend || '转写后端'))
                : ('可选功能，没装也不影响挑视频和评论——会用标题/简介/封面识图兜底判断'),
              on: !!cfg.transcribe, onChange: (v) => saveOne('transcribe', v),
            }),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '转写方式'),
                h('div', { 'data-bd-ds': '' }, '本地＝装在自己机器上（约 200MB，手机常装不下）；云端＝填个 API，几分钱一条，不用装东西')),
              Select({ value: mode, onChange: (v) => saveOne('asrMode', v), minWidth: 140 },
                h('option', { value: 'local' }, '本地（要装）'), h('option', { value: 'cloud' }, '云端 API'))),

            asr.ready ? h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', disabled: asrChecking, onClick: checkAsr },
                asrChecking ? '自检中…' : '转写自检'),
              asrCheck ? h('span', {
                'data-bd-ds': '',
                style: { fontSize: '12px', color: asrCheck.ok ? 'var(--green-tx)' : 'var(--red-tx)' },
              }, asrCheck.ok
                ? ('可用：' + (asrCheck.backend || '') + ' ' + (asrCheck.version || '') + (asrCheck.ffmpeg ? ' · ffmpeg ✓' : ' · 无 ffmpeg（faster-whisper 自带解码，通常不影响）'))
                : ('不可用：' + (asrCheck.error || ''))) : null) : null,
            mode === 'cloud'
              ? h('div', null,
                h('div', { 'data-bd-setrow': '' },
                  h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API 地址'),
                    h('div', { 'data-bd-ds': '' }, '填到 /v1 就行，会自动补 /audio/transcriptions。例：https://api.siliconflow.cn/v1')),
                  h(DraftInput, { value: cfg.asrCloudUrl || '', onCommit: (v) => saveOne('asrCloudUrl', v.trim()), placeholder: 'https://api.siliconflow.cn/v1' })),
                h('div', { 'data-bd-setrow': '' },
                  h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '模型名'),
                    h('div', { 'data-bd-ds': '' }, '如 FunAudioLLM/SenseVoiceSmall（硅基流动）、whisper-1（OpenAI）')),
                  h(DraftInput, { value: cfg.asrCloudModel || '', onCommit: (v) => saveOne('asrCloudModel', v.trim()), placeholder: 'FunAudioLLM/SenseVoiceSmall' })),
                h('div', { 'data-bd-setrow': '' },
                  h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API Key'),
                    h('div', { 'data-bd-ds': '' }, cloud.hasKey ? '已存过 key，留空就不改' : '还没填过')),
                  h(DraftInput, { value: '', type: 'password', onCommit: (v) => { if (v.trim()) saveOne('asrCloudKey', v.trim()) }, placeholder: cloud.hasKey ? '已存 key（留空不变）' : 'sk-…' })),
                h('div', { 'data-bd-note': '', style: { marginTop: '8px' } },
                  '支持任何 OpenAI 兼容接口——硅基流动、OpenAI、你自建的都行，不是只能用它一家。',
                  h('div', { style: { marginTop: '6px' } }, '省钱提示：硅基流动的 FunAudioLLM/SenseVoiceSmall 有免费用量（以官网为准），够日常听视频用。')))
              : h('div', null,
                asr.ready ? null : h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center', marginTop: '10px' } },
                  h('button', {
                    'data-bd-btn': '', className: 'primary sm', disabled: asrRunning,
                    onClick: () => installEnv('asr'),
                  }, asrRunning ? '安装中…' : '一键安装转写后端'),
                  h('span', { 'data-bd-ds': '', style: { fontSize: '12px', color: 'var(--t2)' } }, '约 200MB，装完首次转写还要下模型')),
                asr.ready ? null : h('div', { 'data-bd-note': '', style: { marginTop: '8px' } },
                  '装不上也别纠结：把上面的「转写方式」换成云端 API，或者干脆不转写——会用标题/简介/封面识图兜底。')),
            envJobView(['asr']),
            mode === 'local' ? h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '本地模型大小'), h('div', { 'data-bd-ds': '' }, 'small 最快、large 最准也最慢（只影响本地转写）')),
              Select({ value: cfg.asrModel || 'small', onChange: (v) => saveOne('asrModel', v), minWidth: 130 },
                h('option', { value: 'small' }, 'small'), h('option', { value: 'medium' }, 'medium'), h('option', { value: 'large' }, 'large'))) : null))
        }

        curGroup = 'social'
        /* 私信 */
        put(curGroup, Card({ title: '私信', sub: null },
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '投递方式'), h('div', { 'data-bd-ds': '' }, '日报送到哪：只发公开评论 / 只发私信 / 两者都发')),
            Select({ value: cfg.dmMode || 'off', onChange: (v) => saveOne('dmMode', v) },
              h('option', { value: 'off' }, '只发公开评论'), h('option', { value: 'only' }, '只发私信'), h('option', { value: 'both' }, '评论 + 私信'))),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '私信发给谁'), h('div', { 'data-bd-ds': '' }, '接收者的 UID（你的小号或大号）。0 = 没配——没配的话监察只看看、私信也发不出去')),
            Input({ value: dmUidDraft != null ? dmUidDraft : (cfg.dmUid != null ? String(cfg.dmUid) : '0'), onChange: (v) => { setDmUidDraft(v); setDirty((d) => ({ ...d, dmUid: true })) }, placeholder: '0' })),
          ToggleRow({ label: '私信监察', note: '定期看有没有新私信；查到才处理，不花 token', on: !!cfg.dmWatch, onChange: (v) => saveOne('dmWatch', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '监察间隔（分钟）'), h('div', { 'data-bd-ds': '' }, '多久看一次私信')),
            Stepper({ value: (cfg.dmWatchMinutes || 0) + ' 分钟', onStep: (d) => step('dmWatchMinutes', d, ' 分钟') })),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每天回几条私信'), h('div', { 'data-bd-ds': '' }, '0 = 只监察不回；回太多像骚扰，建议 1-3')),
            Stepper({ value: (cfg.dmReplyPerDay || 0) + ' 条', onStep: (d) => step('dmReplyPerDay', d, ' 条') }))))

        /* 日报详略 + 收藏夹 */
        put(curGroup, Card({ title: '日报详略 · 收藏夹', sub: null },
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '报告级别'), h('div', { 'data-bd-ds': '' }, '完整 = 每个挑中的视频单独一段；薄薄两行 = 只列值不值得 + 链接；不写 = 不出日报文件，但判重表照记')),
            Select({ value: cfg.reportLevel || 'full', onChange: (v) => saveOne('reportLevel', v), minWidth: 130 },
              h('option', { value: 'full' }, '完整'), h('option', { value: 'brief' }, '薄薄两行'), h('option', { value: 'none' }, '不写'))),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '收藏夹 ID'), h('div', { 'data-bd-ds': '' }, '填了就把判为「值得看」的视频收进这个收藏夹（用插件里新加的 bili_favorite_add）；0 = 不收藏')),
            Input({ value: favDraft != null ? favDraft : (cfg.favFolderId != null ? String(cfg.favFolderId) : '0'), onChange: (v) => { setFavDraft(v); setDirty((d) => ({ ...d, favFolderId: true })) }, placeholder: '0' }))))

        curGroup = 'ai'     // ③ AI 与记忆
        /* 识图模型 */
        {
          const vs = st.vision || {}
          put(curGroup, Card({
            title: '识图模型（可选）', sub: '没字幕时让它看一眼封面，给判断补画面信息',
            right: Tag({ c: vs.ready ? 'green' : 'gray', children: vs.ready ? ('已配 · ' + (vs.model || '')) : '未配' }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API 地址'), h('div', { 'data-bd-ds': '' }, '智谱就是 https://open.bigmodel.cn/api/paas/v4')),
              Input({ value: vUrl || '', onChange: (v) => { setVUrl(v); setVisionTouched(true); setVisionDirty(true) }, placeholder: 'https://open.bigmodel.cn/api/paas/v4' })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '模型名'), h('div', { 'data-bd-ds': '' }, '免费视觉模型：glm-4v-flash / glm-4.6v-flash')),
              Input({ value: vModel || '', onChange: (v) => { setVModel(v); setVisionTouched(true); setVisionDirty(true) }, placeholder: 'glm-4v-flash' })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API Key'),
                h('div', { 'data-bd-ds': '' }, vs.hasKey
                  ? ('已存的 key 是 ' + (vs.keyHint || '••••') + ' —— 留空就继续用它，不会被清掉')
                  : '还没存过任何 key（留空 = 不启用识图）')),
              Input({
                value: vKey || '',
                onChange: (v) => { setVKey(v); setVisionTouched(true); setVisionDirty(true) },
                placeholder: vs.hasKey ? ('已存 ' + (vs.keyHint || '••••') + '，留空不变') : 'sk-…（还没存过）',
                type: 'password',
              })),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: () => saveVision({ apiUrl: String(vUrl || '').trim(), modelName: String(vModel || '').trim(), apiKey: String(vKey || '').trim() || ((cfg.visionModel || {}).apiKey || '') }) }, '保存识图模型'),
              visionDirty ? Tag({ c: 'amber', children: '改动还没保存' }) : null,
              h('span', { 'data-bd-ds': '' }, '配了以后：没字幕的视频会用封面图补一点画面信息'))))
        }

        /* 上下文与记忆 */
        {
          const mem = st.memory || {}
          const inThread = (cfg.contextMode === 'thread')
          put(curGroup, Card({ title: '上下文与记忆', sub: '默认：一条视频一个上下文，判完就忘' },
            ToggleRow({
              label: '保留每条视频的对话上下文',
              note: '关（默认）= 每条视频都当第一次见，视频之间也互不影响；开 = 每条视频记一份「我说过什么 / 谁回了什么」，下次能接着聊',
              on: inThread,
              onChange: (v) => saveOne('contextMode', v ? 'thread' : 'isolated'),
            }),
            h('div', { 'data-bd-sum': '', style: { marginTop: '4px', fontWeight: 600 } }, '关着的时候（默认）它怎么跑：'),
            h('ul', { 'data-bd-charter': '', style: { fontSize: '12.5px' } }, [
              '每次判断一条视频都是全新会话：模型只看到「你的人设 + 章程 + 这条视频的标题/简介/字幕」，看不到别的视频，也看不到自己上一轮说过什么',
              '唯一跨轮留下的是判重表（哪个视频、哪条评论处理过）——那只是"别再重复"的记号，不含任何对话内容',
              '好处：不会把上一条视频的观点带过来，不会越跑越"人设漂移"，token 也最省',
              '代价：同一条视频下你之前说过啥它不记得；别人回复你时，它不懂来龙去脉（只会看到对方那一句）',
            ].map((t, i) => h('li', { key: i }, t))),
            h('div', { 'data-bd-sum': '', style: { marginTop: '10px', fontWeight: 600, color: 'var(--amber-tx)' } }, '打开的代价与风险（想清楚再开）：'),
            h('ul', { 'data-bd-charter': '', style: { fontSize: '12.5px' } }, [
              '会在本地 threads/ 目录里存下别人的昵称和留言内容——这是别人的信息，属于隐私，用不着就点下面的「清空」',
              '每次多带一段上下文，token 会变多（实测每条视频多几百 token）',
              '容易"顺着自己前面说过的话往下圆"：前面判断错了，后面会接着错、还不好改口',
              '记录会越攒越多，不清理就一直是历史包袱',
            ].map((t, i) => h('li', { key: i, style: { color: 'var(--t2)' } }, t))),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
              h('span', { 'data-bd-ds': '', style: { fontSize: '12px', color: 'var(--t2)' } }, mem.mode === 'thread'
                ? ('当前：已存 ' + (mem.count || 0) + ' 条视频 / ' + (mem.turns || 0) + ' 轮对话 / ' + ((mem.bytes || 0) / 1024).toFixed(1) + ' KB')
                : '当前：没有保存任何对话上下文（只剩判重表）'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: clearMemory }, '清空所有上下文'))))
        }

        curGroup = 'env'    // ④ 运行·更新
        /* 运行环境 */
        {
          const v = st.venv || {}
          // 就绪判定：venv 就绪 或 系统里已有"带依赖的解释器"（baseWithDeps）都算。
          // 之前只看 venvReady，"系统 Python 直接能用"这种情况会被误标成「待安装」（2026-10-31 修）
          const ready = Boolean(st.venvReady || v.baseWithDeps)
          const where = v.venvReady ? v.venvPath : (v.baseWithDeps || '')
          // 分四种情况说人话：就绪 / venv在但依赖缺 / 有Python待装依赖 / 真没找到
          const desc = ready
            ? ('已就绪 · ' + (where || '系统 Python') + '（bilibili-api / mcp / aiohttp / qrcode 都在）')
            : v.venvExists
              ? ('插件自己的 venv 已经建好了（' + (v.venvPath || '') + '），但依赖还没装全 —— 首次登录或跑一轮时会自动补，约 1-2 分钟，需联网')
              : v.basePython
                ? ('有 Python（' + v.basePython + '），但还没装依赖 —— 首次登录或跑一轮时会自动装，约 1-2 分钟，需联网')
                : '没找到 Python 3。点下面的「重新检测」能看到具体试过哪些路径；确认真的没装的话，装一个 Python 3.10+ 即可'
          put(curGroup, Card({
            title: '运行环境', sub: '依赖插件自己装，不用你手动 pip',
            right: Tag({ c: ready ? 'green' : 'amber', children: ready ? '就绪' : '待安装' }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'Python 依赖'), h('div', { 'data-bd-ds': '' }, desc)),
              h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap' } },
                ready ? null : h('button', {
                  'data-bd-btn': '', className: 'primary sm', disabled: envRunning,
                  onClick: () => installEnv('auto'),
                }, envRunning ? '安装中…' : (v.basePython ? '一键安装依赖' : '一键装好（含 Python）')),
                h('button', {
                  'data-bd-btn': '', className: 'ghost sm', disabled: envBusy,
                  onClick: recheckEnv,
                }, envBusy ? '检测中…' : '重新检测'))),
            envJobView(['auto', 'deps', 'python']),
            envDiag ? h('details', { style: { marginTop: '4px' } },
              h('summary', { style: { fontSize: '12px', color: 'var(--blue)', cursor: 'pointer' } }, '看检测细节（试过哪些 Python）'),
              h('div', { 'data-bd-tech': '', style: { marginTop: '8px' } },
                '平台 ' + (envDiag.platform || '?') + '　找到：' + (envDiag.found ? (envDiag.found.cmd + '（' + envDiag.found.ver + '）') : '没有任何可用的 Python') + '\n' +
                ((envDiag.tried || []).length ? '试过的解释器（✓ 通 / ✗ 失败）：\n' + envDiag.tried.map((t) => (t.ok ? '✓ ' : '✗ ') + t.cmd + (t.ok ? ('  ' + t.ver) : (t.why ? ('  — ' + t.why) : ''))).join('\n') + '\n' : '') +
                'venv：' + (envDiag.venv && envDiag.venv.exists ? ((envDiag.venv.ready ? '已就绪 · ' : '存在但依赖未装全 · ') + envDiag.venv.path) : '还没建'))) : null))
        }

        /* 高级（只读） */
        put(curGroup, Card({ title: '高级（只读，改文件才行）', sub: null },
          h('div', { 'data-bd-sum': '' },
            ['pythonPath', 'dshBin', 'headlessProfile', 'workspace'].map((k) => k + '：' + (cfg[k] || '（空）')).join('\n') + '\noverlayMcp：' + (cfg.overlayMcp ? '开' : '关'))))

        /* 版本与更新（自己造的那套：DSH 自带的「检查更新」只更新 DSH 自己） */
        {
          const base = upRes || st.update || {}
          const cur = base.current || st.version || '0.0.0'
          const mode = upMode || base.mode || 'auto'
          const customVal = upCustom != null ? upCustom : (base.custom || '')
          const srcList = [['auto', '自动（挨个试，通了就用）'], ...(base.sources || []).map((s) => [s.id, s.label])]
          const triedList = base.tried || []
          const autoOn = base.autoCheck !== false
          const job = st.selfUpdate || {}
          const jobRunning = Boolean(job.running)
          put(curGroup, Card({
            title: '版本与更新',
            sub: 'DSH 自带的「检查更新」更新的是 DSH 软件本身，这个是专门给本插件用的',
            right: Tag({
              c: upBusy ? 'gray' : (base.hasUpdate ? 'amber' : (base.ok ? 'green' : 'gray')),
              children: upBusy ? '正在检查…' : (base.hasUpdate ? ('有新版本 v' + base.latest) : (base.ok ? ('已是最新 · v' + base.latest) : '还没查到')),
            }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '当前版本'), h('div', { 'data-bd-ds': '' }, '你手上装的是这个')),
              Tag({ c: 'gray', children: 'v' + cur })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' },
                h('div', { 'data-bd-lb': '' }, '包身份'),
                h('div', { 'data-bd-ds': '' }, '两个版本长得几乎一样，装错包时版本号会对不上。这里显示的就是你实际装的包：'
                  + (st.pkg ? String(st.pkg) : '未知') + (String(st.pkg || '').indexOf('mobile') >= 0 ? '（手机版 ✓）' : '（电脑版 —— 手机上建议换装手机版）'))),
              Tag({ c: String(st.pkg || '').indexOf('mobile') >= 0 ? 'green' : 'amber', children: String(st.pkg || '').indexOf('mobile') >= 0 ? '手机版' : '电脑版' })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '最新版本'),
                h('div', { 'data-bd-ds': '' }, base.ok
                  ? ('GitHub 仓库里是 v' + base.latest + (base.hasUpdate ? '，比你手上的新' : '，和你手上一样') + (base.source ? ('（走的是：' + base.source + '）') : ''))
                  : '没连上 GitHub。换下面的加速源再点一次「立即检查更新」')),
              Tag({ c: base.hasUpdate ? 'amber' : (base.ok ? 'green' : 'gray'), children: base.ok ? ('v' + base.latest) : '未知' })),
            base.hasUpdate ? h('div', { 'data-bd-note': '', style: { margin: '0 0 12px' } },
              h('div', null, '发现新版本 v' + base.latest + '。点「一键更新」它会自己下载并替换文件，你的配置和登录凭证都不会被动；也可以自己下 zip 手动导入。'),
              (job.phase && job.phase !== 'idle') ? h('div', { style: { marginTop: '10px' } },
                h('div', { style: { display: 'flex', alignItems: 'center', gap: '10px' } },
                  h('div', { 'data-bd-upbar': '' }, h('i', { style: { width: (job.pct || 0) + '%', background: job.error ? 'var(--red-tx)' : (job.done ? 'var(--green-tx)' : undefined) } })),
                  h('span', { 'data-bd-ds': '', style: { whiteSpace: 'nowrap', fontWeight: 600 } }, (job.pct || 0) + '%')),
                h('div', { 'data-bd-ds': '', style: { marginTop: '6px', color: job.error ? 'var(--red-tx)' : (job.done ? 'var(--green-tx)' : 'var(--t2)') } },
                  job.error ? ('✖ ' + job.msg) : (job.done ? ('✔ ' + job.msg) : job.msg))) : null,
              h('div', { style: { marginTop: '10px', display: 'flex', gap: '12px', flexWrap: 'wrap', alignItems: 'center' } },
                h('button', { 'data-bd-btn': '', className: 'primary sm', disabled: jobRunning, onClick: applyUpdate }, jobRunning ? '更新中…' : ('⚡ 一键更新到 v' + base.latest)),
                h('a', { 'data-bd-link': '', href: base.zipUrl, target: '_blank', rel: 'noopener' }, '手动下 zip ↗'),
                h('a', { 'data-bd-link': '', href: base.homepage, target: '_blank', rel: 'noopener' }, '去 GitHub 看改动 ↗'))) : null,
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '更新源'), h('div', { 'data-bd-ds': '' }, '查不到就换一个；下面是刚才每个源的实测结果')),
              Select({ value: mode, onChange: (v) => { setUpMode(v); if (v === 'custom') { saveUpOption({ mode: 'custom', custom: customVal }) } else { setUpCustom(''); saveUpOption({ mode: v, custom: '' }) } } },
                srcList.map(([v, label]) => h('option', { value: v, key: v }, label)))),
            mode === 'custom' ? h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '自定义代理地址'), h('div', { 'data-bd-ds': '' }, '填代理前缀（比如 ghfast.top）或完整地址都行；它会替我们去问 GitHub 的版本文件')),
              Input({ value: customVal, onChange: (v) => setUpCustom(v), placeholder: 'ghfast.top 或 https://你的代理/…/package.json' })) : null,
            triedList.length ? h('div', { 'data-bd-sum': '', style: { margin: '4px 0 0', fontSize: '12px' } },
              '刚才试过的源：' + triedList.map((t) => t.id + (t.ok ? ' ✓ 通了' : ' ✗ ' + (t.why || '失败'))).join('；')) : null,
            ToggleRow({
              label: '每 6 小时自动检查',
              note: '后台悄悄查一次，查到新版才会在插件日志里提一句；关掉就只能手动点按钮',
              on: autoOn,
              onChange: (v) => { setUpRes((p) => ({ ...(p || {}), autoCheck: v })); saveUpOption({ autoCheck: v }) },
            }),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '10px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: () => doUpdateCheck(), disabled: upBusy }, upBusy ? '正在检查…' : '立即检查更新'),
              mode === 'custom' ? h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => doUpdateCheck({ mode: 'custom', custom: customVal }) }, '保存代理并重试') : null,
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => { setUpMode(null); setUpCustom(null); setUpRes(null) } }, '恢复默认'))))
        }

        /* ── 把小结发进 DSH 会话 ────────────────────────────────────────
           2026-11-08 走通了：插件自己给 DSH 的本机网页接口发请求（和 qq 机器人
           同一条路），已真机验证消息能出现在 DSH 会话里。所以这里是正式功能，
           开关和「试一下」放主视野；给开发者看的接口清单收在「看技术细节」。 */
        curGroup = 'debug'
        {
          const dp = st.dshPush || null
          const failed = Boolean(dp && dp.at && !dp.ok)
          // 会话用哪个模型：没发过就显示「准备用」，发过就显示这次实际用的
          const sm = st.dshSessionModel || null
          const used = (dp && dp.model) || null
          const shownModel = used || sm
          const modelLine = shownModel
            ? ('这个会话用：' + shownModel.label + (shownModel.fromPlugin ? '（你插件里配的）' : '（DSH 自带的备用模型）'))
            : ''
          const apiLines = st.dshApi ? Object.keys(st.dshApi).map((k) => {
            const v = st.dshApi[k]
            return '· ' + k + '：' + (!v ? '没有' : (Array.isArray(v) ? (v.length ? v.join('、') : '（空对象）') : String(v)))
          }).join('\n') : ''
          put(curGroup, Card({
            title: '把小结发进 DSH 会话',
            sub: '开着的话，每轮跑完 DSH 里会多一条记录，AI 会用你插件配的模型回一句',
            right: Tag({ c: failed ? 'amber' : 'gray', children: failed ? '没发出去' : '要 DSH 开着' }),
          },
            h('div', { 'data-bd-note': '', style: { margin: '0' } },
              '每轮跑完，插件会在 DSH 会话列表里建（或复用）一个「刷B站」会话，把结果发进去。DSH 会把它当成一条消息、让 AI 回一句，所以会花一点点模型额度。要 DSH 桌面端开着；独立版 App 里没有 DSH，用不了。'),
            modelLine ? h('div', { 'data-bd-note': '', style: { margin: '0' } },
              modelLine + '。发消息前会先帮 DSH 把模型指定好，不会再随手抓到你关掉的本地模型。' +
              (used && !used.applied ? '不过这次没指定成功，DSH 可能用了它自己的默认模型。' : '') +
              'DSH 这个接口会顺手把默认模型也设成同一个，想换回去在 DSH 右下角自己选一下就行。') : null,
            ToggleRow({
              label: '每轮跑完，自动往 DSH 会话里发一条小结',
              note: '默认关着。发不出去只记日志，完全不影响刷视频、发评论、写备注',
              on: !!cfg.dshSession, onChange: (v) => saveOne('dshSession', v),
            }),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'ghost sm', disabled: dshTesting, onClick: testDshPush },
                dshTesting ? '发送中…' : '试一下'),
              dp && dp.at ? h('span', {
                'data-bd-ds': '',
                style: { fontSize: '12px', color: dp.ok ? 'var(--green-tx)' : 'var(--amber-tx)' },
              }, dp.ok ? '✓ 已发进 DSH 会话（去会话列表看「刷B站」）' : ('✗ ' + (dp.error || '这条没发出去（不影响别的）'))) : null),
            h('button', {
              'data-bd-btn': '', className: 'ghost sm', style: { alignSelf: 'flex-start' },
              onClick: () => setDshDetail(!dshDetail),
            }, dshDetail ? '收起技术细节' : '看技术细节（给开发者）'),
            dshDetail ? h('div', { 'data-bd-tech': '' },
              (dp && dp.sessionId ? ('会话编号：' + dp.sessionId + '\n') : '') +
              (dp && dp.error ? ('说明：' + dp.error + '\n') : '') +
              (dp && dp.stage ? ('环节：' + dp.stage + '\n') : '') +
              (dp && dp.detail ? ('\n诊断信息：\n' + JSON.stringify(dp.detail, null, 2).slice(0, 1800) + '\n') : '') +
              '\n我们点名问过的几个服务对象（只读，不是权限清单）：\n' + (apiLines || '（没探到）')) : null))
        }

        /* 保存栏：三个页面底部都放一份，改完不用切页找保存 */
        curGroup = 'tail'
        put(curGroup, Card({ title: null },
          h('span', { className: 'sub' }, '所有修改写入插件同一份 config.json，DSH 那边同步生效'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px' } },
            h('button', { 'data-bd-btn': '', className: 'ghost', onClick: () => { setDirty({}); setPersona(null); setKws(null); setMentionDraft(null); setDmUidDraft(null); setFavDraft(null) } }, '重新载入'),
            h('button', { 'data-bd-btn': '', className: 'primary', onClick: saveSettings }, '保存设置'))))

        /* ── 按当前页签挑卡片：head 每页都带、tail 每页都带，中间只放本页的卡 ── */
        const PAGE_OF = { find: 'find', social: 'settings', ai: 'settings', env: 'env', debug: 'env' }
        const META = {
          find: ['找视频', '关键词、从哪捞片、每天挑几条 —— 找片相关的都在这'],
          settings: ['设置', '评论、私信、日报这些开关；改完即时生效，DSH 那边同步'],
          env: ['环境与更新', 'Python 依赖、检查更新，还有给开发者的排障信息'],
        }
        const key = META[which] ? which : 'settings'
        const [title, sub] = META[key]
        const withKeys = (arr, p) => arr.map((el, i) => (el && el.props ? React.cloneElement(el, { key: p + i }) : el))
        const headEls = withKeys(blocks.filter((b) => b.g === 'head').map((b) => b.el), 'h')
        const cards = withKeys(blocks.filter((b) => PAGE_OF[b.g] === key).map((b) => b.el), 'c')
        const tailEls = withKeys(blocks.filter((b) => b.g === 'tail').map((b) => b.el), 't')
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' },
            h('span', { className: 't' }, title),
            h('span', { className: 's' }, sub)),
          ...headEls, ...cards, ...tailEls)
      }

      /**
       * 发布页（2026-10-31 加）：豆包写的发布能力之前只在「网页控制台」有入口，
       * DSH 设置面板里根本找不到，用户以为功能丢了。这里补上同样的入口。
       * 注意：表单全部用非受控输入（点按钮时读 DOM），不在这里加 useState —— 见 Select 上方注释。
       */
      const renderPublish = () => {
        const readVal = (sel) => {
          try { const el = document.querySelector(sel); return el ? String(el.value || '').trim() : '' } catch { return '' }
        }
        // 今天的标题（给"没思路"的人当主题候选）
        const todayTitles = (() => {
          try {
            const md = String((st.report && st.report.markdown) || '')
            const out = []
            for (const m of md.matchAll(/标题：([^\n]{4,50})/g)) {
              const t = String(m[1]).split('（关键词')[0].trim()
              if (t && !out.includes(t)) out.push(t)
              if (out.length >= 4) break
            }
            return out
          } catch { return [] }
        })()
        const doDynamic = async () => {
          const text = readVal('[data-bd-dyninput] textarea')
          if (!text) return toast_('先写点内容再发')
          try {
            toast_('正在发动态…')
            const r = await jpost('/publish/dynamic', { text })
            toast_(r && r.ok ? '动态已发出去' : ('发动态失败：' + ((r && (r.error || r.message)) || '未知')))
          } catch (e) { toast_('发动态失败：' + String(e?.message ?? e)) }
        }
        const doVideo = async () => {
          const body = {
            videoPath: readVal('[data-bd-vidpath] input'),
            title: readVal('[data-bd-vidtitle] input'),
            desc: readVal('[data-bd-viddesc] input'),
            tid: Number(readVal('[data-bd-vidtid] input')) || 124,
            tags: readVal('[data-bd-vidtags] input') || 'AI',
            coverPath: readVal('[data-bd-vidcover] input'),
          }
          if (!body.videoPath) return toast_('先填视频文件的完整路径')
          if (!body.title) return toast_('先填标题')
          try {
            toast_('正在投稿，可能要一会儿…')
            const r = await jpost('/publish/video', body)
            toast_(r && r.ok ? '投稿已提交（B站还要审核）' : ('投稿失败：' + ((r && (r.error || r.message)) || '未知')))
          } catch (e) { toast_('投稿失败：' + String(e?.message ?? e)) }
        }

        /** 一键生成：AI 写文案 → 本地渲染 → 自动把路径填进下面的投稿表单 */
        const startGen = async () => {
          try {
            const r = await jpost('/publish/genvideo', { topic: readVal('[data-bd-vtopic] input') })
            if (!r || !r.ok) return toast_((r && r.error) || '启动失败')
            toast_('开始生成，进度看这张卡片')
            const tick = async () => {
              try {
                const s = await jget('/publish/genvideo/status')
                const bar = document.querySelector('[data-bd-vgbar]')
                const txt = document.querySelector('[data-bd-vgtxt]')
                const lg = document.querySelector('[data-bd-vglog]')
                if (bar) bar.style.width = Math.min(100, Number(s.pct) || 0) + '%'
                if (txt) txt.textContent = (s.error ? ('失败：' + s.error) : (s.done ? '完成' : (s.phase || ''))) + ' ' + (Number(s.pct) || 0) + '%'
                if (lg && s.log) lg.textContent = s.log.join('\n')
                if (s.done && s.outPath) {
                  const inp = document.querySelector('[data-bd-vidpath] input')
                  if (inp) { inp.value = s.outPath; inp.dispatchEvent(new Event('input', { bubbles: true })) }
                  toast_('生成好了，路径已自动填进「投稿视频」，下面可以直接放着看')
                  loadVideoList()
                  return
                }
                if (s.error) return
                setTimeout(tick, 1500)
              } catch { setTimeout(tick, 2500) }
            }
            setTimeout(tick, 1200)
          } catch (e) { toast_('启动失败：' + String(e?.message ?? e)) }
        }
        /** 把素材列表画进 DOM（不用 React state：这些组件是直接调用式，加 hooks 会崩） */
        const openAssets = async () => {
          try { const r = await jpost('/assets/reveal', {}); if (r && r.dir) toast_('已打开：' + r.dir) } catch { toast_('打不开素材文件夹') }
        }
        /** 自动发视频：拉队列画进 DOM（同 loadPosted 的直接 DOM 写法，不碰 hooks） */
        const loadAutoQ = async () => {
          const box = document.querySelector('[data-bd-apq]')
          if (!box) return
          try {
            const r = await jget('/publish/auto')
            const q = (r && r.queue) || []
            box.innerHTML = ''
            const tip = document.createElement('div')
            tip.style.cssText = 'font-size:12px;color:var(--t3);margin-top:6px'
            tip.textContent = q.length
              ? ('今天已发 ' + ((r && r.todayCount) || 0) + '/' + ((r && r.perDay) || 2) + ' 条 · 队列 ' + q.length + ' 条')
              : '队列是空的：生成一个视频后会自动排进来'
            box.appendChild(tip)
            const mkBtn = (txt, fn, danger) => {
              const b = document.createElement('button')
              b.className = 'ghost sm'; b.textContent = txt
              if (danger) b.style.color = 'var(--red, #e35d6a)'
              b.onclick = fn
              return b
            }
            const refresh = () => { setTimeout(loadAutoQ, 300) }
            for (const it of q.slice(0, 8)) {
              const row = document.createElement('div')
              row.style.cssText = 'padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-top:6px;background:var(--surface)'
              const t = document.createElement('div')
              t.style.cssText = 'font-size:12px;color:var(--t1);line-height:1.6'
              t.textContent = it.title + '（' + Math.round((it.size || 0) / 1048576) + ' MB）'
              const meta = document.createElement('div')
              const stTxt = { pending: '待处理', approved: '已确认，等间隔到点', working: '正在投…', done: '已发出 ' + (it.bvid || ''), failed: '失败：' + (it.error || ''), skipped: '已忽略' }[it.status] || it.status
              meta.style.cssText = 'font-size:11px;color:var(--t3);margin-top:3px'
              meta.textContent = stTxt
              const bar = document.createElement('div')
              bar.style.cssText = 'display:flex;gap:8px;margin-top:6px;flex-wrap:wrap'
              if (it.status === 'pending') {
                if ((r && r.mode) === 'review') {
                  bar.appendChild(mkBtn('✓ 确认投稿', async () => {
                    await jpost('/publish/auto/approve', { id: it.id }); toast_('已确认，间隔到点自动投'); refresh()
                  }))
                } else {
                  bar.appendChild(mkBtn('⚡ 立即投稿', async () => {
                    toast_('正在投稿…')
                    const rr = await jpost('/publish/auto/now', { id: it.id })
                    toast_(rr && rr.ok ? '已投出去（' + (rr.bvid || '见创作中心') + '）' : ('失败：' + ((rr && rr.error) || '未知')))
                    refresh()
                  }))
                }
                bar.appendChild(mkBtn('忽略', async () => { await jpost('/publish/auto/approve', { id: it.id, act: 'remove' }); refresh() }, true))
              }
              if (it.status === 'approved') {
                bar.appendChild(mkBtn('⚡ 不等了，现在投', async () => {
                  toast_('正在投稿…')
                  const rr = await jpost('/publish/auto/now', { id: it.id })
                  toast_(rr && rr.ok ? '已投出去（' + (rr.bvid || '见创作中心') + '）' : ('失败：' + ((rr && rr.error) || '未知')))
                  refresh()
                }))
              }
              if (bar.children.length) row.appendChild(bar)
              box.appendChild(row)
            }
          } catch { box.innerHTML = '<div style="font-size:12px;color:var(--t3)">队列读不到（后端没起来？）</div>' }
        }
        setTimeout(() => { try { if (document.querySelector('[data-bd-runs]')) loadRuns() } catch { /* noop */ } }, 200)
        setTimeout(() => { try { if (document.querySelector('[data-bd-posted]')) loadPosted() } catch { /* noop */ } }, 260)
        setTimeout(() => { try { if (document.querySelector('[data-bd-published]')) loadPublished() } catch { /* noop */ } }, 320)
        setTimeout(() => { try { syncAutoFromCfg(); planAuto() } catch { /* noop */ } }, 380)
        setTimeout(() => { try { if (document.querySelector('[data-bd-apq]')) loadAutoQ() } catch { /* noop */ } }, 440)
        // 卡片第一次渲染出来后自动拉一次列表（只拉一次，避免每次重渲染都打接口）
        setTimeout(() => {
          const box = document.querySelector('[data-bd-assets]')
          if (box && !box.dataset.loaded) { box.dataset.loaded = '1'; loadAssets() }
        }, 120)
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '发布'),
            h('span', { className: 's' }, '生成 / 发动态 / 投稿视频——内容你自己把关')),
          Card({ title: '一键生成视频（最简图文）', sub: 'AI 写文案 → 本地渲染，零额外 API 费；首次要装约 30MB 渲染组件' },
            h('div', { 'data-bd-input': '', 'data-bd-vtopic': '' },
              h('input', { placeholder: '可选：写个主题（例如「这周 AI 圈三个变化」）。注意：只有开了 AI 写稿主题才生效；模板模式固定用今天刷到的标题' })),
            h('div', { 'data-bd-ds': '', style: { marginTop: '6px' } }, '没思路？点一个当主题：'),
            todayTitles.length
              ? h('div', { style: { marginTop: '6px', display: 'flex', gap: '6px', flexWrap: 'wrap' } },
                todayTitles.map((t, i) => h('button', {
                  key: i, 'data-bd-btn': '', className: 'ghost sm',
                  onClick: () => {
                    const inp = document.querySelector('[data-bd-vtopic] input')
                    if (inp) { inp.value = t; inp.dispatchEvent(new Event('input', { bubbles: true })) }
                    toast_('已填入主题，可以自己改一下')
                  },
                }, t.slice(0, 14) + (t.length > 14 ? '…' : ''))))
              : h('div', { 'data-bd-ds': '', style: { marginTop: '4px', color: 'var(--t3)' } }, '（今天还没跑过，没有现成标题）'),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: startGen }, '生成视频'),
              h('div', { 'data-bd-upbar': '', style: { flex: 1, minWidth: '110px' } },
                h('i', { 'data-bd-vgbar': '', style: { width: '0%' } })),
              h('span', { 'data-bd-ds': '', 'data-bd-vgtxt': '', style: { whiteSpace: 'nowrap' } }, '空闲')),
            h('div', { 'data-bd-vglog': '', style: { marginTop: '8px', fontSize: '11.5px', color: 'var(--t2)', whiteSpace: 'pre-wrap', lineHeight: 1.7, maxHeight: '120px', overflow: 'auto', background: 'var(--gray-bg)', borderRadius: '6px', padding: '8px 10px' } }, '')),
          Card({
            title: '自动发视频',
            sub: '生成完自动投稿；总开关默认关，不开就永远不会自动发',
            right: Tag({ c: cfg.apOn ? 'green' : 'gray', children: cfg.apOn ? '开着' : '关着' }),
          },
            ToggleRow({
              label: '生成完的视频自动投稿',
              note: '开了以后：每生成一条新视频就排进队列，按下面的节奏自动投。模型、配音、声线都用本页「视频生成设置」的配置，不用另配一套',
              on: !!cfg.apOn, onChange: (v) => saveOne('apOn', v, '自动发视频'),
            }),
            cfg.apOn ? h('div', null,
              h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '投稿方式'),
                  h('div', { 'data-bd-ds': '' }, '全自动＝AI 写好文案直接投，你不用管；先审后发＝每条都要你在这张卡里点确认才投。B 站对短时间批量投稿风控很严，建议先审后发跑顺了再放开')),
                Select({ value: cfg.apMode === 'review' ? 'review' : 'auto', onChange: (v) => saveOne('apMode', v, '投稿方式'), minWidth: 150 },
                  h('option', { value: 'auto' }, '全自动（不用管）'),
                  h('option', { value: 'review' }, '先审后发（我确认）'))),
              h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '6px' } },
                h('div', { 'data-bd-input': '', style: { flex: '1', minWidth: '130px' } },
                  h('input', {
                    type: 'number', min: 1, max: 168, defaultValue: Number(cfg.apGapHours) || 6,
                    onBlur: (e) => saveOne('apGapHours', Math.max(1, Number(e.target.value) || 6), '最小间隔（小时）'),
                  })),
                h('div', { 'data-bd-input': '', style: { flex: '1', minWidth: '130px' } },
                  h('input', {
                    type: 'number', min: 1, max: 10, defaultValue: Number(cfg.apPerDay) || 2,
                    onBlur: (e) => saveOne('apPerDay', Math.max(1, Number(e.target.value) || 2), '每日上限'),
                  }))),
              h('div', { style: { display: 'flex', gap: '14px', flexWrap: 'wrap', marginTop: '4px' } },
                h('span', { 'data-bd-ds': '', style: { flex: '1', minWidth: '130px' } }, '↑ 两次投稿最少隔几小时'),
                h('span', { 'data-bd-ds': '', style: { flex: '1', minWidth: '130px' } }, '↑ 每天最多发几条')),
              h('div', { 'data-bd-note': '', style: { marginTop: '8px' } },
                '小提醒：这是 AI 生成的视频，发出去后最好去创作中心把「含 AI 生成内容」的声明勾上（这版接口还勾不了，得手动补一次）。'),
              h('div', { 'data-bd-apq': '', style: { marginTop: '8px' } })) : null),
          Card({ title: '视频生成设置', sub: '独立配置，和发评论的分开' },
            ToggleRow({ label: '配音（需联网）', note: '用微软 edge-tts 免费合成旁白（就是你要的「A 级 TTS」）；关掉就只有画面，渲染过程完全不联网（首次装 30MB 依赖还是要联网一次）', on: cfg.videoVoice !== false, onChange: (v) => saveOne('videoVoice', v) }),
            (cfg.videoVoice !== false) && h('details', {
              'data-bd-ttsadv': '',
              style: { marginTop: '4px' },
              open: BILI_UI_OPEN.tts,   // 受控：靠模块变量记状态，轮询重渲染不会把它关掉
              onToggle: (e) => { BILI_UI_OPEN.tts = Boolean(e.target.open) },
            },
              h('summary', { style: { cursor: 'pointer', fontSize: '12.5px', color: 'var(--blue)', padding: '8px 0', userSelect: 'none' } },
                '🎙 配音设置（点开：引擎 / 声线 / 语速 / 音调 / 试听）'),
              h('div', { style: { paddingLeft: '2px' } },
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '配音引擎'),
                  h('div', { 'data-bd-ds': '' }, '内置=微软免费声线（零下载，装了就能用）；外部=接你自己跑的开源 TTS（能出声线包/大肥鱼这类）。插件**不打包模型**，因为一个声线包就几百 MB~几 G，会让所有人下载都变慢')),
                Select({ value: cfg.videoTtsEngine || 'edge', onChange: (v) => saveOne('videoTtsEngine', v), minWidth: 160 },
                  h('option', { value: 'edge' }, '内置 微软（免下载）'),
                  h('option', { value: 'http' }, '外部 TTS 服务'))),
              (cfg.videoVoice !== false) && (cfg.videoTtsEngine === 'http') && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '外部 TTS 地址'),
                  h('div', { 'data-bd-ds': '' }, '填服务地址（POST {"text":...} 返回音频）。常见开源：GPT-SoVITS、ChatTTS、vits-simple-api。去 GitHub 搜名字就能下到，自己跑起来再把地址填这里')),
                h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
                  Input({ defaultValue: cfg.videoTtsUrl || '', placeholder: 'http://127.0.0.1:9880/tts', onBlur: (e) => saveOne('videoTtsUrl', String(e.target.value || '').trim(), 'TTS 地址') }),
                Input({ defaultValue: cfg.videoTtsModel || '', placeholder: '模型/角色名（可选，有些服务必填，如 s2）', onBlur: (e) => saveOne('videoTtsModel', String(e.target.value || '').trim(), 'TTS 模型') }),
                  h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => { const inp = document.querySelector('[data-bd-ttsUrl] input'); toast_('地址填好后点「试听」验证') } }, '提示'))),
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '配音声线'),
                  h('div', { 'data-bd-ds': '' }, '下拉是常用音色（快捷选择）；**想用别的，直接在下面输入框填音色代码**，比如 zh-CN-XiaoxiaoNeural、ja-JP-NanamiNeural（日语）、en-US-AriaNeural（英语）。完整列表搜「edge-tts 音色列表」')),
                Select({ value: cfg.videoVoiceName || 'zh-CN-XiaoxiaoNeural', onChange: (v) => { saveOne('videoVoiceName', v); toast_('声线改成 ' + v) }, minWidth: 170 },
                  h('option', { value: 'zh-CN-XiaoxiaoNeural' }, '晓晓（标准女声）'),
                  h('option', { value: 'zh-CN-YunxiNeural' }, '云希（年轻男声）'),
                  h('option', { value: 'zh-CN-YunyangNeural' }, '云野（播音男声）'),
                  h('option', { value: 'zh-CN-XiaoyiNeural' }, '晓伊（温柔女声）'),
                  h('option', { value: 'zh-CN-YunjianNeural' }, '云健（活力男声）'),
                  h('option', { value: 'zh-CN-liaoning-XiaobeiNeural' }, '晓北（东北口音女声）'),
                  h('option', { value: 'zh-CN-shaanxi-XiaoniNeural' }, '小妮（陕西口音女声）'),
                  h('option', { value: 'zh-CN-YunxiaNeural' }, '云夏（少年男声）')),
                Input({ defaultValue: cfg.videoVoiceName || '', placeholder: '也可直接填音色代码，如 ja-JP-NanamiNeural', onBlur: (e) => { const v = String(e.target.value || '').trim(); if (v) saveOne('videoVoiceName', v, '声线') } })),
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '语速'), h('div', { 'data-bd-ds': '' }, '微软原生支持，百分比如 -20%（慢）/ +20%（快）')),
                Select({ value: cfg.videoVoiceRate || '+0%', onChange: (v) => saveOne('videoVoiceRate', v), minWidth: 110 },
                  h('option', { value: '-30%' }, '-30% 很慢'),
                  h('option', { value: '-15%' }, '-15% 稍慢'),
                  h('option', { value: '+0%' }, '正常'),
                  h('option', { value: '+15%' }, '+15% 稍快'),
                  h('option', { value: '+30%' }, '+30% 很快')),
                Input({ defaultValue: cfg.videoVoiceRate || '', placeholder: '也可自填，如 +7% / -12%', onBlur: (e) => { const v = String(e.target.value || '').trim(); if (v) saveOne('videoVoiceRate', v, '语速') } })),
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '音调'), h('div', { 'data-bd-ds': '' }, '负值更低沉，正值更清亮/稚嫩')),
                Select({ value: cfg.videoVoicePitch || '+0Hz', onChange: (v) => saveOne('videoVoicePitch', v), minWidth: 110 },
                  h('option', { value: '-30Hz' }, '-30Hz 低沉'),
                  h('option', { value: '-15Hz' }, '-15Hz 稍低'),
                  h('option', { value: '+0Hz' }, '正常'),
                  h('option', { value: '+15Hz' }, '+15Hz 稍高'),
                  h('option', { value: '+30Hz' }, '+30Hz 清亮')),
                Input({ defaultValue: cfg.videoVoicePitch || '', placeholder: '也可自填，如 +22Hz', onBlur: (e) => { const v = String(e.target.value || '').trim(); if (v) saveOne('videoVoicePitch', v, '音调') } })),
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '音量'), h('div', { 'data-bd-ds': '' }, '配音音量，和视频画面的音量平衡')),
                Select({ value: cfg.videoVoiceVolume || '+0%', onChange: (v) => saveOne('videoVoiceVolume', v), minWidth: 110 },
                  h('option', { value: '-20%' }, '-20% 小声'),
                  h('option', { value: '+0%' }, '正常'),
                  h('option', { value: '+20%' }, '+20% 大声')),
                Input({ defaultValue: cfg.videoVoiceVolume || '', placeholder: '也可自填，如 -5%', onBlur: (e) => { const v = String(e.target.value || '').trim(); if (v) saveOne('videoVoiceVolume', v, '音量') } })),
              (cfg.videoVoice !== false) && h('div', { 'data-bd-setrow': '', 'data-bd-ttsrow': '' },
                h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '试听一下'), h('div', { 'data-bd-ds': '' }, '用上面这套配置念一句，听完再生成，省得白等')),
                h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                  h('button', { 'data-bd-btn': '', className: 'ghost sm', 'data-bd-ttsbtn': '', onClick: doTtsPreview }, '▶ 试听'),
                  h('span', { 'data-bd-ttsmsg': '', style: { fontSize: '11.5px', color: 'var(--t2)' } }, ''))))),
            h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '6px', flexWrap: 'wrap' } },
              h('span', { 'data-bd-ds': '', style: { fontSize: '12px' } }, '已生成的视频（占手机空间，看过的可以删）'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: clearVideos }, '🧹 全部清空')),
            h('div', { 'data-bd-vidlist': '', style: { marginTop: '6px' } }, ''),
            ToggleRow({ label: '用 AI 写稿', note: '关掉 = 用当天刷到的标题拼合集，不需要任何模型 / key', on: cfg.videoUseAI !== false, onChange: (v) => saveOne('videoUseAI', v) }),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '清晰度'), h('div', { 'data-bd-ds': '' }, '默认 720p；1080p 更清楚但更慢；480p 只建议极端省电（会糊）')),
              Select({ value: cfg.videoQuality || '720', onChange: (v) => saveOne('videoQuality', v), minWidth: 120 },
                h('option', { value: '720' }, '720p（默认）'),
                h('option', { value: '1080' }, '1080p'),
                h('option', { value: '480' }, '480p 省电'))),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '视频卡片数（画面张数）'), h('div', { 'data-bd-ds': '' }, '指视频里翻页的文字画面有几张（就是 PPT 页数），不是人格卡；人格卡在「人设」页配置，这里会自动沿用。越多视频越长；手机建议 4 张')),
              Stepper({ value: (cfg.videoMaxCards || 6) + ' 张', onStep: (d) => step('videoMaxCards', d, ' 张') })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '画面版式'),
                h('div', { 'data-bd-ds': '' }, '自动=5 种版式依次轮换（不呆板）；也可以固定一种。点「看预览」立刻渲染一张给你看')),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                Select({ value: cfg.videoLayout || 'auto', onChange: (v) => { saveOne('videoLayout', v); setTimeout(() => showLayoutPreview(v), 350) }, minWidth: 150 },
                  h('option', { value: 'auto' }, '自动轮换（推荐）'),
                  h('option', { value: '0' }, '居中大标题'),
                  h('option', { value: '1' }, '大编号左对齐'),
                  h('option', { value: '2' }, '金句居中'),
                  h('option', { value: '3' }, '标题+列表'),
                  h('option', { value: '4' }, '简洁居中')),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => showLayoutPreview(null) }, '看预览'))),
            h('div', { 'data-bd-setrow': '', style: { display: 'block' } },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '版式预览')),
              h('div', { 'data-bd-layoutpv': '' }, h('div', { style: { fontSize: '12px', color: 'var(--t3)' } }, '点上面的「看预览」')))
            , h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '思考强度'),
                h('div', { 'data-bd-ds': '' }, '模型自带的推理强度。关=最快最省（默认）；高强度更会"想"，适合写长文案，但慢很多、更费 token。写稿时传给模型的是 reasoning_effort，模型不认会自动退回普通模式')),
              Select({ value: cfg.thinkLevel || 'off', onChange: (v) => saveOne('thinkLevel', v), minWidth: 130 },
                h('option', { value: 'off' }, '关（最快）'),
                h('option', { value: 'low' }, '低'),
                h('option', { value: 'medium' }, '中'),
                h('option', { value: 'high' }, '高（最费）'))),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '写稿用哪个模型'),
                h('div', { 'data-bd-ds': '' }, (() => {
                  const eps = (st.chain && st.chain.endpoints) || []
                  return '「DSH 模型」= 直接读 DSH 设置页里配好的模型（不走发评论的降级链）；「跟评论链」= 和发评论完全同一条降级链；「自定义」= 下面单独填一套接口/模型/Key，只给写稿用。现在 DSH 里有 ' + eps.length + ' 个可用模型'
                    + (eps.length ? '' : '；选「不用模型」则连 key 都不需要')
                })())),
              Select({ value: (cfg.videoUseAI === false ? 'off' : (cfg.videoModelSource || 'dsh')), onChange: (v) => { if (v === 'off') { saveOne('videoUseAI', false) } else { saveOne('videoUseAI', true); saveOne('videoModelSource', v) } }, minWidth: 140 },
                h('option', { value: 'off' }, '不用模型（模板合集，零 key）'),
                h('option', { value: 'dsh' }, 'DSH 模型（推荐）'),
                h('option', { value: 'chain' }, '跟评论同一条链'),
                h('option', { value: 'custom' }, '自定义（写稿专用）'))),
            (cfg.videoUseAI !== false && cfg.videoModelSource === 'custom') &&               h('div', { 'data-bd-custommodel': '', style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', margin: '4px 0', background: 'var(--gray-bg)', borderRadius: '8px', fontSize: '12px', color: 'var(--t2)' } },
              h('div', null, '写稿专用自定义模型（只给视频文案用，和发评论的完全分开；兼容 OpenAI 格式的接口都行）'),
              h(Input, { defaultValue: cfg.videoCustomBaseUrl || '', placeholder: '接口地址，结尾带 /v1 或 /v4，如 https://api.deepseek.com/v1', key: 'u' + (cfg.videoCustomBaseUrl || ''), onBlur: (e) => draftUpd('videoCustomBaseUrl', e.target.value) }),
              h(Input, { defaultValue: cfg.videoCustomModel || '', placeholder: '模型名，如 deepseek-chat / glm-4-flash / qwen-turbo 这类', key: 'm' + (cfg.videoCustomModel || ''), onBlur: (e) => draftUpd('videoCustomModel', e.target.value) }),
              h(Input, { defaultValue: cfg.videoCustomKey || '', type: 'password', key: 'k' + (cfg.videoCustomKey || ''), placeholder: '这个模型的 API Key（存本地配置，不会上传）', onBlur: (e) => draftUpd('videoCustomKey', e.target.value) }),
              h(Input, { defaultValue: cfg.videoCustomName || '', placeholder: '显示名（可选，如「免费小模型」）', key: 'n' + (cfg.videoCustomName || ''), onBlur: (e) => draftUpd('videoCustomName', e.target.value) }),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap', marginTop: '4px' } },
                h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: saveCustomModel }, '💾 保存'),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: testCustomModel }, '🔌 测一下能不能连上'),
                h('span', { 'data-bd-cmsg': '', style: { fontSize: '11.5px', color: 'var(--t2)' } }, '填完记得点保存'))),
            (!(cfg.videoUseAI === false) && cfg.videoModelSource !== 'custom') && h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '指定具体模型'),
                h('div', { 'data-bd-ds': '' }, '列表就是上面选的来源里的模型（名字 = DSH 设置页里你看到的）；不选就自动用第一个可用的。选了「自定义」时这一项不生效（别挑了，直接用的就是上面那套）')),
              Select({ value: cfg.videoModel || '', onChange: (v) => saveOne('videoModel', v), minWidth: 150 },
                h('option', { value: '' }, '自动'),
                (((st.chain && st.chain.endpoints) || []).map((e) => h('option', { value: e.id, key: e.id }, e.label || e.model || e.id))))),
            ToggleRow({ label: '省电模式（针对手机）', note: '开了之后：①手机空闲时 12 秒刷新一次、任务跑着 3 秒；内容没变化就不重绘整个面板（省 CPU）；锁屏/切 App 完全不发请求；②日志只读末尾一段、超过 2MB 自动裁到最后 4000 行；③系统可用内存低于 12% 时自动释放；④私信监察间隔放宽到 3 倍；⑤渲染限制 ffmpeg 单线程 + ultrafast（文件大 10~20%，画质肉眼看不出）。想边打游戏边跑就开这个', on: !!cfg.lowPower, onChange: (v) => saveOne('lowPower', v) })),
            SegRow({
              label: '轻量界面（治滑动掉帧）',
              note: '自动：手机/平板才启用（按浏览器 UA 判断）。强制开：任何设备都合并成一个滚动、关掉循环动画——滚动更顺，但页面会变长。强制关：保留原来的多滚动区布局。设备被认错时手动改这里就行',
              value: cfg.liteUI || 'auto',
              options: [{ v: 'auto', t: '自动' }, { v: 'on', t: '强制开' }, { v: 'off', t: '强制关' }],
              onChange: (v) => saveOne('liteUI', v),
            }),
            Card({ title: '内存（运行内存，不是存储空间）', sub: '注意：这里显示的是宿主进程总量（DSH 本体 + 本插件），不是插件单独占的' },
              h('div', { 'data-bd-meminfo': '', style: { fontSize: '12px', color: 'var(--t2)', lineHeight: 1.9 } }, '读取中…'),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
                h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: runOptimize }, '⚡ 一键优化（内存+临时文件）'),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: doFreeMemory }, '🧹 只释放内存'),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadMemInfo }, '刷新'))),
          Card({ title: '素材库', sub: '图片当背景 / 音频当 BGM。备注可以不写（不写就不会被 AI 选用）；写一句「什么时候用」它才会主动挑' },
            ToggleRow({
              label: '启用素材库',
              note: '开着时，AI 写稿会看到素材备注，自己决定用不用；没备注的不会被选（导入时已自动用文件名填好）',
              on: !!cfg.useAssets, onChange: (v) => saveOne('useAssets', v),
            }),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: pickAndUploadAssets }, '📷 从相册/文件选素材'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: autoNoteAssets }, '🤖 AI 帮我写备注（图片）'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: analyzeAudioAssets }, '🎵 识别音乐（BGM，本地）'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: exportAssets }, '📤 导出到手机'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: importAssets }, '📥 从手机导入'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: openAssets }, '打开插件内目录'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: loadAssets }, '刷新列表')),
            h('div', { 'data-bd-setrow': '', style: { display: 'block' } },
              h('div', { 'data-bd-txt': '' },
                h('div', { 'data-bd-lb': '' }, '识图模型（「AI 写备注」要用它）'),
                h('div', { 'data-bd-ds': '' }, (st.vision || {}).hasKey
                  ? ('已经配了：' + ((st.vision || {}).model || (cfg.visionModel || {}).modelName || '—') + '（key ' + ((st.vision || {}).keyHint || '已存') + '）。想换就改下面的地址/模型/Key 再保存')
                  : '还没配全。填一个能看图的模型（OpenAI 兼容的 vision 接口都行，比如 glm-4v-flash 这类有免费额度的）')),
              h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px', marginTop: '6px' } },
                Input({ defaultValue: (cfg.visionModel || {}).apiUrl || '', placeholder: '接口地址，如 https://open.bigmodel.cn/api/paas/v4', key: 'vu' + ((cfg.visionModel || {}).apiUrl || ''), onBlur: (e) => setVUrl(String(e.target.value || '').trim()) }),
                Input({ defaultValue: (cfg.visionModel || {}).modelName || '', placeholder: '模型名，如 glm-4v-flash', key: 'vm' + ((cfg.visionModel || {}).modelName || ''), onBlur: (e) => setVModel(String(e.target.value || '').trim()) }),
                Input({ defaultValue: '', type: 'password', key: 'vk' + ((st.vision || {}).keyHint || ''), placeholder: (st.vision || {}).hasKey ? ('已存 ' + ((st.vision || {}).keyHint || '••••') + '，留空不改') : 'API Key', onBlur: (e) => setVKey(String(e.target.value || '').trim()) })),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap', alignItems: 'center' } },
                h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: () => saveVision({ apiUrl: String(vUrl || (cfg.visionModel || {}).apiUrl || '').trim(), modelName: String(vModel || (cfg.visionModel || {}).modelName || '').trim(), apiKey: String(vKey || '').trim() || ((cfg.visionModel || {}).apiKey || '') }) }, '💾 保存识图模型'),
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: testVision }, '🔍 测一下能不能看图'),
                h('span', { 'data-bd-ds': '' }, '配好后点上面的「🤖 AI 帮我写备注」'))),

            h('div', { 'data-bd-assets': '', style: { marginTop: '8px', fontSize: '12px', color: 'var(--t2)', lineHeight: 1.8 } }, '')),
          Card({ title: '开场动态（可选，AI 生视频）', sub: '用 CogVideoX 生成 3 秒片头；排队久但只在开头用一次' },
            ToggleRow({ label: '生成开场动态', note: '开了之后：整条片子先渲染好，再额外生成一段 3 秒 AI 动态拼在最前面。⚠️ 免费额度要排队，通常等 1~5 分钟；等太久会放弃并保留正常版本，不会毁掉已经做好的片子。用的是上面「画面生成模型」的地址和 Key', on: !!cfg.videoCogVideo, onChange: (v) => saveOne('videoCogVideo', v) }),
            !!cfg.videoCogVideo && h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '开场怎么做'),
                h('div', { 'data-bd-ds': '' }, '本地推近 = 用第一张卡片图做缓慢放大，**免费、秒出、离线可用**（推荐）；AI 生成 = 调 CogVideoX，效果更活但免费额度全站排队，深夜也常限流')),
              Select({ value: cfg.videoCogVideoMode || 'local', onChange: (v) => saveOne('videoCogVideoMode', v), minWidth: 170 },
                h('option', { value: 'local' }, '本地推近（免费秒出）'),
                h('option', { value: 'ai' }, 'AI 生成（排队）'))),
            !!cfg.videoCogVideo && h('div', { style: { display: 'flex', flexDirection: 'column', gap: '6px' } },
              h('div', { style: { fontSize: '11.5px', color: 'var(--t3)', lineHeight: 1.7 } }, '下面这些只有选「AI 生成」才用得上。地址和 Key 留空 = 直接用「画面生成模型」里填的那套'),
              Input({ defaultValue: cfg.videoCogVideoBaseUrl || '', placeholder: '视频接口地址（留空=用画面生成那套）', onBlur: (e) => saveOne('videoCogVideoBaseUrl', String(e.target.value || '').trim(), '开场视频地址') }),
              Input({ defaultValue: cfg.videoCogVideoKey || '', type: 'password', placeholder: '视频接口 Key（留空=用画面生成那套）', onBlur: (e) => saveOne('videoCogVideoKey', String(e.target.value || '').trim(), '开场视频 Key') }),
              Input({ defaultValue: cfg.videoCogVideoModel || 'cogvideox-flash', placeholder: '视频模型名，默认 cogvideox-flash', onBlur: (e) => saveOne('videoCogVideoModel', String(e.target.value || '').trim(), '开场视频模型') }),
              h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: testCogVideo }, '🎬 测一下能不能生视频'),
                h('span', { style: { fontSize: '11px' } }, '会真的消耗一次生成机会，且要等几分钟')),
              h('div', { 'data-bd-vidpv': '' }))),
          Card({ title: '画面生成模型（可选，进阶）', sub: '用文生图接口给每张卡片画背景图；不填就用纯色卡片' },
            ToggleRow({ label: '启用画面生成', note: '开了才联网调文生图接口，每张卡片生成一张背景图；关掉/不填 = 纯色卡片，渲染离线也能跑', on: !!cfg.videoImageEnabled, onChange: (v) => saveOne('videoImageEnabled', v) }),
            !!cfg.videoImageEnabled && h('div', { 'data-bd-imgmodel': '', style: { display: 'flex', flexDirection: 'column', gap: '6px', padding: '10px 12px', margin: '4px 0', background: 'var(--gray-bg)', borderRadius: '8px', fontSize: '12px', color: 'var(--t2)' } },
              h('div', { style: { lineHeight: 1.8 } }, '要填的是**文生图**模型（不是对话模型）。智谱免费方案：地址 ', h('code', null, 'https://open.bigmodel.cn/api/paas/v4'), '、模型 ', h('code', null, 'cogview-3-flash'), '、Key 跟 GLM 那个通用'),
              h(Input, { defaultValue: cfg.videoImageBaseUrl || '', placeholder: '接口地址，智谱填 https://open.bigmodel.cn/api/paas/v4', onBlur: (e) => saveOne('videoImageBaseUrl', String(e.target.value || '').trim(), '画面接口地址') }),
              h(Input, { defaultValue: cfg.videoImageModel || '', placeholder: '模型名，如 cogview-3-flash（智谱免费）/ dall-e-3', onBlur: (e) => saveOne('videoImageModel', String(e.target.value || '').trim(), '画面模型名') }),
              h(Input, { defaultValue: cfg.videoImageKey || '', type: 'password', placeholder: '文生图接口的 API Key（存本地配置，不会上传）', onBlur: (e) => saveOne('videoImageKey', String(e.target.value || '').trim(), '画面 Key') }),
              h('div', { style: { display: 'flex', gap: '8px', marginTop: '6px', flexWrap: 'wrap', alignItems: 'center' } },
                h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: testImageGen }, '🖼 测一下能不能生图'),
                h('span', { style: { fontSize: '11px' } }, '每张卡片会花几秒~十几秒；图生得越多，出片越慢')),
              h('div', { 'data-bd-imgpv': '', style: { marginTop: '10px' } }))),
          Card({ title: '发动态', sub: '纯手动：AI 不代写、不自动发' },
            h('div', { 'data-bd-input': '', 'data-bd-dyninput': '', style: { height: 'auto', padding: '8px 12px', alignItems: 'stretch' } },
              h('textarea', { placeholder: '写你想发的动态文字…', rows: 4 })),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: doDynamic }, '发布动态'))),
          Card({ title: '投稿视频', sub: '点「启动投稿」才上传；B站自己审核' },
            h('div', { 'data-bd-input': '', 'data-bd-vidpath': '' },
              h('input', { placeholder: '视频文件完整路径（如 D:/videos/test.mp4）' })),
            h('div', { 'data-bd-input': '', 'data-bd-vidtitle': '', style: { marginTop: '8px' } },
              h('input', { placeholder: '视频标题（必填，≤80字）' })),
            h('div', { 'data-bd-input': '', 'data-bd-viddesc': '', style: { marginTop: '8px' } },
              h('input', { placeholder: '视频简介（可选）' })),
            h('div', { style: { display: 'flex', gap: '8px', marginTop: '8px', flexWrap: 'wrap' } },
              h('div', { 'data-bd-input': '', 'data-bd-vidtid': '', style: { flex: '1 1 110px' } },
                h('input', { placeholder: '分区ID（默认124）' })),
              h('div', { 'data-bd-input': '', 'data-bd-vidtags': '', style: { flex: '2 1 160px' } },
                h('input', { placeholder: '标签（逗号分隔）' }))),
            h('div', { 'data-bd-input': '', 'data-bd-vidcover': '', style: { marginTop: '8px' } },
              h('input', { placeholder: '封面图路径（可选，留空自动抽帧）' })),
            h('div', { style: { marginTop: '10px', display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: doVideo }, '启动投稿'))))
      }

      /* ===== QQ 接入（遥控小门）：独立顶层页（2026-11-08 用户要求从环境页拆出来） ===== */
      function renderQQ() {
        const r = state?.remote || {}
        const saveRemote = async (patch) => {
          try { await jpost('/remote/config', patch); toast_(r.on ? '已保存，几秒内生效' : '已保存，正在开门…') }
          catch (e) { toast_('没保存上：' + (e?.message || e)) }
        }
        const copyToken = () => {
          try { navigator.clipboard.writeText(r.token || ''); toast_('口令已复制') }
          catch { toast_('复制失败，手动选中口令复制吧') }
        }
        // 一键对接：扫本机网卡 → 哪个地址真能打到门卫 → 拼好各家机器人要填的东西
        const doScan = async () => {
          try {
            const s = await jpost('/remote/scan', {})
            const token = s.token || ''
            const url = s.url || ('http://127.0.0.1:' + (s.port || 8792))
            const L = []
            L.push('[门卫] ' + (s.listening ? '在监听' : '没在监听') + ' · 端口 ' + s.port + ' · ' + (s.readOnly ? '只看不干（只读）' : '可写'))
            L.push('[地址] ' + url)
            if ((s.addrs || []).length) L.push('[扫到] ' + s.addrs.map((a) => a.host + (a.ok ? ' ✅' : ' ❌')).join('   '))
            L.push('')
            L.push('—— AstrBot 插件 astrbot_plugin_bili_bridge ——')
            L.push('api_base = ' + url)
            L.push('token = ' + (token || '（先点「打开小门」，口令会自动生成）'))
            L.push('')
            L.push('—— qq-bridge / SnowLuma（任何 MCP 宿主都用同一份）——')
            L.push('不用填：mcp-bili.js 自己读本机配置里的口令（机器人不在同一台机器才要设 BILI_CMD_URL / BILI_TOKEN）')
            L.push('')
            L.push('—— 自定义 / 别的机器人（只要它能发 HTTP）——')
            L.push('POST ' + url + '/cmd')
            L.push('Header: X-Bili-Token: ' + (token || '<口令>'))
            L.push('Body: {"action":"help"}   // 想点名干活就换 {"action":"triple","args":{"bvid":"BV..."}}')
            L.push('回包：{"ok":true,"reply":"..."}，把 reply 原样丢给群友就行')
            L.push('')
            L.push('—— 裸 HTTP 自测 ——')
            L.push('curl -X POST ' + url + '/cmd -H "Content-Type: application/json" -H "X-Bili-Token: ' + (token || '<口令>') + '" -d \'{"action":"help"}\'')
            const box = document.querySelector('[data-bd-scanout]')
            if (box) box.value = L.join('\n')
            toast_('扫完了，下面这段直接复制')
          } catch (e) { toast_('扫失败：' + (e && e.message ? e.message : e)) }
        }
        const copyScan = () => {
          const box = document.querySelector('[data-bd-scanout]')
          const txt = box ? box.value : ''
          if (!txt) { toast_('先点「扫描并生成」'); return }
          try { navigator.clipboard.writeText(txt); toast_('已复制') }
          catch { toast_('复制失败，手动选中吧') }
        }
        // 同机才有的福利：这台机器上真装了 AstrBot 的话，直接把配置写进去，不用手抄
        const writeLocal = async () => {
          try {
            const d = await jpost('/remote/detect', {})
            const hit = (d && d.found && d.found[0]) || null
            if (!hit) { toast_((d && d.hint) || '这台机器上没找到 AstrBot 的桥接配置'); return }
            const w = await jpost('/remote/apply', { path: hit.path })
            if (!w.ok) { toast_('写入失败：' + (w.error || '')); return }
            const box = document.querySelector('[data-bd-scanout]')
            if (box) {
              box.value = (box.value ? box.value + '\n\n' : '') + '[已写入本机] ' + w.path
                + '\napi_base = ' + w.apiBase + '\ntoken = 已写入（' + (w.tokenLen || 0) + ' 位）'
            }
            toast_('已写入：' + w.path + '（AstrBot 里重载一次插件就生效）')
          } catch (e) { toast_('写入失败：' + (e && e.message ? e.message : e)) }
        }
        return h('div', {},
          Card({
            title: 'QQ 接入（遥控小门）',
            sub: '给 QQ 机器人（比如 AstrBot）留的一扇带口令的小门：只认白名单动作，外面碰不到你的密钥和配置',
            right: Tag({ c: r.on ? (r.listening ? 'green' : 'amber') : 'gray', children: r.on ? (r.listening ? '开着 · 监听中' : '开着 · 还没监听') : '关着' }),
          },
            h('div', { 'data-qq-sum': '', style: { fontSize: '13px', lineHeight: 1.7 } },
              r.on
                ? ('机器人隔着这扇门可以：看状态、问最近刷了啥、让它刷一轮、撤回误发的评论……共 ' + (r.actions || 0) + ' 个白名单动作。' +
                  (r.readOnly ? '现在是「只看不干」模式：只能查，不能干活。' : '') +
                  (r.error ? ('\n启动失败：' + r.error) : ''))
                : '关着时不监听任何端口。打开后，机器人就能隔着门看状态、命令刷视频（要口令）。',
              r.listening && (r.urls || []).length ? ('\n\n本机可用：127.0.0.1:' + (r.port || '') + '；局域网：' + r.urls.join('、')) : ''),
            r.on ? h('div', { style: { display: 'flex', gap: '8px', alignItems: 'center', marginTop: '8px' } },
              Tag({ c: r.readOnly ? 'green' : 'red', children: r.readOnly ? '只读模式 · 只看不干（安全）' : '可写模式 · 允许干活（有风险）' }),
              Tag({ c: 'gray', children: '点右边按钮切换' })) : null,
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
              h('button', { className: r.on ? 'danger sm' : 'primary sm', onClick: () => saveRemote({ remoteOn: !r.on }) },
                r.on ? '关掉小门' : '打开小门'),
              r.on ? h('button', {
                  className: 'sm',
                  style: r.readOnly
                    ? { background: 'var(--amber)', borderColor: 'var(--amber)', color: '#3a2c00', fontWeight: 600 }
                    : { background: 'var(--green)', borderColor: 'var(--green)', color: '#fff', fontWeight: 600 },
                  onClick: () => saveRemote({ remoteReadOnly: !r.readOnly }),
                },
                r.readOnly ? '关掉「只看不干」（允许干活）' : '设为「只看不干」') : null)),
          Card({ title: '口令与地址（给机器人插件填）', sub: '两样东西填进 AstrBot 的桥接插件就能用；同一台机器填 127.0.0.1 那个地址最稳' },
            h('div', { style: { fontFamily: 'ui-monospace, monospace', fontSize: '13px', whiteSpace: 'pre-wrap', wordBreak: 'break-all' } },
              '口令：' + (r.token || '（打开小门后自动生成一把）') + '\n' +
              '门卫地址：' + (r.listening ? ('http://127.0.0.1:' + (r.port || '8792')) : '（门没开）') +
              ((r.urls || []).length ? ('\n局域网地址：' + r.urls.join('　')) : '')),
            r.token ? h('div', { style: { display: 'flex', gap: '8px', marginTop: '10px' } },
              h('button', { className: 'ghost sm', onClick: copyToken }, '复制口令')) : null,
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--t2)' } },
              '⚠️ 口令等于这扇门的钥匙：只发给机器人插件，别发到群里。'),
            h('div', { style: { marginTop: '6px', fontSize: '12px', color: 'var(--t2)' } },
              '怎么接？仓库的 integrations/ 里有现成的：AstrBot 插件、MCP 适配器（qq-bridge / SnowLuma 等）、以及纯 HTTP 示例——照着填口令就行，不用另装服务。')),
          Card({ title: '一键对接（扫一下，照着抄）', sub: '算出哪个地址真能打到门卫，再把各家机器人该填的东西拼好；不用自己拼 IP 和口令' },
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: doScan }, '🔍 扫描并生成'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: copyScan }, '复制全部'),
              h('button', { 'data-bd-btn': '', className: 'outline sm', onClick: writeLocal }, '📝 写入本机 AstrBot'),
              h('span', { style: { fontSize: '11px', color: 'var(--t2)' } }, '扫描会分别试 127.0.0.1 和每张网卡的地址；「写入本机」只在面板和 AstrBot 同机时找得到配置文件')),
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--t2)' } },
              'AstrBot 插件的设置在哪：打开 AstrBot 控制台（默认 6185 端口）→ 插件管理 → astrbot_plugin_bili_bridge → 设置，里面就两个框（api_base 和 token），把下面生成的粘进去。AstrBot 跑在 Docker 里时，「写入本机」一般找不到它的盘，还是复制粘贴。'),
            h('textarea', {
              'data-bd-scanout': '',
              readOnly: true,
              rows: 9,
              placeholder: '点「扫描并生成」，这里会出现可复制的配置',
              style: { width: '100%', marginTop: '8px', fontFamily: 'ui-monospace, monospace', fontSize: '12px', lineHeight: 1.6 },
            })),
          Card({ title: '门里允许干什么（白名单）', sub: '改配置、拿密钥这类事，门里根本没有对应动作' },
            h('div', { style: { fontSize: '12.5px', color: 'var(--t2)', lineHeight: 1.8 } },
              ['看状态', '看最近刷的视频', '看发过的评论/动态', '看日报', '命令刷一轮', '试跑（只挑不发）', '停止', '发动态', '查回私信', '撤回最近几条评论', '给指定视频点赞/三连/评论（投币只记提醒）'].join(' · '))))
      }

      /* ===== 为所欲为（wild）：独立顶层页（2026-11-13 新增） =====
       * 打开 = 全自动自己逛 B站（首页推荐流自己挑，不靠关键词），评论/点赞/发动态（投币不代投），直到关掉。
       * 与 QQ 遥控的「为所欲为」是两回事：QQ 那边是有人下令才动。 */
      function renderWild() {
        const on = !!cfg.wildMode
        const selfSearch = cfg.wildSelfSearch !== false
        const perDay = Math.max(1, Number(cfg.wildPerDay) || 20)
        const perRound = Math.max(1, Number(cfg.wildPerRound) || 5)
        const gap = Math.max(1, Number(cfg.wildInterval) || 10)
        const numRow = (label, key, val, unit, min, max) => h('div', { 'data-bd-setrow': '' },
          h('div', { 'data-bd-txt': '' },
            h('div', { 'data-bd-lb': '' }, label),
            h('div', { 'data-bd-ds': '' }, '当前 ' + val + (unit || ''))),
          h('div', { style: { display: 'flex', gap: '6px' } },
            h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => saveOne(key, Math.max(min, val - 1), label) }, '−'),
            h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => saveOne(key, Math.min(max, val + 1), label) }, '+')))
        const runWildOnce = async () => {
          try { const r = await jpost('/run/wild', {}); toast_(r.message || (r.ok ? '已开始，去「总览」看活动流' : '没开始')) }
          catch (e) { toast_('没跑起来：' + String(e?.message ?? e)) }
        }
        const stopAll = async () => {
          try { const r = await jpost('/run/stop', {}); toast_(r.message || '已叫停') }
          catch (e) { toast_('停止失败：' + String(e?.message ?? e)) }
        }
        return h('div', {},
          Card({
            title: '为所欲为模式',
            sub: '打开它就自己逛 B站：自己想搜什么就去搜、自己挑视频、自己评论/点赞/发动态（投币不代投），直到你关掉',
            right: Tag({ c: on ? 'red' : 'gray', children: on ? '野着跑中' : '关着' }),
          },
            h('div', { 'data-bd-callout': '' },
              '它怎么干活：不用你给关键词——每轮它自己出一批「今天想搜什么」，拿这些词去B站搜，同时也翻首页推荐流；挑中就评论，顺手点赞，还会发一条图文动态；投币不代投（B站要人机验证），想投的去「待手动投币」按提醒自己投。',
              '\n保险在后台定死了：触发风控冷却就停手、每天有总量上限、每条都记进「评论」页和日报；总览里的「自动值守总开关」一关，它也跟着停。'),
            h('div', { style: { display: 'flex', gap: '8px', flexWrap: 'wrap', marginTop: '10px' } },
              h('button', {
                'data-bd-btn': '',
                className: on ? 'ghost sm' : 'danger sm',
                style: on ? {} : { fontWeight: 700 },
                onClick: () => saveOne('wildMode', !on, '为所欲为'),
              }, on ? '关掉为所欲为' : '打开为所欲为（开始野）'),
              h('button', { 'data-bd-btn': '', className: 'outline sm', onClick: runWildOnce }, '立即来一发（只野一轮）'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: stopAll }, '停止')),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' },
                h('div', { 'data-bd-lb': '' }, '自己去搜（自己出关键词）'),
                h('div', { 'data-bd-ds': '' }, selfSearch ? '开着：每轮它自己出 2~4 个词去搜，也翻首页推荐' : '关着：只翻首页推荐流，不自己搜')),
              h('button', {
                'data-bd-btn': '',
                className: 'ghost sm',
                onClick: () => saveOne('wildSelfSearch', !selfSearch, '自己去搜'),
              }, selfSearch ? '改成只翻首页' : '让它自己搜')),
            h('div', { style: { marginTop: '8px', fontSize: '12px', color: 'var(--t2)' } },
              '⚠️ 打开 = 真的发评论/动态。频率越高越容易被 B站 限流；真被风控会自动冷却 24 小时。')),
          Card({ title: '野的节奏', sub: '默认值是替你定好的保险参数，想调也行，别调太疯' },
            numRow('每天最多挑几条', 'wildPerDay', perDay, ' 条', 1, 500),
            numRow('每轮挑几条', 'wildPerRound', perRound, ' 条', 1, 50),
            numRow('两轮之间隔多久', 'wildInterval', gap, ' 分钟', 1, 240)),
          Card({ title: 'QQ 里的「为所欲为」是另一回事', sub: '同一个引擎，两种玩法' },
            h('div', { style: { fontSize: '12.5px', color: 'var(--t2)', lineHeight: 1.9 } },
              '· 这页的开关：打开 = 它全自动自己野，除非你关掉。',
              '\n· QQ 里喊它「为所欲为」：有人下令才动，野一轮就收；没人叫它，它自己不会动（最多按定时值守的节奏跑）。',
              '\n· QQ 门卫开着「只看不干」时，喊它干活也没用——得先去「QQ 接入」把只读关掉。')))
      }

      const PAGERENDER = {
        overview: renderOverview, models: renderModels, logs: renderLogs, persona: renderPersona,
        chain: renderChain, safety: renderSafety, comments: renderComments, publish: renderPublish,
        qq: renderQQ, wild: renderWild,
        // 这三个页面共用同一批「设置类卡片」，只是各拿各的那几张
        find: () => renderSettings('find'),
        settings: () => renderSettings('settings'),
        env: () => renderSettings('env'),
      }
      const content = h(PageBoundary, { onHome: () => setPage('overview') }, h('div', { 'data-bd-content': '' }, (PAGERENDER[page] || renderOverview)()))

      const modal = h('div', { 'data-bd-mask': '', className: login.open ? 'show' : undefined },
        h('div', { 'data-bd-modal': '' },
          h('div', { style: { fontSize: '15px', fontWeight: 700 } }, '扫码登录 B站'),
          h('div', { className: 'hint' }, login.hint),
          login.qr ? h('img', { src: login.qr, alt: '登录二维码' }) : null,
          login.url ? h('div', { className: 'qr-url' }, login.url) : null,
          h('div', { className: 'hint' }, login.status || '用 B站 App 扫码，180 秒内有效'),
          h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '12px' } }, h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: closeLogin }, '关闭'))))

      const webPanel = h('div', { 'data-bd-mask': '', className: webOpen ? 'show' : undefined, onClick: (e) => { if (e.target === e.currentTarget) setWebOpen(false) } },
        h('div', { 'data-bd-modal': '' },
          h('div', { style: { fontSize: '15px', fontWeight: 700 } }, '网页版控制台地址'),
          h('div', { className: 'hint' }, '在手机浏览器里打开这个地址即可用完整网页版；点下面的链接可直接跳转，或长按地址框复制。'),
          webUrl ? h('a', { 'data-bd-weburl-link': '', href: webUrl, target: '_blank', rel: 'noopener' }, '点我打开网页版 ↗') : null,
          h('input', { id: 'bd-weburl', 'data-bd-weburl': '', value: webUrl, readOnly: true, onFocus: (e) => { try { e.target.select() } catch {} } }),
          h('div', { style: { display: 'flex', gap: '10px', justifyContent: 'center', marginTop: '12px' } },
            h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: copyWebUrl }, '复制地址'),
            h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => setWebOpen(false) }, '关闭'))))

      const toastEl = h('div', { 'data-bd-toast': '', className: toast ? 'show' : undefined }, toast)

      // 改了配置就在右下角浮出「保存配置」——不用滚回页面底部找保存按钮
      const unsaved = Object.keys(dirty || {}).filter((k) => dirty[k]).length
      // 低配模式：触摸设备（手机/平板）或用户手动开了省电模式时，换成「单滚动上下文」的轻量布局。
      // 只影响界面渲染，不改任何功能；电脑端 UA 不含 mobile 且没开省电，class 不会加上，行为一个字节没变。
      const isLite = (() => {
        try {
          const mode = (st && st.settings && st.settings.liteUI) || 'auto'
          if (mode === 'on') return true
          if (mode === 'off') return false
          // auto：手机/平板 UA 命中才启用；另外省电模式也强制启用（它本来就是给低配设备的）
          if (/android|iphone|ipad|ipod|mobile/i.test(navigator.userAgent || '')) return true
          return !!(st && st.settings && st.settings.lowPower)
        } catch { return false }
      })()
      const pageCls = [narrow ? 'narrow' : '', unsaved ? 'has-floatsave' : '', isLite ? 'lite' : ''].filter(Boolean).join(' ')
      const floatSave = unsaved ? h('div', { 'data-bd-floatsave': '' },
        h('span', { 'data-bd-ds': '', style: { fontSize: '12px' } }, '有 ' + unsaved + ' 项改动没保存'),
        h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: saveSettings }, '保存配置'),
        h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => { setDirty({}); setPersona(null); setKws(null); setMentionDraft(null); setDmUidDraft(null); setFavDraft(null); toast_('已放弃改动，恢复成已保存的值') } }, '放弃')) : null

      return h('div', { 'data-bd-page': '', ref: rootRef, className: pageCls },
        topbar,
        loginBar,
        banner,
        h('div', { 'data-bd-main': '' }, sidebar, content),
        h('div', { 'data-bd-foot': '' }, '插件目录：' + (st.home || '—') + ' · 本地服务 127.0.0.1 · 每 2 秒自动刷新 · 最近更新 ' + (st.now || '')),
        floatSave, modal, webPanel, toastEl)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const style = document.createElement('style')
        style.setAttribute('data-plugin-css', 'dsh-bili-console')
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(() => () => style.remove(), 'dsh-bili-console: 控制台样式')

        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () => slots.register(
          { name: 'settings.section', id: 'bili-console', order: 30, label: '刷视频' },
          () => h(Console),
        ))
      },
    }
  },
})
