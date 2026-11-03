const test=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const vm=require('node:vm');
const {parseHTML}=require('linkedom');
const harness=require('./workflow-harness.cjs');

function dashboard(){
 const {window,document}=parseHTML(fs.readFileSync(require.resolve('../src/dashboard.html'),'utf8'));const actions=[];
 window.companion={action:async(name,value)=>{actions.push({name,value});return {ok:true,value:name==='context-text'?'Saved text':undefined}},onState(){},onNavigate(){},snapshot:async()=>({})};
 window.confirm=()=>true;
 const context=vm.createContext({window,document,console,setTimeout,clearTimeout});
 vm.runInContext(fs.readFileSync(require.resolve('../src/dashboard.js'),'utf8'),context);
 const h=harness();
 const fixture=()=>JSON.parse(h.run('JSON.stringify(snapshot())'));
 const render=s=>{context.fixture=s;vm.runInContext('render(fixture)',context);};
 return {window,document,actions,h,fixture,render,context};
}
// LinkeDOM does not implement the browser's select.value setter.
const choose=(el,value)=>Object.defineProperty(el,'value',{configurable:true,value});
// Actions are recorded inside the renderer's VM realm; compare them as plain data.
const last=d=>JSON.parse(JSON.stringify(d.actions.at(-1)));

test('Start lists context with checkboxes and starts or continues the companion',async()=>{
 const d=dashboard();const s=d.fixture();
 s.contextItems=[{id:'cv',kind:'file',name:'resume.pdf',path:'/cv.pdf',chars:4200,enabled:true},{id:'job',kind:'text',name:'Exegy posting',chars:900,enabled:false}];s.contextChars=4200;
 d.render(s);
 const boxes=d.document.querySelectorAll('#start-context [data-toggle]');
 assert.equal(boxes.length,2);assert.equal(boxes[0].hasAttribute('checked'),true);assert.equal(boxes[1].hasAttribute('checked'),false);
 assert.equal(d.document.getElementById('start').textContent,'Start companion');assert.equal(d.document.getElementById('start-new').hidden,true);
 boxes[1].checked=true;
 boxes[1].dispatchEvent(new d.window.Event('change',{bubbles:true}));
 assert.deepEqual(last(d),{name:'update-context',value:{id:'job',enabled:true}});
 await d.document.getElementById('start').onclick();assert.deepEqual(last(d),{name:'start'});
 s.session.messages=[{role:'user',text:'Hi'}];d.render(s);
 assert.equal(d.document.getElementById('start').textContent,'Continue current chat');
 await d.document.getElementById('start-new').onclick();assert.deepEqual(last(d),{name:'start',value:{newChat:true}});
});

test('pasted context is added and edited through the text editor',async()=>{
 const d=dashboard();const s=d.fixture();s.contextItems=[{id:'notes',kind:'text',name:'Projects',chars:10,enabled:true}];d.render(s);
 await d.document.getElementById('add-text').onclick();
 assert.equal(d.document.getElementById('text-editor').hidden,false);
 d.document.getElementById('text-name').value='Exegy posting';d.document.getElementById('text-body').value='Low-latency C++';
 await d.document.getElementById('text-save').onclick();
 assert.deepEqual(last(d),{name:'add-context-text',value:{name:'Exegy posting',text:'Low-latency C++'}});
 assert.equal(d.document.getElementById('text-editor').hidden,true);
 await d.document.getElementById('context-list').onclick({target:d.document.querySelector('[data-edit="notes"]')});
 assert.equal(d.document.getElementById('text-body').value,'Saved text');
 await d.document.getElementById('text-save').onclick();
 assert.equal(d.actions.at(-1).name,'update-context');assert.equal(d.actions.at(-1).value.id,'notes');
});

