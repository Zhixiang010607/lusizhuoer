#!/usr/bin/env python3
"""Generate the one-page HC-08 handoff sheet for the device-side team."""

from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)


ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "output" / "pdf" / "露思卓儿_魔法柔肤_HC-08设备端一页接入说明.pdf"

INK = colors.HexColor("#35291E")
GOLD = colors.HexColor("#9A6D2D")
PALE_GOLD = colors.HexColor("#F2E7D3")
IVORY = colors.HexColor("#FFF9F0")
LINE = colors.HexColor("#D7BE97")
MUTED = colors.HexColor("#6F6255")
RED = colors.HexColor("#A43C32")


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


def style(name, size, leading=None, color=INK, align=TA_LEFT, **kwargs):
    return ParagraphStyle(
        name,
        fontName="CN",
        fontSize=size,
        leading=leading or size * 1.45,
        textColor=color,
        alignment=align,
        spaceAfter=0,
        **kwargs,
    )


def box(title, body, styles, tone="gold"):
    fill = PALE_GOLD if tone == "gold" else colors.HexColor("#FCECE9")
    border = LINE if tone == "gold" else colors.HexColor("#DDA69E")
    title_color = GOLD if tone == "gold" else RED
    content = Paragraph(
        f'<font name="CN-Bold" color="{title_color.hexval()}">{title}</font><br/>{body}',
        styles["box"],
    )
    table = Table([[content]], colWidths=[178 * mm])
    table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), fill),
        ("BOX", (0, 0), (-1, -1), 0.8, border),
        ("LEFTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 4 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.4 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.4 * mm),
    ]))
    return table


def draw_page(canvas, doc):
    width, height = A4
    canvas.saveState()
    canvas.setFillColor(IVORY)
    canvas.rect(0, 0, width, height, fill=1, stroke=0)
    canvas.setStrokeColor(LINE)
    canvas.setLineWidth(0.6)
    canvas.line(16 * mm, 11 * mm, width - 16 * mm, 11 * mm)
    canvas.setFont("CN", 7.2)
    canvas.setFillColor(MUTED)
    canvas.drawString(16 * mm, 6.7 * mm, "露思卓儿｜魔法柔肤 LASER-BLE｜设备端接入说明")
    canvas.drawRightString(width - 16 * mm, 6.7 * mm, "2026-10-08｜第 1 页 / 共 1 页")
    canvas.restoreState()


