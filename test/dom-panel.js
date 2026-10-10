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
w.eval(fs.readFileSync(dir+'lib/markdown.js','utf8')+'\n;window.cizMarkdown=cizMarkdown;'); w.eval(fs.readFileSync(dir+'lib/wall.js','utf8')); w.eval(fs.readFileSync(dir+'panel.js','utf8'));
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
 ok('empty chat uses the centred layout', $('page-chat').classList.contains('is-empty'));
 ok('starter chips above the text bar: summarize, tabs, help', [...w.document.querySelectorAll('.starters .chip')].map(b=>b.dataset.fill).join('|') === 'Summarize this page|/tabs|/help' && $('composer').parentElement.firstElementChild.classList.contains('starters'));
 // the "/" menu: typing / lists the commands, narrows as you type, Enter runs the highlighted one, Escape closes it
 const slashTyped=v=>{ $('input').value=v; $('input').dispatchEvent(new w.Event('input')); };
 const slashKey=k=>$('input').dispatchEvent(new w.KeyboardEvent('keydown',{key:k,bubbles:true}));
 const slashNames=()=>[...$('slashMenu').querySelectorAll('button')].map(b=>b.dataset.cmd);
 slashTyped('/');
 ok('slash menu: / lists the nine commands, help first', !$('slashMenu').hidden && slashNames().length===9 && slashNames()[0]==='help', slashNames().join(','));
 slashTyped('/ta');
 ok('slash menu: /ta narrows to tabs', slashNames().join(',')==='tabs', slashNames().join(','));
 slashTyped('/'); slashKey('ArrowDown'); slashKey('Enter');
 ok('slash menu: Enter runs the highlighted command (tabs)', [...$('messages').querySelectorAll('.msg.user .body')].pop().textContent.trim()==='/tabs' && $('input').value==='' && $('slashMenu').hidden);
 slashTyped('/'); slashKey('Escape');
 ok('slash menu: Escape closes it and keeps the text', $('slashMenu').hidden && $('input').value==='/');
 slashTyped('/help'); slashKey('Enter');
 ok('/help lists every command', /\/screenshot: Screenshot of this tab/.test($('messages').textContent) && /\/improve: Improve Claude in Zen/.test($('messages').textContent));
 ok('claude row ok, no mismatch', $('claudeVal').textContent==='signed in · personalworksacc@gmail.com' && /ok/.test($('claudeDot').className));
 onMsg({type:'state',state:{...ready,claude:{...ready.claude,email:'felpecabezaz@gmail.com'}},log:[]});
 ok('mismatch flagged', /not personalworksacc/.test($('claudeVal').textContent) && /warn/.test($('claudeDot').className));
 onMsg({type:'state',state:ready,log:[]});
 ok('Speed shown by default, + off', $('modeLabel').textContent==='Speed' && $('modeSeg').dataset.mode==='speed' && $('modeBtn').getAttribute('aria-label')==='Speed. Switch to Quality.' && $('plusBtn').getAttribute('aria-pressed')==='false' && !!$('plusBtn').querySelector('svg'));
 $('modeBtn').click(); ok('Speed click asks for Quality', sent.some(m=>m.type==='setModel'&&m.value==='quality'));
 onMsg({type:'state',state:{...ready,chatModel:'quality'},log:[]});
 ok('Quality shown, model line says Opus', $('modeLabel').textContent==='Quality' && $('modeSeg').dataset.mode==='quality' && $('modelLine').textContent==='Opus 5.5 · high effort');
