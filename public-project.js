/* Approved public editorial copy, independently rendered for the Web client. */
(() => {
  "use strict";
  const projects = {
    ocean: {
      name: "海洋之蕴", category: "生活美容 · 轮廓管理", headline: "聚焦轮廓与肤龄观感。", image: "assets/project-ocean-hero.jpg",
      title: "以轮廓为主线，兼顾肤质与肤龄观感。",
      intro: "海洋之蕴定位于面部轮廓与肤龄观感管理。项目以微聚焦超声、聚焦射频和生物电射频组成分层护理思路，重点关注面颊、下颌线等部位的轮廓线条，同时兼顾肤质细腻度与整体状态感，三项护理各有侧重、彼此衔接。",
      chapters: [
        ["超声", "关注轮廓框架。", "微聚焦超声作为分层护理的一部分，护理重点放在面颊、下颌线等轮廓区域。项目以整体线条为观察维度，与另外两项护理模块形成由整体到局部的搭配。"],
        ["射频", "兼顾肤质观感。", "聚焦射频承担肤质护理方向，围绕细纹观感、细腻度与紧致观感安排护理重点。该模块可独立使用，也可与轮廓护理组合，使整体轮廓与近看细节处于同一套管理思路中。"],
        ["生物电", "细化局部线条。", "生物电射频更多关注局部线条与面部整体协调，作为轮廓护理的补充模块，可结合不同部位与当次护理重点灵活搭配。"]
      ],
      detailTitle: "轮廓为主，肤质与状态感为辅。", detailText: "海洋之蕴的核心在于分层组合：先明确轮廓关注区域，再将局部线条与肤质细节纳入同一护理思路，使三项护理的分工更加清晰。",
      details: [["轮廓主线", "关注面颊、下颌线及面部整体线条的协调观感。"], ["肤龄观感", "将细腻度、紧致观感与整体状态感纳入日常美容管理。"], ["分层组合", "三项护理模块各有侧重，可根据部位与外观需求组合安排。"]], next: "skin"
    },
    skin: {
      name: "魔法柔肤", category: "生活美容 · 肤质管理", headline: "聚焦肤质与肤色观感。", image: "assets/project-skin-hero.jpg",
      title: "以肤质肤色为主线，关注肌肤外观状态。",
      intro: "魔法柔肤定位于肤质与肤色观感管理。项目以柔肤仪的纳秒光与多种护理模式为基础，沿着“清、促、建”的护理思路，重点关注粗糙感、毛孔观感、暗沉和肤色不匀等常见外观状态，并兼顾水润度、光泽感与触感。",
      chapters: [
        ["清", "为肤质管理打底。", "“清”围绕肌肤表面的油脂、污垢与清洁状态展开，重视清爽、洁净的肤感，为后续细致护理建立基础。"],
        ["促", "细化肤色与触感。", "“促”结合纳秒光与不同护理模式，可按当次外观状态安排侧重，关注粗糙感、毛孔观感、暗沉和肤色不匀，使肤质与肤色成为护理主线。"],
        ["建", "延续日常状态管理。", "“建”将水润度、光泽感与细腻度纳入持续养护，形成从清洁、细致护理到状态维护的完整思路。"]
      ],
      detailTitle: "肤质为本，肤色与光泽同步关注。", detailText: "魔法柔肤围绕肌肤外观状态组织护理：以清洁为起点，以肤质、肤色与水润光泽为重点，使不同护理模式服务于清晰的肌肤管理方向。",
      details: [["肤质观感", "关注粗糙感、毛孔观感与触感细腻度。"], ["肤色观感", "关注暗沉、肤色不匀与整体清透感。"], ["水润光泽", "兼顾肌肤的水润度、光泽感与日常状态维护。"]], next: "warmth"
    },
    warmth: {
      name: "露思康辰", category: "生活美容 · 温度管理", headline: "聚焦温度与身体舒适感。", image: "assets/project-warmth-hero.jpg",
      title: "以温度管理为主线，关注身体舒适体验。",
      intro: "露思康辰定位于日常身体护理。项目由低频脉冲、自感磁场与可调温热感三项护理模块组成，配合贴合、速度、力度和连贯度等操作细节，重点关注久坐、劳累后常见的紧绷感与身体舒适感，以温热、放松和日常状态维护为主要方向。",
      chapters: [
        ["电", "建立护理节奏。", "低频脉冲以有节奏的体验参与身体护理，与自感磁场和温热护理共同构成项目基础。操作中的速度与力度相互配合，形成连贯、舒适的护理节奏。"],
        ["磁", "配合整体体验。", "自感磁场作为组合模块之一，与低频脉冲和温热护理协同使用。三项模块整合在同一护理流程中，使技术体验与贴合手法自然衔接。"],
        ["热", "温度贯穿护理。", "可调温手柄为护理提供温热感，温度可按部位和舒适度安排，配合贴合、连贯的操作，使温度成为整个项目的核心体验线索。"]
      ],
      detailTitle: "温度为主，兼顾六项体验细节。", detailText: "露思康辰的核心在于温度与手法的协同管理。舒适、贴合、速度、力度、连贯与温度六个细节共同构成体验，项目方向是日常身体关怀与放松体验。",
      details: [["舒适感", "以温热感与放松感作为日常身体护理的体验重点。"], ["贴合度", "手柄与护理部位的贴合，是细致接触的基础。"], ["速度", "手法的快慢形成节奏，让各个环节自然衔接。"], ["力度", "轻重有度的手法，照顾不同部位的接触感受。"], ["连贯度", "连续而有序的手法，将局部护理串成完整体验。"], ["温度管理", "可调温手柄配合不同部位与个人感受安排温热体验。"]], next: "ocean"
    }
  };
  const requested = new URLSearchParams(location.search).get("project");
  const key = Object.hasOwn(projects, requested) ? requested : "ocean";
  const p = projects[key];
  document.title = `${p.name} · 露思卓儿`;
  document.querySelector(`[data-project-nav="${key}"]`).setAttribute("aria-current", "page");
  // Only static whitelisted copy is interpolated; never URL text or business data.
  document.getElementById("publicProject").innerHTML = `<header class="public-project-hero"><div><p>${p.category}</p><h1>${p.name}</h1><h2>${p.headline}</h2></div><img src="${p.image}" alt="${p.name}护理概念图"></header><section class="public-project-introduction"><h2>${p.title}</h2><p>${p.intro}</p></section><nav class="public-project-chapters" role="tablist" aria-label="护理章节">${p.chapters.map((c,i)=>`<button id="chapter-tab-${i+1}" type="button" role="tab" data-chapter="${i}" aria-controls="chapter-${i+1}" aria-selected="${i===0}" tabindex="${i===0?0:-1}">${c[0]}</button>`).join("")}</nav>${p.chapters.map((c,i)=>`<section id="chapter-${i+1}" class="public-project-chapter" role="tabpanel" aria-labelledby="chapter-tab-${i+1}" ${i===0?"":"hidden"}><span>${String(i+1).padStart(2,"0")} / ${c[0]}</span><h2>${c[1]}</h2><p>${c[2]}</p></section>`).join("")}<section><h2>${p.detailTitle}</h2><p>${p.detailText}</p><dl class="company-facts">${p.details.map(d=>`<div><dt>${d[0]}</dt><dd>${d[1]}</dd></div>`).join("")}</dl></section><footer class="public-project-footer"><a href="login.html#projects">返回公司主页</a><a href="public-project.html?project=${p.next}">下一个项目 · ${projects[p.next].name} →</a></footer>`;
  const tabs = [...document.querySelectorAll("[data-chapter]")];
  const panels = [...document.querySelectorAll(".public-project-chapter")];
  function showChapter(index) {
    tabs.forEach((tab, i) => {
      tab.setAttribute("aria-selected", String(i === index));
      tab.tabIndex = i === index ? 0 : -1;
      panels[i].hidden = i !== index;
    });
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => showChapter(index));
    tab.addEventListener("keydown", (event) => {
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault();
      showChapter(next);
      tabs[next].focus();
    });
  });
  const initial = /^#chapter-([1-3])$/.exec(location.hash || "");
  showChapter(initial ? Number(initial[1]) - 1 : 0);
})();
