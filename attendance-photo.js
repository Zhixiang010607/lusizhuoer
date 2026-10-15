(() => {
  "use strict";
  const initialized = new WeakSet();
  const alive = (node, id) => node.isConnected && node.dataset.attendancePhoto === id;
  async function mount(node) {
    if (initialized.has(node)) return;
    initialized.add(node);
    const id = node.dataset.attendancePhoto;
    if (!/^[1-9]\d{0,17}$/.test(id || "")) return;
    const image = document.createElement("img"), button = document.createElement("button");
    image.alt = "本次打卡照片（右下角为打卡类型与北京时间）";
    image.className = "attendance-evidence-image";
    image.hidden = true;
    button.type = "button"; button.className = "secondary-button";
    button.textContent = "正在读取打卡照片…"; button.disabled = true;
    node.replaceChildren(image, button);
    const call = async (data) => {
      const result = await window.WebWorkCommon.call("faceRecognition", "getAttendancePhoto", { attendanceId: id, ...data });
      if (result.attendanceId !== id) throw new Error("打卡照片不匹配");
      return result;
    };
    async function read() {
      if (button.disabled) return;
      button.disabled = true; button.textContent = "正在读取…";
      let url = "";
      try {
        const result = await call({ readBytes: true });
        if (!alive(node, id)) return;
        if (!result.photo) { node.textContent = "此记录未留存照片"; return; }
        const bytes = Uint8Array.from(atob(result.photo.imageBase64), (c) => c.charCodeAt(0));
        if (bytes.length !== result.photo.bytes) throw new Error("照片读取不完整");
        url = URL.createObjectURL(new Blob([bytes], { type: "image/jpeg" }));
        const dialog = document.createElement("dialog"), close = document.createElement("button"), full = document.createElement("img");
        dialog.className = "attendance-evidence-dialog";
        close.textContent = "关闭"; close.type = "button"; close.className = "secondary-button";
        close.addEventListener("click", () => dialog.close());
        full.src = url; full.alt = image.alt;
        dialog.append(close, full); document.body.append(dialog);
        dialog.addEventListener("close", () => { URL.revokeObjectURL(url); dialog.remove(); }, { once: true });
        dialog.showModal();
        button.textContent = "查看打卡照片";
      } catch (_) { if (url) URL.revokeObjectURL(url); if (alive(node, id)) button.textContent = "照片读取失败，重新读取"; }
      finally { if (alive(node, id)) button.disabled = false; }
    }
    button.addEventListener("click", read); image.addEventListener("click", read);
    image.addEventListener("error", () => { image.hidden = true; button.textContent = "照片读取失败，重新读取"; });
    try {
      const result = await call({});
      if (!alive(node, id)) return;
      if (!result.photo) { node.textContent = "此记录未留存照片"; return; }
      image.src = result.photo.url; image.hidden = false;
      button.textContent = "查看打卡照片";
    } catch (_) { if (alive(node, id)) button.textContent = "照片读取失败，重新读取"; }
    finally { if (alive(node, id)) button.disabled = false; }
  }
  function scan() { document.querySelectorAll("[data-attendance-photo]").forEach(mount); }
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
  scan();
})();
