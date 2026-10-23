#!/usr/bin/env node
const mode = process.argv[process.argv.indexOf('--microphone') + 1];
if (mode === 'fail') setTimeout(() => { console.log(JSON.stringify({ type: 'error', message: 'Fixture permission denied' })); process.exit(1); }, 30);
else if (mode !== 'hang') setTimeout(() => {console.log(JSON.stringify({ type: 'started' }));if(mode==='crash')setTimeout(()=>process.kill(process.pid,'SIGKILL'),30);}, 60);
require('node:readline').createInterface({input:process.stdin}).on('line', line=>{ if(line.startsWith('flush:')) { console.log(JSON.stringify({type:'segment',path:require('node:path').join(process.argv[process.argv.indexOf('--listen')+1],'flush.wav'),source:'Computer',at:1})); console.log(JSON.stringify({type:'flushed',id:line.slice(6)})); } else process.exit(0); });
process.stdin.resume();
