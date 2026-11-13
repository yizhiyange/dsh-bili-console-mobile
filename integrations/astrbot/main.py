"""
astrbot_plugin_bili_bridge —— 把「刷B站助手」接进聊天（v0.3.0）
============================================================
核心改变（v0.3.0「记在心里」）：
    助手每刷到一条视频，就按「标题 + 链接」记进小鲸鱼的见闻笔记
    （插件数据目录 notes.md）。每次 AI 开口前，把最近几条见闻
    塞进 system_prompt —— 聊天聊到相关话题时，它自然想得起来，
    像真人「刷到过、记在心里」一样，不用谁去翻工具。

自动分享：
    不用填群号 —— 它在哪个群聊过天就记住哪个群（90 分钟内的活跃群）。
    刷到新视频，挑最新的主动甩进群里（标题 + 可点链接）。
    首轮只记账不发言，防历史刷屏。

给大模型的三件工具：
    bili_status       看助手状态（登录没、今天刷了多少、忙不忙、有没有被风控冷却）
    bili_recent_feed  看最近刷到的视频（带可点链接）+ 发出去的评论
    bili_run_round    命令助手现在去刷一轮B站
"""

import asyncio
import json
import re
import subprocess
import time
import urllib.request

from astrbot.api import logger
from astrbot.api.event import AstrMessageEvent, filter
from astrbot.api.event.filter import EventMessageType
from astrbot.api.star import Context, Star, StarTools, register
from astrbot.core.message.message_event_result import MessageChain

RE_JUDGED = re.compile(r"判 (BV[0-9A-Za-z]{10})「(.+?)」")
RE_POSTED = re.compile(r"已发 (BV[0-9A-Za-z]{10})：(.+)")
RE_VERDICT = re.compile(r"(BV[0-9A-Za-z]{10}) → \S+：(.+)")

MIND_INJECT = (
    "\n[你最近刷B站记在心里的见闻]（聊到相关话题时可以自然提起，"
    "像随口想起来的，不要一次性全倒出来，也不要提笔记两个字）：\n{items}"
)


