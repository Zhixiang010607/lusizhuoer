#!/usr/bin/env python3
"""Generate the detailed HC-08 device-side BLE protocol handoff PDF."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    PageBreak,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "露思卓儿_魔法柔肤_HC-08设备端完整通信协议.pdf"
TOTAL_PAGES = 4

INK = colors.HexColor("#35291E")
GOLD = colors.HexColor("#956728")
DEEP_GOLD = colors.HexColor("#78501F")
PALE_GOLD = colors.HexColor("#F3E7D2")
IVORY = colors.HexColor("#FFF9F0")
WHITE = colors.white
LINE = colors.HexColor("#D5BA90")
MUTED = colors.HexColor("#6F6255")
RED = colors.HexColor("#A43C32")
PALE_RED = colors.HexColor("#FCECEA")
GREEN = colors.HexColor("#356B50")
PALE_GREEN = colors.HexColor("#EAF4EE")
BLUE = colors.HexColor("#365D7A")
PALE_BLUE = colors.HexColor("#EAF1F6")


def register_fonts():
    candidates = [
        Path("/System/Library/Fonts/PingFang.ttc"),
        Path("/System/Library/Fonts/STHeiti Medium.ttc"),
        Path("/System/Library/Fonts/Supplemental/Songti.ttc"),
    ]
    font_path = next((item for item in candidates if item.exists()), None)
    if not font_path:
        raise RuntimeError("未找到可用中文字体")
    pdfmetrics.registerFont(TTFont("CN", str(font_path), subfontIndex=0))
    pdfmetrics.registerFont(TTFont("CN-Bold", str(font_path), subfontIndex=0))


def paragraph_style(name, size, leading=None, color=INK, align=TA_LEFT, font="CN", **kwargs):
    return ParagraphStyle(
        name,
        fontName=font,
        fontSize=size,
        leading=leading or size * 1.45,
        textColor=color,
        alignment=align,
        spaceAfter=0,
        **kwargs,
    )


def p(text, style):
    return Paragraph(text, style)


def code(text, style, size=7.6):
    return Paragraph(f'<font name="Courier" size="{size}">{text}</font>', style)


def info_box(title, body, styles, tone="gold"):
    tones = {
        "gold": (PALE_GOLD, LINE, GOLD),
        "red": (PALE_RED, colors.HexColor("#DDA69E"), RED),
        "green": (PALE_GREEN, colors.HexColor("#A8C8B5"), GREEN),
        "blue": (PALE_BLUE, colors.HexColor("#AFC5D6"), BLUE),
    }
    fill, border, title_color = tones[tone]
    content = p(
        f'<font name="CN-Bold" color="{title_color.hexval()}">{title}</font><br/>{body}',
        styles["box"],
    )
    table = Table([[content]], colWidths=[178 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.75, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.5 * mm),
    ]))
    return table


def styled_table(rows, widths, header_rows=1, paddings=(1.6, 1.6), grid=True):
    table = Table(rows, colWidths=widths, repeatRows=header_rows)
    commands = [
        ("BACKGROUND", (0, 0), (-1, header_rows - 1), GOLD),
        ("TEXTCOLOR", (0, 0), (-1, header_rows - 1), WHITE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), paddings[0] * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), paddings[1] * mm),
        ("ROWBACKGROUNDS", (0, header_rows), (-1, -1), [WHITE, colors.HexColor("#FCF6EC")]),
    ]
    if grid:
        commands.append(("GRID", (0, 0), (-1, -1), 0.45, LINE))
    else:
        commands.extend([
            ("LINEBELOW", (0, 0), (-1, 0), 0.7, LINE),
            ("LINEBELOW", (0, 1), (-1, -2), 0.35, LINE),
            ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ])
    table.setStyle(TableStyle(commands))
    return table


def draw_page(canvas, doc):
    width, height = A4
    page = canvas.getPageNumber()
    canvas.saveState()
    canvas.setFillColor(IVORY)
    canvas.rect(0, 0, width, height, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.55)
    canvas.line(16 * mm, height - 10 * mm, width - 16 * mm, height - 10 * mm)
    canvas.line(16 * mm, 11 * mm, width - 16 * mm, 11 * mm)
    canvas.setFillColor(MUTED)
    canvas.setFont("CN", 7.3)
    canvas.drawString(16 * mm, height - 7.2 * mm, "露思卓儿｜魔法柔肤 LASER-BLE｜HC-08 设备端协议")
    canvas.drawString(16 * mm, 6.8 * mm, "协议基线：2026-10-08｜对应小程序开发版 0.2.91")
    canvas.drawRightString(width - 16 * mm, 6.8 * mm, f"第 {page} 页 / 共 {TOTAL_PAGES} 页")
    canvas.restoreState()


def build():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    styles = {
        "title": paragraph_style("title", 20, 25, align=TA_CENTER, font="CN-Bold"),
        "subtitle": paragraph_style("subtitle", 9.4, 13.5, MUTED, TA_CENTER),
        "page_title": paragraph_style("page_title", 15, 19, DEEP_GOLD, font="CN-Bold"),
        "h2": paragraph_style("h2", 11.5, 15, GOLD, font="CN-Bold"),
        "body": paragraph_style("body", 9.2, 13.8),
        "small": paragraph_style("small", 8.2, 11.8, MUTED),
        "box": paragraph_style("box", 9.0, 13.2),
        "cell": paragraph_style("cell", 8.35, 11.7),
        "cell_small": paragraph_style("cell_small", 7.65, 10.6),
        "head": paragraph_style("head", 8.4, 11.5, WHITE, TA_CENTER, font="CN-Bold"),
        "step": paragraph_style("step", 9.0, 13.2),
    }

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=14 * mm,
        bottomMargin=15 * mm,
        title="露思卓儿魔法柔肤 HC-08 设备端完整通信协议",
        author="广州露思卓儿科技有限公司",
        subject="魔法柔肤 LASER-BLE 设备身份、广播、GATT、精简报文和联调验收规则",
    )

    story = []

    # Page 1: identity and discovery
    story += [
        Spacer(1, 3 * mm),
        p("魔法柔肤 HC-08 设备端完整通信协议", styles["title"]),
        p("给设备固件开发、蓝牙调试与联合验收人员", styles["subtitle"]),
        Spacer(1, 4 * mm),
        info_box(
            "本文件的范围",
            "只规定魔法柔肤设备与微信小程序之间的 BLE 通信。项目业务仍叫“魔法柔肤”；设备规范类型固定为 "
            "<b>LASER-BLE</b>。旧通用拼音类型 <font name=\"Courier\">mofaroufu</font> 不再用于魔法柔肤设备身份。",
            styles,
            "gold",
        ),
        Spacer(1, 3 * mm),
        p("一、固定身份、广播名称与 GATT", styles["h2"]),
    ]

    identity_rows = [
        [p("项目", styles["head"]), p("固定值或格式", styles["head"]), p("来源与用途", styles["head"])],
        [p("业务项目名称", styles["cell"]), p("魔法柔肤", styles["cell"]), p("门店在小程序中选择的项目；服务端据此确定设备规范类型。", styles["cell"])],
        [p("设备规范类型", styles["cell"]), code("LASER-BLE", styles["cell"]), p("由服务端资格下发给小程序，不需要在精简 BLE 报文中重复发送。", styles["cell"])],
        [p("设备编号", styles["cell"]), p('<font name="Courier">LA</font> + 12 位大写十六进制', styles["cell"]), p("写入二维码；示例：LAF82E0CC8C5B9。", styles["cell"])],
        [p("BLE 广播名", styles["cell"]), p('<font name="Courier">LA-</font> + 设备编号末 6 位', styles["cell"]), p("设备必须真实广播；示例：LA-C8C5B9。小程序执行完全一致匹配。", styles["cell"])],
        [p("GATT", styles["cell"]), code("Service FFE0 / Write FFE1 / Notify FFE1", styles["cell"]), p("同一个 FFE1 同时承担下行写入和上行通知；必须支持 CCCD 订阅。", styles["cell"])],
    ]
    story += [styled_table(identity_rows, [34 * mm, 57 * mm, 87 * mm]), Spacer(1, 3 * mm)]

    story += [
        p("二、小程序如何确定要连接哪一台", styles["h2"]),
    ]
    flow_rows = [
        [p("顺序", styles["head"]), p("小程序已知的信息", styles["head"]), p("执行的检查", styles["head"])],
        [p("1", styles["cell"]), p("当前项目为“魔法柔肤”", styles["cell"]), p("服务端资格要求设备类型必须是 LASER-BLE。", styles["cell"])],
        [p("2", styles["cell"]), p("二维码中的完整设备编号", styles["cell"]), p("必须符合 LA 加 12 位大写十六进制。", styles["cell"])],
        [p("3", styles["cell"]), p("由编号推导出的广播名", styles["cell"]), p("只连接名称完全相同的 BLE 广播，例如 LA-C8C5B9。", styles["cell"])],
        [p("4", styles["cell"]), p("已连接设备的 GATT", styles["cell"]), p("只使用该类型固定的 FFE0 和 FFE1；其他服务不参与候选。", styles["cell"])],
        [p("5", styles["cell"]), p("精简 q=1 回包", styles["cell"]), p("读取实时状态和当前 nonce；通过后才申请开机授权。", styles["cell"])],
    ]
    story += [styled_table(flow_rows, [19 * mm, 65 * mm, 94 * mm]), Spacer(1, 3 * mm)]

    story += [
        info_box(
            "附近有多台设备时",
            "同款设备只要广播名各自唯一，小程序不会连接其他名称。不同设备即使也有 FFE0/FFE1，只要广播名不同也不会连接。"
            "按当前确认方案，q=1 不再重复返回设备编号、类型或广播名，因此厂家必须保证每台设备的编号和广播名一一对应，"
            "<b>不得把两台设备设置成相同广播名</b>。如果两台设备完整复制了同一身份，手机无法仅凭 BLE 区分。",
            styles,
            "red",
        ),
        Spacer(1, 2.5 * mm),
        info_box(
            "为什么报文里没有 LASER-BLE",
            "小程序不是收到 q=1 后才猜设备类型，而是在扫码前已从服务端资格知道本次必须使用 LASER-BLE。设备固件本身也按该固定协议实现。"
            "精简报文只传本次交互需要变化的数据。",
            styles,
            "blue",
        ),
    ]

    # Page 2: wire protocol
    story += [PageBreak(), Spacer(1, 3.5 * mm), p("三、FFE1 字节协议与全部精简报文", styles["page_title"]), Spacer(1, 2.5 * mm)]
    story += [
        info_box(
            "分片规则",
            "JSON 使用 UTF-8。小程序下行每条完整 JSON 后追加 LF，即 <font name=\"Courier\">0x0A</font>；"
            "当前按每片最多 20 字节顺序写入，不增加人为片间等待。设备必须把每片追加到同一个 rx_buffer，见到 LF 后才解析一条完整 JSON，"
            "不得逐片解析或清空，建议接收缓冲区至少 512 字节。设备上行可在完整右花括号后结束，也可追加 LF；手机会跨通知拼接完整顶层 JSON。",
            styles,
            "gold",
        ),
        Spacer(1, 3 * mm),
    ]

    protocol_rows = [
        [p("方向与用途", styles["head"]), p("完整 JSON 示例", styles["head"]), p("字节/片", styles["head"])],
        [p("小程序 → 设备<br/>1. 读取信息", styles["cell"]), code('{"q":1}', styles["cell_small"]), p("7+LF / 1", styles["cell"] )],
        [p("设备 → 小程序<br/>1. 设备信息", styles["cell"]), code('{"q":1,"c":"i","s":1,"n":"00112233445566778899aabbccddeedd"}', styles["cell_small"], 7.1), p("60 / 3", styles["cell"])],
        [p("小程序 → 设备<br/>2. 开机授权", styles["cell"]), code('{"q":2,"c":"a","u":2,"e":1791450472,"x":"41638537597196183052aecgeigdifkh"}', styles["cell_small"], 6.85), p("75+LF / 4", styles["cell"])],
        [p("设备 → 小程序<br/>2. 授权成功", styles["cell"]), code('{"q":2,"o":1,"s":2}', styles["cell_small"]), p("19 / 1", styles["cell"])],
        [p("设备 → 小程序<br/>2. 授权失败", styles["cell"]), code('{"q":2,"o":0,"e":1001}', styles["cell_small"]), p("示例 22 / 2", styles["cell"])],
        [p("小程序 → 设备<br/>3. 查询状态", styles["cell"]), code('{"q":3}', styles["cell_small"]), p("7+LF / 1", styles["cell"])],
        [p("设备 → 小程序<br/>3. 真实状态", styles["cell"]), code('{"q":3,"s":2}', styles["cell_small"]), p("13 / 1", styles["cell"])],
    ]
    story += [styled_table(protocol_rows, [39 * mm, 115 * mm, 24 * mm], paddings=(1.9, 1.9)), Spacer(1, 3 * mm)]

    field_rows = [
        [p("字段", styles["head"]), p("含义", styles["head"]), p("设备端要求", styles["head"])],
        [code("q", styles["cell"]), p("步骤号：1 读取、2 授权、3 状态", styles["cell"]), p("回包必须使用与请求对应的 q。", styles["cell"])],
        [code("c", styles["cell"]), p("i=设备信息；a=授权", styles["cell"]), p("只在需要区分内容的 q=1、q=2 报文中出现。", styles["cell"])],
        [code("s", styles["cell"]), p("设备状态：1=待机，2=工作中", styles["cell"]), p("必须返回真实状态，不得为了通过核销固定返回 2。", styles["cell"])],
        [code("n", styles["cell"]), p("当前 32 位小写十六进制 nonce", styles["cell"]), p("用于计算本次 x；必须是恰好 32 个十六进制字符。", styles["cell"])],
        [code("u", styles["cell"]), p("本次允许使用的次数", styles["cell"]), p("正整数；设备按产品能力决定如何执行，但不得忽略。", styles["cell"])],
        [code("e", styles["cell"]), p("q=2 下行为授权到期 Unix 秒；失败上行为设备错误码", styles["cell"]), p("结合报文方向解释；示例 1001 不是强制错误码表。", styles["cell"])],
        [code("x", styles["cell"]), p("由当前 n 计算出的 32 字符 signature", styles["cell"]), p("设备必须按第六节重算并逐字比较。", styles["cell"])],
        [code("o", styles["cell"]), p("授权结果：1=成功，0=失败", styles["cell"]), p("只有实际进入工作态才可返回 o=1、s=2。", styles["cell"])],
    ]
    story += [p("四、字段定义", styles["h2"]), styled_table(field_rows, [19 * mm, 69 * mm, 90 * mm], paddings=(1.25, 1.25))]

    # Page 3: timing and state machine
    story += [PageBreak(), Spacer(1, 3.5 * mm), p("五、时序、超时、重试与状态机", styles["page_title"]), Spacer(1, 2.5 * mm)]
    timing_rows = [
        [p("阶段", styles["head"]), p("正常动作", styles["head"]), p("超时或异常时", styles["head"])],
        [p("人脸后资格", styles["cell"]), p("服务端建立 90 秒扫码资格。", styles["cell"]), p("资格过期则停止；不得连接后绕过资格。", styles["cell"])],
        [p("q=1 读取", styles["cell"]), p("Notify 订阅完成后立即发送，不增加固定等待。", styles["cell"]), p("5 秒未得到完整信息时清空残片，只补发一次相同 q=1；总等待最多 10 秒，不发送旧长报文。", styles["cell"])],
        [p("服务端授权", styles["cell"]), p("服务端根据已验证身份签发最长 30 秒授权，且不超过剩余资格时间。", styles["cell"]), p("资格、门店、项目、次数或客户校验失败时，不向设备发送 q=2。", styles["cell"])],
        [p("q=2 执行", styles["cell"]), p("设备校验 u、e、x；成功后进入并持久化工作态，立即回 q=2 成功。", styles["cell"]), p("小程序最多等待 10 秒；绝不自动重发 q=2，避免设备重复启动。", styles["cell"])],
        [p("q=3 补查", styles["cell"]), p("仅在 q=2 成功回执未收到时查询设备真实状态。", styles["cell"]), p("最多等待 10 秒。未得到 s=2，服务端不得扣次或生成工单。", styles["cell"])],
        [p("完成", styles["cell"]), p("只有 q=2 成功或 q=3 返回 s=2，才确认设备已工作。", styles["cell"]), p("最终仍由服务端原子扣次并创建唯一工单。", styles["cell"])],
    ]
    story += [styled_table(timing_rows, [32 * mm, 73 * mm, 73 * mm], paddings=(1.8, 1.8)), Spacer(1, 3 * mm)]

    state_rows = [
        [p("收到的命令", styles["head"]), p("允许状态", styles["head"]), p("设备端处理", styles["head"]), p("必须回包", styles["head"])],
        [code('{"q":1}', styles["cell_small"]), p("待机或工作中", styles["cell"]), p("读取当前状态和当前 nonce。每收到一条完整命令，只发送一份完整响应。", styles["cell"]), code('{"q":1,"c":"i",...}', styles["cell_small"], 6.8)],
        [code('{"q":2,...}', styles["cell_small"]), p("待机", styles["cell"]), p("校验有效期、次数、signature；同一授权不得重复启动。成功后持久化工作态。", styles["cell"]), code('{"q":2,"o":1,"s":2}', styles["cell_small"], 6.8)],
        [code('{"q":2,...}', styles["cell_small"]), p("校验失败", styles["cell"]), p("保持原状态，不启动，不伪造工作态。", styles["cell"]), code('{"q":2,"o":0,"e":1001}', styles["cell_small"], 6.8)],
        [code('{"q":3}', styles["cell_small"]), p("任意", styles["cell"]), p("只读查询，不改变状态；s 按当前真实值填写 1 或 2。", styles["cell"]), code('{"q":3,"s":2}', styles["cell_small"], 6.8)],
    ]
    story += [p("设备端状态处理", styles["h2"]), styled_table(state_rows, [34 * mm, 29 * mm, 77 * mm, 38 * mm], paddings=(1.65, 1.65)), Spacer(1, 3 * mm)]

    story += [
        info_box(
            "关闭扫码后再次进入",
            "小程序关闭本轮扫码时会注销 Notify、断开 BLE 并清空接收缓冲区；资格仍有效时可建立全新连接。设备不得依赖上一连接的分片。"
            "如果 q=2 已经发送，系统只能查询原授权结果，不能通过重新扫码生成第二次开机。",
            styles,
            "blue",
        ),
        Spacer(1, 2.5 * mm),
        info_box(
            "重复命令规则",
            "q=1 和 q=3 都是只读命令，可安全再次响应。q=2 会改变设备状态，禁止把网络或 BLE 重试理解为新的开机。"
            "设备必须按同一授权内容做幂等保护；已执行过的同一授权不得再次启动。",
            styles,
            "red",
        ),
    ]

    # Page 4: signature and acceptance
    story += [PageBreak(), Spacer(1, 3.5 * mm), p("六、signature 凯撒算法与设备验收", styles["page_title"]), Spacer(1, 2.5 * mm)]
    story += [
        info_box(
            "算法定义",
            "输入是 q=1 返回的 32 位 nonce，先统一转为小写。对从 0 开始的每个位置 index，计算 "
            "<b>offset = (4 × (index + 1)) mod 7</b>。数字在 0-9 内循环右移；小写字母在 a-z 内循环右移。"
            "输出仍为 32 个 ASCII 字符，可能出现 g、i、k 等超出十六进制范围的字母。该算法不使用生产 Key、不计算 HMAC、不构造 canonical string。",
            styles,
            "gold",
        ),
        Spacer(1, 3 * mm),
    ]

    vector_rows = [
        [p("项目", styles["head"]), p("固定验收值", styles["head"])],
        [p("nonce 输入", styles["cell"]), code("00112233445566778899aabbccddeeff", styles["cell"], 8.2)],
        [p("signature 输出", styles["cell"]), code("41638537597196183052aecgeigdifkh", styles["cell"], 8.2)],
    ]
    story += [styled_table(vector_rows, [42 * mm, 136 * mm], paddings=(2.1, 2.1)), Spacer(1, 3 * mm)]

    pseudo = (
        '<font name="Courier" size="7.4">for index, ch in nonce.lower():<br/>'
        '&nbsp;&nbsp;offset = (4 * (index + 1)) % 7<br/>'
        '&nbsp;&nbsp;if ch is 0..9: out += rotate(ch, "0123456789", offset)<br/>'
        '&nbsp;&nbsp;else if ch is a..z: out += rotate(ch, "abcdefghijklmnopqrstuvwxyz", offset)<br/>'
        '&nbsp;&nbsp;else: reject nonce<br/>'
        'accept only when out == x and current_time &lt;= e and u is valid</font>'
    )
    story += [info_box("设备端参考伪代码", pseudo, styles, "blue"), Spacer(1, 3 * mm)]

    checklist_rows = [
        [p("验收项", styles["head"]), p("通过标准", styles["head"])],
        [p("身份烧录", styles["cell"]), p("设备编号符合 LA+12 位大写十六进制；广播名等于 LA-加编号末6位，且不同设备不得重名。", styles["cell"])],
        [p("GATT", styles["cell"]), p("FFE0 下存在同一 FFE1；支持小程序写入及 notify/indicate，CCCD 可订阅。", styles["cell"])],
        [p("下行组帧", styles["cell"]), p("能连续接收 q=2 的 4 个 20 字节以内分片，直到 LF 才解析；不逐片清空。", styles["cell"])],
        [p("上行组帧", styles["cell"]), p("按顺序发送完整 JSON；可多次 notify，不能丢片、乱序、重复整包或夹入调试文字。", styles["cell"])],
        [p("q=1", styles["cell"]), p("立即返回真实 s 与 32 位 n；同一完整请求只回一份。仅实现精简格式，不回复旧长 info。", styles["cell"])],
        [p("q=2", styles["cell"]), p("正确向量能通过；错误 x、过期 e、非法 u 均失败且不启动；成功后真实进入 s=2 并持久化。", styles["cell"])],
        [p("q=3", styles["cell"]), p("只返回真实状态。断电恢复后仍能报告已持久化的工作状态。", styles["cell"])],
        [p("业务闭环", styles["cell"]), p("设备没有进入 s=2 时，小程序和服务端均不会扣次；重复同一授权不得再次启动。", styles["cell"])],
    ]
    story += [p("七、交付前联合验收清单", styles["h2"]), styled_table(checklist_rows, [38 * mm, 140 * mm], paddings=(1.4, 1.4)), Spacer(1, 2.5 * mm)]

    story += [
        info_box(
            "nonce 与唯一性",
            "不同核销资格允许设备返回相同 nonce，服务端仍通过唯一资格、一次性授权令牌、幂等提交和原子扣次保证每张工单唯一。"
            "但同一资格或同一 q=2 授权绝不能重复启动或重复扣次。",
            styles,
            "green",
        )
    ]

    doc.build(story, onFirstPage=draw_page, onLaterPages=draw_page)
    print(OUTPUT)


if __name__ == "__main__":
    build()