def build():
    register_fonts()
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    styles = {
        "title": style("title", 19.5, 24.5, align=TA_CENTER),
        "sub": style("sub", 9.2, 13, MUTED, TA_CENTER),
        "h2": style("h2", 11.2, 14.8, GOLD),
        "body": style("body", 9.1, 13.4),
        "small": style("small", 8.2, 11.5, MUTED),
        "box": style("box", 9.1, 13.3),
        "cell": style("cell", 8.6, 12.2),
        "cellhead": style("cellhead", 8.6, 12.2, colors.white, TA_CENTER),
    }

    doc = SimpleDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=16 * mm,
        rightMargin=16 * mm,
        topMargin=13 * mm,
        bottomMargin=15 * mm,
        title="露思卓儿魔法柔肤 HC-08 设备端一页接入说明",
        author="广州露思卓儿科技有限公司",
    )

    story = [
        Paragraph("魔法柔肤 HC-08 设备端一页接入说明", styles["title"]),
        Paragraph("给设备固件开发／调试人员｜按本页实现即可联调", styles["sub"]),
        Spacer(1, 3.5 * mm),
        box(
            "一、固定身份与 GATT（必须按此实现）",
            "设备类型：<b>LASER-BLE</b>　｜　设备编号：<b>LA + 12 位大写十六进制</b><br/>"
            "广播名：<b>LA- + 设备编号末 6 位</b>　｜　示例：LAF82E0CC8C5B9 → LA-C8C5B9<br/>"
            "Service UUID：<b>FFE0</b>　｜　Write UUID：<b>FFE1</b>　｜　Notify UUID：<b>FFE1</b>",
            styles,
        ),
        Spacer(1, 3 * mm),
        Paragraph("二、FFE1 怎样使用", styles["h2"]),
    ]

    gatt_rows = [
        [Paragraph("方向", styles["cellhead"]), Paragraph("设备端动作", styles["cellhead"]), Paragraph("硬性要求", styles["cellhead"])],
        [Paragraph("小程序 → 设备", styles["cell"]), Paragraph("在 FFE1 接收 get_info、auth、query_status", styles["cell"]), Paragraph("FFE1 开启 write 或 writeNoResponse", styles["cell"])],
        [Paragraph("设备 → 小程序", styles["cell"]), Paragraph("在同一 FFE1 发送 info、auth_result、status", styles["cell"]), Paragraph("FFE1 开启 notify 或 indicate，并支持 CCCD 订阅", styles["cell"])],
        [Paragraph("字节协议", styles["cell"]), Paragraph("UTF-8 JSON；小程序下行以 LF（0x0A）结束", styles["cell"]), Paragraph("设备上行到完整 } 即可结束；可选追加 LF", styles["cell"])],
    ]
    gatt_table = Table(gatt_rows, colWidths=[29 * mm, 78 * mm, 71 * mm], repeatRows=1)
    gatt_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GOLD),
        ("GRID", (0, 0), (-1, -1), 0.5, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.5 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.7 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.7 * mm),
    ]))
    story += [gatt_table, Spacer(1, 2.2 * mm)]
    story.append(box(
        "重要：20 字节是当前单片上限，不是整条报文长度",
        "小程序 → 设备：get_info、auth、query_status 按 1-20 字节顺序写入。设备只追加到 rx_buffer，<b>不得逐片解析或清空</b>；"
        "见到 LF 后才解析完整 JSON，缓冲区至少 512 字节。<br/>"
        "设备 → 小程序：精简 info 为 <b>60 字节</b>，发送 20+20+20 三片；手机拼成完整顶层 JSON 后处理。可支持更大 MTU，但不能依赖大包。",
        styles,
        tone="red",
    ))
    story += [Spacer(1, 2.2 * mm), Paragraph("三、精简 info 回包（设备收到 get_info 后返回）", styles["h2"])]
    story.append(box(
        "完整报文（复制实现；示例不带 LF）",
        "<font name=\"Courier\" size=\"7.2\">{\"q\":1,\"c\":\"i\",\"s\":1,\"n\":\"00112233445566778899aabbccddeedd\"}</font><br/>"
        "<b>q</b>=1（请求序号）；<b>c</b>=i（info）；<b>s</b>=1 待机／2 工作中；<b>n</b>=32 位十六进制 nonce。"
        "不要加入 device_id、device_type、ble_name、ver、ok。可不带 LF；也允许最后追加 LF。",
        styles,
    ))
    story += [Spacer(1, 2.2 * mm), Paragraph("四、一次完整通信顺序", styles["h2"])]

    flow_rows = [
        [Paragraph("1", styles["cellhead"]), Paragraph("连接后允许小程序订阅 FFE1 通知。", styles["cell"])],
        [Paragraph("2", styles["cellhead"]), Paragraph("收到完整 get_info 后返回上方精简 info。手机 5 秒未收到完整结果时最多补发一次；设备重发响应，不改变状态。", styles["cell"])],
        [Paragraph("3", styles["cellhead"]), Paragraph("收到完整 auth 后校验 device_id、device_type、nonce、expire_at、usage_count，并按下方算法重算 signature。通过后才进入工作态并持久化 status=2，再返回 seq=2、cmd=auth_result、ok=true、status=2。", styles["cell"])],
        [Paragraph("4", styles["cellhead"]), Paragraph("收到 query_status 后返回真实状态。未执行 auth 时只能返回 status=1；已经真实进入工作态才返回 status=2。", styles["cell"])],
    ]
    flow_table = Table(flow_rows, colWidths=[10 * mm, 168 * mm])
    flow_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (0, -1), GOLD),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (1, 0), (1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2.3 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2.3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.25 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.25 * mm),
    ]))
    story += [flow_table, Spacer(1, 2.5 * mm)]
    story.append(box(
        "五、signature 凯撒算法（必须与验收样例逐字一致）",
        "输入：把 32 位十六进制 nonce 统一转成小写。对从 0 开始的每个位置 <b>index</b>，计算 "
        "<b>offset = (4 × (index + 1)) mod 7</b>。数字只在 0-9 内循环右移；小写字母只在 a-z 内循环右移。"
        "输出仍为 32 个 ASCII 字符，可能出现 g、i、k 等超出十六进制范围的字母。<br/>"
        "固定验收输入：<font name=\"Courier\" size=\"7.2\">00112233445566778899aabbccddeeff</font><br/>"
        "固定验收输出：<font name=\"Courier\" size=\"7.2\">41638537597196183052aecgeigdifkh</font><br/>"
        "不使用生产 Key，不计算 HMAC，不构造 canonical string。设备用同一算法重算后逐字比较 signature。",
        styles,
    ))
    story.append(Spacer(1, 2.5 * mm))

    lower = Table([
        [[
            Paragraph("六、交付前验收", styles["h2"]),
            Paragraph(
                "□ 广播名与编号末 6 位一致　□ FFE1 可写且可订阅通知　□ 下行三种指令均在 LF 后解析<br/>"
                "□ 60 字节 info 分 3 片发送　□ get_info 一次只回一条 info　□ 凯撒样例逐字一致<br/>"
                "□ 重复 nonce 的下一笔可开机　□ 同一 auth 不重复启动　□ 未授权时 query_status 返回 1",
                styles["body"],
            ),
        ]]
    ], colWidths=[178 * mm])
    lower.setStyle(TableStyle([
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("BOX", (0, 0), (-1, -1), 0.6, LINE),
        ("BACKGROUND", (0, 0), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 3 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 2.2 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 2.2 * mm),
    ]))
    story += [lower]

    doc.build(story, onFirstPage=draw_page)
    print(OUTPUT)


if __name__ == "__main__":
    build()
