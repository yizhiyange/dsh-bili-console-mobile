#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
make_video.py —— 最简「图文口播」视频生成器（零前置：不依赖系统 ffmpeg）
============================================================================
为什么单独一个脚本：视频编码是 CPU 密集活，放在独立进程里跑，
不占 DSH 主进程、随时可以杀，手机上也更稳。

依赖（都由 pip 自动装，不需要用户手动）：
  · Pillow        —— 画文字卡（qrcode[pil] 已经带它）
  · imageio-ffmpeg —— 自带一份 ffmpeg 二进制（**不需要系统装 ffmpeg**）
  · edge-tts      —— 可选，免费语音合成，**不需要任何 API key**（只是要联网）

用法：
  python make_video.py spec.json
spec.json：
  {
    "out": "D:/x/output.mp4",
    "width": 1280, "height": 720, "fps": 25,
    "cards": [{"title": "标题", "lines": ["第一行", "第二行"], "seconds": 4.5}],
    "voice": {"enabled": true, "voice": "zh-CN-XiaoxiaoNeural", "rate": "+0%"}
  }

进度约定：往 stdout 打 `PROGRESS <0-100>`，Node 侧解析显示进度。
============================================================================
"""
import json
import os
import subprocess
import sys
import tempfile
import asyncio

W_WARN = '#_'

# ---------- 字体：跨平台找一个能写中文的 ----------
def find_font():
    cands = [
        # Windows
        'C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc',
        'C:/Windows/Fonts/simhei.ttf', 'C:/Windows/Fonts/simsun.ttc',
        # Android / Termux / proot
        '/system/fonts/NotoSansCJK-Regular.ttc', '/system/fonts/NotoSansSC-Regular.otf',
        '/system/fonts/DroidSansFallback.ttf',
        '/data/data/com.termux/files/usr/share/fonts/TTF/NotoSansCJK-Regular.ttc',
        # Linux
        '/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc',
        '/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc',
        '/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',
        # macOS
        '/System/Library/Fonts/PingFang.ttc',
        '/System/Library/Fonts/STHeiti Medium.ttc',
    ]
    for p in cands:
        if os.path.exists(p):
            return p
    return None


def progress(pct):
    try:
        sys.stdout.write('PROGRESS %d\n' % int(pct))
        sys.stdout.flush()
    except Exception:
        pass


def log(msg):
    try:
        sys.stdout.write(str(msg) + '\n')
        sys.stdout.flush()
    except Exception:
        pass


def wrap_cjk(draw, text, font, max_w):
    """按像素宽度折行（中英文混排都能用）"""
    lines, cur = [], ''
    for ch in str(text or ''):
        if ch == '\n':
            lines.append(cur); cur = ''; continue
        if draw.textlength(cur + ch, font=font) > max_w:
            lines.append(cur); cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def load_bg(path, W, H):
    """把背景图按 cover 方式铺满（不变形），失败返回 None"""
    try:
        from PIL import Image
        if not path or not os.path.exists(path):
            return None
        im = Image.open(path).convert('RGB')
        sw, sh = im.size
        if not sw or not sh:
            return None
        scale = max(W / sw, H / sh)
        nw, nh = int(sw * scale + 0.5), int(sh * scale + 0.5)
        im = im.resize((max(W, nw), max(H, nh)), Image.LANCZOS)
        left = max(0, (im.size[0] - W) // 2)
        top = max(0, (im.size[1] - H) // 2)
        return im.crop((left, top, left + W, top + H))
    except Exception as e:
        log('背景图加载失败：%s' % str(e)[:100])
        return None


import unicodedata


def clean_text(t):
    """去掉 emoji 与各类"字库里没有"的符号（2026-11-1）。
    为什么：中文字体（msyh/Noto CJK）里没有彩色 emoji 字形，画出来就是一个空心方框，
    用户看到的是「耳朵要聋了▯」。emoji 表现力交给文字本身，别硬画。"""
    out = []
    for ch in str(t or ''):
        cp = ord(ch)
        # 常见 emoji / 符号区
        if (0x1F000 <= cp <= 0x1FAFF) or (0x2600 <= cp <= 0x27BF) or (0x1F1E6 <= cp <= 0x1F1FF):
            continue
        if cp in (0xFE0F, 0x200D, 0x20E3, 0xFE0E):      # 变体选择符/零宽连接
            continue
        if 0x2190 <= cp <= 0x21FF:                       # 箭头（字体常缺）
            continue
        cat = unicodedata.category(ch)
        if cat in ('So', 'Sk', 'Cs', 'Co', 'Cn'):        # 其它图片符号/修饰符/私用区
            continue
        out.append(ch)
    s2 = ''.join(out)
    # 收尾清理：多余空格、连续标点
    while '  ' in s2:
        s2 = s2.replace('  ', ' ')
    return s2.strip()


def _fit_font(font_path, text, max_w, draw, start=86, min_size=34):
    """按可用宽度自动挑字号，避免长标题挤成一团或溢出"""
    from PIL import ImageFont
    size = start
    while size > min_size:
        try:
            f = ImageFont.truetype(font_path, size) if font_path else ImageFont.load_default()
        except Exception:
            return None, size
        try:
            w = draw.textlength(text, font=f)
        except Exception:
            w = len(text) * size
        if w <= max_w:
            return f, size
        size -= 4
    try:
        return (ImageFont.truetype(font_path, min_size) if font_path else ImageFont.load_default()), min_size
    except Exception:
        return None, min_size


def render_card(card, idx, total, W, H, font_path):
    """返回 (底图, 文字层)。文字层单独一层是为了做淡入动画（不用每帧重排文字）。"""
    from PIL import Image, ImageDraw, ImageFont

    title = clean_text(card.get('title') or '')
    body = [clean_text(x) for x in (card.get('lines') or []) if clean_text(x)]

    # ── 底图：有素材图就用，没有就画渐变（纯黑太呆）
    bg = load_bg(card.get('bg') or '', W, H)
    if bg is not None:
        base = bg.convert('RGBA')
        ov = Image.new('RGBA', (W, H), (8, 10, 14, 176))
        base = Image.alpha_composite(base, ov)
    else:
        base = Image.new('RGBA', (W, H), (0, 0, 0, 255))
        px = base.load()
        for y in range(H):
            t = y / max(1, H - 1)
            r = int(14 + 16 * t)
            g = int(17 + 18 * t)
            b = int(24 + 26 * t)
            for x in range(0, W):
                px[x, y] = (r, g, b, 255)

    d0 = ImageDraw.Draw(base)
    accent = (64, 158, 255)
    # 装饰：左侧竖条 + 底部细线（保留一点品牌感）
    d0.rectangle([0, 0, 10, H], fill=accent)

    layer = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    try:
        f_small = ImageFont.truetype(font_path, 26) if font_path else ImageFont.load_default()
    except Exception:
        f_small = None

    if f_small:
        d.text((48, 38), '第 %d / %d 页' % (idx + 1, total), font=f_small, fill=(126, 136, 152, 255))

    variant = idx % 5
    pad = 80

    if variant == 0 and title:
        # ① 大标题居中 + 副标题
        f_t, _sz = _fit_font(font_path, title, W - pad * 2, d, 96)
        if f_t:
            tl = wrap_cjk(d, title, f_t, W - pad * 2)
            th = len(tl) * (_sz + 16)
            y = int(H * 0.5 - th / 2) - 30
            for ln in tl[:3]:
                w = d.textlength(ln, font=f_t)
                d.text(((W - w) / 2, y), ln, font=f_t, fill=(246, 249, 255, 255))
                y += _sz + 16
            d.rectangle([(W / 2 - 34), y + 34, (W / 2 + 34), y + 39], fill=accent + (255,))
            y += 66
            f_b = ImageFont.truetype(font_path, 40) if font_path else None
            if f_b:
                for para in body[:2]:
                    for ln in wrap_cjk(d, para, f_b, W - pad * 2):
                        w = d.textlength(ln, font=f_b)
                        d.text(((W - w) / 2, y), ln, font=f_b, fill=(198, 207, 220, 255))
                        y += 54
                        if y > H - 70:
                            break

    elif variant == 1:
        # ② 大编号 + 左对齐标题 + 分隔线
        f_num = ImageFont.truetype(font_path, 130) if font_path else None
        if f_num:
            num = '%02d' % (idx + 1)
            nw = d.textlength(num, font=f_num)
            d.text((W - nw - 56, 70), num, font=f_num, fill=(38, 44, 56, 255))
        y = int(H * 0.38)
        tw = W - pad * 2 - 130        # 给右上角编号留位置，别让标题压上去
        f_t, sz = _fit_font(font_path, title, tw, d, 76)
        if f_t and title:
            for ln in wrap_cjk(d, title, f_t, tw)[:2]:
                d.text((pad, y), ln, font=f_t, fill=(246, 249, 255, 255))
                y += sz + 10
        y += 26
        d.rectangle([pad, y, pad + 64, y + 5], fill=accent + (255,))
        y += 30
        f_b = ImageFont.truetype(font_path, 40) if font_path else None
        if f_b:
            for para in body[:3]:
                for ln in wrap_cjk(d, para, f_b, W - pad * 2):
                    if y > H - 80:
                        break
                    d.text((pad, y), ln, font=f_b, fill=(200, 209, 222, 255))
                    y += 56

    elif variant == 2 and title:
        # ③ 金句：整句居中大字（标题+正文合成一句）
        line = title if not body else (title + '，' + body[0])
        f_t, sz = _fit_font(font_path, line, W - pad * 2, d, 82, 40)
        if f_t:
            tl = wrap_cjk(d, line, f_t, W - pad * 2)
            th = len(tl) * (sz + 14)
            y = int((H - th) / 2)
            for ln in tl[:4]:
                w = d.textlength(ln, font=f_t)
                d.text(((W - w) / 2, y), ln, font=f_t, fill=(248, 250, 255, 255))
                y += sz + 14

    elif variant == 3:
        # ④ 上下分层：上面大字标题，下面带「·」的列表
        f_t, sz = _fit_font(font_path, title, W - pad * 2, d, 72)
        y = 90
        if f_t and title:
            for ln in wrap_cjk(d, title, f_t, W - pad * 2)[:2]:
                d.text((pad, y), ln, font=f_t, fill=(248, 250, 255, 255))
                y += sz + 10
        d.rectangle([pad, y + 16, W - pad, y + 19], fill=(58, 66, 80, 255))
        y += 56
        f_b = ImageFont.truetype(font_path, 38) if font_path else None
        if f_b:
            for para in body[:4]:
                for ln in wrap_cjk(d, para, f_b, W - pad * 2 - 30):
                    if y > H - 90:
                        break
                    d.ellipse([pad, y + 16, pad + 9, y + 25], fill=accent + (255,))
                    d.text((pad + 26, y), ln, font=f_b, fill=(206, 214, 226, 255))
                    y += 54

    else:
        # ⑤ 兜底：居中标题 + 正文
        y = int(H * 0.34)
        f_t, sz = _fit_font(font_path, title or ' ', W - pad * 2, d, 78)
        if f_t and title:
            for ln in wrap_cjk(d, title, f_t, W - pad * 2)[:2]:
                w = d.textlength(ln, font=f_t)
                d.text(((W - w) / 2, y), ln, font=f_t, fill=(246, 249, 255, 255))
                y += sz + 12
        y += 26
        f_b = ImageFont.truetype(font_path, 40) if font_path else None
        if f_b:
            for para in body[:2]:
                for ln in wrap_cjk(d, para, f_b, W - pad * 2):
                    w = d.textlength(ln, font=f_b)
                    d.text(((W - w) / 2, y), ln, font=f_b, fill=(202, 211, 224, 255))
                    y += 56
                    if y > H - 80:
                        break
    return base, layer


def tts_to_mp3(text, out_mp3, voice, rate='+0%', pitch='+0Hz', volume='+0%'):
    """edge-tts：免费、不需要 key，只要求联网。失败返回 False
    微软原生支持 语速 rate / 音调 pitch / 音量 volume（2026-11-1 全开放）"""
    try:
        import edge_tts
    except Exception:
        log('没装 edge-tts，跳过配音')
        return False
    async def _run():
        com = edge_tts.Communicate(text, voice, rate=rate, volume=volume, pitch=pitch)
        await com.save(out_mp3)
    try:
        asyncio.run(_run())
        return os.path.exists(out_mp3) and os.path.getsize(out_mp3) > 1000
    except Exception as e:
        log('配音失败（不影响出片）：%s' % str(e)[:120])
        return False


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        pass
    # 兜底：系统里的 ffmpeg
    from shutil import which
    return which('ffmpeg')


def probe_duration(ff, path):
    """用 ffmpeg -i 解析时长（没有 ffprobe 也能用）"""
    try:
        p = subprocess.run([ff, '-i', path], capture_output=True, text=True, timeout=30)
        out = (p.stderr or '') + (p.stdout or '')
        import re
        m = re.search(r'Duration:\s*(\d+):(\d+):(\d+\.\d+)', out)
        if m:
            return int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    except Exception:
        pass
    return 0.0


def main():
    if len(sys.argv) < 2:
        log('用法: python make_video.py spec.json')
        return 2
    spec = json.load(open(sys.argv[1], 'r', encoding='utf-8'))
    out = spec.get('out')
    W = int(spec.get('width') or 1280)
    H = int(spec.get('height') or 720)
    fps = int(spec.get('fps') or 25)
    cards = spec.get('cards') or []
    if not out or not cards:
        log('spec 缺 out 或 cards')
        return 2

    ff = ffmpeg_exe()
    if not ff:
        log('没找到 ffmpeg（imageio-ffmpeg 没装上？请先 pip install imageio-ffmpeg）')
        return 3
    log('ffmpeg: %s' % ff)

    font_path = find_font()
    log('字体: %s' % (font_path or '系统默认（可能显示不了中文）'))

    # 1) 配音（可选）
    voice = spec.get('voice') or {}
    audio_path = None
    audio_dur = 0.0
    tts_tmp = None
    audio_loop = False
    card_durs = []          # 每张卡片「声音多长就停多长」（2026-11-1 修：以前按计划时长分配，话说一半就翻页）
    if voice.get('enabled'):
        texts = []
        for c in cards:
            t = clean_text(str(c.get('title') or '') + '。' + '。'.join([str(x) for x in (c.get('lines') or [])])).strip()
            texts.append(t or '（这一页没有文字）')
        progress(4)
        log('正在合成配音（免费 edge-tts，需联网）…')
        seg_files = []
        seg_durs = []
        ok_all = True
        for i, t in enumerate(texts):
            seg = os.path.join(tempfile.gettempdir(), 'dshvideo_tts_%d_%d.mp3' % (os.getpid(), i))
            good = tts_to_mp3(
                t, seg,
                voice.get('voice') or 'zh-CN-XiaoxiaoNeural',
                voice.get('rate') or '+0%',
                voice.get('pitch') or '+0Hz',
                voice.get('volume') or '+0%',
            )
            if not good:
                ok_all = False
                break
            d = probe_duration(ff, seg)
            if d <= 0:
                ok_all = False
                break
            seg_files.append(seg)
            seg_durs.append(d)
        if ok_all and seg_files:
            # 把每段配音按顺序拼成一条音轨（同编码直接流复制，时长与各段一致）
            listfile = os.path.join(tempfile.gettempdir(), 'dshvideo_tts_%d.txt' % os.getpid())
            with open(listfile, 'w', encoding='utf-8') as fh:
                for seg in seg_files:
                    fh.write("file '%s'\n" % seg.replace('\\', '/').replace("'", "'\\''"))
            joined = os.path.join(tempfile.gettempdir(), 'dshvideo_tts_%d.mp3' % os.getpid())
            try:
                subprocess.run([ff, '-y', '-f', 'concat', '-safe', '0', '-i', listfile, '-c', 'copy', joined],
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=180)
            except Exception:
                pass
            if os.path.exists(joined) and os.path.getsize(joined) > 1000:
                audio_path = joined
                tts_tmp = joined
                # 每页停多久 = 这句配音的长度 + 一点点呼吸（0.35 秒），保证说得完再翻
                card_durs = [max(1.6, d + 0.35) for d in seg_durs]
                audio_dur = sum(card_durs)
                log('配音逐页合成完成：' + ' / '.join('%.1f' % d for d in seg_durs) + ' 秒 → 画面按语音长度走')
            else:
                log('配音拼接失败，退回整段模式')
                ok_all = False
        if not ok_all or not card_durs:
            # 兜底：老办法（整段合成），至少能出片
            text = ' '.join(texts).strip()
            tmp_mp3 = os.path.join(tempfile.gettempdir(), 'dshvideo_tts_%d.mp3' % os.getpid())
            if text and tts_to_mp3(text, tmp_mp3, voice.get('voice') or 'zh-CN-XiaoxiaoNeural',
                                   voice.get('rate') or '+0%', voice.get('pitch') or '+0Hz', voice.get('volume') or '+0%'):
                audio_path = tmp_mp3
                tts_tmp = tmp_mp3
                audio_dur = probe_duration(ff, tmp_mp3)
                log('配音时长 %.1f 秒（整段模式）' % audio_dur)
        progress(10)

    # 1b) BGM（可选）：没有配音时，用 BGM 当唯一音轨（循环铺满整段）
    bgm_path = spec.get('bgm') or ''
    if not audio_path and bgm_path and os.path.exists(bgm_path):
        audio_path = bgm_path
        audio_loop = True
        log('用 BGM 当音轨：%s' % os.path.basename(bgm_path))

    # 2) 卡片时长
    #    ① 逐页配音成功 → 直接用「这句话多长」当这一页时长（字幕和声音对齐，说完才翻页）
    #    ② 否则退回按计划时长/总配音等比分配
    if card_durs and len(card_durs) == len(cards):
        durs = card_durs
    else:
        base_total = sum(max(1.0, float(c.get('seconds') or 4)) for c in cards)
        if audio_dur > 0:
            scale = max(1.0, audio_dur) / base_total
            durs = [max(1.0, float(c.get('seconds') or 4) * scale) for c in cards]
        else:
            durs = [max(1.0, float(c.get('seconds') or 4)) for c in cards]

    cmd = [ff, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(fps), '-i', '-']
    if audio_path:
        if audio_loop:
            cmd += ['-stream_loop', '-1']
        cmd += ['-i', audio_path]
    # 省电（2026-11-1，针对手机）：限制 ffmpeg 单线程 + ultrafast 预设 —— 边打游戏边跑时
    # 编码不再把所有核吃满（代价：文件大约 10~20%，画质肉眼几乎没差）
    preset = 'veryfast'
    extra = []
    if spec.get('lowPower'):
        preset = 'ultrafast'
        extra = ['-threads', '1']
        log('省电模式：ffmpeg 限制单线程 + ultrafast')
    cmd += ['-c:v', 'libx264', '-preset', preset, '-crf', '26', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart'] + extra
    if audio_path:
        # ⚠️ 必须转成 44100Hz 立体声：edge-tts 出来是 24kHz 单声道，
        #   安卓系统播放器/文件管理器对 24kHz AAC 兼容极差 → 用户点开显示「无法播放此视频」（2026-11-1 修）
        cmd += ['-c:a', 'aac', '-ar', '44100', '-ac', '2', '-b:a', '128k', '-shortest']
    cmd += [out]

    log('开始渲染 %d 张卡片，%dx%d@%dfps…' % (len(cards), W, H, fps))
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    total_frames = sum(int(d * fps) for d in durs)
    done = 0
    try:
        from PIL import Image
        for i, card in enumerate(cards):
            base, layer = render_card(card, i, len(cards), W, H, font_path)
            full = Image.alpha_composite(base, layer).convert('RGB')
            frames = max(1, int(durs[i] * fps))
            fade = max(1, int(fps * 0.35))     # 0.35 秒淡入
            for k in range(frames):
                if k < fade:
                    a = (k + 1) / fade
                    ov = layer.copy()
                    ov.putalpha(ov.getchannel('A').point(lambda v: int(v * a)))
                    img = Image.alpha_composite(base, ov).convert('RGB')
                    proc.stdin.write(img.tobytes())
                else:
                    proc.stdin.write(full.tobytes())
                done += 1
                if done % max(1, fps * 2) == 0:
                    progress(15 + int(80 * done / max(1, total_frames)))
        proc.stdin.close()
    except BrokenPipeError:
        log('ffmpeg 提前退出（可能参数不兼容）')
    err = proc.stderr.read().decode('utf-8', 'ignore') if proc.stderr else ''
    code = proc.wait()
    if code != 0:
        log('ffmpeg 失败（退出码 %d）：%s' % (code, err[-600:]))
        return 4
    if tts_tmp:
        try:
            os.remove(tts_tmp)
        except Exception:
            pass
    progress(100)
    log('完成：%s（%d 帧）' % (out, done))
    return 0


if __name__ == '__main__':
    sys.exit(main())