test('settings provider controls route through app actions while disconnected',async()=>{
 const d=dashboard();const s=d.fixture();s.selectedProvider='claude';s.connected=false;s.status='Claude disconnected';d.render(s);
 assert.equal(d.document.getElementById('reconnect').textContent,'Reconnect Claude');
 assert.equal(d.document.getElementById('claude-login').hidden,false);
 assert.equal(d.document.getElementById('connection').textContent,'Claude disconnected');
 choose(d.document.getElementById('provider'),'codex');await d.document.getElementById('provider').onchange();
 assert.deepEqual(last(d),{name:'provider',value:'codex'});
 await d.document.getElementById('claude-login').onclick();assert.equal(d.actions.at(-1).name,'claude-login');
});

test('built-in modes cannot be deleted; custom modes can',()=>{
 const d=dashboard();const s=d.fixture();d.render(s);
 assert.equal(d.document.getElementById('delete-mode').hidden,true);
 s.modes.push({id:'0f8fad5b-d9cb-469f-a165-70867728950e',name:'Mine',instructions:'',notesTemplate:''});
 choose(d.document.getElementById('mode-select'),s.modes.at(-1).id);d.render(s);d.document.getElementById('mode-select').onchange();
 assert.equal(d.document.getElementById('delete-mode').hidden,false);
});

test('ticked context is sent with requests and unticked context is not',async()=>{
 const h=harness();
 h.run("contextItems=[{id:'cv',kind:'text',name:'Resume',text:'Built a C++ simulator',chars:21,enabled:true},{id:'old',kind:'text',name:'Old notes',text:'Unrelated draft',chars:15,enabled:false}]");
 await h.run("ask({text:'Tell me about yourself'})");
 assert.match(h.calls[0].instructions,/Context: Resume\nBuilt a C\+\+ simulator/);
 assert.doesNotMatch(h.calls[0].instructions,/Unrelated draft/);
 assert.deepEqual(h.run('active().messages[0].context.files'),['Resume']);
 assert.equal(h.calls[0].text,'Tell me about yourself','context stays out of the user turn');
});

test('context over the ticked limit is added unticked and cannot be ticked',async()=>{
 const h=harness();
 h.run("contextItems=[{id:'big',kind:'text',name:'Big',text:'x'.repeat(150000),chars:150000,enabled:true}]");
 await h.run("action('add-context-text',{name:'More',text:'y'.repeat(60000)})");
 assert.equal(h.run('contextItems[1].enabled'),false);assert.match(h.run('problem'),/added unticked/i);
 await assert.rejects(h.run("action('update-context',{id:contextItems[1].id,enabled:true})"),/limited/);
 await h.run("action('update-context',{id:'big',enabled:false})");
 await h.run("action('update-context',{id:contextItems[1].id,enabled:true})");assert.equal(h.run('contextItems[1].enabled'),true);
});

test('Start hides the Dashboard and shows the panel; opening the Dashboard hides the panel',async()=>{
 const h=harness();
 h.run("var shown=[];dashboard={isDestroyed:()=>false,visible:true,isVisible(){return this.visible},show(){this.visible=true;shown.push('dashboard')},hide(){this.visible=false;shown.push('dashboard-hidden')},focus(){},webContents:{send(){}}};win.visible=true;win.isVisible=()=>win.visible;win.hide=()=>{win.visible=false;shown.push('panel-hidden')};win.show=()=>{win.visible=true;shown.push('panel')};app.focus=()=>{}");
 await h.run("action('start')");
 assert.equal(h.run('dashboard.visible'),false);assert.equal(h.run('win.visible'),true);
 await h.run("action('open-dashboard','context')");
 assert.equal(h.run('dashboard.visible'),true);assert.equal(h.run('win.visible'),false);
 h.run("active().messages=[{role:'user',text:'Earlier'}]");const before=h.run('activeId');
 await h.run("action('start',{newChat:true})");
 assert.notEqual(h.run('activeId'),before,'Start a new chat creates a fresh conversation');assert.equal(h.run('win.visible'),true);
});