const nFlipQ = sent.filter(m=>m.type==='setModel').length; $('modeBtn').click(); ok('Quality click flips back to Speed', sent.filter(m=>m.type==='setModel').length===nFlipQ+1 && sent.filter(m=>m.type==='setModel').pop().value==='speed');
 ok('files note off', /Off/.test($('filesNote').textContent));
 $('filesFolder').value='C:\\notes'; $('filesToggle').checked=true; $('filesToggle').dispatchEvent(new w.Event('change'));
 ok('toggle sends folder and mode', sent.some(m=>m.type==='setFiles'&&m.value&&m.folder==='C:\\notes'&&m.mode==='read'));
 onMsg({type:'state',state:{...ready,filesEnabled:true,filesMode:'write',filesFolder:'C:\\notes'},log:[]});
 ok('write note warns', $('filesNote').classList.contains('warnnote') && /no undo/.test($('filesNote').textContent));
 // Settings > Saving files: Download now is the default; a click asks the add-on to store, and a stored file is named in the chat
 const outBtn=v=>w.document.querySelector('#outputSeg button[data-value="'+v+'"]');
 ok('saving files: Download now is checked first', [...w.document.querySelectorAll('#outputSeg button')].map(b=>b.dataset.value).join('|')==='download|store' && outBtn('download').getAttribute('aria-checked')==='true' && outBtn('store').getAttribute('aria-checked')==='false');
 const filesBefore=sent.filter(m=>m.type==='setFiles').length;
 outBtn('store').click();
 ok('saving files: a click asks the add-on to store, and leaves file access alone', sent.some(m=>m.type==='setOutput'&&m.value==='store') && sent.filter(m=>m.type==='setFiles').length===filesBefore);
 onMsg({type:'state',state:{...ready,outputMode:'store'},log:[]});
 ok('saving files: store is checked and explained', outBtn('store').getAttribute('aria-checked')==='true' && outBtn('download').getAttribute('aria-checked')==='false' && /beside the mods folder/.test($('outputNote').textContent));
 onMsg({type:'outputSaved',name:'chart.png',path:'C:\\Zen\\extension\\output\\chart.png'});
 ok('saving files: the chat names the stored file', /Stored chart\.png in the output folder/.test($('messages').textContent));
 onMsg({type:'state',state:ready,log:[]});
 ok('saving files: back to Download now', outBtn('download').getAttribute('aria-checked')==='true');
 // chat
 $('input').value='hi'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const chatMsg=sent.find(m=>m.type==='chat'); ok('chat sent', chatMsg && chatMsg.text==='hi');
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'tool',name:'tabs_list',input:'{}'}});
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'tool_result',error:false,text:'ok'}});
 onMsg({type:'chatEvent',id:chatMsg.id,event:{kind:'text',text:'You have 3 tabs.'}});
 await new Promise(r=>setTimeout(r,60));
 ok('stream renders text and a progress bar, no tool chips', /You have 3 tabs/.test($('messages').textContent) && $('messages').querySelector('.progress .pfill') && !$('messages').querySelector('.step'));
 ok('a chat with messages leaves the empty layout', !$('page-chat').classList.contains('is-empty') && $('emptyState').hidden);
 ok('send disabled while answering', $('sendBtn').disabled===true);
 onMsg({type:'chatDone',id:chatMsg.id,ok:false,error:'Claude AI usage limit reached',limit:true});
 const btn=[...$('messages').querySelectorAll('button')].find(b=>/another account/.test(b.textContent));
 ok('limit shows switch button', !!btn && $('sendBtn').disabled===false);
 btn.click(); ok('switch button sends switchAccount', sent.some(m=>m.type==='switchAccount'));
 onMsg({type:'state',state:{...ready,chatModel:'speed',chatPlus:false},log:[]});
 ok('Speed shown, + not pressed', $('modeLabel').textContent==='Speed' && $('plusBtn').getAttribute('aria-pressed')==='false');
 $('plusBtn').click(); ok('+ turns Speed Plus on', sent.some(m=>m.type==='setPlus'&&m.value===true));
 onMsg({type:'state',state:{...ready,chatModel:'speed',chatPlus:true},log:[]});
 ok('+ pressed, model line says Haiku max effort', $('plusBtn').getAttribute('aria-pressed')==='true' && $('modelLine').textContent==='Haiku 5.5 · max effort');
 $('plusBtn').click(); ok('+ again turns Speed Plus off', sent.filter(m=>m.type==='setPlus').pop().value===false);
 onMsg({type:'state',state:{...ready,chatModel:'quality',chatPlus:true},log:[]});
 ok('Quality shown, + hidden', $('modeLabel').textContent==='Quality' && $('modeBtn').getAttribute('aria-label')==='Quality. Switch to Speed.' && $('plusBtn').hidden===true);
  const nFlipS = sent.filter(m=>m.type==='setModel').length; $('modeBtn').click(); ok('Quality click flips to Speed', sent.filter(m=>m.type==='setModel').length===nFlipS+1 && sent.filter(m=>m.type==='setModel').pop().value==='speed'); onMsg({type:'state',state:{...ready,chatModel:'speed',chatPlus:true},log:[]}); ok('Back in Speed, + shows and stays on', $('plusBtn').hidden===false && $('plusBtn').getAttribute('aria-pressed')==='true');
 // dark mode: the switch at the top of Settings flips the theme
 ok('dark mode is the first row of Settings', $('page-settings').querySelector('.row label')?.textContent==='Dark mode' && $('themeToggle').closest('.card')===$('page-settings').querySelector('.card'));
 $('themeToggle').checked=true; $('themeToggle').dispatchEvent(new w.Event('change'));
 ok('dark mode on sets the dark theme', w.document.documentElement.dataset.theme==='dark');
 $('themeToggle').checked=false; $('themeToggle').dispatchEvent(new w.Event('change'));
 ok('wallpaper: four choices, Default checked', [...w.document.querySelectorAll('.wallseg button')].map(b=>b.dataset.wall).join('|')==='default|solid|gradient|picture' && w.document.querySelector('.wallseg button[data-wall="default"]').getAttribute('aria-checked')==='true');
 w.document.querySelector('.wallseg button[data-wall="solid"]').click();
 ok('wallpaper: Solid marks the page and shows only the colour', w.document.documentElement.dataset.wall==='solid' && !$('wallSolid').hidden && $('wallGradient').hidden && $('wallPicture').hidden);
 $('wallColor').value='#112233'; $('wallColor').dispatchEvent(new w.Event('input'));
 ok('wallpaper: the colour input sets the page colour', w.document.documentElement.style.getPropertyValue('--wall-color').trim()==='#112233', w.document.documentElement.style.getPropertyValue('--wall-color'));
 ok('wallpaper: a dark colour sets white page text', w.document.documentElement.dataset.wallInk==='light', w.document.documentElement.dataset.wallInk);
 $('wallColor').value='#f6e7c1'; $('wallColor').dispatchEvent(new w.Event('input'));
 ok('wallpaper: a cream colour sets black page text', w.document.documentElement.dataset.wallInk==='dark', w.document.documentElement.dataset.wallInk);
 w.document.querySelector('.wallseg button[data-wall="gradient"]').click();
 ok('wallpaper: Gradient shows the two colours', w.document.documentElement.dataset.wall==='gradient' && !$('wallGradient').hidden && $('wallSolid').hidden);
 w.document.querySelector('.wallseg button[data-wall="picture"]').click();
 ok('wallpaper: Picture shows Choose and Remove', w.document.documentElement.dataset.wall==='picture' && !$('wallPicture').hidden && !!$('wallPick') && !!$('wallClear'));
 $('wallClear').click();
 ok('wallpaper: Remove picture goes back to Default', w.document.documentElement.dataset.wall==='default' && w.document.querySelector('.wallseg button[data-wall="default"]').getAttribute('aria-checked')==='true');
 ok('dark mode off sets the light theme', w.document.documentElement.dataset.theme==='light');
 ok('wallpaper: Default takes the ink off the page', !w.document.documentElement.dataset.wallInk);
