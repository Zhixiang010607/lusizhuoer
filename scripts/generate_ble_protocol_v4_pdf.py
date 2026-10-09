#!/usr/bin/env python3
"""Generate the concise, current BLE device-side protocol (maximum five pages)."""

from __future__ import annotations

import os

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Frame,
    PageBreak,
    PageTemplate,
    Paragraph,
    Spacer,
    Table,
    TableStyle,
)


ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.path.join(ROOT, "output", "pdf", "Lusizhuoer_BLE_Device_Interaction_Protocol_V4.0.pdf")
PAGE_W, PAGE_H = A4
MARGIN_X = 14 * mm
MARGIN_TOP = 15 * mm
MARGIN_BOTTOM = 14 * mm

FONT_PATH = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"
FONT = "ArialUnicode"
pdfmetrics.registerFont(TTFont(FONT, FONT_PATH))

INK = colors.HexColor("#2A241D")
MUTED = colors.HexColor("#73695E")
BRONZE = colors.HexColor("#7A592C")
GOLD = colors.HexColor("#C39A55")
CREAM = colors.HexColor("#FBF7EF")
SAND = colors.HexColor("#F2E6D2")
GREEN = colors.HexColor("#276B55")
GREEN_BG = colors.HexColor("#E8F3EE")
RED = colors.HexColor("#923D36")
RED_BG = colors.HexColor("#F8E9E7")
BLUE = colors.HexColor("#315C84")
BLUE_BG = colors.HexColor("#EAF1F8")
GRID = colors.HexColor("#D9C5A5")


def esc(value: object) -> str:
    return (
        str(value)
        .replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
        .replace("\n", "<br/>")
    )


styles = getSampleStyleSheet()
styles.add(ParagraphStyle(
    "TitleCN", fontName=FONT, fontSize=21, leading=28, textColor=INK,
    spaceAfter=3 * mm,
))
styles.add(ParagraphStyle(
    "SubtitleCN", fontName=FONT, fontSize=9.5, leading=14, textColor=MUTED,
    spaceAfter=2 * mm,
))
styles.add(ParagraphStyle(
    "H1CN", fontName=FONT, fontSize=14, leading=19, textColor=INK,
    spaceBefore=2 * mm, spaceAfter=2 * mm, keepWithNext=True,
))
styles.add(ParagraphStyle(
    "H2CN", fontName=FONT, fontSize=10.5, leading=14, textColor=BRONZE,
    spaceBefore=1.5 * mm, spaceAfter=1 * mm, keepWithNext=True,
))
styles.add(ParagraphStyle(
    "BodyCN", fontName=FONT, fontSize=8.4, leading=12.2, textColor=INK,
    spaceAfter=1.2 * mm,
))
styles.add(ParagraphStyle(
    "SmallCN", fontName=FONT, fontSize=7.1, leading=9.7, textColor=MUTED,
    spaceAfter=0.8 * mm,
))
styles.add(ParagraphStyle(
    "TableCN", fontName=FONT, fontSize=7, leading=9.4, textColor=INK,
))
styles.add(ParagraphStyle(
    "TableHeadCN", fontName=FONT, fontSize=7.1, leading=9.3,
    textColor=colors.white, alignment=TA_CENTER,
))
styles.add(ParagraphStyle(
    "CodeCN", fontName=FONT, fontSize=6.8, leading=9.1, textColor=INK,
    backColor=colors.HexColor("#F5F1EA"), borderColor=GRID, borderWidth=0.4,
    borderPadding=5, leftIndent=1.5 * mm, rightIndent=1.5 * mm,
    spaceBefore=0.7 * mm, spaceAfter=1.2 * mm,
))


def p(text: object, style: str = "BodyCN") -> Paragraph:
    return Paragraph(esc(text), styles[style])


def rich(text: str, style: str = "BodyCN") -> Paragraph:
    return Paragraph(text, styles[style])


def h1(text: str) -> Paragraph:
    return p(text, "H1CN")


def h2(text: str) -> Paragraph:
    return p(text, "H2CN")


def code(text: str) -> Paragraph:
    return p(text, "CodeCN")


def bullets(items, small=False):
    return [p(f"• {item}", "SmallCN" if small else "BodyCN") for item in items]