test('Plain mode sends no companion instructions or context, only the user turn',async()=>{
 const h=harness();
 h.run("contextItems=[{id:'cv',kind:'text',name:'Resume',text:'Built a C++ simulator',chars:21,enabled:true}];modeId='plain';active().transcript=[{source:'Computer',text:'Tell me about yourself',at:1}]");
 await h.run("ask({text:'Help'})");
 assert.equal(h.calls[0].instructions,require('../src/prompts.cjs').PLAIN_INSTRUCTIONS);
 assert.doesNotMatch(h.calls[0].instructions,/simulator|Local Companion|Mode:/);
 assert.match(h.calls[0].text,/Tell me about yourself/);assert.match(h.calls[0].text,/Help$/);
 assert.deepEqual(h.run('active().messages[0].context.files'),[]);
 h.codex.emit('completed',{status:'completed'});await assert.rejects(h.run("action('save-mode',{id:'plain',instructions:'x'})"),/nothing/);
});

test('instructions carry no notes template or disabled-research line; notes requests carry the template',()=>{
 const {defaultModes,buildRequest}=require('../src/prompts.cjs');
 const mode=defaultModes().find(m=>m.id==='general');
 const chat=buildRequest({text:'Hi',session:{transcript:[]},mode});
 assert.doesNotMatch(chat.instructions,/Notes template|Web research is disabled/);
 const notes=buildRequest({kind:'notes',session:{transcript:[{at:1,source:'Me',text:'We ship Friday'}]},mode});
 assert.match(notes.prompt,/Notes template:\nSummary/);
 assert.match(buildRequest({text:'Hi',session:{transcript:[]},mode,preferences:{smart:true}}).instructions,/Web research is enabled/);
});

test('existing saved mode lists gain Plain mode',()=>{
 const {upgradeModes}=require('../src/prompts.cjs');
 assert.ok(upgradeModes([{id:'general',name:'General',instructions:'x'}]).some(m=>m.id==='plain'));
});

test('Codex threads switch off memories, skills, plugins, hooks and collaboration modes',async()=>{
 const {CodexClient}=require('../src/codex.cjs');const client=new CodexClient('/tmp');const requests=[];
 client.rpc={closed:false,request:async(method,params)=>{requests.push({method,params});return method==='turn/start'?{turn:{id:'t'}}:{thread:{id:'th'}}}};
 client.threadConfig={mcp_servers:{},features:{memories:false,hooks:false,apps:false,collaboration_modes:false},memories:{use_memories:false,generate_memories:false}};
 await client.ask({text:'Hi',instructions:'X'});
 const start=requests.find(r=>r.method==='thread/start').params;
 assert.equal(start.config.features.memories,false);assert.equal(start.config.memories.generate_memories,false);
 const source=require('node:fs').readFileSync(require.resolve('../src/codex.cjs'),'utf8');
 for(const key of ['use_memories: false','generate_memories: false','hooks: false','include_instructions: false','include_collaboration_mode_instructions: false','project_doc_max_bytes: 0']) assert.ok(source.includes(key),key);
});

test('Untick all clears every ticked context item',async()=>{
 const d=dashboard();const s=d.fixture();
 s.contextItems=[{id:'cv',kind:'file',name:'resume.pdf',path:'/cv.pdf',chars:10,enabled:true}];d.render(s);
 const buttons=d.document.querySelectorAll('[data-untick-all]');assert.equal(buttons.length,2);assert.equal(buttons[0].hidden,false);
 await buttons[0].onclick();assert.deepEqual(last(d),{name:'untick-all-context'});
 s.contextItems[0].enabled=false;d.render(s);assert.equal(buttons[0].hidden,true,'hidden when nothing is ticked');
 const h=harness();h.run("contextItems=[{id:'a',text:'x',enabled:true},{id:'b',text:'y',enabled:true}]");
 await h.run("action('untick-all-context')");assert.equal(h.run('enabledContext().length'),0);
});
