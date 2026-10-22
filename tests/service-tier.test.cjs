const test=require('node:test');const assert=require('node:assert/strict');
const {CodexClient}=require('../src/codex.cjs');
test('Codex transport passes selected tier on new, resumed and continuing turns',async()=>{
 const client=new CodexClient('/tmp');const calls=[];
 client.rpc={request:async(method,params)=>{calls.push({method,params});return method.startsWith('thread/')?{thread:{id:params.threadId || 'fresh'}}:{turn:{id:'turn'}}}};
 await client.ask({model:'fixture',text:'first',serviceTier:'priority'});client.busy=false;
 await client.ask({threadId:'fresh',model:'fixture',text:'second',serviceTier:'default'});client.busy=false;
 await client.ask({threadId:'other',model:'fixture',text:'third',serviceTier:'priority'});
 assert.deepEqual(calls.filter(c=>c.method==='turn/start').map(c=>c.params.serviceTier),['priority','default','priority']);
 assert.equal(calls.find(c=>c.method==='thread/start').params.serviceTier,'priority');
 assert.equal(calls.find(c=>c.method==='thread/resume').params.serviceTier,'priority');
});