// formatting, copy, selection-safe rendering
 $('input').value='fmt'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const f2=sent.filter(m=>m.type==='chat').pop();
 onMsg({type:'chatEvent',id:f2.id,event:{kind:'meta',model:'claude-haiku-5-5',effort:'max'}});
 onMsg({type:'chatEvent',id:f2.id,event:{kind:'text',text:'**Bold** and `code`\n- item'}});
 onMsg({type:'chatDone',id:f2.id,ok:true});
 const last=[...$('messages').querySelectorAll('.msg.assistant')].pop();
 ok('bold and code rendered, no raw markers', last.querySelector('strong')?.textContent==='Bold' && last.querySelector('code')?.textContent==='code' && !/\*\*/.test(last.textContent) && last.querySelector('li')?.textContent==='item');
 ok('copy button on finished reply', !!last.querySelector('button.copy'));
 ok('reply shows model and effort it ran with', last.querySelector('.ran')?.textContent==='Haiku 5.5 · max effort' && last.querySelector('.ran.plus'));
 // progress plan, links, files
 $('input').value='plan'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 const f3=sent.filter(m=>m.type==='chat').pop();
 onMsg({type:'chatEvent',id:f3.id,event:{kind:'progress',steps:['Search','Pick','Post'],done:1,note:'Picking a video'}});
 await new Promise(r=>setTimeout(r,60));
 ok('plan shows step label', /Step 2 of 3 · Picking a video/.test($('messages').textContent));
 onMsg({type:'chatEvent',id:f3.id,event:{kind:'text',text:'See [the video](https://youtube.com/watch?v=1) and [your tab](zen://tab/7) and [Notes.md](zen://file/fabc1)'}});
 onMsg({type:'fileCreated',file:{id:'fabc1',name:'Notes.md',size:2048,msg:f3.id}});
 onMsg({type:'chatEvent',id:f3.id,event:{kind:'stats',ms:4200,turns:3}});
 onMsg({type:'chatDone',id:f3.id,ok:true});
 const m3=[...$('messages').querySelectorAll('.msg.assistant')].pop();
 const links=[...m3.querySelectorAll('a')];
 links[0].click(); links[1].click(); links[2].click();
 ok('links open url, switch tab, open file', sent.some(m=>m.type==='openLink'&&/youtube/.test(m.url)) && sent.some(m=>m.type==='openTab'&&m.id===7) && sent.some(m=>m.type==='openFile'&&m.id==='fabc1'));
 const card=m3.querySelector('.filecard'); ok('file card with Download', card && /Notes\.md/.test(card.textContent));
 [...card.querySelectorAll('button')].find(b=>b.textContent==='Download').click();
 ok('download asks the add-on', sent.some(m=>m.type==='downloadFile'&&m.id==='fabc1'));
 ok('finished answer shows done line with time', /Done in 4\.2 s/.test([...$('messages').querySelectorAll('.msg.assistant')].pop().querySelector('.donebar')?.textContent||''));
 const before=[...$('messages').querySelectorAll('.msg.assistant')].pop(); onMsg({type:'state',state:{...ready,chatModel:'quality'},log:[]});
 ok('state updates do not rebuild the chat (keeps selection)', before.isConnected);
  // top tabs: the highlight sits under the selected tab and slides when the tab changes
 Object.defineProperty(w.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return this.tagName==='BUTTON'?100:0}});
 Object.defineProperty(w.HTMLElement.prototype,'offsetLeft',{configurable:true,get(){return this.tagName==='BUTTON'?[...this.parentElement.querySelectorAll('button')].indexOf(this)*100:0}});
 w.document.querySelector('.tabs button[data-page="settings"]').click();
 ok('tab highlight moves under Settings', $('tabThumb').style.transform==='translateX(200px)' && $('tabThumb').style.width==='100px', $('tabThumb').style.transform);
 w.document.querySelector('.tabs button[data-page="chat"]').click();
 ok('tab highlight slides back to Claude', $('tabThumb').style.transform==='translateX(0px)' && $('tabThumb').classList.contains('animate'));
