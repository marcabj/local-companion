const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { parseHTML } = require('linkedom');

test('Listen starts background capture without opening a different view', async () => {
  const { window, document } = parseHTML(fs.readFileSync(require.resolve('../src/index.html'), 'utf8'));
  document.body.classList.add('compact');
  const actions = [];
  window.companion = {
    action: async (name, value) => {
      actions.push(name);
      if (name === 'compact') document.body.classList.toggle('compact', value);
      return { ok: true };
    },
    onState() {}, onLevel() {}, snapshot: async () => ({}),
  };
  const context = vm.createContext({ window, document, console, setTimeout, clearTimeout, setInterval, clearInterval });
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'), 'utf8'), context);
  vm.runInContext('state = { compact: true, listening: false, audioBusy: false };', context);
  await document.getElementById('listen').onclick();
  assert.equal(document.body.classList.contains('compact'), true, 'Listening must not interrupt the current layout');
  assert.equal(document.getElementById('transcript').hidden, true);
  assert.deepEqual(actions,['listen']);
  assert.ok(actions.includes('listen'), 'The real capture action must still run');
});

test('blank input submits latest question and transcript rows submit their selected index', async()=>{
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
 const actions=[];window.companion={action:async(name,value)=>{actions.push({name,value});return {ok:true}},onState(){},onLevel(){},snapshot:async()=>({})};
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
 vm.runInContext("state={busy:false,requesting:false,compact:true};",context);
 await document.getElementById('ask-form').onsubmit({preventDefault(){}});
 assert.equal(actions.find(a=>a.name==='ask').value.kind,'latest');assert.equal(actions.find(a=>a.name==='ask').value.text,'');
 actions.length=0;document.getElementById('transcript-lines').innerHTML='<button data-transcript="3">A question</button>';
 document.getElementById('transcript-lines').onclick({target:document.querySelector('[data-transcript]')});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(actions.find(a=>a.name==='ask').value.transcriptIndex,3);
});

 test('Screen submits the typed prompt with a screenshot action',async()=>{
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
 const actions=[];window.companion={action:async(name,value)=>{actions.push({name,value});return {ok:true}},onState(){},onLevel(){},snapshot:async()=>({})};
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
 vm.runInContext("state={busy:false,requesting:false,compact:true};",context);
 document.getElementById('question').value='Explain this code';await document.getElementById('screen').onclick();
 assert.equal(actions.find(a=>a.name==='ask').value.kind,'screen');assert.equal(actions.find(a=>a.name==='ask').value.text,'Explain this code');
 assert.equal(document.getElementById('question').value,'');
 });


test('privacy button toggles protection without hiding and renders eye or incognito', async () => {
  const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
  const actions=[];
  window.companion={action:async name=>{actions.push(name);return {ok:true}},onState(){},onLevel(){},snapshot:async()=>({})};
  const context=vm.createContext({window,document,console,setTimeout,clearTimeout});
  vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
  const button=document.getElementById('privacy-toggle');
  for(const enabled of [false,true,false]) {
    vm.runInContext(`renderPrivacyToggle(${enabled})`,context);
    assert.equal(button.getAttribute('aria-pressed'),String(enabled));
    assert.equal(document.getElementById('privacy-eye').hasAttribute('hidden'),enabled);
    assert.equal(document.getElementById('privacy-incognito').hasAttribute('hidden'),!enabled);
    assert.match(button.getAttribute('aria-label'),enabled?/on/:/off/);
  }
  await button.onclick();
  assert.deepEqual(actions,['toggle-privacy']);
});


