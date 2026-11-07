'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict'),test=require('node:test'),path=require('node:path');
const root='miniprogram-app/miniprogram',read=p=>fs.readFileSync(path.join(root,p),'utf8');
test('only the existing HQ home review menu receives reminders; cancelled dock and note column stay absent',()=>{
 const html=read('pages/home/index.wxml'),js=read('pages/home/index.js');
 assert.match(html,/session\.role === 'hq'[\s\S]*bindtap="toggleReviewMenu"/);
 assert.match(html,/reviewNoticeReady && reviewNoticeTotal > 0/);assert.match(html,/class="review-nav-dot"/);
 for(const key of ['purchase','recharge','refund','verification'])assert.match(html,new RegExp('reviewNoticeCounts\\.'+key+' > 0'));
 assert.match(html,/<text>产品审核<\/text>/);assert.doesNotMatch(html,/产品购买审核|review-notification-dock/);
 assert.match(js,/session\.role === "hq"\s*\? reviewNotifications\.subscribe/);
 assert.match(js,/onHide\(\)[\s\S]*this\._reviewUnsubscribe\(\)/);
 const reviews=read('pages/reviews/index.wxml');assert.doesNotMatch(reviews,/申请备注|noteOpen|review-notification-dock/);assert.match(reviews,/申请留言：\{\{pending\.applicantNote\}\}/);
 assert.match(read('pages/reviews/index.js'),/const PAGE_SIZE = 10/);assert.match(reviews,/\{\{index \+ 1\}\}/);assert.match(reviews,/bindtap="jumpPage"/);assert.match(reviews,/scroll-x="true"/);assert.doesNotMatch(reviews,/scroll-y="true"/);
 assert.match(read('pages/home/index.wxss'),/\.review-nav-dot\s*\{[^}]*width: 8px;[^}]*height: 8px;/);
});