@register("bili_bridge", "yizhiyange", "刷B站助手桥", "0.3.0")
class BiliBridge(Star):
    def __init__(self, context: Context, config=None):
        super().__init__(context)
        self.cfg = config or {}
        self._task = None
        self._notes = []          # [{bv, title, ts}] 新的在前
        self._seen_bvs = set()
        self._groups = {}         # umo -> 最后发言时间戳
        try:
            self.data_dir = StarTools.get_data_dir("astrbot_plugin_bili_bridge")
        except Exception:
            self.data_dir = None
        self._load_notes()
        logger.info(
            "[刷B站桥] 门卫:%s（口令%s填） 见闻已记 %d 条",
            self._base(), "已" if self._token() else "未", len(self._notes),
        )

    # ---------- 生命周期 ----------

    async def initialize(self):
        self._task = asyncio.create_task(self._mind_loop())

    async def terminate(self):
        if self._task:
            self._task.cancel()
            self._task = None

    # ---------- 底层 ----------

    def _base(self) -> str:
        return str(self.cfg.get("api_base", "http://127.0.0.1:8792")).rstrip("/")

    def _panel(self) -> str:
        return str(self.cfg.get("panel_base", "http://127.0.0.1:8790/api/bili-console")).rstrip("/")

    def _token(self) -> str:
        return str(self.cfg.get("token", "")).strip()

    def _hint(self) -> str:
        return str(self.cfg.get("hint", "")).strip()

    def _cmd_sync(self, action: str, args=None, timeout: int = 90) -> str:
        body = json.dumps({"action": action, "args": args or {}}).encode("utf-8")
        req = urllib.request.Request(
            self._base() + "/cmd",
            data=body,
            headers={"Content-Type": "application/json", "X-Bili-Token": self._token()},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=timeout) as r:
            d = json.loads(r.read().decode("utf-8"))
        if not isinstance(d, dict):
            return "助手回了个看不懂的东西"
        return str(d.get("reply", "")) or "助手没给出说明，去面板看看"

    def _raw_sync(self, path: str, timeout: int = 20):
        try:
            req = urllib.request.Request(self._panel() + "/" + path.lstrip("/"))
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return json.loads(r.read().decode("utf-8"))
        except Exception as e:
            # 连不上（机器重启后面板没起来）：拉活一次，稍等重试
            msg = str(e)
            if "Connection refused" in msg or "Errno 111" in msg or "10061" in msg:
                self._revive()
                import time as _t
                for _ in range(4):          # node 起来要几秒，多试几次
                    _t.sleep(5)
                    try:
                        req = urllib.request.Request(self._panel() + "/" + path.lstrip("/"))
                        with urllib.request.urlopen(req, timeout=timeout) as r:
                            return json.loads(r.read().decode("utf-8"))
                    except Exception:
                        continue
            raise

    def _revive(self):
        """面板死了（多半是机器重启）就把它拉起来 —— 自愈。"""
        try:
            subprocess.Popen(
                ["bash", "-c",
                 "cd ~/bili-console && setsid nohup bash -c 'BILI_HOST=0.0.0.0 exec node standalone.mjs' "
                 ">> ~/.bili-console-app/bili.log 2>&1 &"],
                stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
                start_new_session=True,
            )
            logger.info("[刷B站桥] 面板没响应，已尝试自动拉起（约 5 秒后恢复）")
            return True
        except Exception as e:
            logger.warning("[刷B站桥] 自动拉起失败: %s", e)
            return False

    async def _cmd(self, action: str, args=None, timeout: int = 90) -> str:
        try:
            loop = asyncio.get_running_loop()
            reply = await loop.run_in_executor(None, lambda: self._cmd_sync(action, args, timeout))
            hint = self._hint()
            return (hint + "\n" + reply) if hint else reply
        except Exception as e:
            logger.warning("[刷B站桥] %s 失败: %s", action, e)
            return "(刷B站助手现在联系不上，可能没开机或没启动。别编造它刷了什么。)"

    # ---------- 见闻笔记（记在心里） ----------

    def _notes_file(self):
        return (self.data_dir / "notes.json") if self.data_dir else None

    def _load_notes(self):
        f = self._notes_file()
        if not f:
            return
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
            self._notes = d.get("notes", [])
            self._seen_bvs = set(d.get("seen", []))
        except Exception:
            self._notes, self._seen_bvs = [], set()

    def _save_notes(self):
        f = self._notes_file()
        if not f:
            return
        try:
            f.write_text(json.dumps({
                "notes": self._notes[:120],
                "seen": sorted(self._seen_bvs)[-400:],
            }, ensure_ascii=False), encoding="utf-8")
        except Exception:
            pass

    def _extract_from_log(self, text: str):
        """从 duty.log 抽见闻（新的在前）：
        「判 BVxxx「标题」」/「已发 BVxxx：评语」/「BVxxx → 评级：AI理由」。
        条目 {bv, title, note}，note = 评语或 AI 判断理由（梗知识的本体）。"""
        out, seen = [], set()
        for line in reversed((text or "").splitlines()):
            m = RE_JUDGED.search(line) or RE_POSTED.search(line) or RE_VERDICT.search(line)
            if not m:
                continue
            bv = m.group(1)
            if bv in seen:
                continue
            seen.add(bv)
            out.append({"bv": bv, "title": m.group(2).strip(), "note": "", "ts": time.time()})
        return out

    def _merge_report(self, rows):
        """用日报把条目养肥：日报每块有完整标题、AI 判断理由、拟评论（梗/总结）。"""
        try:
            d = self._raw_sync("/report")
            md = str(d.get("markdown") or "") if isinstance(d, dict) else ""
        except Exception:
            return rows
        if not md:
            return rows
        by_bv = {r["bv"]: r for r in rows}
        for block in md.split("\n### ")[1:]:
            m = re.search(r"BV[0-9A-Za-z]{10}", block)
            if not m or m.group(0) not in by_bv:
                continue
            r = by_bv[m.group(0)]
            mt = re.search(r"- 标题：(.+?)（关键词", block)
            if mt and mt.group(1).strip():
                r["title"] = mt.group(1).strip()[:60]
            mc = re.search(r"- 拟评论：(.+)", block)
            if mc and mc.group(1).strip():
                r["note"] = mc.group(1).strip()[:80]
            elif not r.get("note"):
                first = block.strip().splitlines()
                if len(first) >= 2:
                    r["note"] = first[1].strip()[:80]   # 首行是「### BV · 评级」，第二行是 AI 理由
        return rows

    async def _harvest(self, trigger_if_empty: bool):
        """收一轮日志+日报里的见闻；没新货且允许时，让助手试跑一轮再收一次。"""
        loop = asyncio.get_running_loop()
        d = await loop.run_in_executor(None, lambda: self._raw_sync("/rawlog?count=240"))
        text = "\n".join(str(l.get("msg", "")) for l in (d.get("lines") or []) if isinstance(l, dict))
        rows = self._extract_from_log(text)
        fresh = [r for r in rows if r["bv"] not in self._seen_bvs]
        if not fresh and trigger_if_empty:
            logger.info("[刷B站桥] 没新见闻，让助手试跑一轮（只挑不发）")
            await self._cmd("dry", timeout=300)
            await asyncio.sleep(90)
            d = await loop.run_in_executor(None, lambda: self._raw_sync("/rawlog?count=240"))
            text = "\n".join(str(l.get("msg", "")) for l in (d.get("lines") or []) if isinstance(l, dict))
            rows = self._extract_from_log(text)
            fresh = [r for r in rows if r["bv"] not in self._seen_bvs]
        if fresh:
            rows = await loop.run_in_executor(None, lambda: self._merge_report(rows))
            fresh = [r for r in rows if r["bv"] not in self._seen_bvs]
            for r in reversed(fresh):     # 旧的先进，新的排前
                self._notes.insert(0, r)
                self._seen_bvs.add(r["bv"])
            self._notes = self._notes[:120]
            self._save_notes()
        return fresh

    # ---------- 记进 AI 心里：检索式注入（库与上下文隔离，命中才给，省 token） ----------

    _BROAD = ("b站", "视频", "刷到", "刷的", "推荐", "看过", "看了", "看点", "梗", "知识", "冷知识",
              "热搜", "热议", "新闻", "最近", "听说", "话题", "吃瓜", "瓜", "崩了", "服务器", "冲浪")

    @staticmethod
    def _segs(title: str):
        """标题去标点后按二字滑窗切成词片段（「港风聊斋AI短剧」→ 港风/风聊/聊斋/AI/短剧…），
        单字不建词、避免乱触发。"""
        clean = re.sub(r"[「」【】\s，。！？:：/|·\-—…,.!?（）()]+", "", title or "")
        return {clean[i:i + 2] for i in range(len(clean) - 1)} if len(clean) >= 2 else set()

    def _match_notes(self, text: str):
        """聊天内容 ↔ 见闻库检索：命中 ≥2 个二字词才算直接相关（防单字/单词巧合误触发）。"""
        t = (text or "").strip()
        if not t or not self._notes:
            return [], False
        tl = t.lower()
        exact = []
        for n in self._notes[:80]:
            segs = self._segs(n["title"])
            if not segs:
                continue
            hits = sum(1 for s in segs if s in t or s.lower() in tl)
            if hits >= 2:
                exact.append(n)
            if len(exact) >= 3:
                break
        if exact:
            return exact, True
        broad = any(w in tl for w in self._BROAD)
        if broad:
            return self._notes[:2], False
        return [], False

    @filter.on_llm_request()
    async def on_llm_req(self, event, req):
        if not self._notes:
            return
        try:
            msg = getattr(event, "message_str", "") or ""
        except Exception:
            msg = ""
        hits, direct = self._match_notes(msg)
        if not hits:
            return
        if direct:
            items = "\n".join(
                f"- {n['title']}｜你当时的想法：{n.get('note') or '（没留）'}（链接 https://www.bilibili.com/video/{n['bv']} 可发出来）"
                for n in hits
            )
            add = (
                "\n[见闻检索命中] 下面是你自己之前刷B站记下的、和这条消息直接相关的见闻。"
                "如果它涉及梗、热梗或最近热议（服务器崩了、时事瓜之类），把它当成你本来就知道的"
                "最近话题自然聊，像随口想起来一样，别提检索、笔记这些词：\n" + items
            )
        else:
            items = "\n".join(
                f"- {n['title']}｜{n.get('note') or ''}（https://www.bilibili.com/video/{n['bv']}）"
                for n in hits
            )
            add = (
                "\n[你最近刷B站记下的] 这些可以当成你了解的最近梗/热议话题，"
                "聊到相关话题时自然提起：\n" + items
            )
        try:
            req.system_prompt += add
        except Exception:
            pass

    # ---------- 群活跃自动记忆（不用填群号） ----------

    @filter.event_message_type(EventMessageType.ALL, priority=1)
    async def on_any_message(self, event: AstrMessageEvent):
        try:
            if event.get_message_type().name != "GroupMessage":
                return
            umo = event.unified_msg_origin
            if umo:
                self._groups[umo] = time.time()
                if len(self._groups) > 50:
                    keep = sorted(self._groups.items(), key=lambda x: -x[1])[:50]
                    self._groups = dict(keep)
        except Exception:
            pass

    def _active_groups(self, window_sec=5400, limit=2):
        now = time.time()
        alive = [(t, u) for u, t in self._groups.items() if now - t <= window_sec]
        return [u for _, u in sorted(alive, reverse=True)[:limit]]

    # ---------- 心跳：刷 → 记 → 分享 ----------

    async def _mind_loop(self):
        first = True
        brush = False          # 本轮要不要主动刷：从刷B站面板的配置读（总览页「自动刷见闻」开关）
        while True:
            try:
                if first:
                    await asyncio.sleep(45)
                    first = False
                else:
                    st = {}
                    try:
                        loop = asyncio.get_running_loop()
                        st = await loop.run_in_executor(None, lambda: self._raw_sync("/state"))
                    except Exception as e:
                        logger.warning("[刷B站桥] 读面板配置失败: %s", e)
                    s = (st.get("settings") or {}) if isinstance(st, dict) else {}
                    brush = bool(s.get("autoBrushOn", self.cfg.get("autoBrushOn", False)))
                    wait_min = int(s.get("brushEveryMin") or self.cfg.get("brushEveryMin", 120) or 120)
                    await asyncio.sleep(max(20, wait_min) * 60)
                fresh = await self._harvest(trigger_if_empty=brush)
                if not fresh or not self._notes:
                    continue
                groups = self._active_groups()
                if not groups or not self.cfg.get("shareOn", True):
                    continue
                n = fresh[0]
                text = f"刚刷到个「{n['title']}」，有点意思\nhttps://www.bilibili.com/video/{n['bv']}"
                for g in groups:
                    try:
                        await self.context.send_message(g, MessageChain().message(text))
                        logger.info("[刷B站桥] 已分享到 %s: %s", g, n["bv"])
                    except Exception as e:
                        logger.warning("[刷B站桥] 分享到 %s 失败: %s", g, e)
                await asyncio.sleep(2)
            except asyncio.CancelledError:
                return
            except Exception as e:
                logger.warning("[刷B站桥] 心跳出错: %s", e)
                await asyncio.sleep(120)

    # ---------- 给大模型的工具 ----------

    @filter.llm_tool()
    async def bili_status(self, event: AstrMessageEvent):
        """查看刷B站助手的当前状态：B站登录了没、今天刷了多少条视频、现在忙不忙、有没有在风控冷却。当群友问你在干嘛、刷B站了没、或者你想知道自己账号状态时用。
        """
        return await self._cmd("status", timeout=15)

    @filter.llm_tool()
    async def bili_recent_feed(self, event: AstrMessageEvent):
        """看刷B站助手最近刷到的B站视频（带链接，可以甩给群友点开）。当群友求推荐、问"你最近看了啥"，或你想分享刚刷到的视频时用。分享时直接把链接发出来。
        """
        watched = "最近刷到的：\n"
        if self._notes:
            watched += "\n".join(
                f"{i}. {n['title']} https://www.bilibili.com/video/{n['bv']}"
                for i, n in enumerate(self._notes[:5], 1)
            )
        else:
            try:
                loop = asyncio.get_running_loop()
                d = await loop.run_in_executor(None, lambda: self._raw_sync("/watched"))
                rows = d.get("rows") or []
                watched += "\n".join(
                    f"{i}. {r.get('url') or 'https://www.bilibili.com/video/' + r.get('bvid','')}"
                    for i, r in enumerate(rows[:5], 1)
                ) or "（还没刷过）"
            except Exception:
                watched += "（还没刷过）"
        return (self._hint() + "\n" + watched) if self._hint() else watched

    @filter.llm_tool()
    async def bili_run_round(self, event: AstrMessageEvent):
        """让刷B站助手现在就去刷一轮B站：挑视频、看内容、把梗和热议记进心里（试跑模式，不会往B站发任何东西）。一次要几分钟，一小时最多一两次，不要连续调用。
        """
        return await self._cmd("dry", timeout=300)