// Unsafe mode: turning it on asks first; the badge and the Google row follow the state
 onMsg({type:'state',state:{...ready,unsafe:false},log:[]});
 const mark=sent.length;
 $('unsafeToggle').checked=true; $('unsafeToggle').dispatchEvent(new w.Event('change'));
 ok('unsafe asks before turning on', !$('unsafeConfirm').hidden && !$('unsafeToggle').checked && !sent.slice(mark).some(m=>m.type==='setUnsafe'));
 $('unsafeNo').click();
 ok('unsafe cancel sends nothing', $('unsafeConfirm').hidden && !$('unsafeToggle').checked && !sent.slice(mark).some(m=>m.type==='setUnsafe'));
 $('unsafeToggle').checked=true; $('unsafeToggle').dispatchEvent(new w.Event('change')); $('unsafeYes').click();
 ok('unsafe confirm sends setUnsafe on', sent.slice(mark).some(m=>m.type==='setUnsafe'&&m.value===true));
 onMsg({type:'state',state:{...ready,unsafe:true},log:[]});
 ok('badge and Google row show Unsafe mode', !$('unsafeBadge').hidden && $('googleVal').textContent==='allowed (Unsafe mode)' && $('unsafeToggle').checked===true);
 $('unsafeToggle').checked=false; $('unsafeToggle').dispatchEvent(new w.Event('change'));
 ok('turning it off needs no question', sent.some(m=>m.type==='setUnsafe'&&m.value===false) && $('unsafeConfirm').hidden);
 onMsg({type:'state',state:{...ready,unsafe:false},log:[]});
 ok('badge hidden and Google row back to hands-off when off', $('unsafeBadge').hidden && $('googleVal').textContent==='always hands-off');
 // Tools and plugins card: essentials first, local tools ask first, sign-in from the row
 const tools={busy:null,scanned:1,checked:0,
  plugins:[{id:'vidiq@synced',label:'vidIQ',version:'0.1.6',scope:'synced',skills:true,local:false,recommended:true,on:true,status:'needs-auth',servers:[{name:'plugin:vidiq:vidiq',label:'vidiq',status:'needs-auth',transport:'http'}]},
   {id:'caveman@x',label:'caveman',version:'1.1.2',scope:'user',skills:true,local:false,recommended:true,on:true,status:'none',servers:[]},
   {id:'desktop-commander@synced',label:'Desktop Commander',version:'0.2.0',scope:'synced',skills:false,local:true,recommended:false,on:false,status:'unknown',servers:[{name:'plugin:desktop-commander:desktop-commander',label:'desktop-commander',status:'unknown',transport:'stdio',local:true}]}],
  connectors:[],added:[{name:'my-api',label:'my-api',status:'connected',transport:'http',target:'https://example.com/mcp',on:true}]};
 onMsg({type:'state',state:{...ready,tools},log:[]});
 const rows=[...$('toolsList').querySelectorAll('.trow')];
 const groups=[...$('toolsList').querySelectorAll('.tgroup')].map(g=>g.textContent);
 ok('tools: groups in order, essentials on top', groups.join('|')==='Recommended|Plugins|claude.ai connectors|Added by you' && /vidIQ/.test(rows[0].textContent) && rows[0].querySelector('.switch').checked, groups.join('|'));
 ok('tools: connectors hint before the first check', /Press check/.test($('toolsList').textContent));
 const vrow=rows[0]; const signBtn=[...vrow.querySelectorAll('button')].find(b=>b.textContent==='sign in');
 ok('tools: vidIQ shows needs sign-in with a button', /needs sign-in/.test(vrow.textContent) && !!signBtn);
 signBtn.click(); ok('tools: sign in asks the helper for that server', sent.some(m=>m.type==='toolSignIn'&&m.name==='plugin:vidiq:vidiq'));
 const drow=rows.find(r=>/Desktop Commander/.test(r.textContent)); const dsw=drow.querySelector('.switch');
 const mk=sent.length; dsw.checked=true; dsw.dispatchEvent(new w.Event('change'));
 ok('tools: a local tool asks before turning on', !$('toolConfirm').hidden && /runs programs on this PC/.test($('toolConfirmText').textContent) && !sent.slice(mk).some(m=>m.type==='toolSet'));
 $('toolYes').click(); ok('tools: confirm turns it on', sent.slice(mk).some(m=>m.type==='toolSet'&&m.kind==='plugin'&&m.id==='desktop-commander@synced'&&m.value===true));
 const csw=rows[1].querySelector('.switch'); csw.checked=false; csw.dispatchEvent(new w.Event('change'));
 ok('tools: switching off needs no question', sent.some(m=>m.type==='toolSet'&&m.id==='caveman@x'&&m.value===false));
 $('toolsCheck').click(); ok('tools: check asks the helper', sent.some(m=>m.type==='toolsCheck'));
 $('addName').value='my-mcp'; $('addTarget').value='https://mcp.example.com/mcp'; $('addBtn').click();
 ok('tools: add by address sends name and target, on', sent.some(m=>m.type==='toolAdd'&&m.name==='my-mcp'&&m.target==='https://mcp.example.com/mcp'&&m.on===true));
 $('pluginSpec').value='caveman@anthropic-plugin-directory'; $('pluginBtn').click();
 ok('tools: install plugin sends the spec', sent.some(m=>m.type==='pluginInstall'&&m.spec==='caveman@anthropic-plugin-directory'));
 // Profile: accounts list, Add account, Remove asks first; Permissions sit at the bottom of Profile
 const acctState={...ready,tools:undefined,accounts:[{id:'a1',email:'personalworksacc@gmail.com',plan:'pro',org:'',loggedIn:true,active:true},{id:'a2',email:'felpecabezaz@gmail.com',plan:'pro',org:'',loggedIn:true,active:false},{id:'a3',email:'old@example.com',plan:'',org:'',loggedIn:false,active:false}]};
 onMsg({type:'state',state:acctState,log:[]});
 const arows=[...$('acctList').querySelectorAll('.acctcard')]; ok('each account is its own card, with real buttons', arows.length===3 && arows.every(c=>c.classList.contains('card')) && arows.every(c=>[...c.querySelectorAll('.aacts button')].every(b=>!b.classList.contains('link'))));
 ok('accounts: one row per account, the active one says In use', arows.length===3 && /In use/.test(arows[0].textContent) && !/In use/.test(arows[1].textContent));
 ok('accounts: a signed-out account offers Sign in', /Sign in/.test(arows[2].textContent) && /signed out/.test(arows[2].textContent));
 const mA=sent.length;
 [...arows[1].querySelectorAll('button')].find(b=>b.textContent==='Use').click();
 ok('accounts: Use switches the chat to that account', sent.slice(mA).some(m=>m.type==='accountUse'&&m.id==='a2'));
 [...arows[2].querySelectorAll('button')].find(b=>b.textContent==='Sign in').click();
 ok('accounts: Sign in asks for that account', sent.slice(mA).some(m=>m.type==='accountSignIn'&&m.id==='a3'));
 $('accountAdd').click(); ok('accounts: Add account opens a sign-in', sent.slice(mA).some(m=>m.type==='accountAdd'));
 [...arows[1].querySelectorAll('.aacts button')].find(b=>b.textContent==='Remove').click();
 ok('accounts: Remove asks first, inside its own card', !arows[1].querySelector('.confirm').hidden && /Remove felpecabezaz/.test(arows[1].querySelector('.confirm').textContent) && !sent.slice(mA).some(m=>m.type==='accountRemove'));
 [...arows[1].querySelectorAll('.confirm button')].find(b=>b.textContent==='Remove').click(); ok('accounts: Remove confirmed sends accountRemove', sent.slice(mA).some(m=>m.type==='accountRemove'&&m.id==='a2'));
 onMsg({type:'state',state:{...acctState,accountLogin:{id:'a2',isNew:false}},log:[]});
