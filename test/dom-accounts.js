'use strict';
// The account card (panel-chat.js): when the claude.ai account and the Claude Code account a chat runs on differ, the first
// message of a chat waits behind a card that names both. Optional DOM test: needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs=require('fs');
const dir=EXT;
const { panelPage, evalPanel } = require('./lib/panel-scripts');
const { html, files: panelFiles } = panelPage(dir);
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window; const sent=[]; let onMsg;
w.browser={runtime:{connect:()=>({postMessage:m=>sent.push(m),onMessage:{addListener:f=>onMsg=f}}),getManifest:()=>({version:'0.4.0'})},
 storage:{session:{get:async()=>({}),set:async()=>{}}},
 tabs:{query:async()=>[{title:'T',url:'https://x'}],onActivated:{addListener(){}},onUpdated:{addListener(){}}}};
w.eval(fs.readFileSync(dir+'lib/markdown.js','utf8')+'\n;window.cizMarkdown=cizMarkdown;'); w.eval(fs.readFileSync(dir+'lib/wall.js','utf8')); evalPanel(dom, dir, panelFiles);
const $=id=>w.document.getElementById(id);
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(x?'  '+x:''))};
const base={agent:'active',signedIn:false,native:'missing',claude:null,debugPort:'off',pending:0,chatModel:'speed',filesMode:'read',filesFolder:''};
const A='me@claude.test', B='me@code.test';
// A panel state signed in to claude.ai as `account` and running chats on Claude Code as `claude` (no email = unknown).
const panel=(account,claude)=>({...base,signedIn:true,native:'connected',hostVersion:'0.4.0',account,claude:{installed:true,loggedIn:true,plan:'pro',...claude}});
const put=s=>onMsg({type:'state',state:s,log:[]});
const chats=()=>sent.filter(m=>m.type==='chat');
const typeAndSend=t=>{ $('input').value=t; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true})); };
const press=id=>{ const b=$(id); if (b) b.click(); };
const cardOn=()=>!!$('accountCard') && !$('accountCard').hidden;
const shown=()=>[...$('messages').querySelectorAll('.msg.user .body')].map(e=>e.textContent.trim());
const finish=()=>{ const c=chats().pop(); if (c) onMsg({type:'chatDone',id:c.id,ok:true}); };
const newChat=()=>w.document.querySelector('#moreMenu [data-act="new"]').click();
(async()=>{
 await new Promise(r=>setTimeout(r,50));
 put(panel({email:A,name:'F',uuid:'u'},{email:B}));
 const c0=chats().length;
 ok('no card before a message is sent', !cardOn());
 // 1. The first message of a chat waits behind the card: both accounts named, nothing sent, the text kept in the input.
 typeAndSend('plan the week');
 ok('mismatch: the first message shows the account card', cardOn());
 ok('mismatch: the card says both accounts in the exact sentence', ($('accountCardText')||{}).textContent===`This browser is signed in to claude.ai as ${A}, but chats run on Claude Code as ${B}.`, ($('accountCardText')||{}).textContent);
 ok('mismatch: the card offers Use <B> for this chat, or Open Accounts', ($('accountUse')||{}).textContent===`Use ${B} for this chat` && ($('accountOpen')||{}).textContent==='Open Accounts');
 ok('mismatch: nothing sent, and the message is not in the chat yet', chats().length===c0 && !shown().includes('plan the week'));
 ok('mismatch: the message stays in the input', $('input').value==='plan the week');
 // 2. Use <B> sends the held message; the rest of that chat sends with no card.
 press('accountUse');
 ok('Use <B>: the held message is sent and the card goes', chats().length===c0+1 && chats()[c0].text==='plan the week' && !cardOn());
 finish();
 typeAndSend('and the day after');
 ok('Use <B>: later messages in that chat send with no card', chats().length===c0+2 && chats()[c0+1].text==='and the day after' && !cardOn());
 finish();
 // 3. New chat asks again.
 newChat();
 typeAndSend('fresh start');
 ok('New chat: the first message of the new chat asks again', cardOn() && chats().length===c0+2);
 // 4. Open Accounts: the Accounts view opens, the text stays in the input, nothing is sent.
 press('accountOpen');
 ok('Open Accounts: Profile page opens, card goes, text stays in the input', !$('page-profile').hidden && $('page-chat').hidden && !cardOn() && $('input').value==='fresh start' && chats().length===c0+2);
 w.document.querySelector('.tabs button[data-page="chat"]').click();
 typeAndSend('fresh start');
 ok('back in the chat, sending again asks again', cardOn() && chats().length===c0+2);
 // 5. Matching accounts (case aside), or an unknown email on either side: no card.
 newChat();
 put(panel({email:A},{email:A.toUpperCase()}));
 typeAndSend('same account');
 ok('matching accounts: sent with no card', !cardOn() && chats().length===c0+3);
 finish();
 newChat();
 put(panel({email:A},{}));
 typeAndSend('no code email');
 ok('Claude Code email unknown: sent with no card', !cardOn() && chats().length===c0+4);
 finish();
 newChat();
 put(panel({name:'F'},{email:B}));
 typeAndSend('no account email');
 ok('claude.ai email unknown: sent with no card', !cardOn() && chats().length===c0+5);
 finish();
 console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.log('ERROR',e.stack);process.exit(1)});