def callout(title: str, body: str, kind: str = "blue") -> Table:
    palette = {
        "blue": (BLUE_BG, BLUE),
        "green": (GREEN_BG, GREEN),
        "red": (RED_BG, RED),
        "gold": (SAND, BRONZE),
    }
    bg, fg = palette[kind]
    content = rich(f"<b><font color='{fg.hexval()}'>{esc(title)}</font></b><br/>{esc(body)}")
    box = Table([[content]], colWidths=[PAGE_W - 2 * MARGIN_X])
    box.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), bg),
        ("BOX", (0, 0), (-1, -1), 0.55, fg),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("RIGHTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    return box


def table(headers, rows, widths, font_size=7.0):
    total = PAGE_W - 2 * MARGIN_X
    scale = total / sum(widths)
    widths = [value * scale for value in widths]
    head = [p(item, "TableHeadCN") for item in headers]
    body_style = ParagraphStyle(
        f"Table{font_size}", parent=styles["TableCN"], fontSize=font_size,
        leading=font_size + 2.3,
    )
    body = [[Paragraph(esc(item), body_style) for item in row] for row in rows]
    result = Table([head] + body, colWidths=widths, repeatRows=1)
    commands = [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#4B4135")),
        ("GRID", (0, 0), (-1, -1), 0.35, GRID),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("LEFTPADDING", (0, 0), (-1, -1), 4),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4),
        ("TOPPADDING", (0, 0), (-1, -1), 3.5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 3.5),
    ]
    for row_index in range(2, len(rows) + 1, 2):
        commands.append(("BACKGROUND", (0, row_index), (-1, row_index), CREAM))
    result.setStyle(TableStyle(commands))
    return result


class ProtocolDoc(BaseDocTemplate):
    def __init__(self, path: str):
        super().__init__(
            path,
            pagesize=A4,
            leftMargin=MARGIN_X,
            rightMargin=MARGIN_X,
            topMargin=MARGIN_TOP,
            bottomMargin=MARGIN_BOTTOM,
            title="露思卓儿 BLE 设备交互协议 V4.0",
            author="广州露思卓儿科技有限公司",
            subject="LASER-BLE compact JSON and adaptive ATT MTU",
        )
        frame = Frame(
            self.leftMargin, self.bottomMargin, self.width, self.height,
            leftPadding=0, rightPadding=0, topPadding=0, bottomPadding=0,
        )
        self.addPageTemplates(PageTemplate(id="body", frames=[frame], onPage=draw_page))


def draw_page(canvas, doc):
    canvas.saveState()
    canvas.setFillColor(BRONZE)
    canvas.rect(0, PAGE_H - 6 * mm, PAGE_W, 6 * mm, fill=1, stroke=0)
    canvas.setFont(FONT, 6.6)
    canvas.setFillColor(MUTED)
    canvas.drawString(MARGIN_X, 6.5 * mm, "露思卓儿 · LASER-BLE 设备交互协议 V4.0")
    canvas.drawRightString(PAGE_W - MARGIN_X, 6.5 * mm, f"第 {canvas.getPageNumber()} / 4 页")
    canvas.restoreState()


