(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);

  function storedProjects() {
    try { return JSON.parse(sessionStorage.getItem("prototypeCreatedProjects") || "[]"); } catch (_) { return []; }
  }

  function nextProjectId() {
    const highest = storedProjects().reduce((max, project) => Math.max(max, Number(String(project.id || "").replace(/\D/g, "")) || 0), 6);
    return `P${String(highest + 1).padStart(3, "0")}`;
  }

  function submitProject(event) {
    event.preventDefault();
    const projects = storedProjects(), id = nextProjectId();
    let session = null;
    try { session = JSON.parse(sessionStorage.getItem("prototypeSession") || "null"); } catch (_) { session = null; }
    projects.push({ id, name: $("projectCreateName").value.trim(), description: $("projectCreateDescription").value.trim(), status: "活跃", createdAt: new Date().toISOString(), createdBy: { account: session?.account || "HQ001", name: session?.name || "总部管理员" } });
    sessionStorage.setItem("prototypeCreatedProjects", JSON.stringify(projects));
    location.href = `project-management.html?created=${encodeURIComponent(id)}`;
  }

  $("generatedProjectCode").textContent = `编号 ${nextProjectId()}（自动生成）`;
  $("projectCreateForm").addEventListener("submit", submitProject);
})();
