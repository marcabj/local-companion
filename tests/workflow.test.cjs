const test=require('node:test');const assert=require('node:assert/strict');
const {defaultModes,buildRequest}=require('../src/prompts.cjs');
const harness=require('./workflow-harness.cjs');
test('Send flushes newest speech and configures mode without automatic capture',async()=>{
 const h=harness();h.run('listening=true');h.audio.flush=async()=>h.run("active().transcript.push({source:'Computer',text:'What is two plus two?',at:1})");
 await h.run('ask()');assert.equal(h.calls.length,1);assert.equal(h.captures(),0);assert.match(h.calls[0].text,/What is two plus two/);assert.match(h.calls[0].instructions,/General/);assert.equal(h.calls[0].images.length,0);assert.equal(h.run('requesting'),false);
});
test('screen-off quick reply uses active mode and selected transcript without a screenshot',async()=>{
 const h=harness();h.run("preferences.screenUse=false;modeId='sales';active().transcript=[{source:'Computer',text:'What does it cost?',at:1},{source:'Computer',text:'Unselected future line',at:2}]");
 await h.run("ask({kind:'reply',transcriptIndex:0})");assert.equal(h.captures(),0);assert.match(h.calls[0].text,/What does it cost/);assert.doesNotMatch(h.calls[0].text,/Unselected future line/);assert.match(h.calls[0].instructions,/discovery/);assert.match(h.calls[0].text,/What should I say next/);
});
test('capture failure fails the request without sending or leaving controls busy',async()=>{
 const h=harness();h.electron.desktopCapturer.getSources=async()=>{throw Error('Permission denied')};
 await assert.rejects(h.run("ask({kind:'screen'})"),/Permission denied/);assert.equal(h.calls.length,0);assert.equal(h.run('requesting'),false);assert.equal(h.run('busy'),false);
});
test('concurrent Assist cannot send duplicate requests',async()=>{
 const h=harness();let release;h.run("listening=true;active().transcript=[{at:1,source:'Me',text:'Hello'}]");h.audio.flush=()=>new Promise(r=>release=r);const first=h.run('ask()');await assert.rejects(h.run('ask()'),/Stop the current/);release();await first;assert.equal(h.calls.length,1);
});
test('ending capture drains transcription and stores completed notes separately',async()=>{
 const h=harness();h.audio.drain=async()=>h.run("active().transcript=[{source:'Computer',text:'Sam owns the launch by Friday.',at:1}]");
 await h.run("action('end-session')");assert.equal(h.captures(),0);assert.match(h.calls[0].text,/Sam owns the launch/);h.codex.emit('delta','Sam will launch by Friday.');h.codex.emit('completed',{status:'completed'});assert.equal(h.run('active().notes'),'Sam will launch by Friday.');assert.ok(h.events.some(e=>e[0]==='navigate'&&e[1]==='notes'));
});
test('notes keep early decisions beyond the live transcript window',()=>{
 const transcript=Array.from({length:120},(_,i)=>({source:'Computer',at:i,text:i===0?'EARLY DECISION: ship Monday.':'Later discussion '+('a'.repeat(300))}));
 const result=buildRequest({kind:'notes',session:{transcript},mode:defaultModes()[0]});assert.match(result.prompt,/EARLY DECISION/);assert.equal(result.context.omittedTranscriptSegments,0);
});
test('mode reference data is structured and omission is explicit',()=>{
 const mode=defaultModes()[0];mode.files=[{name:'resume.txt',text:'Built a search tool.'}];const result=buildRequest({session:{transcript:Array.from({length:1000},()=>({at:1,source:'Me',text:'x'.repeat(300)}))},mode});assert.match(result.instructions,/Built a search tool/);assert.ok(result.context.omittedTranscriptSegments>0);assert.equal(result.context.files[0],'resume.txt');
});

