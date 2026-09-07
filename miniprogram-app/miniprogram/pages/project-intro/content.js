// Public editorial content. Sources and claim exclusions: docs/design/project-intro-native/.
const PROJECTS = {
  ocean: {
    key: "ocean", name: "海洋之蕴", device: "15D 精雕仪", category: "分层护理",
    headline: "美，自有层次。", keywords: "MFU · RF · DP",
    introLabel: "01 / 分层理念", introTitle: "关注轮廓，\n也关注每一处细节。",
    introduction: "以分层护理为思路，将 MFU、RF 与 DP 组合运用，关注面部轮廓与肌肤细节。",
    storyLabel: "LAYERED CARE",
    steps: [
      { word: "MFU", title: "从整体，看轮廓。", text: "微聚焦超声，是分层方案的一部分。从整体轮廓出发，了解你希望重点关注的区域。" },
      { word: "RF", title: "从细节，看肌肤。", text: "聚焦射频，纳入面部精细护理。围绕不同区域的肌肤状态，让护理各有侧重。" },
      { word: "DP", title: "让方案，适合自己。", text: "DP 生物电射频，与另外两项技术共同组成护理方案。具体搭配，结合你的实际需求确定。" }
    ],
    detailLabel: "02 / 个体方案", detailTitle: "选择在适合，\n也在于持续关注。",
    detailText: "关注面部轮廓与肌肤状态，也了解你的既往护理经历。一次充分的沟通，是确定方案的开始。",
    details: [
      { title: "了解需求", text: "沟通轮廓、肤质与日常护理关注点" },
      { title: "确认方案", text: "结合个人情况安排护理重点" },
      { title: "持续沟通", text: "依专业建议安排后续护理与反馈" }
    ],
    beforeText: "体验前请主动说明健康状况、植入物、既往手术及近期接受的其他项目，由具备相应资质的人员依据设备说明书评估风险。出现持续或明显不适，应及时就医。",
    nextKey: "skin", nextName: "魔法柔肤", nextDevice: "13D 柔肤仪"
  },
  skin: {
    key: "skin", name: "魔法柔肤", device: "13D 柔肤仪", category: "肌肤护理",
    headline: "美，从细致开始。", keywords: "清 · 促 · 建",
    introLabel: "01 / 护理理念", introTitle: "把护理的每一层，\n都认真对待。",
    introduction: "从了解肌肤出发，让清洁、护理与日常维护，各有重点。",
    storyLabel: "THE CARE RITUAL",
    steps: [
      { word: "清", title: "清洁，是起点。", text: "先了解肌肤当下的状态，再确认合适的清洁方式，让护理从细节开始。" },
      { word: "促", title: "护理，有重点。", text: "围绕当下的护理需求，沟通方案与体验反馈，让每一步都有清楚的方向。" },
      { word: "建", title: "维护，入日常。", text: "把肤质、肤色与日常护理习惯放在一起考虑，建立适合自己的持续护理节奏。" }
    ],
    detailLabel: "02 / 细致体验", detailTitle: "每一张面孔，\n都有自己的节奏。",
    detailText: "关注肤质、肤色与日常护理习惯。沟通你的需求，让每一步护理更贴合你的生活。",
    details: [
      { title: "了解肌肤", text: "沟通当前状态与护理经历" },
      { title: "确认方案", text: "结合肌肤状态安排护理重点" },
      { title: "日常维护", text: "让后续护理有章可循" }
    ],
    beforeText: "请先阅读设备说明书，由具备相应资质的人员评估适用范围、禁忌与风险。正在治疗或有特殊皮肤情况时，应先咨询医生。",
    nextKey: "warmth", nextName: "露思康辰", nextDevice: "E 脉通"
  },
  warmth: {
    key: "warmth", name: "露思康辰", device: "E 脉通", category: "身体关怀",
    headline: "给自己，一刻温暖。", keywords: "电 · 磁 · 热",
    introLabel: "01 / 项目理念", introTitle: "把忙碌暂放，\n听见身体的感受。",
    introduction: "低频脉冲、自感磁场与恒温热灸，构成 E 脉通的三项技术特点。体验过程，重视舒适感，也重视你的每一次反馈。",
    storyLabel: "THREE ELEMENTS",
    steps: [
      { word: "电", title: "感受，有节律。", text: "低频脉冲，与磁、热相互配合。体验中保持沟通，认真听取你的每一次感受。" },
      { word: "磁", title: "三种技术，一个整体。", text: "自感磁场，与低频脉冲、恒温热灸共同构成 E 脉通的技术体系。三项技术，围绕一次完整体验展开。" },
      { word: "热", title: "温度，听你的感受。", text: "恒温热灸，让温度成为体验中的一部分。从开始到结束，持续关注你的舒适感。" }
    ],
    detailLabel: "02 / 体验细节", detailTitle: "舒适，\n藏在每一个细节里。",
    detailText: "从舒适感到连贯度，关注体验中的六个细节，也认真听取你的感受。",
    details: ["舒适度", "服帖度", "速度", "力度", "连贯度", "温度"].map(title => ({ title })),
    beforeText: "孕妇、未成年人及部分植入物、心脏手术等情况属于设备资料列出的禁用情形。预约前请主动说明健康与手术情况，由具备相应资质的人员依据实际设备说明书核对全部禁忌与适用范围。",
    nextKey: "ocean", nextName: "海洋之蕴", nextDevice: "15D 精雕仪"
  }
};

function getProject(key) {
  return ["ocean", "skin", "warmth"].includes(key) ? PROJECTS[key] : null;
}

module.exports = { getProject };
