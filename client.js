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
    [data-bd-weburl-link]{display:inline-block;margin:6px 0;color:var(--blue);font-weight:600;font-size:14px;word-break:break-all;}
    [data-bd-weburl-link]:hover{text-decoration:underline;}
    [data-bd-weburl]{width:100%;height:40px;padding:0 10px;border:1px solid var(--line);border-radius:6px;background:var(--gray-bg);font-size:13px;color:var(--t1);}

    [data-bd-sw]{flex:none;width:44px;height:24px;border-radius:12px;border:0;cursor:pointer;position:relative;padding:0;background:var(--off);transition:background .15s;}
    [data-bd-sw][data-on]{background:var(--blue);} [data-bd-sw] i{position:absolute;top:3px;left:3px;width:18px;height:18px;border-radius:50%;background:#fff;transition:left .15s;display:block;box-shadow:0 1px 2px rgba(0,0,0,.2);}
    [data-bd-sw][data-on] i{left:23px;} [data-bd-sw]:disabled{opacity:.45;cursor:default;}
    [data-bd-select]{display:inline-flex;align-items:center;justify-content:space-between;gap:8px;height:32px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px;min-width:130px;color:var(--t1);}
    [data-bd-select] select{border:none;outline:none;background:none;font-size:13px;width:100%;cursor:pointer;appearance:none;color:var(--t1);}
    [data-bd-input]{display:flex;align-items:center;height:36px;padding:0 12px;border:1px solid var(--line);border-radius:6px;background:var(--surface);font-size:13px;gap:8px;color:var(--t1);}
    [data-bd-input] input{border:none;outline:none;flex:1;font-size:13px;background:none;min-width:0;color:var(--t1);}
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
    [data-bd-logbox]{max-height:520px;overflow-y:auto;} [data-bd-logbox]::-webkit-scrollbar{width:6px;} [data-bd-logbox]::-webkit-scrollbar-thumb{background:var(--off);border-radius:3px;}
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
    [data-bd-errpage]{padding:16px 0;}
    [data-bd-radio]{width:16px;height:16px;border-radius:50%;border:1.5px solid var(--off);display:inline-flex;align-items:center;justify-content:center;flex-shrink:0;cursor:pointer;}
    [data-bd-radio].on{border-color:var(--blue);} [data-bd-radio].on::after{content:"";width:8px;height:8px;border-radius:50%;background:var(--blue);}
    textarea[data-bd-persona]{width:100%;min-height:420px;border:1px solid var(--line);border-radius:8px;padding:14px;font-size:12.5px;line-height:1.8;resize:vertical;background:var(--surface);color:var(--t1);}
    textarea[data-bd-persona]:focus{outline:none;border-color:var(--blue);}
    [data-bd-chainitem]{display:flex;align-items:center;gap:10px;padding:10px 12px;border:1px solid var(--line);border-radius:8px;background:var(--surface);}
    [data-bd-chainitem] .idx{width:22px;height:22px;border-radius:50%;background:var(--blue-bg);color:var(--blue);font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;flex:none;}
    [data-bd-chainitem] .nm{font-weight:600;font-size:13px;} [data-bd-chainitem] .mdl{font-size:11px;color:var(--t3);}
    [data-bd-chainitem] .src{margin-left:auto;}
    [data-bd-chainitem] .arrows{display:flex;flex-direction:column;gap:2px;}
    [data-bd-chainitem] .arrows button{font-size:11px;color:var(--t2);padding:0 4px;line-height:1.1;} [data-bd-chainitem] .arrows button:hover{color:var(--blue);}
    [data-bd-chainitem] .arrows button:disabled{opacity:.3;cursor:not-allowed;}
    [data-bd-chainlist]{display:flex;flex-direction:column;gap:8px;}
    [data-bd-setrow]{display:flex;align-items:center;gap:12px;padding:12px 0;}
    [data-bd-setrow]+[data-bd-setrow]{border-top:1px solid var(--line);}
    [data-bd-setrow] .txt{flex:1;min-width:0;} [data-bd-setrow] .lb{font-size:13px;margin-bottom:2px;} [data-bd-setrow] .ds{font-size:11px;color:var(--t2);line-height:1.6;}
    [data-bd-callout]{border-left:3px solid var(--blue);background:var(--canvas);border-radius:0 6px 6px 0;padding:12px 16px;font-size:12px;line-height:1.9;}
    [data-bd-charter]{font-size:12.5px;color:var(--t2);line-height:2;padding-left:18px;}
    [data-bd-charter] li{margin-bottom:4px;}

    [data-bd-toast]{position:fixed;left:50%;bottom:32px;transform:translateX(-50%) translateY(20px);background:#111;color:#fff;font-size:13px;padding:10px 18px;border-radius:8px;opacity:0;pointer-events:none;transition:opacity .2s,transform .2s;z-index:99;max-width:80%;}
    [data-bd-toast].show{opacity:.92;transform:translateX(-50%) translateY(0);}
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
    .narrow [data-bd-sidebar]{width:100%;position:static;flex-direction:row;flex-wrap:nowrap;overflow-x:auto;
      padding:8px;gap:6px;align-items:center;}
    .narrow [data-bd-sidebar]::-webkit-scrollbar{height:5px;}
    .narrow [data-bd-sidebar]::-webkit-scrollbar-thumb{background:var(--off);border-radius:3px;}
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

    const Select = (props, ...kids) => {
      const p = props || {}
      const children = [...(p.children != null ? [].concat(p.children) : []), ...kids]
      return h('div', { 'data-bd-select': '', style: p.minWidth ? { minWidth: p.minWidth } : undefined },
        h('select', { value: p.value ?? '', onChange: (e) => p.onChange(e.target.value) }, children),
        h('span', { style: { color: 'var(--t2)' } }, '▾'))
    }

    const Input = ({ value, onChange, placeholder, type, onBlur, style }) => h('div', { 'data-bd-input': '', style },
      h('input', { type: type || 'text', value: value ?? '', placeholder: placeholder || '', onChange: (e) => onChange(e.target.value), onBlur }))

    const Stepper = ({ value, onStep }) => h('span', { 'data-bd-stepper': '' },
      h('button', { onClick: () => onStep(-1) }, '−'),
      h('span', { className: 'val' }, String(value)),
      h('button', { onClick: () => onStep(1) }, '+'))

    const ChainList = ({ endpoints, onReorder }) => {
      if (!endpoints || !endpoints.length) return h('div', { 'data-bd-empty': '' }, '链上空：去「模型与密钥」加一个模型，或等 DSH 预设同步')
      return h('div', { 'data-bd-chainlist': '' }, endpoints.map((ep, i) => {
        const srcTag = ep.source === 'preset' ? Tag({ c: 'blue', children: 'DSH预设' }) : Tag({ c: 'gray', children: '自定义' })
        const arrows = h('div', { className: 'arrows' },
          h('button', { disabled: i === 0, onClick: () => onReorder(i, -1) }, '▲'),
          h('button', { disabled: i === endpoints.length - 1, onClick: () => onReorder(i, 1) }, '▼'))
        return h('div', { 'data-bd-chainitem': '' },
          h('div', { className: 'idx' }, String(i + 1)),
          h('div', null, h('div', { className: 'nm' }, ep.label || ''), h('div', { className: 'mdl' }, ep.model || '')),
          h('div', { className: 'src' }, srcTag),
          arrows)
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

      // 主轮询：state 2s / rawlog 3s / report 5s（对齐 console 的节奏）
      React.useEffect(() => {
        const tick = async () => {
          try { const s = await jget('/state'); if (alive.current && s.ok) { setState(s); setFails(0) } else if (alive.current) setFails((n) => n + 1) }
          catch { if (alive.current) setFails((n) => n + 1) }
        }
        const tickLog = async () => { try { const l = await jget('/rawlog'); if (alive.current) setRawlog((l && l.lines) || []) } catch {} }
        const tickRep = async () => { try { const r = await jget('/report'); if (alive.current) setReport(r) } catch {} }
        tick(); tickLog(); tickRep()
        const t1 = setInterval(tick, 2000), t2 = setInterval(tickLog, 3000), t3 = setInterval(tickRep, 5000)
        return () => { clearInterval(t1); clearInterval(t2); clearInterval(t3) }
      }, [])

      const st = state
      const cfg = st?.settings || {}

      // 识图模型草稿：仅在未手动改过时从服务端同步
      React.useEffect(() => {
        if (st && !dirty.vision) { const v = cfg.visionModel || {}; setVUrl(v.apiUrl || ''); setVModel(v.modelName || ''); setVKey(v.apiKey || '') }
      }, [st, dirty.vision])

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
        try { const r = await jpost('/settings', { visionModel: v }); toast_(r.ok ? '识图模型已保存' : ('失败：' + (r.error || ''))) }
        catch (e) { toast_('失败：' + String(e?.message ?? e)) }
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
          if (r && r.hasUpdate) toast_('有新版本 v' + r.latest + ' —— 下面有下载链接')
          else if (r && r.ok) toast_('已经是最新版 v' + r.latest)
          else toast_('没查到版本，试试换个加速源')
        } catch (e) { toast_('检查失败：' + String(e?.message ?? e)) } finally { setUpBusy(false) }
      }
      const runNow = async () => { try { const r = await jpost('/run/now', { force: true }); toast_(r.message || (r.ok ? '已开始' : '失败')) } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) } }
      /** 清空所有视频的对话上下文（thread 模式产物） */
      const clearMemory = async () => {
        try { const r = await jpost('/memory/clear', {}); toast_(r.ok ? '已清空所有对话上下文' : '清空失败') }
        catch (e) { toast_('清空失败：' + String(e?.message ?? e)) }
      }
      /** 撤回：把 AI 刚发出去的那条评论从 B站 删掉（只能删自己发的） */
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
      const runDry = async () => { try { const r = await jpost('/run/now', { force: true, dryRun: true }); toast_(r.message || (r.ok ? '已开始试跑' : '失败')) } catch (e) { toast_('请求失败：' + String(e?.message ?? e)) } }
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
      else if (st.safeMode) banner = h('div', { 'data-bd-banner': '' }, '安全模式：当前不会自动发评论、不会发私信。想真发时，到「设置」把「自动评论并 @」和「投递方式」打开。')

      /* ── 侧边导航 ── */
      const PAGES = [['overview', '总览'], ['models', '模型与密钥'], ['logs', '专业日志'], ['persona', '人设'], ['chain', '降级链'], ['safety', '安全防护'], ['settings', '设置']]
      const sidebar = h('aside', { 'data-bd-sidebar': '' },
        PAGES.map(([v, label]) => h('button', { key: v, 'data-bd-pill': '', className: page === v ? 'active' : '', onClick: () => setPage(v) }, label)),
        h('button', { 'data-bd-pill': '', className: 'switch', onClick: openConsole }, '网页版控制台 ↗'),
        h('div', { 'data-bd-spacer': '' }),
        h('div', { 'data-bd-modecard': '' }, h('b', null, 'dsh-bili-console'), h('span', { style: { color: 'var(--t2)', fontSize: '11px' } }, 'DSH 内置控制台 · 与网页版共用同一份配置')))

      /* ── 各页面 ── */
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
                }, '撤回上一条' + (((st.posted && st.posted.count) || 0) ? ('（' + st.posted.count + '）') : ''))))),
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
            : h('div', { 'data-bd-empty': '' }, '没从 DSH 里提取到带密钥的模型。检查 DSH 的 cordis.patch.yml 里 providers 有没有配 apiKeyEnv，以及 ~/.dsh/.credentials.yaml 里有没有对应的 key。'))
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' },
            h('span', { className: 't' }, '模型与密钥'),
            h('span', { className: 's' }, '一个 API key 下挂多个模型；点模型名就能进出降级链')),
          Card({ title: '降级链（模型排队）', sub: '越靠上越先用，出问题往下切' },
            ChainList({ endpoints: chainDraft || [], onReorder: (i, d) => { const arr = (chainDraft || []).slice(); const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; setChainDraft(arr) } }),
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

      const renderPersona = () => h('div', { 'data-bd-pagewrap': '' },
        h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '人设'), h('span', { className: 's' }, 'AI 挑视频、写评论时按这张角色卡说话；改完下一轮生效')),
        Card({ title: '角色卡（personaPrompt）', sub: (persona || '').length + ' / 8000 字' },
          h('textarea', { 'data-bd-persona': '', spellcheck: false, value: persona || '', onChange: (e) => { setPersona(e.target.value); setDirty((d) => ({ ...d, persona: true })) } }),
          h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', flexWrap: 'wrap', alignItems: 'center' } },
            h('button', { 'data-bd-btn': '', className: 'primary', onClick: savePersona }, '保存人设'),
            h('button', { 'data-bd-btn': '', className: 'ghost', onClick: () => { setDirty((d) => ({ ...d, persona: false })); setPersona(cfg.personaPrompt || '') } }, '撤销改动，重新载入'))),
        h('div', { 'data-bd-callout': '' }, '上面文本框里就是插件实际使用的完整人格卡——没有摘要、没有截断，你写的多少字就用多少字（上限 8000 字，当前已用 ' + (persona || '').length + ' 字）。这个框也收文件路径：填一个 AGENTS.md 的路径，插件就会去读那个文件当人设。人设存在插件目录的 config.json 里，和 DSH 共用同一份；在这里改完，DSH 那边也是新的。'))

      const renderChain = () => {
        const ep = chainDraft || []
        return h('div', { 'data-bd-pagewrap': '' },
          h('div', { 'data-bd-pagetitle': '' }, h('span', { className: 't' }, '降级链'), h('span', { className: 's' }, '越靠上越先用：没钱 / 没资源包 / 适配器没注册，自动往下切')),
          Card({ title: '模型排队', sub: '↑↓ 调顺序 · 点模型名去「模型与密钥」里加减' },
            ChainList({ endpoints: ep, onReorder: (i, d) => { const arr = ep.slice(); const j = i + d; if (j < 0 || j >= arr.length) return; const t = arr[i]; arr[i] = arr[j]; arr[j] = t; setChainDraft(arr) } }),
            h('div', { style: { display: 'flex', gap: '10px', marginTop: '12px', alignItems: 'center' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: saveChainOrder }, '保存顺序'),
              h('button', { 'data-bd-btn': '', className: 'ghost sm', onClick: () => setPage('models') }, '去模型与密钥 ←'))))
      }

      const renderSafety = () => {
        const on = [cfg.autoComment, cfg.dmMode && cfg.dmMode !== 'off', cfg.replyToComments, cfg.transcribe, cfg.dmWatch].filter(Boolean).length
        const chips = [['peakValley', '错峰'], ['noon', '午间'], ['night', '夜间']]
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
            h('div', { style: { display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'center' } },
              h('span', { className: 'sub' }, '开启时段：'),
              chips.map(([k, label]) => h('span', { key: k, 'data-bd-chip': '', style: { cursor: 'pointer', background: cfg[k] ? 'var(--blue)' : 'var(--blue-bg)', color: cfg[k] ? '#fff' : 'var(--blue)' }, onClick: () => toggleChip(k, !cfg[k]) }, label)),
              h('span', { style: { marginLeft: 'auto' } }, Stepper({ value: (cfg.perDay || 0) + ' 条', onStep: (d) => step('perDay', d, ' 条') }))),
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

      const renderSettings = () => {
        const kwList = String(kws || '').split('\n').map((s) => s.trim()).filter(Boolean)
        const kwChips = h('div', { 'data-bd-chips': '' },
          kwList.map((k, i) => h('span', { key: i, 'data-bd-chip': '' }, k,
            h('button', { className: 'x', onClick: () => { const arr = kwList.slice(); arr.splice(i, 1); setKws(arr.join('\n')); setDirty((d) => ({ ...d, keywords: true })) } }, '×'))))
        const blocks = []
        blocks.push(h('div', { 'data-bd-pagetitle': '' },
          h('span', { className: 't' }, '设置'),
          h('span', { className: 's' }, '每一项都能改、都能存；改完即时生效并同步到 DSH')))

        /* 监听关键词 */
        blocks.push(Card({ title: '监听关键词', sub: '回车添加，点 × 移除' },
          kwChips,
          h('div', { style: { marginTop: '10px' } },
            h('div', { 'data-bd-input': '' }, h('input', {
              placeholder: '+ 输入后回车添加', value: newKw,
              onChange: (e) => setNewKw(e.target.value),
              onKeyDown: (e) => { if (e.key === 'Enter') { e.preventDefault(); const v = newKw.trim(); if (v) { setKws((kws || '') + (kws ? '\n' : '') + v); setNewKw(''); setDirty((d) => ({ ...d, keywords: true })) } } },
            }))),
          h('div', { 'data-bd-note': '', style: { margin: '10px 0 0' } }, 'AI 拿这些词去 B站 搜视频；没填就用默认几组（DeepSeek Harness、DSH 插件等）。')))

        /* 评论与互动 */
        blocks.push(Card({ title: '评论与互动', sub: null },
          ToggleRow({ label: '自动评论并 @', note: '开着才会发评论；关了就只挑不发，不打扰任何人', on: !!cfg.autoComment, onChange: (v) => saveOne('autoComment', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '@ 谁'), h('div', { 'data-bd-ds': '' }, '评论结尾 @ 这个人，比如填 @某位好友（不填就不 @）')),
            Input({ value: mentionDraft != null ? mentionDraft : (cfg.mentionName || ''), onChange: (v) => { setMentionDraft(v); setDirty((d) => ({ ...d, mentionName: true })) }, placeholder: '@某人' })),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每轮最多评论'), h('div', { 'data-bd-ds': '' }, '一轮里最多发几条；超出自动暂停，防止刷太猛被盯上')),
            Stepper({ value: (cfg.commentPerRound || 0) + ' 条', onStep: (d) => step('commentPerRound', d, ' 条') })),
          ToggleRow({ label: '回复评论', note: '别人回复你的评论时，它接一句（每轮最多「每轮回复几条」条）。不保存上下文时它只看到对方那一句；想让它记得来龙去脉，到「设置 → 上下文与记忆」打开保留上下文', on: !!cfg.replyToComments, onChange: (v) => saveOne('replyToComments', v) }),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每轮回复几条'), h('div', { 'data-bd-ds': '' }, '回评论的轮次上限；每条 100 字以内')),
            Stepper({ value: (cfg.replyPerRound || 0) + ' 条', onStep: (d) => step('replyPerRound', d, ' 条') }))))

        /* 每天挑与转写 */
        {
          const asr = st.asr || {}
          blocks.push(Card({
            title: '每天挑与转写', sub: null,
            right: Tag({ c: asr.ready ? 'green' : 'amber', children: asr.ready ? ('转写后端就绪 · ' + (asr.backend || '')) : '转写后端未装' }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '每天最多挑几条'), h('div', { 'data-bd-ds': '' }, '全天总量：AI 一轮里从候选视频里挑出值得看的条数。挑满就收工，不贪多')),
              Stepper({ value: (cfg.perDay || 0) + ' 条', onStep: (d) => step('perDay', d, ' 条') })),
            ToggleRow({
              label: '本地转写',
              note: asr.ready
                ? ('没字幕时会下载音频，用本机 ' + (asr.backend || '转写后端') + ' 转成文字再看内容；慢几十秒，不花云端额度')
                : ('没装后端：' + (asr.reason || '') + '。没装时没字幕的视频会直接跳过（装好后这个开关才有意义）'),
              on: !!cfg.transcribe, onChange: (v) => saveOne('transcribe', v),
            }),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '转写模型'), h('div', { 'data-bd-ds': '' }, 'small 最快、large 最准也最慢')),
              Select({ value: cfg.asrModel || 'small', onChange: (v) => saveOne('asrModel', v), minWidth: 130 },
                h('option', { value: 'small' }, 'small'), h('option', { value: 'medium' }, 'medium'), h('option', { value: 'large' }, 'large')))))
        }

        /* 私信 */
        blocks.push(Card({ title: '私信', sub: null },
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
        blocks.push(Card({ title: '日报详略 · 收藏夹', sub: null },
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '报告级别'), h('div', { 'data-bd-ds': '' }, '完整 = 每个挑中的视频单独一段；薄薄两行 = 只列值不值得 + 链接；不写 = 不出日报文件，但判重表照记')),
            Select({ value: cfg.reportLevel || 'full', onChange: (v) => saveOne('reportLevel', v), minWidth: 130 },
              h('option', { value: 'full' }, '完整'), h('option', { value: 'brief' }, '薄薄两行'), h('option', { value: 'none' }, '不写'))),
          h('div', { 'data-bd-setrow': '' },
            h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '收藏夹 ID'), h('div', { 'data-bd-ds': '' }, '填了就把判为「值得看」的视频收进这个收藏夹（用插件里新加的 bili_favorite_add）；0 = 不收藏')),
            Input({ value: favDraft != null ? favDraft : (cfg.favFolderId != null ? String(cfg.favFolderId) : '0'), onChange: (v) => { setFavDraft(v); setDirty((d) => ({ ...d, favFolderId: true })) }, placeholder: '0' }))))

        /* 识图模型 */
        {
          const vs = st.vision || {}
          blocks.push(Card({
            title: '识图模型（可选）', sub: '没字幕时让它看一眼封面，给判断补画面信息',
            right: Tag({ c: vs.ready ? 'green' : 'gray', children: vs.ready ? ('已配 · ' + (vs.model || '')) : '未配' }),
          },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API 地址'), h('div', { 'data-bd-ds': '' }, '智谱就是 https://open.bigmodel.cn/api/paas/v4')),
              Input({ value: vUrl || '', onChange: setVUrl, placeholder: 'https://open.bigmodel.cn/api/paas/v4' })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '模型名'), h('div', { 'data-bd-ds': '' }, '免费视觉模型：glm-4v-flash / glm-4.6v-flash')),
              Input({ value: vModel || '', onChange: setVModel, placeholder: 'glm-4v-flash' })),
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'API Key'), h('div', { 'data-bd-ds': '' }, '留空 = 沿用已经存过的 key，不会清掉')),
              Input({ value: vKey || '', onChange: setVKey, placeholder: '留空沿用已存的 key', type: 'password' })),
            h('div', { style: { display: 'flex', gap: '10px', alignItems: 'center', marginTop: '4px' } },
              h('button', { 'data-bd-btn': '', className: 'primary sm', onClick: () => saveVision({ apiUrl: String(vUrl || '').trim(), modelName: String(vModel || '').trim(), apiKey: String(vKey || '').trim() || ((cfg.visionModel || {}).apiKey || '') }) }, '保存识图模型'),
              h('span', { 'data-bd-ds': '' }, '配了以后：没字幕的视频会用封面图补一点画面信息'))))
        }

        /* 上下文与记忆 */
        {
          const mem = st.memory || {}
          const inThread = (cfg.contextMode === 'thread')
          blocks.push(Card({ title: '上下文与记忆', sub: '默认：一条视频一个上下文，判完就忘' },
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

        /* 运行环境 */
        {
          const v = st.venv || {}
          const ready = Boolean(st.venvReady)
          const where = v.venvReady ? v.venvPath : (v.baseWithDeps || '')
          const desc = ready
            ? ('已就绪 · ' + (where || '系统 Python') + '（bilibili-api / mcp / aiohttp / qrcode 都在）')
            : (v.basePython ? ('有 Python（' + v.basePython + '），但还没装依赖 —— 首次登录或跑一轮时会自动装，约 1-2 分钟，需联网') : '没检测到 Python 3。请先装 Python 3.10+（python.org），安装时勾选 “Add Python to PATH”')
          blocks.push(Card({ title: '运行环境', sub: '依赖插件自己装，不用你手动 pip' },
            h('div', { 'data-bd-setrow': '' },
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, 'Python 依赖'), h('div', { 'data-bd-ds': '' }, desc)),
              Tag({ c: ready ? 'green' : 'amber', children: ready ? '就绪' : '待安装' }))))
        }

        /* 高级（只读） */
        blocks.push(Card({ title: '高级（只读，改文件才行）', sub: null },
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
          blocks.push(Card({
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
              h('div', { 'data-bd-txt': '' }, h('div', { 'data-bd-lb': '' }, '最新版本'),
                h('div', { 'data-bd-ds': '' }, base.ok
                  ? ('GitHub 仓库里是 v' + base.latest + (base.hasUpdate ? '，比你手上的新' : '，和你手上一样') + (base.source ? ('（走的是：' + base.source + '）') : ''))
                  : '没连上 GitHub。换下面的加速源再点一次「立即检查更新」')),
              Tag({ c: base.hasUpdate ? 'amber' : (base.ok ? 'green' : 'gray'), children: base.ok ? ('v' + base.latest) : '未知' })),
            base.hasUpdate ? h('div', { 'data-bd-note': '', style: { margin: '0 0 12px' } },
              h('div', null, '发现新版本 v' + base.latest + '。下载后重新导入安装包即可，你原来的配置和登录凭证不会被覆盖：'),
              h('div', { style: { marginTop: '8px', display: 'flex', gap: '12px', flexWrap: 'wrap' } },
                h('a', { 'data-bd-link': '', href: base.zipUrl, target: '_blank', rel: 'noopener' }, '下载最新代码 zip ↗'),
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

        /* 保存栏 */
        blocks.push(Card({ title: null },
          h('span', { className: 'sub' }, '所有修改写入插件同一份 config.json，DSH 那边同步生效'),
          h('div', { style: { marginLeft: 'auto', display: 'flex', gap: '10px' } },
            h('button', { 'data-bd-btn': '', className: 'ghost', onClick: () => { setDirty({}); setPersona(null); setKws(null); setMentionDraft(null); setDmUidDraft(null); setFavDraft(null) } }, '重新载入'),
            h('button', { 'data-bd-btn': '', className: 'primary', onClick: saveSettings }, '保存设置'))))

        return h('div', { 'data-bd-pagewrap': '' }, blocks)
      }

      const PAGERENDER = { overview: renderOverview, models: renderModels, logs: renderLogs, persona: renderPersona, chain: renderChain, safety: renderSafety, settings: renderSettings }
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

      return h('div', { 'data-bd-page': '', ref: rootRef, className: narrow ? 'narrow' : '' },
        topbar,
        loginBar,
        banner,
        h('div', { 'data-bd-main': '' }, sidebar, content),
        h('div', { 'data-bd-foot': '' }, '插件目录：' + (st.home || '—') + ' · 本地服务 127.0.0.1 · 每 2 秒自动刷新 · 最近更新 ' + (st.now || '')),
        modal, webPanel, toastEl)
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