test('mode migration upgrades untouched interview prompts and preserves customized context',()=>{
 const {upgradeModes,defaultModes}=require('../src/prompts.cjs');
 const original='Help formulate clear answers grounded in the supplied resume, job description and actual experience. Use natural spoken language. Never invent projects, metrics or credentials. State missing personal evidence briefly.';
 const saved=[{id:'interview',instructions:original,context:'My real background',files:[{name:'resume.txt',text:'My experience'}]},{id:'coding',instructions:'My custom instructions'}];
 const next=upgradeModes(saved);assert.equal(next[0].instructions,defaultModes().find(m=>m.id==='interview').instructions);assert.match(next[0].instructions,/current interview question/);assert.equal(next[0].context,saved[0].context);assert.deepEqual(next[0].files,saved[0].files);assert.equal(next[1].instructions,'My custom instructions');
});


test('privacy toggle remains available while answering and listening, without hiding',async()=>{
  const h=harness();
  h.run("busy=true;listening=true;preferences.contentProtection=false;win.hide=()=>{throw Error('Must stay visible')};privacy={apply(p){if(typeof p.contentProtection!=='boolean')throw Error('Invalid privacy state')},state(){return {}}}");
  await h.run("action('toggle-privacy')");assert.equal(h.run('preferences.contentProtection'),true);
  await h.run("action('toggle-privacy')");assert.equal(h.run('preferences.contentProtection'),false);
  assert.equal(h.run('busy'),true);assert.equal(h.run('listening'),true);
});


test('latest spoken question flushes speech without capturing or consuming queued images',async()=>{
 const h=harness();h.run("listening=true;preferences.screenUse=true;active().threadId='screen-thread';active().attachments=[{id:'queued',path:'/queued.png',preview:'image',name:'Screen'}];win.hide=()=>{throw Error('Panel must stay visible')}");
 h.audio.flush=async()=>h.run("active().transcript.push({source:'Computer',text:'What is a database index?',at:1})");
 await h.run("ask({kind:'latest'})");
 assert.equal(h.captures(),0);assert.equal(h.calls[0].images.length,0);assert.equal(h.calls[0].threadId,'screen-thread');
 assert.match(h.calls[0].text,/What is a database index/);assert.doesNotMatch(h.calls[0].text,/Answer only/);
 assert.equal(h.run('listening'),true);assert.equal(h.run('active().attachments[0].path'),'/queued.png');
 h.codex.emit('thread','screen-thread');assert.equal(h.run('active().threadId'),'screen-thread');
});
test('latest question requires transcript rather than guessing from screen or references',async()=>{
 const h=harness();h.run("currentMode().context='My resume';active().attachments=[{id:'queued',path:'/queued.png'}]");
 await assert.rejects(h.run("ask({kind:'latest'})"),/transcript|Listen/i);assert.equal(h.calls.length,0);assert.equal(h.captures(),0);
});


test('global answer shortcut directly requests latest transcript without screenshot',async()=>{
 const h=harness();h.run("active().transcript=[{source:'Computer',text:'What is two plus two?',at:1}];registerShortcuts(DEFAULT_SHORTCUTS)");
 await h.shortcuts.get('Control+Alt+Return')();
 assert.equal(h.calls.length,1);assert.equal(h.captures(),0);assert.equal(h.run('active().lastPreparedRequest.kind'),'latest');
});

test('screenshot after voice continues the same conversation without resending consumed speech',async()=>{
 const h=harness();h.run("listening=true;active().transcript=[{source:'Computer',text:'What is the difference between a stack and a queue?',at:1}];active().threadId='contaminated-screen-thread';active().notes='Earlier stack versus queue discussion';");
 await h.run("ask({kind:'latest'})");h.codex.emit('thread','audio-thread');h.codex.emit('completed',{status:'completed'});
 await h.run("ask({kind:'screen'})");
 const request=h.calls[1];assert.equal(request.images.length,1);assert.equal(h.captures(),1);
 assert.doesNotMatch(request.text,/stack|queue/i,'Screen action must not resend the unrelated spoken question or session notes');
 assert.equal(request.threadId,'audio-thread','A screenshot continues the same conversation');
 assert.equal(h.run('listening'),true);
});

