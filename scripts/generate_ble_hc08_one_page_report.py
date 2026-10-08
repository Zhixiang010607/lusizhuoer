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
        "设备 → 小程序：按下表发送精简 JSON；手机拼成完整顶层 JSON 后处理。可支持更大 MTU，但不能依赖大包。",
        styles,
        tone="red",
    ))
    story += [Spacer(1, 2.2 * mm), Paragraph("三、精简报文全集（示例数值可直接联调）", styles["h2"])]
    protocol_rows = [
        [Paragraph("方向／用途", styles["cellhead"]), Paragraph("完整 JSON（小程序下行另加 LF）", styles["cellhead"]), Paragraph("字节／片", styles["cellhead"])],
        [Paragraph("小程序→设备<br/>读取信息", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"ver":"1.0","seq":1,"cmd":"get_info","ts":1791455307}</font>', styles["cell"]), Paragraph("54+LF／3", styles["cell"])],
        [Paragraph("设备→小程序<br/>设备信息", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"q":1,"c":"i","s":1,"n":"00112233445566778899aabbccddeedd"}</font>', styles["cell"]), Paragraph("60／3", styles["cell"])],
        [Paragraph("小程序→设备<br/>开机授权", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"q":2,"c":"a","u":2,"e":1791450472,"x":"41638537597196183052aecgeigdifkh"}</font>', styles["cell"]), Paragraph("75+LF／4", styles["cell"])],
        [Paragraph("设备→小程序<br/>授权成功", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"q":2,"o":1,"s":2}</font>', styles["cell"]), Paragraph("19／1", styles["cell"])],
        [Paragraph("小程序→设备<br/>查询状态", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"q":3}</font>', styles["cell"]), Paragraph("7+LF／1", styles["cell"])],
        [Paragraph("设备→小程序<br/>真实状态", styles["cell"]), Paragraph('<font name="Courier" size="7.2">{"q":3,"s":2}</font>', styles["cell"]), Paragraph("13／1", styles["cell"])],
    ]
    protocol_table = Table(protocol_rows, colWidths=[32 * mm, 126 * mm, 20 * mm], repeatRows=1)
    protocol_table.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, 0), GOLD),
        ("GRID", (0, 0), (-1, -1), 0.45, LINE),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("BACKGROUND", (0, 1), (-1, -1), colors.white),
        ("LEFTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("RIGHTPADDING", (0, 0), (-1, -1), 2 * mm),
        ("TOPPADDING", (0, 0), (-1, -1), 1.1 * mm),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 1.1 * mm),
    ]))
    story += [protocol_table, Spacer(1, 2.2 * mm)]
    story.append(box(
        "四、字段与执行规则",
        "q=步骤号；c=i 表示设备信息、c=a 表示授权；s=1 待机／2 工作中；n=当前 32 位 nonce；"
        "u=本次次数；e=授权到期 Unix 秒；x=由当前 nonce 生成的 signature；o=1 成功／0 失败。<br/>"
        "设备收到 auth 后用<b>当前 nonce</b>重算 x，并校验 u、e；通过后才进入并持久化工作态。失败回包："
        '<font name="Courier" size="7.2">{"q":2,"o":0,"e":1001}</font>（e 为原错误码）。同一 auth 不得重复启动。',
        styles,
    ))
    story += [Spacer(1, 2.2 * mm)]
    story.append(box(
        "五、signature 凯撒算法",
        "输入：把 32 位十六进制 nonce 统一转成小写。对从 0 开始的每个位置 <b>index</b>，计算 "
        "<b>offset = (4 × (index + 1)) mod 7</b>。数字只在 0-9 内循环右移；小写字母只在 a-z 内循环右移。"
        "输出仍为 32 个 ASCII 字符，可能出现 g、i、k 等超出十六进制范围的字母。<br/>"
        "固定验收输入：<font name=\"Courier\" size=\"7.2\">00112233445566778899aabbccddeeff</font><br/>"
        "固定验收输出：<font name=\"Courier\" size=\"7.2\">41638537597196183052aecgeigdifkh</font><br/>"
        "不使用生产 Key，不计算 HMAC，不构造 canonical string。设备用同一算法重算后逐字比较 signature。",
        styles,
    ))

    doc.build(story, onFirstPage=draw_page)
    print(OUTPUT)


if __name__ == "__main__":
    build()