ok('Signing in: the card says so, and the account buttons wait', /Signing in/.test($('acctLogin').textContent) && [...$('acctList').querySelectorAll('.aacts button')].every(b=>b.disabled));
 ok('accounts: a sign-in window shows its note and holds Add account', !$('acctLogin').hidden && $('accountAdd').disabled);
 const mC=sent.length; $('acctLoginCancel').click(); ok('accounts: cancel sign-in sends accountCancel', sent.slice(mC).some(m=>m.type==='accountCancel'));
onMsg({type:'state',state:{...acctState,accountBusy:'a2'},log:[]});
ok('switch: the chat line names the account, and every account button waits', /Switching the chat to felpecabezaz/.test($('acctChat').textContent) && [...$('acctList').querySelectorAll('.aacts button')].every(b=>b.disabled) && [...$('acctList').querySelectorAll('.aacts button')].some(b=>b.textContent==='Switching…'));
onMsg({type:'state',state:{...acctState,accountNote:{ok:true,text:'The chat now uses felpecabezaz@gmail.com. Your next message runs on it.'}},log:[]});
ok('switch: the result shows in Profile, and the chat line follows the list', !$('acctNote').hidden && $('acctNote').classList.contains('good') && /now uses felpecabezaz/.test($('acctNote').textContent) && /The chat uses personalworksacc/.test($('acctChat').textContent));
onMsg({type:'state',state:{...acctState,accountNote:{ok:false,text:'Claude is still answering. Switch accounts after it finishes.'}},log:[]});
ok('switch: a refusal shows in Profile, not only in the log', $('acctNote').classList.contains('bad') && /still answering/.test($('acctNote').textContent));
onMsg({type:'state',state:{...acctState,accounts:acctState.accounts.map(a=>({...a,active:a.id==='a2'})),account:{email:'personalworksacc@gmail.com',name:'F',uuid:'u'}},log:[]});
ok('the chat line says when claude.ai is still on another account', $('acctChat').textContent === 'The chat uses felpecabezaz@gmail.com. The add-on is still signed in to claude.ai as personalworksacc@gmail.com; sign out of claude.ai and back in as felpecabezaz@gmail.com, and the add-on follows.');
onMsg({type:'state',state:{...acctState,accounts:acctState.accounts.map(a=>({...a,active:a.id==='a2'})),account:{email:'felpecabezaz@gmail.com',name:'F',uuid:'u'}},log:[]});
ok('the chat line is the plain one once claude.ai is on the same account', $('acctChat').textContent === 'The chat uses felpecabezaz@gmail.com.');
ok('connections: each one has a bold name and a status', w.document.querySelectorAll('.conns .conn-name').length===6 && !!$('claudeVal').textContent);
ok('connections: Claude Code has a detail line', /The chat spends this/.test($('claudeDetail').textContent));
$('switchClaude').click();
ok('Manage accounts opens Profile at the accounts', !$('page-profile').hidden && $('switchClaude').textContent==='Manage accounts');
onMsg({type:'state',state:{...acctState,folderPicking:true,filesFolder:'C:\\Users\\F\\Notes'},log:[]});
ok('Choose folder: the button waits while the folder window is open', $('chooseFolder').disabled && $('chooseFolder').textContent==='Choosing…');
onMsg({type:'state',state:{...acctState,folderPicking:false,filesFolder:'C:\\Users\\F\\Notes'},log:[]});
ok('Choose folder: the folder chosen is shown, and the typed path sits under a disclosure', !$('chooseFolder').disabled && $('folderNow').textContent==='C:\\Users\\F\\Notes' && $('filesFolder').closest('details')!==null && /Type the path instead/.test($('filesFolder').closest('details').querySelector('summary').textContent));
$('chooseFolder').click();
ok('Choose folder sends pickFolder', sent.some(m=>m.type==='pickFolder'));
 ok('Permissions sit at the bottom of Profile, not in Settings', $('page-profile').contains($('filesToggle')) && $('page-profile').contains($('unsafeToggle')) && !$('page-settings').contains($('filesToggle')) && $('page-profile').lastElementChild===$('permCard'));
 ok('Tools and Advanced start closed', $('toolsBody').hidden && $('advancedBody').hidden && $('toolsHead').getAttribute('aria-expanded')==='false' && $('advancedHead').getAttribute('aria-expanded')==='false');
 $('toolsHead').click(); ok('Tools opens on click', !$('toolsBody').hidden && $('toolsHead').getAttribute('aria-expanded')==='true');
 $('toolsHead').click(); ok('Tools closes again', $('toolsBody').hidden);
 $('advancedHead').click(); ok('Advanced holds Panel, Developer and the action log', !$('advancedBody').hidden && ['Panel','Developer','Action log'].every(x=>$('advancedBody').textContent.includes(x)) && $('advancedBody').contains($('log')) && $('advancedBody').contains($('devPing')));
 $('advancedHead').click(); ok('Advanced closes again', $('advancedBody').hidden);
 // composer: + adds files, the small button opens the menu
 w.document.querySelector('.tabs button[data-page="chat"]').click();
 ok('composer: + and the options button sit in the message box', $('composer').querySelector('.attach #attachBtn') && $('composer').querySelector('.attach #moreBtn') && $('composer').firstElementChild.classList.contains('attach'));
 $('moreBtn').click();
 ok('menu opens with the options', !$('moreMenu').hidden && $('moreBtn').getAttribute('aria-expanded')==='true' && /Upload files/.test($('moreMenu').textContent) && /Caveman mode/.test($('moreMenu').textContent));
 $('moreMenu').querySelector('[data-act="caveman"]').click();
 ok('caveman item toggles caveman mode and closes the menu', sent.some(m=>m.type==='setCaveman'&&m.value===true) && $('moreMenu').hidden);
 onMsg({type:'state',state:{...ready,chatModel:'speed',chatPlus:false,caveman:true,tools},log:[]});
 ok('caveman shows in the menu, on the button and in the hint', $('moreMenu').querySelector('[data-act="caveman"]').getAttribute('aria-checked')==='true' && $('moreBtn').classList.contains('on') && /caveman/.test($('modelLine').textContent));
 $('moreBtn').click(); $('moreMenu').querySelector('[data-act="snap"]').click();
 const snapReq=sent.filter(m=>m.type==='snapTab').pop(); ok('screenshot asks the add-on', !!snapReq);
 onMsg({type:'snap',req:snapReq.req,data:'iVBORw0KGgo=',name:'screenshot example.com.png',mime:'image/png'});
 ok('screenshot becomes an attachment chip', $('attachList').querySelectorAll('.attchip').length===1 && /screenshot example\.com\.png/.test($('attachList').textContent));
 const doc=new w.File([new Uint8Array([80,75,3,4,1,2,3])],'Lista 1.docx',{type:'application/vnd.openxmlformats-officedocument.wordprocessingml.document'});
 const pasteEv=new w.Event('paste',{bubbles:true,cancelable:true}); pasteEv.clipboardData={files:[doc],getData:()=>''};
 $('input').dispatchEvent(pasteEv);
 ok('pasting a file adds a chip', $('attachList').querySelectorAll('.attchip').length===2 && /DOCX/.test($('attachList').textContent));
 $('attachList').querySelectorAll('.attchip .ax')[1].click();
 ok('chip × removes the file', $('attachList').querySelectorAll('.attchip').length===1);
 $('input').dispatchEvent(Object.assign(new w.Event('paste',{bubbles:true,cancelable:true}),{clipboardData:{files:[doc],getData:()=>''}}));
 $('input').value='summarize these'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
 await new Promise(r=>setTimeout(r,120));
 const withFiles=sent.filter(m=>m.type==='chat').pop();
 ok('message goes with both files as base64', withFiles.text==='summarize these' && withFiles.attachments.length===2 && withFiles.attachments[0].data==='iVBORw0KGgo=' && withFiles.attachments[1].name==='Lista 1.docx' && withFiles.attachments[1].data==='UEsDBAECAw==', JSON.stringify(withFiles.attachments.map(a=>[a.name,a.data])));
 ok('chips clear after sending; the message lists the files', $('attachList').hidden && /Lista 1\.docx/.test([...$('messages').querySelectorAll('.msg.user')].pop().textContent));
 onMsg({type:'chatEvent',id:withFiles.id,event:{kind:'notice',text:'vidIQ needs you to sign in before Claude can use it.',action:{type:'tool_signin',name:'plugin:vidiq:vidiq',label:'Sign in to vidIQ'}}});
 onMsg({type:'chatEvent',id:withFiles.id,event:{kind:'tool',name:'vidiq_video_transcript',server:'vidIQ',input:'{"video_id":"abc"}'}});
 await new Promise(r=>setTimeout(r,60));
 const nb=[...$('messages').querySelectorAll('.notice button')].pop();
 ok('notice in the reply has a Sign in button', nb && nb.textContent==='Sign in to vidIQ');
 const before2=sent.length; nb.click(); ok('notice button starts the sign-in', sent.slice(before2).some(m=>m.type==='toolSignIn'&&m.name==='plugin:vidiq:vidiq'));
 ok('other servers\' tools get readable labels', /vidIQ: video transcript/.test($('messages').textContent), $('messages').querySelector('.plabel')?.textContent);