def build_story():
    story = []

    # Page 1: identity, GATT and transport.
    story += [Spacer(1, 8 * mm), p("露 思 卓 儿", "SubtitleCN")]
    story.append(p("LASER-BLE 扫码核销设备交互协议", "TitleCN"))
    story.append(p("V4.0 · 设备端实施版 · 对齐 faceRecognition v120 / 小程序 0.2.94", "SubtitleCN"))
    story.append(callout(
        "一句话原则",
        "报文仍是 JSON；只把 BLE 单次写入包按实际 MTU 放大。设备必须同时兼容一包完整 JSON 和多包拼接 JSON。",
        "gold",
    ))
    story.append(h1("1. 固定设备身份与 GATT"))
    story.append(table(
        ["项目", "固定值 / 规则"],
        [
            ["设备编号", "LA + 12 位大写十六进制，例如 LAF82E0CC8C5B9；每台设备不得重复"],
            ["二维码", "nc://bind?sn=<设备编号>&code=<6位数字>"],
            ["BLE 广播名", "LA- + 设备编号末 6 位，例如 LA-C8C5B9；必须精确匹配二维码"],
            ["项目设备类型", "LASER-BLE；由小程序项目档案确定，不需要在精简回包中重复发送"],
            ["Service", "FFE0（兼容标准 128 位 Bluetooth Base UUID 表示）"],
            ["Write / Notify", "FFE1 / FFE1；同时支持时优先 writeNoResponse"],
        ],
        [35, 135],
        7.4,
    ))
    story.append(h1("2. JSON 与自适应 MTU"))
    story += bullets([
        "下行：UTF-8 JSON object，末尾追加 LF（0x0A）。上行：可带 LF，也可在完整顶层 } 处结束。",
        "连接后读取实际 ATT MTU。Android 请求 MTU 185；iOS 不能强制设置，使用系统与 HC-08 自动协商后微信返回的值。",
        "单次有效载荷 = MTU - 3，代码上限 182 字节。MTU 不可读、无效或仍为 23 时，回退为 20 字节。",
        "设备接收端必须把每次 GATT 写入追加到同一缓冲区，遇到 LF 后再解析一次 JSON；不得把一次写入当成一条固定报文。",
        "小程序逐次等待微信写回调并保持顺序，不增加 50ms/100ms/1s 固定延时。",
    ])
    story.append(callout(
        "为什么有时是一包",
        "精简授权约 76-77 字节（含 LF）。实际 MTU 至少为 79-80 时可一次写完；MTU=23 时仍会拆成 4 包。HC-08 是否支持大 MTU决定最终片数。",
        "blue",
    ))
    story.append(PageBreak())

    # Page 2: exact frames.
    story.append(h1("3. 全部线上报文（字段不得自行改名）"))
    story.append(table(
        ["步骤", "方向", "完整报文", "默认 MTU 23"],
        [
            ["1 读取", "小程序→设备", '{"q":1} + LF', "8 字节 / 1 包"],
            ["1 信息", "设备→小程序", '{"q":1,"c":"i","s":1,"n":"<32位nonce>"}', "60 字节 / 3 包"],
            ["2 授权", "小程序→设备", '{"q":2,"c":"a","u":2,"e":1791450472,"x":"<32位signature>"} + LF', "约 76 字节 / 4 包"],
            ["2 成功", "设备→小程序", '{"q":2,"o":1,"s":2}', "19 字节 / 1 包"],
            ["2 失败", "设备→小程序", '{"q":2,"o":0,"e":1001}', "按长度分包"],
            ["3 补查", "小程序→设备", '{"q":3} + LF', "8 字节 / 1 包"],
            ["3 状态", "设备→小程序", '{"q":3,"s":1} 或 {"q":3,"s":2}', "13 字节 / 1 包"],
        ],
        [19, 30, 91, 30],
        6.65,
    ))
    story.append(h2("3.1 步骤 1 - 设备信息"))
    story.append(code('{"q":1,"c":"i","s":1,"n":"00112233445566778899aabbccddeeff"}'))
    story += bullets([
        "q=1、c=i 固定；s=1 表示待机，s=2 表示已经工作。",
        "n 必须为 32 位十六进制字符串。允许不同核销重复同一个 nonce，但当前连接返回什么，步骤 2 就按什么计算 x。",
        "精简 info 不发送设备编号、类型和广播名：小程序已用二维码 SN、扫描时精确广播名、项目 LASER-BLE 和 FFE0/FFE1 重建并校验身份。",
    ], small=True)
    story.append(h2("3.2 步骤 2 - 开机授权"))
    story.append(code('{"q":2,"c":"a","u":2,"e":1791450472,"x":"41638537597196183052aecgeigdifkh"}\n'))
    story.append(table(
        ["字段", "含义", "设备要求"],
        [
            ["u", "本次核销次数", "整数 1-999；不得擅自固定为 1"],
            ["e", "授权到期 Unix 秒", "收到时仍有效；设备有可靠时钟时必须校验"],
            ["x", "当前 nonce 的凯撒结果", "严格逐字比较；不等则回 e=1001，保持 s=1"],
        ],
        [20, 48, 102],
        7.2,
    ))
    story.append(h2("3.3 步骤 3 - 只读状态补查"))
    story.append(p("q=3 只读取真实状态，不开机、不改变 nonce、不延长授权。只有设备确实执行 q=2 并进入工作态后才能返回 s=2。"))
    story.append(callout(
        "禁止行为",
        "没有收到完整 q=2 时，禁止因为收到 q=3 就返回 s=2；禁止把 q=1 或 q=3 当成核销完成。",
        "red",
    ))
    story.append(PageBreak())

    # Page 3: flow and retries.
    story.append(h1("4. 时序、等待、重扫与唯一性"))
    story.append(table(
        ["阶段", "小程序行为", "设备行为"],
        [
            ["人脸资格", "服务端建立 90 秒资格；此时不扣次", "保持待机 s=1"],
            ["q=1 首读", "开启 Notify 后立即发送，不强制等待", "每收到一条完整 q=1，只返回一条完整 info"],
            ["首读补发", "5 秒仍无完整 info，清空首轮残片并只补发一次同一 q=1；总等待最多 10 秒", "可重发相同当前状态；不得因为重复 q=1 改变工作状态"],
            ["q=2 授权", "最长等待 10 秒；绝不自动重发同一 q=2", "验签、保存工作状态后立即回 q=2,o=1,s=2"],
            ["无授权回执", "只发送一次 q=3，再最多等 10 秒", "返回真实 s=1 或 s=2"],
            ["最终核销", "只有确认 s=2 才向服务端扣次并生成一张工单", "工作状态需写入非易失存储，断电可恢复"],
        ],
        [28, 76, 66],
        6.9,
    ))
    story.append(h2("4.1 关闭窗口后重新扫码"))
    story += bullets([
        "90 秒资格未过期且核销未完成时，用户可以关闭并重新打开扫码；每轮都会取消旧 Notify、关闭旧连接和适配器，旧缓冲与旧回包不能进入新会话。",
        "重复扫描同一二维码和同一设备：若本轮实时 info 仍为 s=1，服务端按本轮 nonce 签发新 token 和新 q=2，旧 token 立即失效。",
        "二维码、设备编号、LASER-BLE 类型或次数任一变化都拒绝；不允许同一资格切换另一台设备。",
        "设备已为 s=2 时不再签发新 q=2，只恢复原授权与原工单；不得重复扣次。",
        "资格不足或小程序完全关闭后冷启动，才要求重新拍照做人脸验证。",
    ])
    story.append(h2("4.2 大包失败时的处理"))
    story.append(callout(
        "不得自动降级重发授权",
        "大包 q=2 写入结果不确定时，不能立刻把同一授权拆成小包再发一次。先用 q=3 查询真实状态；仍无法确认时关闭本轮连接。同一设备重新扫码后，由服务端生成新 token，旧 token 已失效。",
        "red",
    ))
    story.append(h2("4.3 状态机"))
    story.append(table(
        ["状态", "允许", "禁止"],
        [
            ["s=1 待机", "q=1、有效 q=2、q=3", "未验签即工作"],
            ["s=2 工作", "q=1、q=3、恢复当前服务", "接受新的 q=2、重复启动、生成新 nonce 覆盖当前服务"],
            ["服务结束", "安全停止、保存完成状态、回到 s=1", "自动退还业务次数"],
        ],
        [27, 73, 70],
        7.1,
    ))
    story.append(PageBreak())

    # Page 4: signature and acceptance checklist.
    story.append(h1("5. signature 算法与设备验收"))
    story.append(h2("5.1 当前唯一生效算法：按位置递增的凯撒变换"))
    story += bullets([
        "输入：设备本轮返回的 32 位十六进制 nonce，先统一为小写。",
        "位置从 0 开始；offset = (4 × (index + 1)) mod 7。",
        "数字只在 0-9 内循环；小写字母只在 a-z 内循环；逐字符输出 32 位 x。",
        "这是可逆混淆，不是 HMAC、AES 或数字签名；没有生产 Key，也不读取 BLE_AUTH_SIGNING_KEY。",
    ])
    story.append(code("00112233445566778899aabbccddeeff\n→ 41638537597196183052aecgeigdifkh"))
    story.append(table(
        ["错误码", "含义 / 设备动作"],
        [
            ["1001", "x 不匹配；保持 s=1"],
            ["1002", "授权已过期；保持 s=1"],
            ["1003", "当前 nonce 不一致；保持 s=1"],
            ["1004", "旧固件的永久 nonce 封锁不得继续使用；不同资格允许重复 nonce"],
            ["1005", "设备已经工作；保持原服务，不重复启动"],
            ["1011", "次数不支持；保持 s=1"],
        ],
        [30, 140],
        7.2,
    ))
    story.append(h2("5.2 设备端必须通过的联调清单"))
    story += bullets([
        "二维码 SN、广播名 LA-末六位和烧录编号一一对应；同场多台设备编号与广播名不重复。",
        "FFE0/FFE1 可发现；Notify 先启用；writeNoResponse / write 属性与固件真实能力一致。",
        "MTU=23 时 q=2 分 4 次写入可正确拼接；MTU≥80 时同一 JSON 一次写入也可正确解析。",
        "无论一次或多次写入，都只在 LF 到达后解析一次；解析成功后立即清空该帧缓冲。超时、断连和新连接都清空旧缓冲。",
        "q=1 首次和只读补发都能返回完整 info；重复 q=1 不改变 nonce 或工作状态。",
        "q=2 正确时先持久化 s=2 再回成功；错误、残帧或过期时保持 s=1。q=3 永远只回真实状态。",
        "断电重启后，未完成服务仍恢复 s=2；同一授权不会二次启动，下一笔服务不会沿用上一笔工作状态。",
    ], small=True)
    story.append(callout(
        "上线边界",
        "当前 q=2 回执和 q=3 状态没有设备侧认证，凯撒 x 也不绑定 u/e。它能满足当前简单设备联调，但不能宣称已形成完整密码学闭环。",
        "blue",
    ))
    story.append(Spacer(1, 2 * mm))
    story.append(p("文档结束 · 任何字段、状态或重试规则变更，必须同时更新小程序、设备固件、服务端规则与本协议。", "SmallCN"))
    return story


def main():
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    ProtocolDoc(OUT).build(build_story())
    print(OUT)


if __name__ == "__main__":
    main()
