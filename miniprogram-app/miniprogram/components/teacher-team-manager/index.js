const {callStaff}=require("../../services/api");
const empty=()=>({records:[],page:1,totalPages:1,total:0});
Component({
  properties:{teacherId:{type:String,value:""}},
  data:{members:empty(),candidates:empty(),keyword:"",membersInput:"1",candidatesInput:"1",searched:false,loading:false,mutating:false,error:""},
  observers:{teacherId(){if(this._ready)this.reload();}},
  lifetimes:{attached(){this._ready=true;this.reload();},detached(){this._ready=false;this._epoch=(this._epoch||0)+1;}},
  methods:{
    async reload(page=1){const epoch=this._epoch=(this._epoch||0)+1;this.setData({loading:true,error:"",members:empty(),candidates:empty(),searched:false});try{const r=await callStaff("getTeacherTeam",{teacherId:this.data.teacherId,page});if(!this._ready||epoch!==this._epoch)return;if(!r.teacher?.isTeamLeader)throw new Error("组长身份已取消，请返回基本资料");this.setData({members:r.members,membersInput:String(r.members.page)});}catch(e){if(this._ready&&epoch===this._epoch)this.setData({members:empty(),candidates:empty(),error:e.message||"成员读取失败"});}finally{if(this._ready&&epoch===this._epoch)this.setData({loading:false});}},
    keyword(event){this.setData({keyword:String(event.detail.value||"")});},
    search(){return this.loadCandidates(1);},
    async loadCandidates(page){const epoch=this._epoch=(this._epoch||0)+1;this.setData({loading:true,error:"",candidates:empty(),searched:true});try{const r=await callStaff("listTeacherTeamCandidates",{teacherId:this.data.teacherId,keyword:this.data.keyword.trim(),page});if(this._ready&&epoch===this._epoch)this.setData({candidates:r.candidates,candidatesInput:String(r.candidates.page)});}catch(e){if(this._ready&&epoch===this._epoch)this.setData({candidates:empty(),members:empty(),error:e.message||"老师搜索失败"});}finally{if(this._ready&&epoch===this._epoch)this.setData({loading:false});}},
    movePage(e){const kind=e.currentTarget.dataset.kind,p=this.data[kind].page+Number(e.currentTarget.dataset.delta);this.goPage(kind,p);},
    changePageInput(e){this.setData({[e.currentTarget.dataset.kind+"Input"]:String(e.detail.value||"")});},
    jumpPage(e){const kind=e.currentTarget.dataset.kind;this.goPage(kind,Number(this.data[kind+"Input"]));},
    goPage(kind,p){if(this.data.loading||this.data.mutating||!["members","candidates"].includes(kind))return;if(!Number.isInteger(p)||p<1||p>this.data[kind].totalPages){wx.showToast({title:"请输入有效页码",icon:"none"});return;}return kind==="members"?this.reload(p):this.loadCandidates(p);},
    memberPage(event){return this.reload(event.detail.page);},candidatePage(event){return this.loadCandidates(event.detail.page);},
    async mutate(event){if(this.data.mutating||this.data.loading)return;const memberTeacherId=String(event.currentTarget.dataset.id||""),assigned=event.currentTarget.dataset.add===true||event.currentTarget.dataset.add==="true";if(!memberTeacherId)return;
      if(!assigned){const yes=await new Promise(resolve=>wx.showModal({title:"移除成员？",content:"移除后，该老师可重新分配给其他组长。原有业务、打卡与日报保留。",success:r=>resolve(r.confirm),fail:()=>resolve(false)}));if(!yes||!this._ready)return;}
      const searched=this.data.searched;this.setData({mutating:true,error:""});let message="";try{await callStaff("setTeacherTeamMember",{teacherId:this.data.teacherId,memberTeacherId,assigned});}catch(e){message=e.message||"操作结果暂未确认，请刷新名单";}finally{if(this._ready){await this.reload();if(searched)await this.loadCandidates(1);if(this._ready){this.setData({mutating:false,error:message||this.data.error});this.triggerEvent("changed");}}}
    }
  }
});