test('queued screen capture ignores slow ASR; send includes mode references and anchors followups',async()=>{
 const h=harness();h.run("listening=true;audioBusy=true;currentMode().context='Use clear code';currentMode().files=[{name:'requirements.txt',text:'Prefer iterative solutions'}]");
 h.audio.flush=async()=>{throw Error('Capture must not wait for audio')};
 await h.run("action('screen')");assert.equal(h.calls.length,0);assert.equal(h.captures(),1);
 h.run('listening=false;audioBusy=false');await h.run("ask({text:'Explain the complexity too'})");
 assert.equal(h.calls[0].text,'Explain the complexity too');assert.match(h.calls[0].instructions,/Prefer iterative solutions/);
 h.codex.emit('thread','same-thread');h.codex.emit('completed',{status:'completed'});
 await h.run("ask({text:'Explain the base case'})");assert.equal(h.calls[1].threadId,'same-thread');
});

test('answer speed is explicit, validated and independent of reasoning effort',async()=>{
 const h=harness();h.run("models[0].serviceTiers=[{id:'priority',name:'Fast',description:'2x speed, increased usage'}];active().transcript=[{source:'Computer',text:'Question',at:1}]");
 await h.run("action('answer-model',{serviceTier:'priority',effort:'low'})");
 await h.run("ask({kind:'latest'})");assert.equal(h.calls[0].serviceTier,'priority');assert.equal(h.calls[0].effort,'low');
 h.codex.emit('completed',{status:'completed'});
 await h.run("action('answer-model',{serviceTier:'default'})");await h.run("ask({text:'Follow up'})");assert.equal(h.calls[1].serviceTier,'default');
 h.codex.emit('completed',{status:'completed'});
 await assert.rejects(h.run("action('answer-model',{serviceTier:'unavailable'})"),/not available/);
 h.run("selectedServiceTier='priority';models.push({model:'standard-only',supportedReasoningEfforts:[{reasoningEffort:'low'}]})");
 await h.run("action('answer-model',{model:'standard-only'})");assert.equal(h.run('selectedServiceTier'),'default');
});

test('combined screen and transcript flushes newest speech, forces a fresh image and preserves listening',async()=>{
 const h=harness();h.run("listening=true;preferences.screenUse=false;active().attachments=[{id:'queued',path:'/queued.png'}];active().threadId='old-screen-thread';registerShortcuts(DEFAULT_SHORTCUTS)");
 h.audio.flush=async()=>h.run("active().transcript.push({source:'Computer',text:'Explain the complexity of the solution on screen',at:1})");
 await h.shortcuts.get('Control+Alt+\\')();assert.ok(h.events.some(e=>e[0]==='command'&&e[1]==='screen-transcript'));
 await h.run("ask({kind:'screen-transcript',text:'Keep it concise'})");
 assert.equal(h.captures(),1);assert.equal(h.calls[0].images.length,2);assert.equal(h.calls[0].images[0],'/queued.png');
 assert.match(h.calls[0].text,/Explain the complexity/);assert.match(h.calls[0].text,/Keep it concise/);assert.doesNotMatch(h.calls[0].text,/Solve the task/);
 assert.equal(h.calls[0].threadId,'old-screen-thread');assert.equal(h.run('listening'),true);
 assert.equal(h.run('active().messages[0].context.transcriptCount'),1);
});
test('combined action does not send an incomplete request on audio or screenshot failure',async()=>{
 const h=harness();h.run('listening=true');h.audio.flush=async()=>{throw Error('Audio flush failed')};
 await assert.rejects(h.run("ask({kind:'screen-transcript'})"),/Audio flush failed/);assert.equal(h.calls.length,0);assert.equal(h.captures(),0);
 h.run("listening=false;active().transcript=[{source:'Computer',text:'Describe this',at:1}]");h.electron.desktopCapturer.getSources=async()=>{throw Error('Screen unavailable')};
 await assert.rejects(h.run("ask({kind:'screen-transcript'})"),/Screen unavailable/);assert.equal(h.calls.length,0);
});

test('screen-only punctuation shortcut dispatches screen without transcript',async()=>{
 const h=harness();h.run('registerShortcuts(DEFAULT_SHORTCUTS)');
 await h.shortcuts.get("Control+Alt+'")();
 assert.deepEqual(h.events.filter(e=>e[0]==='command'),[['command','screen']]);
 assert.equal(h.shortcuts.has('Control+Alt+S'),false);assert.equal(h.shortcuts.has('Control+Alt+A'),false);
});
