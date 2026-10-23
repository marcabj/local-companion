// Explicit live check: consumes model usage. Not included in npm test.
const {CodexClient}=require('../src/codex.cjs');
const {buildRequest,defaultModes}=require('../src/prompts.cjs');
const {once}=require('node:events');const fs=require('node:fs');const path=require('node:path');const assert=require('node:assert/strict');
const directory=path.resolve(__dirname,'../.build/chat-flow-smoke');fs.mkdirSync(directory,{recursive:true});
const client=new CodexClient(directory), mode=defaultModes()[0], session={transcript:[]};
const image=path.resolve(__dirname,'../.build/test-screen.png');
let model,threadId;const results=[];
async function send(text,images=[]) {
 const built=buildRequest({text,session,mode,hasImage:images.length>0});let output='';const append=t=>output+=t;client.on('delta',append);
 const completed=once(client,'completed');
 try {await client.ask({threadId,text:built.prompt,images,model,effort:'low',instructions:built.instructions});const [turn]=await completed;assert.equal(turn.status,'completed');if(threadId)assert.equal(client.thread,threadId);else threadId=client.thread;session.sentTranscriptKeys=[...(session.sentTranscriptKeys||[]),...built.transcriptKeys];results.push({input:built.prompt,imageCount:images.length,threadId,response:output});console.log(JSON.stringify(results.at(-1)));return output.trim();} finally{client.off('delta',append);}
}
const timeout=setTimeout(()=>{client.disconnect();process.exitCode=1;console.error('Timed out')},180000);
(async()=>{
 const connection=await client.connect();model=connection.models.find(m=>m.isDefault)?.model || connection.models[0].model;
 assert.equal(await send("I am sending a problem in parts. Remember the codeword ORCHID. Wait until I say ready, including when I send another image. Until then reply only WAIT.",[image]),'WAIT');
 assert.equal(await send('',[image]),'WAIT');
 assert.equal(await send('ready. Add the numbers in the two images I sent. Reply only with the sum.'),'84');
 mode.instructions='Respond to questions with the prefix MODE-B followed by the answer. Keep answers brief.';
 session.transcript.push({id:'voice',source:'Computer',at:Date.now()/1000,text:'What was the codeword?'});
 assert.match(await send(''),/MODE-B.*ORCHID/s);
 client.disconnect();await client.connect();
 assert.match(await send('What was the image sum?'),/MODE-B.*84/s);
 fs.writeFileSync(path.join(directory,'result.json'),JSON.stringify({status:'passed',results},null,2));console.log('PASS: staged images, wait instruction, image-only turn, voice, mode update and reconnect preserve one conversation.');
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>{clearTimeout(timeout);client.disconnect()});
