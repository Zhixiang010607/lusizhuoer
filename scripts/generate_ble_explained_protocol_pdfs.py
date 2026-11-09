#!/usr/bin/env python3
"""Explain device interaction and the existing Caesar check, without code changes.

The V1.0 PDFs, original Magic documentation and deployed sources stay untouched.
The two V1.1 outputs differ only by project/type labels. All examples are synthetic.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path
from xml.sax.saxutils import escape
from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Flowable, PageBreak, Paragraph, SimpleDocTemplate, Table, TableStyle
from generate_ble_three_project_protocol_pdfs import FRAMES, NONCE, PROFILES, SIGNATURE, AUTH, signature, wire

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/pdf'
PW, PH = A4
WIDTH = PW - 32 * mm
TOTAL = 8
INK, GOLD, MUTED = [colors.HexColor(x) for x in ['#382E22', '#80602D', '#786C5B']]
LINE, PALE, IVORY = [colors.HexColor(x) for x in ['#D8C5A5', '#F6EEDF', '#FFFCF7']]
CHAPTERS = ['设备固定配置', '双端交互流程', '全部收发报文', '分片与组帧', '密码是什么系统', '密码算法与验收向量', '设备处理授权', '排错与联调']


def styles():
    pdfmetrics.registerFont(TTFont('DeviceCN', '/System/Library/Fonts/Supplemental/Arial Unicode.ttf'))
    base = dict(fontName='DeviceCN', textColor=INK, wordWrap='CJK')
    return {
        'title': ParagraphStyle('title', **base, fontSize=22, leading=30, spaceAfter=10),
        'h1': ParagraphStyle('h1', fontName='DeviceCN', fontSize=17, leading=24, textColor=GOLD, spaceAfter=12),
        'h2': ParagraphStyle('h2', fontName='DeviceCN', fontSize=12, leading=17, textColor=GOLD, spaceBefore=9, spaceAfter=6),
        'body': ParagraphStyle('body', **base, fontSize=11, leading=16.8, spaceAfter=8),
        'small': ParagraphStyle('small', fontName='DeviceCN', fontSize=9.4, leading=14, textColor=MUTED, spaceAfter=6, wordWrap='CJK'),
        'cell': ParagraphStyle('cell', **base, fontSize=10, leading=15),
        'head': ParagraphStyle('head', fontName='DeviceCN', fontSize=10, leading=15, textColor=colors.white, alignment=TA_CENTER),
        'code': ParagraphStyle('code', fontName='Courier', fontSize=9, leading=13.4, textColor=INK, spaceBefore=6, spaceAfter=16,
                               backColor=PALE, borderPadding=8, leftIndent=8, rightIndent=8),
    }


def p(value, s, kind='body'):
    value = escape(str(value)).replace('\n', '<br/>')
    if kind == 'code': value = value.replace(' ', '&nbsp;')
    return Paragraph(value, s[kind])


def table(headers, rows, widths, s):
    data = [[p(x, s, 'head') for x in headers]] + [[p(x, s, 'cell') for x in row] for row in rows]
    result = Table(data, colWidths=[WIDTH * x / sum(widths) for x in widths], repeatRows=1)
    result.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, 0), GOLD), ('ROWBACKGROUNDS', (0, 1), (-1, -1), [colors.white, IVORY]),
        ('GRID', (0, 0), (-1, -1), .45, LINE), ('VALIGN', (0, 0), (-1, -1), 'MIDDLE'),
        ('LEFTPADDING', (0, 0), (-1, -1), 8), ('RIGHTPADDING', (0, 0), (-1, -1), 8),
        ('TOPPADDING', (0, 0), (-1, -1), 7), ('BOTTOMPADDING', (0, 0), (-1, -1), 7),
    ]))
    return result


def box(title, text, s):
    result = Table([[p(title, s, 'h2')], [p(text, s)]], colWidths=[WIDTH])
    result.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PALE), ('BOX', (0, 0), (-1, -1), .6, LINE),
        ('LEFTPADDING', (0, 0), (-1, -1), 11), ('RIGHTPADDING', (0, 0), (-1, -1), 11),
        ('TOPPADDING', (0, 0), (-1, -1), 5), ('BOTTOMPADDING', (0, 0), (-1, -1), 5),
    ]))
    return result


def bullet(text, s): return p('• ' + text, s)


class Interaction(Flowable):
    """Two endpoints with vector labels; intentionally no business internals."""
    def __init__(self):
        Flowable.__init__(self); self.width, self.height = WIDTH, 330

    def draw(self):
        c = self.canv
        xs = [83, WIDTH - 83]
        for x, label in zip(xs, ['微信小程序', 'HC-08 / 设备固件']):
            c.setFillColor(PALE); c.setStrokeColor(LINE)
            c.roundRect(x - 80, self.height - 34, 160, 30, 5, fill=1, stroke=1)
            c.setFont('DeviceCN', 11); c.setFillColor(INK); c.drawCentredString(x, self.height - 23, label)
            c.setDash(2, 3); c.setStrokeColor(LINE); c.line(x, 8, x, self.height - 37); c.setDash()
        items = [
            (0, 1, '1. 连接 FFE0 / FFE1，开启通知', False),
            (0, 1, '2. 读取信息：{"q":1} + LF', False),
            (1, 0, '3. 返回当前 s 和 nonce n', False),
            (0, 1, '4. 授权：q=2 / u / e / x + LF', False),
            (1, 0, '5. 校验通过且真实启动：o=1 / s=2', False),
            (0, 1, '6. 若步骤5超时，只补查：{"q":3} + LF', True),
            (1, 0, '7. 如实返回当前状态：s=1 或 s=2', True),
        ]
        for i, (a, b, label, optional) in enumerate(items):
            y = self.height - 68 - i * 37
            x1, x2 = xs[a], xs[b]
            c.setDash(3, 2) if optional else c.setDash()
            c.setStrokeColor(GOLD); c.line(x1, y, x2, y)
            sign = 1 if x2 > x1 else -1
            c.line(x2, y, x2 - sign * 5, y + 3); c.line(x2, y, x2 - sign * 5, y - 3)
            c.setDash(); c.setFillColor(INK); c.setFont('DeviceCN', 9.6)
            c.drawCentredString(WIDTH / 2, y + 8, label)


def pages(name, dtype, s):
    result = [[
        p('给设备固件开发与蓝牙联调人员', s, 'small'),
        p(f'{name}\nHC-08交互与密码校验说明', s, 'title'),
        p(f'V1.1 交互详解版 | {dtype} | 2026-11-09', s, 'small'),
        box('只讲设备如何交互', '说明收到什么、如何校验、何时启动以及回什么。完整沿用魔法柔肤LASER-BLE协议，仅项目设备类型取值不同；不改变现有程序和密码算法。', s),
        p('1. 设备固定配置', s, 'h1'),
        table(['项目', '厂家配置 / 示例'], [
            ['设备类型', dtype],
            ['设备编号SN', 'LA + 12位大写十六进制；例：LA001122334455'],
            ['机身二维码', 'nc://bind?sn=LA001122334455&code=123456'],
            ['广播名称', 'LA- + SN末6位；上述设备必须广播LA-334455'],
            ['Service UUID', 'FFE0 / 0000FFE0-0000-1000-8000-00805F9B34FB'],
            ['Write / Notify', '同一FFE1 / 0000FFE1-0000-1000-8000-00805F9B34FB'],
            ['属性 / 订阅', '支持write或writeNoResponse，以及notify或indicate。两种写法都有时优先writeNoResponse；先订阅再收发。'],
        ], [36, 142], s),
        p('厂家先记住这条线', s, 'h2'),
        p('读取q=1 → 返回状态与nonce → 接收q=2并校验 → 实际开机后回成功。若开机回执丢失，仅用q=3查询真实状态，不重复开机。', s),
        p('三项目的SN和末6位广播名均需避免冲突；手机按精确广播名连接。精简BLE包不重复传device_type，不把广播前缀改成项目拼音。文中全为离线示例。', s, 'small'),
    ], [
        p('2. 双端交互流程与等待时间', s, 'h1'), Interaction(),
        table(['阶段', '现有等待 / 重试规则'], [
            ['读取q=1', '收到完整信息就继续；满5秒仍无完整信息时只补发一次同q=1，总窗口10秒。设备须重新回完整信息，不能只补尾片。'],
            ['授权q=2', '小程序等待结果最多10秒，不自动重发授权。真实校验、启动和回包应尽快完成。'],
            ['补查q=3', '仅当q=2结果超时时走图中虚线；最多等10秒，只查询实际状态，不触发启动。'],
        ], [30, 148], s),
        p('s=1是待机；s=2是实际工作中，不是“连接成功”或“服务已完成”。设备未启动就不能回s=2；正在工作也不能因手机重连而假装待机。', s),
        p('收到完整报文立即处理，不要求固定等5秒或10秒。设备广播名、GATT、校验和状态流程均照搬原魔法柔肤实现。', s, 'small'),
    ], [
        p('3. 全部收发报文，一条都不省略', s, 'h1'),
        p('小程序发给设备的每条JSON末尾加真正LF（0x0A）。设备回包可在完整顶层JSON闭合处结束，也可追加LF。下面字节数按紧凑JSON计算。', s),
    ]]
    for label, direction, payload, lf in FRAMES:
        size = len(wire(payload).encode()) + int(lf)
        result[-1] += [p(f'{label} | {direction} | {size}字节' + ('（含LF）' if lf else '（不含可选LF）'), s, 'h2'),
                       p(wire(payload) + ('\\n' if lf else ''), s, 'code')]
    result[-1] += [
        p('q表示步骤；c=i表示信息，c=a表示授权；o=1成功，o=0失败；s=1待机，s=2工作。下行q=2的e是到期Unix秒，上行失败q=2的e则是错误码，含义不能混用。', s),
        p('u为整数次数1-999，不是分钟数；n为32位小写十六进制nonce；x为32位凯撒结果，可含g-z。示例e为格式示例，已经不是当前可用授权。真实u/e/x使用本次系统返回值。', s, 'small'),
    ]
    result.append([
        p('4. 分片与组帧：不要一片就解析', s, 'h1'),
        p('每次GATT写入最多20字节，按顺序写。一个JSON可以分多次写入，但固件必须把它当连续字节流，等整条命令结束后才执行一次。', s),
        table(['报文', '字节数', '20字节片数'], [
            ['q=1下行 / 信息回包', '8 / 60', '1 / 3'],
            ['q=2示例下行', '76', '4：20+20+20+16'],
            ['q=2成功 / 失败示例', '19 / 22', '1 / 2'],
            ['q=3下行 / 状态回包', '8 / 13', '1 / 1'],
        ], [78, 30, 70], s),
        p('q=2示例实际四片，最后一片含LF', s, 'h2'),
    ])
    auth_bytes = (wire(AUTH) + '\n').encode()
    for index in range(0, len(auth_bytes), 20):
        chunk = auth_bytes[index:index + 20]
        result[-1].append(p(f'{index // 20 + 1}. [{len(chunk):2} bytes] ' + chunk.decode().replace('\n', r'\n'), s, 'code'))
    result[-1] += [
        p('固件接收过程', s, 'h2'),
        p('追加片段 → 等待LF → 取完整帧 → JSON解析 → 校验 → 执行一次 → 清掉已处理部分。一个回调可能只有半帧，也可能有多帧，不能把回调次数当命令次数。', s),
        bullet('建议接收缓冲至少512字节；残帧、无效JSON、溢出均不能启动。断连、新连接应清掉旧半帧。', s),
        bullet('上行通知顺序发送；不要填充0x00、混入调试文字或重复整帧。', s),
        bullet('不请求更大MTU，不加固定片间延时。任何q=2片段失败后，小程序不自动重发某片或整个授权。', s),
        p('这里的\\n表示一个LF字节，不是反斜杠和字母n两个字符。u或e的实际长度变化时，按真实字节重新分片，不能写死“授权永远四片”。', s, 'small'),
    ]
    result.append([
        p('5. “密码”到底是什么系统', s, 'h1'),
        box('实际采用：现有凯撒式动态校验', '设备返回当前nonce n；系统按固定凯撒规则生成x，并随q=2发给设备。设备使用自己保存的同一个当前n重算x，逐字相同才继续校验和启动。没有另设一组需要人工输入的开机密码。', s),
        p('把三个容易混淆的东西分开', s, 'h2'),
        table(['名称', '它是什么', '它不是什么'], [
            ['二维码code', '机身二维码内六位数字，如123456，仅用于扫码审计关联。', '不是开机密码，也不参与x计算。'],
            ['nonce：n', '设备当前32位小写十六进制字符串，q=1发给小程序。', '不是用户账号密码，不是固定密钥。'],
            ['校验值：x', '系统用当前n计算的32位结果，在q=2发回设备。', '不是手工填写的密码，也不是十六进制限定字符串。'],
        ], [28, 79, 71], s),
        p('生成与检查过程', s, 'h2'),
        p('第一步：设备在q=1中发出n，并保留同一个当前n。\n第二步：系统算出x，小程序在q=2.x中原样发回。\n第三步：设备按同一公式重算，与收到的x逐字比较。', s),
        bullet('只用n计算x，不把SN、code、u、e、项目名等拼进签名字符串。u和e要另行校验。', s),
        bullet('n相同，x就相同。不同业务允许重复n，不要建立永久nonce黑名单或要求x绝不重复。', s),
        p('这是既有可逆混淆校验，不是AES加密或HMAC，也没有双方另外共享的秘密Key。本文解释原系统，不升级或替换任何算法。', s, 'small'),
    ])
    result.append([
        p('6. 密码算法：公式、代码与标准答案', s, 'h1'),
        p('先检查n恰好32位十六进制字符，再统一小写。index从0开始；每位偏移如下。数字在0-9循环，字母在a-z循环，不能只在a-f内循环。', s),
        p('offset = (4 * (index + 1)) % 7', s, 'code'),
        table(['index', '输入字符', 'offset', '输出字符'],
              [[str(i), ch, str((4 * (i + 1)) % 7), SIGNATURE[i]] for i, ch in enumerate(NONCE[:8])], [1, 1, 1, 1], s),
        p('参考实现（Python，便于移植核对）', s, 'h2'),
        p('import re\n\ndef signature(n):\n'
          '    if not re.fullmatch(r"[0-9a-fA-F]{32}", n):\n'
          '        raise ValueError("invalid nonce")\n'
          '    out = ""\n'
          '    for i, ch in enumerate(n.lower()):\n'
          '        offset = (4 * (i + 1)) % 7\n'
          '        abc = "0123456789" if ch.isdigit() else "abcdefghijklmnopqrstuvwxyz"\n'
          '        out += abc[(abc.index(ch) + offset) % len(abc)]\n'
          '    return out', s, 'code'),
        p('厂家必须得到相同的完整标准答案', s, 'h2'),
        p('n = ' + NONCE + '\nx = ' + SIGNATURE, s, 'code'),
        p('例如第0位“0”加4得到“4”，第1位“0”加1得到“1”。比较整个32位x；不要把它当整数、截断、补零或转大写再比较。', s, 'small'),
    ])
    result.append([
        p('7. 设备收到q=2后如何处理', s, 'h1'),
        p('顺序：完整组帧 → 检查当前是否待机 → 校验u/e/x → 实际启动并持久化工作态 → 发送成功。校验失败保持原状态，不开机。', s),
        p('处理顺序示意，不是可直接烧录的完整固件', s, 'h2'),
        p('on_complete_auth(frame):\n'
          '    if state == WORKING: return reject(1005)\n'
          '    if not valid_integer_units(frame.u, 1, 999):\n'
          '        return reject(1011)\n'
          '    if now_epoch() >= frame.e: return reject(1002)\n'
          '    if signature(current_nonce) != frame.x:\n'
          '        return reject(1001)\n'
          '    start_and_persist_once(frame)\n'
          '    if real_state() == WORKING:\n'
          '        return {"q": 2, "o": 1, "s": 2}\n'
          '    return existing_device_failure()', s, 'code'),
        table(['必须分清', '设备端原有要求'], [
            ['u是次数', '整数1-999，不能固定成1，不自行换算成分钟。'],
            ['e是到期时间', '绝对Unix秒，不是毫秒；不是收到后才开始倒计时。授权最长30秒，实际可能更短。'],
            ['x按当前n验证', '使用这次信息回包对应的当前n，不用上次连接残留或任意新n。'],
            ['s=2是真实工作', '启动成功并持久化后才发送；不能先回成功再考虑是否启动。'],
            ['重复 / 重启', '同授权不得二次启动；工作中重启恢复持久化工作态，q=3仍返回真实状态。'],
        ], [34, 144], s),
        p('继续复用魔法柔肤的执行器、互斥、防重复、非易失存储、正常结束／复位和时钟实现。本文没有新增开机、结束或校时命令。新硬件若缺时钟，须厂家确认如何沿用原到期校验，不能擅自把e改成相对30秒。', s),
        p('q=1、q=3只读。q=3不得顺手启动、改nonce或重置服务。授权回执丢失时查询真实状态，而不是再执行一次q=2。', s, 'small'),
    ])
    result.append([
        p('8. 常见错误与厂家联调清单', s, 'h1'),
        p('失败包格式仍为 {"q":2,"o":0,"e":错误码}。以下沿用现有含义，不新增线上字段或密码体系。', s),
        table(['e', '含义', '先排查什么'], [
            ['1001', 'x校验失败', '当前n、大小写、index从0、字母a-z循环、完整32位。'],
            ['1002', '授权已过期', 'Unix秒与毫秒是否混用、设备时钟、实际传输耗时。'],
            ['1005', '设备工作中', '不再启动；q=1/q=3如实返回状态。'],
            ['1011', '次数不符合要求', 'u是否整数1-999，是否被固件写死成1。'],
            ['400 / 404', '格式不可识别 / 不支持', '完整JSON+LF、q/c是否正确，是否单片就解析。'],
        ], [24, 51, 103], s),
        p('建议按这个顺序实测', s, 'h2'),
        bullet('身份：正确二维码只能匹配对应精确广播名；同场多机无末6位冲突，固定FFE0/FFE1可用。', s),
        bullet('组帧：任意片界、拆包与粘包都只按完整帧执行；无LF残帧、溢出、调试文字不启动。', s),
        bullet('密码：第6页标准答案一致；故意改一位x、过期e、非法u均不启动且回失败。', s),
        bullet('成功：真实启动并持久化后才回o=1/s=2，不能把write成功当作执行成功。', s),
        bullet('丢回执：故意丢弃q=2成功通知；小程序只补查q=3，设备不二次启动。', s),
        bullet('重复与断电：工作中重复q=2、重连和重启均不重复启动，仍能查到真实工作态。', s),
        bullet('三项目：分别用各项目执行同一套收发、密码和状态用例；只区分设备类型值。', s),
        p('写法兼容：只读q=1/q=3首片被微信明确以10007拒绝时，可切换至另一已报告支持属性试首片一次；q=2任何片失败均不这样回退或自动重发。', s, 'small'),
        box('验收边界', '本文基于现有小程序与云函数的实际收发逻辑。厂家仍需在真实MCU、执行器、时钟和存储上联调；原魔法柔肤协议、程序及原PDF均不改变。', s),
    ])
    assert len(result) == TOTAL
    return result


def verify_contract():
    source = (ROOT / 'miniprogram-app/miniprogram/services/ble-verification.js').read_text()
    for key, value in [('INFO_TIMEOUT_MS', 10000), ('INFO_RETRY_AFTER_MS', 5000), ('AUTH_TIMEOUT_MS', 10000),
                       ('STATUS_TIMEOUT_MS', 10000), ('WRITE_CHUNK_BYTES', 20)]:
        assert re.search(rf'const {key} = {value};', source), key
    assert signature(NONCE) == SIGNATURE
    assert [len(wire(frame).encode()) + int(lf) for _, _, frame, lf in FRAMES] == [8, 60, 76, 19, 22, 8, 13]
    assert [len((wire(AUTH) + '\n').encode()[i:i + 20]) for i in range(0, 76, 20)] == [20, 20, 20, 16]


def build(name, dtype, s):
    content = pages(name, dtype, s)
    output = OUT / f'露思卓儿_{name}_{dtype}_HC-08交互与密码校验说明_V1.1.pdf'
    doc = SimpleDocTemplate(str(output), pagesize=A4, leftMargin=16 * mm, rightMargin=16 * mm,
                            topMargin=18 * mm, bottomMargin=17 * mm,
                            title=f'{name} HC-08交互与密码校验说明 V1.1', author='广州露思卓儿科技有限公司',
                            subject='Existing device interaction and Caesar check; no protocol or software changes')
    def decorate(c, doc):
        number = c.getPageNumber(); c.saveState(); c.setStrokeColor(LINE)
        c.line(16 * mm, PH - 12 * mm, PW - 16 * mm, PH - 12 * mm)
        c.line(16 * mm, 12 * mm, PW - 16 * mm, 12 * mm)
        c.setFont('DeviceCN', 8.2); c.setFillColor(MUTED)
        c.drawString(16 * mm, PH - 9 * mm, f'{name} | {dtype} | 设备交互与密码校验 V1.1')
        c.drawString(16 * mm, 8 * mm, '仅增强设备交互说明，现有协议与程序不变 | 2026-11-09')
        c.drawRightString(PW - 16 * mm, 8 * mm, f'第 {number} / {TOTAL} 页')
        if number <= TOTAL:
            c.bookmarkPage(f'chapter-{number}'); c.addOutlineEntry(f'{number}. {CHAPTERS[number - 1]}', f'chapter-{number}')
        c.restoreState()
    story = []
    for i, page in enumerate(content):
        usable = PH - 35 * mm - 12
        height = sum(item.wrap(WIDTH - 12, usable)[1] + item.getSpaceBefore() + item.getSpaceAfter() for item in page)
        if height > usable: raise ValueError(f'Chapter {i + 1}: {height:.1f} > {usable:.1f}')
        if i: story.append(PageBreak())
        story.extend(page)
    doc.build(story, onFirstPage=decorate, onLaterPages=decorate)
    print(f'{output} | sha256={hashlib.sha256(output.read_bytes()).hexdigest()}')


def main():
    verify_contract(); OUT.mkdir(exist_ok=True, parents=True)
    s = styles()
    for name, dtype in PROFILES: build(name, dtype, s)


if __name__ == '__main__': main()
