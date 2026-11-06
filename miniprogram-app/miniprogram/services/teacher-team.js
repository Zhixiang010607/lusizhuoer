const {callStaff}=require("./api");
const {waitForStartupSession,requireSession}=require("./session");
async function requireTeamAccess(){
  await waitForStartupSession();
  const session=requireSession(["teacher"]);
  if(!session)throw new Error("请使用老师账号登录");
  const access=await callStaff("getTeamAccess");
  if(!access.isTeamLeader)throw new Error("当前没有组长查看权限，请返回个人工作台");
  return session;
}
function teacherUrl(id){return `/pages/teacher-detail/index?scope=TEAM&teacherId=${encodeURIComponent(String(id||""))}`;}
module.exports={requireTeamAccess,teacherUrl};
