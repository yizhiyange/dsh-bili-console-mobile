#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
analyze_audio.py —— 纯本地分析一段音频的「性格」（2026-11-1 加）
============================================================================
为什么需要它：
  纯音乐（BGM）没有歌词，转写模型（whisper）根本给不出信息，识图模型也用不上。
  但 BGM 挑选用不着"听懂"，只要知道**快慢 / 响度 / 明暗**就够了——
  这些是声音的客观属性，用信号处理就能算，**不需要任何 AI 模型、不联网、几百毫秒**。

输出一段中文描述，直接当素材备注用，例如：
  「中速、偏亮、有点力气；适合日常口播垫底」
用法：python analyze_audio.py <音频文件>    → 打印一行中文
      python analyze_audio.py <音频文件> --json  → 打印结构化结果
"""
import json
import os
import subprocess
import sys
import tempfile

SR = 16000        # 分析采样率（够用，越小越快）


def ffmpeg_exe():
    try:
        import imageio_ffmpeg
        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return 'ffmpeg'


def decode(path, seconds=45):
    """用 ffmpeg 把音频解成 16k 单声道 16bit PCM（只取前 45 秒，够判断了）"""
    ff = ffmpeg_exe()
    raw = os.path.join(tempfile.gettempdir(), 'dshaudio_%d.pcm' % os.getpid())
    cmd = [ff, '-y', '-v', 'error', '-i', path, '-t', str(seconds),
           '-ac', '1', '-ar', str(SR), '-f', 's16le', raw]
    try:
        subprocess.run(cmd, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=90)
        if not os.path.exists(raw) or os.path.getsize(raw) < 2048:
            return None
        with open(raw, 'rb') as f:
            data = f.read()
        return data
    except Exception:
        return None
    finally:
        try:
            os.remove(raw)
        except Exception:
            pass


def analyze(path):
    import numpy as np
    data = decode(path)
    if not data:
        return {'ok': False, 'error': '读不出音频（格式不支持或文件损坏）'}

    x = np.frombuffer(data, dtype='<i2').astype(np.float32) / 32768.0
    if x.size < SR // 2:
        return {'ok': False, 'error': '音频太短'}

    # ── 响度（RMS → dBFS）
    rms = float(np.sqrt(np.mean(x ** 2)) + 1e-9)
    db = 20 * np.log10(rms)

    # ── 过零率（越高越"吵/亮"，纯人声低）
    zcr = float(np.mean(np.abs(np.diff(np.signbit(x).astype(np.int8)))))

    # ── 频谱质心（越高越明亮/尖锐，越低越闷/低沉）
    win = 1024
    hop = 512
    frames = max(1, (x.size - win) // hop)
    cents = []
    for i in range(0, min(frames, 240)):
        seg = x[i * hop: i * hop + win]
        if seg.size < win:
            break
        spec = np.abs(np.fft.rfft(seg * np.hanning(win)))
        freqs = np.fft.rfftfreq(win, 1.0 / SR)
        s = spec.sum() + 1e-9
        cents.append(float((spec * freqs).sum() / s))
    centroid = float(np.mean(cents)) if cents else 0.0

    # ── 节拍（能量包络自相关估 BPM）
    win2, hop2 = 1024, 512
    env = []
    for i in range(0, min((x.size - win2) // hop2, 800)):
        seg = x[i * hop2: i * hop2 + win2]
        if seg.size < win2:
            break
        env.append(float(np.sqrt(np.mean(seg ** 2))))
    bpm = 0.0
    contrast = 0.0
    if len(env) > 40:
        e = np.array(env)
        m = float(e.mean()) + 1e-9
        # 节奏「有没有」比「多少」更好判断：包络几乎平的要老实说"没节奏"，
        # 不然自相关会在一堆噪声里瞎挑一个峰，得出荒唐的 BPM（实测踩过）
        contrast = float((np.percentile(e, 90) - np.percentile(e, 10)) / m)
        if contrast >= 0.22:
            ec = e - e.mean()
            ac = np.correlate(ec, ec, mode='full')[len(ec) - 1:]
            ac[:3] = 0
            fps_env = SR / hop2
            lo = int(fps_env * 60 / 170)   # 170 BPM 上限
            hi = int(fps_env * 60 / 55)    # 55 BPM 下限
            if hi > lo and hi < len(ac):
                k = int(np.argmax(ac[lo:hi])) + lo
                if k > 0:
                    bpm = 60.0 * fps_env / k
                    # 半速/倍速纠正：>150 或 <60 时对半/加倍更可信
                    while bpm > 150:
                        bpm /= 2
                    while 0 < bpm < 60:
                        bpm *= 2
    return {
        'ok': True,
        'db': round(db, 1),
        'zcr': round(zcr, 4),
        'centroid': round(centroid, 0),
        'bpm': round(bpm, 0),
        'contrast': round(contrast, 2),
    }


def to_note(r):
    """把数值翻译成大白话备注"""
    bpm = r['bpm']
    if bpm <= 0:
        speed = '没什么节奏（铺底音/氛围音）'
    elif bpm < 78:
        speed = '很慢、舒缓'
    elif bpm < 100:
        speed = '偏慢'
    elif bpm < 125:
        speed = '中速'
    elif bpm < 150:
        speed = '偏快、有节奏'
    else:
        speed = '很快、很躁'

    centroid = r['centroid']
    if centroid < 1200:
        tone = '低沉闷'
    elif centroid < 2200:
        tone = '偏暖'
    elif centroid < 3200:
        tone = '偏亮'
    else:
        tone = '很亮很尖锐'

    db = r['db']
    if db < -30:
        power = '很轻'
    elif db < -20:
        power = '偏轻'
    elif db < -12:
        power = '适中'
    else:
        power = '有力量'

    # 使用建议（按最像的那类场景给）
    if bpm >= 125 and db >= -20:
        use = '适合开场、快节奏剪辑'
    elif bpm and bpm < 90 and db < -18:
        use = '适合讲心情、收尾，当背景别抢话'
    elif centroid >= 3200:
        use = '偏刺耳，人声垫底时要压音量'
    else:
        use = '适合日常口播垫底'

    return '%s、%s、%s；%s' % (speed, tone, power, use)


def main():
    if len(sys.argv) < 2:
        print('用法: python analyze_audio.py <音频文件> [--json]')
        return 2
    path = sys.argv[1]
    if not os.path.exists(path):
        print('文件不存在: %s' % path)
        return 2
    r = analyze(path)
    if len(sys.argv) > 2 and sys.argv[2] == '--json':
        print(json.dumps(r, ensure_ascii=False))
        return 0 if r.get('ok') else 1
    if not r.get('ok'):
        print(r.get('error') or '分析失败')
        return 1
    print(to_note(r))
    return 0


if __name__ == '__main__':
    sys.exit(main())
