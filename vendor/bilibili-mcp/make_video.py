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


def render_card(card, idx, total, W, H, font_path):
    from PIL import Image, ImageDraw, ImageFont
    img = Image.new('RGB', (W, H), (15, 17, 21))
    d = ImageDraw.Draw(img)
    # 左侧强调条
    d.rectangle([0, 0, 10, H], fill=(64, 158, 255))
    # 顶部小字：系列序号
    try:
        f_small = ImageFont.truetype(font_path, 26) if font_path else ImageFont.load_default()
        d.text((48, 40), '第 %d / %d 页' % (idx + 1, total), font=f_small, fill=(120, 130, 145))
    except Exception:
        pass
    # 标题
    title = str(card.get('title') or '').strip()
    y = int(H * 0.22)
    if title:
        try:
            f_title = ImageFont.truetype(font_path, 60) if font_path else ImageFont.load_default()
        except Exception:
            f_title = None
        tlines = wrap_cjk(d, title, f_title, W - 140) if f_title else [title]
        for ln in tlines[:2]:
            d.text((70, y), ln, font=f_title, fill=(240, 244, 250))
            y += 78
        y += 18
    # 正文
    body = [str(x) for x in (card.get('lines') or []) if str(x).strip()]
    try:
        f_body = ImageFont.truetype(font_path, 38) if font_path else ImageFont.load_default()
    except Exception:
        f_body = None
    max_lines = max(1, (H - y - 90) // 56)
    used = 0
    for para in body:
        for ln in (wrap_cjk(d, para, f_body, W - 150) if f_body else [para]):
            if used >= max_lines:
                break
            d.text((70, y), ln, font=f_body, fill=(205, 212, 222))
            y += 56
            used += 1
        y += 8
        if used >= max_lines:
            break
    return img


def tts_to_mp3(text, out_mp3, voice, rate):
    """edge-tts：免费、不需要 key，只要求联网。失败返回 False"""
    try:
        import edge_tts
    except Exception:
        log('没装 edge-tts，跳过配音')
        return False
    async def _run():
        com = edge_tts.Communicate(text, voice, rate=rate)
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
    if voice.get('enabled'):
        text = voice.get('text') or ' '.join(
            [str(c.get('title') or '') + '。' + '。'.join([str(x) for x in (c.get('lines') or [])]) for c in cards]
        )
        text = text.strip()
        if text:
            progress(4)
            log('正在合成配音（免费 edge-tts，需联网）…')
            tmp_mp3 = os.path.join(tempfile.gettempdir(), 'dshvideo_tts_%d.mp3' % os.getpid())
            if tts_to_mp3(text, tmp_mp3, voice.get('voice') or 'zh-CN-XiaoxiaoNeural', voice.get('rate') or '+0%'):
                audio_path = tmp_mp3
                audio_dur = probe_duration(ff, tmp_mp3)
                log('配音时长 %.1f 秒' % audio_dur)
            progress(10)

    # 2) 卡片时长：有配音就按配音总时长等比分配，让画面跟着声音走
    base_total = sum(max(1.0, float(c.get('seconds') or 4)) for c in cards)
    if audio_dur > 0:
        scale = max(1.0, audio_dur) / base_total
        durs = [max(1.0, float(c.get('seconds') or 4) * scale) for c in cards]
    else:
        durs = [max(1.0, float(c.get('seconds') or 4)) for c in cards]

    cmd = [ff, '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', '%dx%d' % (W, H), '-r', str(fps), '-i', '-']
    if audio_path:
        cmd += ['-i', audio_path]
    cmd += ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '26', '-pix_fmt', 'yuv420p',
            '-movflags', '+faststart']
    if audio_path:
        cmd += ['-c:a', 'aac', '-b:a', '96k', '-shortest']
    cmd += [out]

    log('开始渲染 %d 张卡片，%dx%d@%dfps…' % (len(cards), W, H, fps))
    proc = subprocess.Popen(cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    total_frames = sum(int(d * fps) for d in durs)
    done = 0
    try:
        for i, card in enumerate(cards):
            img = render_card(card, i, len(cards), W, H, font_path)
            rgb = img.tobytes()
            frames = max(1, int(durs[i] * fps))
            for _ in range(frames):
                proc.stdin.write(rgb)
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
    if audio_path:
        try:
            os.remove(audio_path)
        except Exception:
            pass
    progress(100)
    log('完成：%s（%d 帧）' % (out, done))
    return 0


if __name__ == '__main__':
    sys.exit(main())
