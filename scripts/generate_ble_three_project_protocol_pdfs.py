#!/usr/bin/env python3
"""Render two device handoffs from the unchanged Magic Soft Skin wire contract.

Only the project/type labels vary. The existing generators and PDFs are never
written. No production key, real device identity or customer data is required.
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
from xml.sax.saxutils import escape

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle, PageBreak,
)

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'output/pdf'
PROFILES = (
    ('海洋之韵', 'haiyangzhiyun'),
    ('露思康辰', 'lusikangcheng'),
)
NONCE = '00112233445566778899aabbccddeeff'
SIGNATURE = '41638537597196183052aecgeigdifkh'
INFO = {'q': 1, 'c': 'i', 's': 1, 'n': NONCE}
AUTH = {'q': 2, 'c': 'a', 'u': 2, 'e': 1791450472, 'x': SIGNATURE}
FRAMES = (
    ('1 读取信息', '小程序 → 设备', {'q': 1}, True),
    ('1 设备信息', '设备 → 小程序', INFO, False),
    ('2 开机授权', '小程序 → 设备', AUTH, True),
    ('2 授权成功', '设备 → 小程序', {'q': 2, 'o': 1, 's': 2}, False),
    ('2 授权失败', '设备 → 小程序', {'q': 2, 'o': 0, 'e': 1001}, False),
    ('3 查询状态', '小程序 → 设备', {'q': 3}, True),
    ('3 真实状态', '设备 → 小程序', {'q': 3, 's': 2}, False),
)
GOLD = colors.HexColor('#80602D')
INK = colors.HexColor('#362E24')
MUTED = colors.HexColor('#786B5B')
LINE = colors.HexColor('#D9C7A9')
PALE = colors.HexColor('#F5EDDF')
CREAM = colors.HexColor('#FFFCF7')
WIDTH, HEIGHT = A4
CONTENT_WIDTH = WIDTH - 32 * mm


def wire(payload):
    return json.dumps(payload, separators=(',', ':'), ensure_ascii=True)


def signature(nonce):
    out = ''
    for index, ch in enumerate(nonce.lower()):
        offset = (4 * (index + 1)) % 7
        if '0' <= ch <= '9':
            out += chr(ord('0') + (ord(ch) - ord('0') + offset) % 10)
        elif 'a' <= ch <= 'z':
            out += chr(ord('a') + (ord(ch) - ord('a') + offset) % 26)
        else:
            raise ValueError('Invalid nonce')
    return out


def styles():
    pdfmetrics.registerFont(TTFont('BleCN', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
    return {
        'title': ParagraphStyle('title', fontName='BleCN', fontSize=22, leading=29, textColor=INK, spaceAfter=9),
        'sub': ParagraphStyle('sub', fontName='BleCN', fontSize=10, leading=15, textColor=MUTED, spaceAfter=9),
        'h1': ParagraphStyle('h1', fontName='BleCN', fontSize=16, leading=22, textColor=GOLD, spaceAfter=10),
        'h2': ParagraphStyle('h2', fontName='BleCN', fontSize=11.5, leading=16, textColor=GOLD, spaceBefore=9, spaceAfter=6),
        'body': ParagraphStyle('body', fontName='BleCN', fontSize=10.3, leading=15.5, textColor=INK, spaceAfter=7, wordWrap='CJK'),
        'small': ParagraphStyle('small', fontName='BleCN', fontSize=9, leading=13, textColor=MUTED, spaceAfter=5, wordWrap='CJK'),
        'cell': ParagraphStyle('cell', fontName='BleCN', fontSize=9.5, leading=14, textColor=INK, wordWrap='CJK'),
        'head': ParagraphStyle('head', fontName='BleCN', fontSize=9.5, leading=14, textColor=colors.white, alignment=TA_CENTER),
        'code': ParagraphStyle('code', fontName='Courier', fontSize=8.4, leading=12.5, textColor=INK, spaceAfter=6,
                               backColor=PALE, borderPadding=7, leftIndent=7, rightIndent=7),
    }


def para(text, s, kind='body'):
    rendered = escape(str(text)).replace('\n', '<br/>')
    if kind == 'code':
        rendered = rendered.replace(' ', '&nbsp;')
    return Paragraph(rendered, s[kind])


def table(headers, rows, widths, s):
    data = [[para(v, s, 'head') for v in headers]]
    data += [[para(v, s, 'cell') for v in row] for row in rows]
    result = Table(data, colWidths=[CONTENT_WIDTH * w / sum(widths) for w in widths], repeatRows=1)
    result.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), GOLD),
        ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, CREAM]),
        ('GRID', (0, 0), (-1, -1), .45, LINE),
        ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8),
        ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 6),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 6),
    ]))
    return result


def bullet(text, s):
    return para('• ' + text, s)


def make_story(name, device_type, s):
    story = [Spacer(1, 4 * mm), para('露思卓儿 / 设备固件技术交接', s, 'sub'),
             para(f'{name}\nHC-08 蓝牙交互技术文档', s, 'title'),
             para(f'设备类型：{device_type}  |  V1.0  |  2026-11-09', s, 'sub'),
             para('本设备完整复用魔法柔肤 LASER-BLE 现有通信与业务流程；唯一配置差异是 device_type 的值。原魔法柔肤实现和原文档保持不变。', s),
             para('项目主档及既有业务名称不改；设备类型严格使用本文件指定值，不从中文名称自动推导。', s, 'small'),
             para('1. 身份、二维码与固定通信通道', s, 'h1')]
    story.append(table(['配置', '固定值 / 要求'], [
        ['设备类型', device_type],
        ['设备编号', 'LA + 12 位大写十六进制；示例 LA001122334455'],
        ['二维码', 'nc://bind?sn=LA001122334455&code=123456'],
        ['广播名称', 'LA- + 编号末 6 位；上述示例为 LA-334455'],
        ['Service UUID', 'FFE0；完整形式 0000FFE0-0000-1000-8000-00805F9B34FB'],
        ['Write / Notify UUID', '同一个 FFE1；完整形式 0000FFE1-0000-1000-8000-00805F9B34FB'],
        ['特征属性', '支持 write 或 writeNoResponse，以及 notify 或 indicate、CCCD 订阅；两种写入均支持时优先 writeNoResponse'],
    ], [37, 141], s))
    story += [para('身份配置说明', s, 'h2'),
        bullet('设备编号和广播名在全部项目之间都必须唯一。类型名不替代广播名，也不把广播前缀改成项目拼音。', s),
        bullet('二维码六位 code 用于扫码和审计关联，不是密钥；没有设备注册表或总部设备预登记步骤。', s),
        bullet('精简 BLE 报文不重复传输 device_type。小程序按服务端资格中的项目类型选择档案，精确匹配二维码与广播名后重建身份。', s),
        para('固定流程', s, 'h2'),
        para('客户人脸通过 → 90 秒资格 → 扫码、连接及订阅 → q=1 读取 → 服务端校验并原子预留次数 → q=2 授权 → 确认真实状态 s=2 → 原子扣次并生成唯一工单。', s),
        PageBreak(), para('2. 全部精简报文', s, 'h1'),
        para('JSON 字段、顺序及处理方式沿用原协议。下行均额外追加一个 LF（0x0A）；上行可在完整顶层 } 处结束，也可追加 LF。', s)]
    for label, direction, payload, lf in FRAMES:
        raw = wire(payload)
        size = len(raw.encode()) + int(lf)
        count = (size + 19) // 20
        story.append(para(f'{label}  ·  {direction}  ·  {size} 字节 / {count} 片' + ('（含 LF）' if lf else '（不含可选 LF）'), s, 'h2'))
        story.append(para(raw, s, 'code'))
    story += [para('以上设备编号、nonce、时间戳均为格式示例。示例 e 不能作为当前可用授权，真实 u/e/x 必须使用服务端本次返回值；s=1 待机，s=2 工作中。', s, 'small'),
        PageBreak(), para('3. 分片、组帧与字段含义', s, 'h1')]
    story.append(table(['字段', '含义'], [
        ['q / c', 'q=1 读取，q=2 授权，q=3 状态；c=i 信息，c=a 授权'],
        ['s / o', 's=1 待机，s=2 工作；o=1 授权成功，o=0 失败'],
        ['n', '当前 32 位十六进制 nonce；签名计算前统一转小写'],
        ['u', '本次次数，整数 1-999；不得固定为 1，也不擅自换算服务分钟数'],
        ['e', '下行 q=2 为授权到期 Unix 秒；失败回包 q=2 为设备错误码'],
        ['x', '根据本轮 n 计算的 32 字符凯撒结果；可包含 g-z 等非十六进制字母'],
    ], [28, 150], s))
    story += [para('固定传输要求', s, 'h2'),
        bullet('每次下行 GATT 写入最多 20 字节，顺序发送；不请求更大 MTU，不增加固定片间延时。', s),
        bullet('设备持续追加到同一个接收缓冲，建议至少 512 字节；见到 LF 才解析、执行一次，不能把每个片段当作一条 JSON。', s),
        bullet('一帧处理完成、断连、新连接、无效帧或缓冲溢出时清理相应旧缓冲。上行通知也必须按顺序发送，不能混入串口调试文字。', s),
        para('q=2 示例的实际四片（含最后一个 LF）', s, 'h2')]
    data = (wire(AUTH) + '\n').encode()
    for offset in range(0, len(data), 20):
        packet = data[offset:offset + 20]
        text = packet.decode().replace('\n', r'\n')
        story.append(para(f'{offset // 20 + 1}: [{len(packet):2} bytes] {text}', s, 'code'))
    story += [para('写入方式与失败处理', s, 'h2'),
        bullet('只读 q=1 / q=3 的首片被微信明确以 10007 拒绝时，才允许切换至另一个已报告支持的写属性并重试首片一次。', s),
        bullet('q=2 任一分片失败都禁止切换写法、重发分片或重发整条授权；只能沿用现有状态核对与同设备恢复流程。', s),
        PageBreak(), para('4. 时序、状态与防重复', s, 'h1')]
    story.append(table(['阶段', '与魔法柔肤完全相同的行为'], [
        ['资格', '客户 1:1 人脸通过后建立 90 秒资格；此时不扣次、不生成工单。'],
        ['读取 q=1', '订阅成功即发送；满 5 秒仍无完整信息时清空残片并仅补发一次相同 q=1，总窗口 10 秒。完整回包到达立即继续。'],
        ['申请授权', '服务端重新校验账号、门店、客户、项目、次数及资格；先原子预留次数，再生成授权。授权最长 30 秒且不超过资格剩余时间。'],
        ['执行 q=2', '设备校验本轮 x、u、e，真实进入并持久化工作态后立即回成功；小程序最多等 10 秒，不自动重发 q=2。'],
        ['补查 q=3', '缺少授权回执时只查真实状态，最多等 10 秒；q=3 自身不启动设备、不改变 nonce。'],
        ['最终落单', '只有已授权设备状态为 2 才确认；服务端再按原事务复核余额或额度、扣次、绑定照片并生成唯一工单。'],
    ], [30, 148], s))
    story += [para('重扫与状态机', s, 'h2'),
        bullet('同一资格重扫仅允许原二维码、原设备、原类型和原次数；本轮为待机时可覆盖生成新 token，旧 token 立即失效。', s),
        bullet('设备已工作时只能恢复原授权及原工单，不重新授权、重复开机或重复扣次。断电后恢复未结束服务的持久化工作状态。', s),
        bullet('关闭本轮后须清理旧监听、连接、适配器、缓冲和等待器；新会话不接收旧回包。', s),
        bullet('不同核销资格允许相同 nonce；同一资格、授权、幂等请求和工单的唯一性规则保持不变。', s),
        para('正常与体验核销共用设备链路：正常扣客户项目余额；体验扣当前老师对应项目额度。补录核销仍不连接 BLE，不受本次配置增加影响。', s, 'small'),
        PageBreak(), para('5. signature 算法与联合验收', s, 'h1'),
        para('现有凯撒算法原样沿用：位置从 0 开始，offset = (4 × (index + 1)) mod 7；数字在 0-9 循环，小写字母在 a-z 循环。输出 32 个 ASCII 字符，不使用生产 Key、HMAC 或 canonical string。', s),
        para('nonce:     ' + NONCE + '\nsignature: ' + SIGNATURE, s, 'code'),
        para('参考实现（Python）', s, 'h2'),
        para('def signature(nonce):\n'
             '    result = ""\n'
             '    for index, ch in enumerate(nonce.lower()):\n'
             '        offset = (4 * (index + 1)) % 7\n'
             '        alphabet = "0123456789" if ch.isdigit() else "abcdefghijklmnopqrstuvwxyz"\n'
             '        result += alphabet[(alphabet.index(ch) + offset) % len(alphabet)]\n'
             '    return result', s, 'code'),
        para('调用前必须先验证 nonce 恰好为 32 个十六进制字符；设备按当前 nonce 重算并逐字比较 x。上述变换属于现有可逆混淆，不改变原协议的安全边界。', s, 'small'),
        para('厂家与小程序共同验收', s, 'h2')]
    for text in [
        '同场多机：编号、广播名与二维码一致且全局不重复；只能连接精确广播名。',
        'FFE0 / FFE1 可发现，先订阅通知；额外服务不改变固定通道选择。',
        'q=1 首次成功及首轮残片后一次补查均可完成；不得固定等满 5 秒才继续。',
        'q=2 四片组帧只执行一次；错误 x、过期 e、非法 u、残帧均不启动。',
        'q=3 只读真实状态；未实际执行授权不得返回 s=2 推动扣次。',
        '工作中、迟到／重复授权及断电恢复不会二次启动或生成重复工单。',
        '三种类型使用同一套报文与签名验收；设备侧和小程序侧均须做实体联调。',
    ]:
        story.append(bullet(text, s))
    return story


def build(name, device_type, s):
    path = OUTPUT / f'露思卓儿_{name}_{device_type}_HC-08蓝牙交互技术文档_V1.0.pdf'
    doc = SimpleDocTemplate(str(path), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
                            topMargin=17 * mm, bottomMargin=16 * mm,
                            title=f'{name} HC-08 蓝牙交互技术文档 V1.0', author='广州露思卓儿科技有限公司',
                            subject=f'{device_type}: exact copy of LASER-BLE wire protocol')
    def footer(canvas, doc):
        canvas.saveState()
        canvas.setStrokeColor(LINE)
        canvas.line(16 * mm, HEIGHT - 11 * mm, WIDTH - 16 * mm, HEIGHT - 11 * mm)
        canvas.line(16 * mm, 11 * mm, WIDTH - 16 * mm, 11 * mm)
        canvas.setFont('BleCN', 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(16 * mm, HEIGHT - 8 * mm, f'{name} | {device_type} | HC-08')
        canvas.drawString(16 * mm, 7 * mm, '协议与魔法柔肤一致，仅设备类型取值不同 / 2026-11-09')
        canvas.drawRightString(WIDTH - 16 * mm, 7 * mm, f'第 {doc.page} 页')
        canvas.restoreState()
    doc.build(make_story(name, device_type, s), onFirstPage=footer, onLaterPages=footer)
    return path


def main():
    assert signature(NONCE) == SIGNATURE
    assert [len(wire(p).encode()) + int(lf) for _, _, p, lf in FRAMES] == [8, 60, 76, 19, 22, 8, 13]
    OUTPUT.mkdir(parents=True, exist_ok=True)
    s = styles()
    for profile in PROFILES:
        path = build(*profile, s)
        print(f'{path} | sha256={hashlib.sha256(path.read_bytes()).hexdigest()}')


if __name__ == '__main__':
    main()
