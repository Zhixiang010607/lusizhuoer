Component({
  properties: { page: {type:Number,value:1}, totalPages:{type:Number,value:1}, total:{type:Number,value:0}, disabled:{type:Boolean,value:false} },
  data:{ input:"1" },
  observers:{ page(value){this.setData({input:String(value||1)});} },
  methods:{
    move(event){this.emitPage(this.data.page+Number(event.currentTarget.dataset.delta));},
    input(event){this.setData({input:String(event.detail.value||"")});},
    jump(){this.emitPage(Number(this.data.input));},
    emitPage(page){if(this.data.disabled)return;if(!Number.isInteger(page)||page<1||page>this.data.totalPages){wx.showToast({title:"请输入有效页码",icon:"none"});return;}this.triggerEvent("change",{page});}
  }
});
