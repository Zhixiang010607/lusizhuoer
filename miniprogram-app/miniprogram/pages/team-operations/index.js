const {callStaff}=require("../../services/api");
const {requireTeamAccess,teacherUrl}=require("../../services/teacher-team");
Page({
  data:{view:"operations",loading:false,error:"",keyword:"",membersInput:"1",members:{records:[],page:1,total:0,totalPages:1}},
  onLoad(){this._loaded=true;},
  onShow(){this.reload();},onUnload(){this._unloaded=true;this._epoch=(this._epoch||0)+1;},
  onPullDownRefresh(){this.reload().finally(()=>wx.stopPullDownRefresh());},
  async reload(page=1){const epoch=this._epoch=(this._epoch||0)+1;this.setData({loading:true,error:"",members:{records:[],page:1,total:0,totalPages:1}});try{await requireTeamAccess();const r=await callStaff("getMyTeacherTeam",{page,keyword:this.data.keyword.trim()});if(!this._unloaded&&epoch===this._epoch)this.setData({members:r.members,membersInput:String(r.members.page)});}catch(e){if(!this._unloaded&&epoch===this._epoch)this.setData({error:e.message||"小组资料读取失败"});}finally{if(!this._unloaded&&epoch===this._epoch)this.setData({loading:false});}},
  openMembers(){this.setData({view:"members"});this.reload();},
  back(){if(this.data.view==="members")this.setData({view:"operations"});else wx.navigateBack();},
  keyword(event){this.setData({keyword:String(event.detail.value||"")});},search(){this.reload();},page(event){this.reload(event.detail.page);},
  movePage(e){const p=this.data.members.page+Number(e.currentTarget.dataset.delta);if(!this.data.loading&&p>=1&&p<=this.data.members.totalPages)this.reload(p);},
  changePageInput(e){this.setData({membersInput:String(e.detail.value||"")});},
  jumpPage(){const p=Number(this.data.membersInput);if(!this.data.loading&&Number.isInteger(p)&&p>=1&&p<=this.data.members.totalPages)this.reload(p);else wx.showToast({title:"请输入有效页码",icon:"none"});},
  openTeacher(event){const id=String(event.currentTarget.dataset.id||"");if(this.data.members.records.some(t=>t.teacherId===id))wx.navigateTo({url:teacherUrl(id)});},
  openQuery(event){if(this.data.loading||this.data.error)return;const type=event.currentTarget.dataset.type;if(["team-dashboard","attendance-tracking","daily-report-tracking","inactive-customers","low-balance-customers"].includes(type))wx.navigateTo({url:`/pages/${type}/index?scope=TEAM`});}
});
