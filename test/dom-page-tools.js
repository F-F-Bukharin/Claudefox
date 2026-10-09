'use strict';
// Page tools against a DOM (jsdom): refs, fill, keys, refusals. Optional DOM test: needs jsdom (npm i --no-save jsdom, or NODE_PATH pointing at one). Skips without it.
let JSDOM;
try { ({ JSDOM } = require('jsdom')); } catch { console.log('SKIP  jsdom not installed'); process.exit(0); }
const EXT = require('path').join(__dirname, '..', 'extension') + '/';
const fs=require('fs'), vm=require('vm');
const src=fs.readFileSync(EXT+'lib/policy.js','utf8')+'\n'+fs.readFileSync(EXT+'lib/tools.js','utf8');
let pass=0,fail=0; const ok=(n,c,x)=>{c?pass++:fail++;console.log((c?'PASS ':'FAIL ')+n+(x?'  '+x:''))};
const html=`<h1>Shop</h1><form id=f><label for=q>Search</label><input id=q name=q>
<input type=password id=pw name=pw><input name=cardnumber autocomplete=cc-number placeholder="Card number">
<input name=otp autocomplete=one-time-code><select id=s><option value=a>Apple</option><option value=b>Banana</option></select>
<textarea id=t></textarea><button id=go>Add to cart</button><a href="/x">Help page</a></form><main>${'Body text. '.repeat(200)}</main>`;
const dom=new JSDOM(html,{url:'https://shop.example/',runScripts:'outside-only'});
const w=dom.window;
w.Element.prototype.getBoundingClientRect=()=>({width:10,height:10});
Object.defineProperty(w.HTMLElement.prototype,'innerText',{get(){return this.textContent}});
w.Element.prototype.scrollIntoView=()=>{};
// run cizPageOp inside the jsdom window, the way executeScript does
const ctx=vm.createContext({URL});vm.runInContext(src+';this.cizPageOp=cizPageOp;this.cizSensitiveField=cizSensitiveField;this.cizUrlBlocked=cizUrlBlocked;',ctx);
const run=(op,args)=>w.eval('('+ctx.cizPageOp.toString()+')('+JSON.stringify(op)+','+JSON.stringify(args)+',('+ctx.cizSensitiveField.toString()+'))');
const err=(op,args)=>{try{run(op,args);return null}catch(e){return e.message}};
const r=run('read',{});
ok('read lists heading and controls', /h1: Shop/.test(r.text)&&/textbox "Search"/.test(r.text)&&/button "Add to cart"/.test(r.text), '\n'+r.text);
ok('password marked not fillable', /password field: Claude may not fill/.test(r.text));
const ref=(/textbox "Search".*\[(ref_\d+)\]/.exec(r.text)||[])[1];
const fr=run('fill',{ref,value:'shoes'}); ok('fill by ref', w.document.getElementById('q').value==='shoes', JSON.stringify(fr));
ok('fill refuses password', /password field/.test(err('fill',{selector:'#pw',value:'x'})||''));
ok('fill refuses card', /payment field/.test(err('fill',{selector:'[name=cardnumber]',value:'4111'})||''));
ok('fill refuses 2FA', /2FA/.test(err('fill',{selector:'[name=otp]',value:'123456'})||''));
ok('press refuses typing in password', /password field/.test(err('press',{selector:'#pw',key:'a'})||''));
ok('select by label', run('fill',{selector:'#s',value:'banana'}).selected==='Banana' && w.document.getElementById('s').value==='b');
const f=run('find',{query:'add cart'}); ok('find returns ref', /button "Add to cart".*ref_\d+/.test(f.text), f.text);
let clicked=0; w.document.getElementById('go').addEventListener('click',e=>{clicked++;e.preventDefault()});
const goRef=/\[(ref_\d+)\]/.exec(f.text)[1]; run('click',{ref:goRef}); ok('click by ref', clicked===1);
run('press',{selector:'#t',key:'h'}); run('press',{selector:'#t',key:'i'}); ok('typing into textarea', w.document.getElementById('t').value==='hi');
let submitted=0; w.document.getElementById('f').addEventListener('submit',e=>{submitted++;e.preventDefault()});
run('press',{selector:'#q',key:'Enter'}); ok('Enter submits form', submitted===1);
ok('stale ref error', /gone or the page changed/.test(err('click',{ref:'ref_9999'})||''));
const t=run('text',{max_chars:1000}); ok('page text: markdown of main, word count, continues', t.truncated===true && t.next_start>0 && /About [\d,]+ words/.test(t.text) && /Body text/.test(t.text), t.text.slice(0,120));
const t2=run('text',{max_chars:1000,start_at:t.next_start}); ok('page text: next part has no header', !/About/.test(t2.text) && /Body text/.test(t2.text));
const an=run('analyze',{}); ok('analyze reports outline, forms, notices', /## Outline/.test(an.text) && /## Forms/.test(an.text) && /password field is visible/.test(an.text), an.text.slice(0,200));
ok('selection empty message', /Nothing is selected/.test(run('selection',{}).text));
const tq=w.document.getElementById('q'); tq.value=''; run('type',{selector:'#q',text:'abc'}); ok('type_text types key by key', tq.value==='abc');
ok('type_text refuses password', /password field/.test(err('type',{selector:'#pw',text:'x'})||''));
let hov=0; w.document.getElementById('go').addEventListener('mouseover',()=>hov++); run('hover',{selector:'#go'}); ok('hover sends mouseover', hov===1);
ok('exists by text', run('exists',{text:'add to cart'})===true && run('exists',{text:'nope'})===false);
ok('bad selector message', /valid CSS/.test(err('click',{selector:'##'})||''));
// policy gate used by cizPageTab / navigate / tab_open
for (const [u,b] of [['https://accounts.google.com/signin','y'],['https://www.google.com/ServiceLogin','y'],['https://myaccount.google.com/','y'],['about:config','y'],['file:///C:/x','y'],['https://mail.google.com/mail/u/0/','n'],['https://shop.example/','n']])
  ok('url gate '+u, ctx.cizUrlBlocked(u).blocked===(b==='y'));
// real-click sequence, coordinates, display:contents, media
const seen=[]; const go2=w.document.getElementById('go');
for (const e of ['pointerdown','mousedown','mouseup','click']) go2.addEventListener(e,()=>seen.push(e));
run('click',{selector:'#go'}); ok('click sends pointer and mouse events', ['pointerdown','mousedown','mouseup','click'].every(e=>seen.includes(e)), seen.join(','));
w.document.elementFromPoint=()=>go2; seen.length=0;
const at=run('click',{x:40,y:50}); ok('click by x,y', seen.includes('click') && at.at[0]===40 && at.at[1]===50);
const wrap=w.document.createElement('yt-button'); wrap.style.display='contents'; const inner=w.document.createElement('span'); inner.textContent='Play'; wrap.appendChild(inner); w.document.body.appendChild(wrap);
w.Element.prototype.getBoundingClientRect=function(){ return this===wrap?{width:0,height:0,left:0,top:0}:{width:10,height:10,left:0,top:0}; };
let wc=0; wrap.addEventListener('click',()=>wc++); run('click',{selector:'yt-button'}); ok('display:contents wrapper clickable', wc===1);
const v=w.document.createElement('video'); let played=0; v.play=()=>{played++;Object.defineProperty(v,'paused',{value:false,configurable:true});return Promise.resolve();}; v.pause=()=>{}; w.document.body.appendChild(v);
const mr=run('media',{action:'play'}); ok('media play hits the video', played===1 && mr.paused===false && mr.players===1);
ok('media bad action refused', /action must be/.test(err('media',{action:'explode'})||''));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);
