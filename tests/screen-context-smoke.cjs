// Live Codex check; consumes account usage. Pass a screenshot of Invert Binary Tree.
const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');const {once}=require('node:events');
const {CodexClient}=require('../src/codex.cjs');const {buildRequest,defaultModes}=require('../src/prompts.cjs');
const image=process.argv[2];if(!image)throw Error('Pass the Invert Binary Tree screenshot path');
const directory=path.resolve(__dirname,'../.build/screen-context-smoke');fs.mkdirSync(directory,{recursive:true});
const client=new CodexClient(directory);const results=[];const session={transcript:[{source:'Computer',text:'What is the difference between a stack and a queue?',at:Date.now()/1000}],notes:''};
const mode=defaultModes().find(m=>m.id==='interview');const timeout=setTimeout(()=>{client.disconnect();process.exitCode=1},120000);
(async()=>{try{
 await client.connect();
 for(const kind of ['latest','screen']){
  const built=buildRequest({kind,session,mode,hasImage:kind==='screen'});let text='';const append=s=>text+=s;client.on('delta',append);
  const completion=once(client,'completed');const start=Date.now();
  await client.ask({text:built.prompt,image:kind==='screen'?image:undefined,model:'gpt-6.1-sol',effort:'low',serviceTier:kind==='screen'?'priority':'default'});
  const [turn]=await completion;client.off('delta',append);assert.equal(turn.status,'completed');
  results.push({kind,text,threadId:client.thread,requestedTier:kind==='screen'?'priority':'default',elapsedMs:Date.now()-start,context:built.context});
 }
 assert.notEqual(results[0].threadId,results[1].threadId);assert.equal(results[1].context.transcriptCount,0);
 assert.match(results[0].text,/LIFO|last\W+in\W+first\W+out/i);assert.match(results[1].text,/invertTree/);
 assert.doesNotMatch(results[1].text,/connecting it|your.*stack.*queue|a stack is|a queue is/i);
 fs.mkdirSync(path.resolve(__dirname,'../.analysis'),{recursive:true});
 fs.writeFileSync(path.resolve(__dirname,'../.analysis/screen-context-verification.json'),JSON.stringify(results,null,2)+'\n');console.log(JSON.stringify(results,null,2));
}finally{clearTimeout(timeout);client.disconnect()}})().catch(e=>{console.error(e);process.exitCode=1});
