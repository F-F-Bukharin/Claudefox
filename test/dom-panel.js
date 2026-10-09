'use strict';
// The real panel.html/panel.js in jsdom: setup guide, model button, file tools, chat stream. Optional DOM test: needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs=require('fs');
const dir=EXT;
const html=fs.readFileSync(dir+'panel.html','utf8').replace(/<script src="panel.js"><\/script>/,'');
const dom=new JSDOM(html,{runScripts:'outside-only',pretendToBeVisual:true});
const w=dom.window; const sent=[]; let onMsg;
w.browser={runtime:{connect:()=>({postMessage:m=>sent.push(m),onMessage:{addListener:f=>onMsg=f}}),getManifest:()=>({version:'0.4.0'})},
 storage:{session:{get:async()=>({}),set:async()=>{}}},
 tabs:{query:async()=>[{title:'T',url:'https://x'}],onActivated:{addListener(){}},onUpdated:{addListener(){}}}};
w.eval(fs.readFileSync(dir+'panel.js','utf8'));
const $=id=>w.document.getElementById(id);
let pass=0,fail=0;const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(x?'  '+x:''))};
const base={agent:'active',signedIn:false,native:'missing',claude:null,debugPort:'off',pending:0,chatModel:'speed',filesMode:'read',filesFolder:''};
(async()=>{
 await new Promise(r=>setTimeout(r,50));
 onMsg({type:'state',state:base,log:[]});
 ok('guide shows, step 1 current', !$('setup').hidden && /Install the helper/.test($('setup').querySelector('.current').textContent), $('emptyText').textContent);
 onMsg({type:'state',state:{...base,native:'connected',claude:{installed:true,loggedIn:true,email:'personalworksacc@gmail.com',plan:'pro'}},log:[]});
 ok('step 4 current when only sign-in left', /Sign in to claude.ai/.test($('setup').querySelector('.current').textContent));
 $('setup').querySelector('.step-btn').click();
 ok('sign-in button sends signIn', sent.some(m=>m.type==='signIn'));
 const ready={...base,signedIn:true,account:{email:'personalworksacc@gmail.com',name:'F',uuid:'u'},native:'connected',hostVersion:'0.4.0',claude:{installed:true,loggedIn:true,email:'personalworksacc@gmail.com',plan:'pro'}};
 onMsg({type:'state',state:ready,log:[]});
 ok('guide hidden when ready', $('setup').hidden && $('emptyTitle').textContent==='What should I do in Zen?');
 ok('claude row ok, no mismatch', $('claudeVal').textContent==='signed in · personalworksacc@gmail.com' && /ok/.test($('claudeDot').className));
 onMsg({type:'state',state:{...ready,claude:{...ready.claude,email:'felpecabezaz@gmail.com'}},log:[]});
 ok('mismatch flagged', /not personalworksacc/.test($('claudeVal').textContent) && /warn/.test($('claudeDot').className));
 onMsg({type:'state',state:ready,log:[]});
 ok('model button Speed', $('modelBtn').textContent==='Speed' && !$('modelBtn').classList.contains('quality'));
 $('modelBtn').click(); ok('click asks for quality', sent.some(m=>m.type==='setModel'&&m.value==='quality'));
 onMsg({type:'state',state:{...ready,chatModel:'quality'},log:[]});
 ok('model button Quality styled', $('modelBtn').textContent==='Quality' && $('modelBtn').classList.contains('quality'));
 ok('files note off', /Off/.test($('filesNote').textContent));
 $('filesFolder').value='C:\\notes'; $('filesToggle').checked=true; $('filesToggle').dispatchEvent(new w.Event('change'));
 ok('toggle sends folder and mode', sent.some(m=>m.type==='setFiles'&&m.value&&m.folder==='C:\\notes'&&m.mode==='read'));
 onMsg({type:'state',state:{...ready,filesEnabled:true,filesMode:'write',filesFolder:'C:\\notes'},log:[]});
 ok('write note warns', $('filesNote').classList.contains('warnnote') && /no undo/.test($('filesNote').textContent));
 // chat
 $('input').value='hi'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const chatMsg=sent.find(m=>m.type==='chat'); ok('chat sent', chatMsg && chatMsg.text==='hi');
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'tool',name:'tabs_list',input:'{}'}});
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'tool_result',error:false,text:'ok'}});
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'text',text:'You have 3 tabs.'}});
 await new Promise(r=>setTimeout(r,60));
 ok('stream renders text and tool chip', /You have 3 tabs/.test($('messages').textContent) && $('messages').querySelector('.step.ok'));
 ok('send disabled while answering', $('sendBtn').disabled===true);
 onMsg({type:'chatDone',id:chatMsg.id,ok:false,error:'Claude AI usage limit reached',limit:true});
 const btn=[...$('messages').querySelectorAll('button')].find(b=>/another account/.test(b.textContent));
 ok('limit shows switch button', !!btn && $('sendBtn').disabled===false);
 btn.click(); ok('switch button sends switchAccount', sent.some(m=>m.type==='switchAccount'));
 // formatting, copy, selection-safe rendering
 $('input').value='fmt'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const f2=sent.filter(m=>m.type==='chat').pop();
 onMsg({type:'chatEvent',id:f2.id,event:{kind:'text',text:'**Bold** and `code`\n- item'}});
 onMsg({type:'chatDone',id:f2.id,ok:true});
 const last=[...$('messages').querySelectorAll('.msg.assistant')].pop();
 ok('bold and code rendered, no raw markers', last.querySelector('strong')?.textContent==='Bold' && last.querySelector('code')?.textContent==='code' && !/\*\*/.test(last.textContent) && /• item/.test(last.textContent));
 ok('copy button on finished reply', !!last.querySelector('button.copy'));
 const before=last; onMsg({type:'state',state:{...ready,chatModel:'quality'},log:[]});
 ok('state updates do not rebuild the chat (keeps selection)', before.isConnected);
 console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.log('ERROR',e.stack);process.exit(1)});
