#!/usr/bin/env node
console.log(JSON.stringify({type:'ready'}));
process.on('SIGTERM',()=>setTimeout(()=>process.exit(0),60));
require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line);
 setTimeout(()=>console.log(JSON.stringify({type:'transcript',id:request.id,source:request.source,text:'preserved speech'})),180);
});
