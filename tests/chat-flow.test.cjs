const test=require('node:test');const assert=require('node:assert/strict');
const harness=require('./workflow-harness.cjs');
const {CodexClient}=require('../src/codex.cjs');
const {buildRequest,defaultModes}=require('../src/prompts.cjs');
test('typed text is unchanged and mode belongs to conversation instructions',()=>{
 const mode=defaultModes()[0];mode.instructions='MODE FIXTURE';mode.context='BACKGROUND FIXTURE';
 const r=buildRequest({text:'Wait, I am sending more.',session:{transcript:[]},mode});
 assert.equal(r.prompt,'Wait, I am sending more.');assert.match(r.instructions,/MODE FIXTURE/);assert.match(r.instructions,/BACKGROUND FIXTURE/);
});
test('screen captures queue multiple images without submitting; send preserves the chat',async()=>{
 const h=harness();h.run("active().threadId='same-chat'");
 await h.run("action('screen')");await h.run("action('screen')");
 assert.equal(h.calls.length,0);assert.equal(h.run('active().attachments.length'),2);
 await h.run("ask({text:'Wait until I send the question.'})");
 assert.equal(h.calls[0].threadId,'same-chat');assert.equal(h.calls[0].images.length,2);assert.equal(h.calls[0].text,'Wait until I send the question.');assert.equal(h.run('active().attachments.length'),0);
});
test('voice and image followups reuse one thread and send only new transcript',async()=>{
 const h=harness();h.run("active().threadId='same-chat';active().transcript=[{id:'a',at:1,source:'Computer',text:'First question?'}]");
 await h.run("ask({kind:'latest'})");assert.equal(h.calls[0].threadId,'same-chat');assert.doesNotMatch(h.calls[0].text,/Answer only|Current mode/);
 h.codex.emit('completed',{status:'completed'});
 h.run("active().transcript.push({id:'b',at:0,source:'Computer',text:'Late ASR question?'})");
 await h.run("ask({kind:'latest'})");assert.doesNotMatch(h.calls[1].text,/First question/);assert.match(h.calls[1].text,/Late ASR question/);
 h.codex.emit('completed',{status:'completed'});
 await h.run("action('screen')");await h.run("ask()");assert.equal(h.calls[2].threadId,'same-chat');assert.equal(h.calls[2].text,'');assert.equal(h.calls[2].images.length,1);
});
test('failed send retains queued images and unconsumed transcript, retry preserves input',async()=>{
 const h=harness();h.run("active().transcript=[{id:'a',at:1,source:'Me',text:'Question?'}]");await h.run("action('screen')");
 h.codex.ask=async r=>{h.calls.push(r);throw Error('Transport failure')};await assert.rejects(h.run("ask({text:'Use this'})"),/Transport failure/);
 assert.equal(h.run('active().attachments.length'),1);assert.equal(h.run('(active().sentTranscriptKeys||[]).length'),0);
 h.codex.ask=async r=>h.calls.push(r);await h.run("action('retry')");
 assert.deepEqual(h.calls[1].images,h.calls[0].images);assert.equal(h.calls[1].text,h.calls[0].text);assert.equal(h.run('active().attachments.length'),0);
});
test('new chat keeps mode and clears model context; drafts belong to each chat',async()=>{
 const h=harness();h.run("modeId='lecture';active().threadId='old'");await h.run("action('screen')");const old=h.run('activeId');await h.run("action('new')");
 assert.equal(h.run('modeId'),'lecture');assert.equal(h.run('active().threadId'),null);assert.equal(h.run('active().attachments.length'),0);
 await h.run(`action('session',${JSON.stringify(old)})`);assert.equal(h.run('active().attachments.length'),1);
});
test('transport sends image-only turns, updates mode on same thread and avoids repeating instructions',async()=>{
 const client=new CodexClient('/tmp');const calls=[];
 client.rpc={request:async(method,params)=>{calls.push({method,params});return ['thread/start','thread/resume'].includes(method)?{thread:{id:params.threadId||'same'}}:{turn:{id:'turn'}}}};
 await client.ask({text:'Wait',images:['/a.png','/b.png'],instructions:'Mode A'});client.busy=false;
 await client.ask({threadId:'same',text:'Continue',instructions:'Mode A'});client.busy=false;
 await client.ask({threadId:'same',text:'',images:['/c.png'],instructions:'Mode B'});
 assert.equal(calls.filter(c=>c.method==='thread/start').length,1);assert.equal(calls.filter(c=>c.method==='thread/resume').length,1);
 assert.equal(calls.find(c=>c.method==='thread/resume').params.threadId,'same');
 const updates=calls.filter(c=>c.method==='thread/inject_items');assert.equal(updates.length,1);assert.match(updates[0].params.items[0].content[0].text,/Mode B/);
 const turns=calls.filter(c=>c.method==='turn/start');assert.equal(turns[0].params.input.length,3);assert.deepEqual(turns[2].params.input,[{type:'localImage',path:'/c.png'}]);
});
test('omitted older transcript does not resurface as new speech on the next turn',()=>{
 const session={transcript:Array.from({length:160},(_,i)=>({id:String(i),at:i,source:'Me',text:`line ${i} `+'a'.repeat(250)}))};
 const first=buildRequest({session,mode:defaultModes()[0]});assert.ok(first.context.omittedTranscriptSegments>0);
 session.sentTranscriptKeys=first.transcriptKeys;
 assert.equal(buildRequest({session,mode:defaultModes()[0]}).prompt,'');
});
test('removing one queued image keeps the others; captures can queue while an answer runs',async()=>{
 const h=harness();h.run('busy=true');await h.run("action('screen')");await h.run("action('screen')");
 const second=h.run('active().attachments[1].id');await h.run("action('remove-image',active().attachments[0].id)");assert.equal(h.run('active().attachments.length'),1);assert.equal(h.run('active().attachments[0].id'),second);assert.equal(h.calls.length,0);
});