// Streaming: each token rebuilds only the reply being written. The messages before it keep their nodes, and a rebuilt
// message does not play its entrance again (the .enter class is set only when a message first appears).
{
  const frame = () => new Promise(r => w.requestAnimationFrame(() => r()));
  if ($('sendBtn').disabled) { const last=sent.filter(m=>m.type==='chat').pop(); onMsg({type:'chatDone',id:last.id,ok:true}); }
  $('input').value='stream check'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
  const sm=sent.filter(m=>m.type==='chat').pop();
  await frame();
  const before=[...$('messages').querySelectorAll('.msg')];
  const replyNode=before[before.length-1];
  ok('a new message is marked to enter once', before[before.length-2].classList.contains('enter') && replyNode.classList.contains('enter'));
  onMsg({type:'chatEvent',id:sm.id,event:{kind:'text',text:'Streaming'}});
  onMsg({type:'chatEvent',id:sm.id,event:{kind:'text',text:' on'}});
  await frame();
  const after=[...$('messages').querySelectorAll('.msg')];
  ok('a streamed token keeps the nodes of the messages before it', after.length===before.length && after.slice(0,-1).every((n,i)=>n===before[i]));
  const rebuilt=after[after.length-1];
  ok('the reply being written shows its new text without entering again', rebuilt!==replyNode && /Streaming on/.test(rebuilt.textContent) && !rebuilt.classList.contains('enter'));
  onMsg({type:'chatDone',id:sm.id,ok:true});
  const done=[...$('messages').querySelectorAll('.msg')];
  ok('finishing the reply leaves the messages before it in place', done.length===before.length && done.slice(0,-1).every((n,i)=>n===before[i]));
}
 {
  // Improve Claude in Zen: the + menu item turns the improve bar on; a send carries improve; the card has Apply and Discard
  const frame2 = () => new Promise(r => w.requestAnimationFrame(() => r()));
  onMsg({type:'state',state:{...ready,chatModel:'speed',chatPlus:false},log:[]});
  const item = w.document.querySelector('#moreMenu [data-act="improve"]');
  ok('the + menu has Improve Claude in Zen, on Opus 5.5', !!item && /Improve Claude in Zen/.test(item.textContent) && /Opus 5\.5/.test(item.textContent));
  $('moreBtn').click(); item.click();
  ok('the improve bar shows, and the panel is marked improving', !$('improveBar').hidden && /Opus 5\.5/.test($('improveBar').textContent) && w.document.body.classList.contains('improving'));
  ok('the improve placeholder is short enough to fit the composer on one line', typeof ($('input') && $('input').placeholder) === 'string' && $('input').placeholder.length <= 30);
  $('input').value = '';
  $('composer').dispatchEvent(new w.Event('submit', {cancelable: true}));
  const im = sent.filter(m => m.type === 'chat').pop();
  ok('an improve message carries improve: true, empty text allowed', !!im && im.improve === true && im.text === '');
  onMsg({type:'chatEvent', id: im.id, event: {kind:'proposal', id:'abc123def456', changed:2, added:3, removed:1,
    files:[{path:'extension/panel.js', status:'modified', added:3, removed:1}, {path:'host/lib/x.js', status:'added', added:4, removed:0}],
    blocked:[], tests:{ok:true, summary:'All test files passed', tail:''}, canApply:true, diff:'--- a/extension/panel.js\n+++ b/extension/panel.js', diffFile:'C:\\x\\changes.diff'}});
  onMsg({type:'chatDone', id: im.id, ok: true});
  await frame2();
  const card = w.document.querySelector('.proposal');
  ok('the card shows the change, the passed tests and an enabled Apply', !!card && /Proposed change: 2 files/.test(card.textContent) && /Tests passed/.test(card.textContent)
    && [...card.querySelectorAll('button')].some(b => b.textContent === 'Apply' && !b.disabled));
  [...card.querySelectorAll('button')].find(b => b.textContent === 'Apply').click();
  ok('Apply sends selfApply with the proposal id', sent.some(m => m.type === 'selfApply' && m.id === 'abc123def456'));
  onMsg({type:'selfResult', id:'abc123def456', ok:true, text:'Applied 2 files.', files:[]});
  await frame2();
  ok('the card then shows the result and no buttons', /Applied 2 files\./.test(w.document.querySelector('.proposal').textContent) && !w.document.querySelector('.proposal .pbtns'));
  $('improveLeave').click();
  ok('Leave hides the bar and the panel is no longer improving', $('improveBar').hidden && !w.document.body.classList.contains('improving'));
}
 {
  // The army: the octopus (Quality only), its card, the model line, and the trail of workers in a reply
  const frame3 = () => new Promise(r => w.requestAnimationFrame(() => r()));
  if ($('sendBtn').disabled) { const last=sent.filter(m=>m.type==='chat').pop(); onMsg({type:'chatDone',id:last.id,ok:true}); }
  onMsg({type:'state',state:{...ready,chatModel:'speed',chatArmy:false},log:[]});
  ok('army: the octopus is hidden in Speed, the + shows', $('armyBtn').hidden===true && $('plusBtn').hidden===false);
  onMsg({type:'state',state:{...ready,chatModel:'quality',chatArmy:false,armyToday:2},log:[]});
  ok('army: the octopus shows in Quality, before the mode button, not pressed', $('armyBtn').hidden===false && $('armyBtn').nextElementSibling===$('plusBtn') && $('armyBtn').getAttribute('aria-pressed')==='false' && $('armyBtn').getAttribute('aria-label')==='Army' && !!$('armyBtn').querySelector('svg'));
  ok('army: the model line without the army is the plain Quality one', $('modelLine').textContent==='Opus 5.5 · high effort');
  $('armyBtn').click();
  ok('army: a click opens the card, sets aria-expanded and focuses the switch, and does not switch the army', !$('armyCard').hidden && $('armyBtn').getAttribute('aria-expanded')==='true' && w.document.activeElement===$('armyToggle') && !sent.some(m=>m.type==='setArmy'));
  ok('army: the runs line for 2 runs, no warning', $('armyRuns').textContent==='Runs today: 2 of 5 recommended.' && !$('armyRuns').classList.contains('warnnote'));
  w.document.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Escape',bubbles:true}));
  ok('army: Esc closes the card and returns focus to the octopus', $('armyCard').hidden && $('armyBtn').getAttribute('aria-expanded')==='false' && w.document.activeElement===$('armyBtn'));
  $('armyBtn').click(); w.document.body.click();
  ok('army: a click outside closes the card', $('armyCard').hidden);
  $('armyBtn').click(); $('armyClose').click();
  ok('army: the close button closes the card', $('armyCard').hidden && w.document.activeElement===$('armyBtn'));
  $('armyBtn').click();
  $('armyToggle').checked=true; $('armyToggle').dispatchEvent(new w.Event('change'));
  ok('army: the switch sends setArmy on', sent.filter(m=>m.type==='setArmy').pop()?.value===true);
  onMsg({type:'state',state:{...ready,chatModel:'quality',chatArmy:true,armyToday:6},log:[]});
  ok('army: aria-pressed and the switch follow chatArmy', $('armyBtn').getAttribute('aria-pressed')==='true' && $('armyToggle').checked===true && !$('armyCard').hidden);
  ok('army: the runs line past 5 warns', $('armyRuns').textContent==="Runs today: 6. That's past the recommended 5, so usage is high." && $('armyRuns').classList.contains('warnnote'));
  ok('army: the model line names the army', $('modelLine').textContent==='Opus 5.5 · max effort · army of 5 Haiku');
  $('armyToggle').checked=false; $('armyToggle').dispatchEvent(new w.Event('change'));
  ok('army: the switch sends setArmy off', sent.filter(m=>m.type==='setArmy').pop()?.value===false);
  onMsg({type:'state',state:{...ready,chatModel:'quality',chatArmy:true,armyToday:6,agent:'stopped'},log:[]});
  ok('army: the switch is disabled while stopped', $('armyToggle').disabled===true);
  onMsg({type:'state',state:{...ready,chatModel:'speed',chatArmy:true},log:[]});
  ok('army: switching to Speed hides the octopus and closes the card', $('armyBtn').hidden && $('armyCard').hidden && $('armyBtn').getAttribute('aria-expanded')==='false' && $('modelLine').textContent==='Haiku 5.5 · high effort');
  onMsg({type:'state',state:{...ready,chatModel:'quality',chatArmy:true,armyToday:6},log:[]});
  $('input').value='compare five shops'; $('composer').dispatchEvent(new w.Event('submit',{cancelable:true}));
  const am=sent.filter(m=>m.type==='chat').pop();
  onMsg({type:'chatEvent',id:am.id,event:{kind:'tool',name:'army_start',input:'{}'}});
  await frame3();
  ok('army: the step label for army_start', /Sending the army/.test($('messages').querySelector('.msg.pending .plabel')?.textContent||''));
  onMsg({type:'chatEvent',id:am.id,event:{kind:'tool_result',error:false,text:'ok'}});
  onMsg({type:'chatEvent',id:am.id,event:{kind:'tool',name:'army_wait',input:'{}'}});
  await frame3();
  ok('army: the step label for army_wait', /Waiting for the army/.test($('messages').querySelector('.msg.pending .plabel')?.textContent||''));
  const wk=(id,state,extra)=>({id,goal:'Price of the X1 at shop '+id,state,tab_id:null,host:'',action:'',steps:0,ms:0,error:'',sources:[],...extra});
  onMsg({type:'chatEvent',id:am.id,event:{kind:'army',run:'r1',round:1,started:true,finished:false,today:6,workers:[
    wk('w1','working',{tab_id:101,host:'shop-a.com',action:'Reading the page: shop-a.com',steps:3}),
    wk('w2','starting'),
    wk('w3','done',{host:'shop-c.com',steps:4,sources:['https://shop-c.com/x1','https://shop-c.com/x1/specs','https://shop-c.com/a','https://shop-c.com/b']}),
    wk('w4','failed',{host:'shop-d.com',error:'The page asked for a sign-in, so the worker stopped.'}),
    wk('w5','stopped',{host:'shop-e.com'})]}});
  await frame3();
  const trail=[...$('messages').querySelectorAll('.msg.assistant')].pop().querySelector('.army-trail');
  const arows=trail?[...trail.querySelectorAll('.arow')]:[];
  ok('army: 5 workers draw 5 rows with the right marks', arows.length===5 && arows.map(r=>r.querySelector('.amark').textContent).join('')==='……✓✕■', arows.map(r=>r.querySelector('.amark').textContent).join(''));
  ok('army: the header counts the done workers', /Army · 1 of 5 done/.test(trail.querySelector('.ahead').textContent));
  ok('army: rows show W1, the host and the action; done says steps; failed shows the error', /W1/.test(arows[0].textContent) && /shop-a\.com/.test(arows[0].textContent) && /Reading the page: shop-a\.com/.test(arows[0].textContent) && /4 steps/.test(arows[2].textContent) && /asked for a sign-in/.test(arows[3].textContent));
  ok('army: a finished row lists up to 3 sources', arows[2].querySelectorAll('.asrc a').length===3 && !arows[0].querySelector('.asrc'));
  const show=arows[0].querySelector('.ashow');
  ok('army: only a working row with a tab has Show', !!show && arows.filter(r=>r.querySelector('.ashow')).length===1);
  const nOpen=sent.length; show.click();
  ok('army: Show sends openTab with the tab id', sent.slice(nOpen).some(m=>m.type==='openTab'&&m.id===101));
  arows[2].querySelector('.asrc a').click();
  ok('army: a source opens through onLink', sent.some(m=>m.type==='openLink'&&m.url==='https://shop-c.com/x1'));
  ok('army: the past-5 notice shows for a started run with today 6', /Army run 6 today: past the recommended 5, so this uses a lot of your plan\./.test([...$('messages').querySelectorAll('.msg.assistant')].pop().querySelector('.notice')?.textContent||''));
  ok('army: the trail sits above the reply text, and the progress bar still shows', !!([...$('messages').querySelectorAll('.msg.assistant')].pop().querySelector('.progress .pfill')));
  onMsg({type:'chatEvent',id:am.id,event:{kind:'army',run:'r1',round:1,started:false,finished:true,workers:[
    wk('w1','done',{host:'shop-a.com',steps:6}),wk('w2','done',{host:'shop-b.com',steps:5}),wk('w3','done',{host:'shop-c.com',steps:4}),
    wk('w4','failed',{host:'shop-d.com',error:'Sign-in page.'}),wk('w5','done',{host:'shop-e.com',steps:2})]}});
  onMsg({type:'chatEvent',id:am.id,event:{kind:'text',text:'Shop C is cheapest.'}});
  onMsg({type:'chatDone',id:am.id,ok:true});
  await frame3();
  const fin=[...$('messages').querySelectorAll('.msg.assistant')].pop();
  ok('army: a finished message shows the collapsed summary line', fin.querySelector('.army-trail .asum')?.textContent.startsWith('Army: 5 workers · 4 done · 1 failed') && !fin.querySelector('.army-trail .arow'), fin.querySelector('.army-trail')?.textContent);
  ok('army: the trail comes before the reply text', !!fin.querySelector('.army-trail') && (fin.querySelector('.army-trail').compareDocumentPosition(fin.querySelector('.body.md')) & 4)!==0);
  fin.querySelector('.army-trail .asum button').click();
  const fin2=[...$('messages').querySelectorAll('.msg.assistant')].pop();
  ok('army: the toggle opens the rows again', fin2.querySelectorAll('.army-trail .arow').length===5);
  fin2.querySelector('.army-trail .asum button').click();
  ok('army: and closes them', [...$('messages').querySelectorAll('.msg.assistant')].pop().querySelectorAll('.army-trail .arow').length===0);
 }
 console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
})().catch(e=>{console.log('ERROR',e.stack);process.exit(1)});