test('new turns anchor at the question; streaming and completion preserve the reading position',()=>{
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
 window.companion={action:async()=>({ok:true}),onState(){},onLevel(){},snapshot:async()=>({})};
 const frames=[];const context=vm.createContext({window,document,console,setTimeout,clearTimeout,requestAnimationFrame:fn=>frames.push(fn),marked:{parse:s=>s},DOMPurify:{sanitize:s=>s}});
 const content=document.getElementById('content');content.scrollHeight=3000;content.clientHeight=400;content.scrollTop=0;
 window.HTMLElement.prototype.getBoundingClientRect=function(){return {top:this===content?0:806-content.scrollTop}};
 vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
 vm.runInContext("state={compact:false}; fixture={session:{id:'one',messages:[{role:'user',text:'Question'},{role:'assistant',text:'',state:'working'}]},preferences:{}};renderMessages(fixture)",context);
 while(frames.length)frames.shift()();assert.equal(content.scrollTop,800,'new question is positioned at the top');
 assert.ok(document.querySelector('[aria-label="Loading"]'));
 assert.equal(document.querySelector('[data-copy]'),null);
 const user=document.querySelector('.message.user');
 content.scrollTop=120;content.scrollHeight=3500;
 vm.runInContext("fixture.session.messages[1].text='First part and the next streamed words';renderMessages(fixture)",context);
 while(frames.length)frames.shift()();assert.equal(content.scrollTop,120,'streaming must not pull the reader down');
 assert.equal(document.querySelector('.message.user'),user,'earlier message nodes remain stable');
 assert.equal(document.querySelector('[data-copy]'),null,'copy waits for completion');
 assert.equal(document.getElementById('jump-latest').hidden,false);
 vm.runInContext("fixture.session.messages[1].state='complete';renderMessages(fixture)",context);
 assert.equal(content.scrollTop,120);assert.ok(document.querySelector('[aria-label="Copy response"]'));
 assert.ok(document.querySelector('.response-more [data-retry]'));
 vm.runInContext("fixture.session.messages.push({role:'user',text:'Next question'},{role:'assistant',text:'',state:'working'});renderMessages(fixture)",context);
 while(frames.length)frames.shift()();assert.equal(content.scrollTop,800,'the next request brings its question into view');
 assert.equal(document.querySelector('.message.assistant').style.minHeight,'','old answers release reserved viewport space');
 content.scrollHeight=content.scrollTop+content.clientHeight;
 content.dispatchEvent(new window.Event('scroll'));
 assert.equal(document.getElementById('jump-latest').hidden,true);
 vm.runInContext("showView('transcript')",context);
 assert.equal(document.getElementById('jump-latest').hidden,true);
});

test('screen context is a hover preview on the answer and survives streaming updates',()=>{
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));
 window.companion={action:async()=>({ok:true}),onState(){},onLevel(){},snapshot:async()=>({})};
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout,marked:{parse:s=>s},DOMPurify:{sanitize:s=>s}});
 vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
 vm.runInContext("state={compact:false,session:{id:'screen',messages:[{role:'user',text:'Solve this',image:'data:image/png;base64,AA=='},{role:'assistant',text:'',state:'working'}]},preferences:{}};renderMessages(state)",context);
 assert.equal(document.querySelector('#messages img'),null,'screenshots do not take conversation space');
 const trigger=document.querySelector('.message.assistant [data-screen]');assert.equal(trigger.textContent,'Viewed screen');
 vm.runInContext("state.session.messages[1].text='The solution';renderMessages(state)",context);
 assert.equal(document.querySelector('[data-screen]'),trigger);
 vm.runInContext("state.session={id:'new',messages:[]};renderMessages(state)",context);
 assert.equal(document.getElementById('messages').children.length,0);assert.equal(document.getElementById('screen-preview').hidden,true);
});

test('combined shortcut command submits the composer text with the explicit combined action',async()=>{
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/index.html'),'utf8'));const actions=[];let command;
 window.companion={action:async(name,value)=>{actions.push({name,value});return {ok:true}},onCommand:fn=>command=fn,onState(){},onLevel(){},snapshot:async()=>({})};
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout});vm.runInContext(fs.readFileSync(require.resolve('../src/renderer.js'),'utf8'),context);
 vm.runInContext('state={busy:false,requesting:false,compact:true}',context);document.getElementById('question').value='Use the diagram to explain his question';
 command('screen-transcript');await new Promise(resolve=>setImmediate(resolve));
 assert.equal(actions.find(a=>a.name==='ask').value.kind,'screen-transcript');assert.equal(actions.find(a=>a.name==='ask').value.text,'Use the diagram to explain his question');
 assert.equal(document.getElementById('question').value,'');
});
