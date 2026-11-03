const {spawn}=require('node:child_process');
const {createInterface}=require('node:readline');
const directions={Up:[0,-1],Down:[0,1],Left:[-1,0],Right:[1,0]};
const arrows={left:123,right:124,down:125,up:126};
const modifiers={command:256,cmd:256,commandorcontrol:256,cmdorctrl:256,super:256,meta:256,control:4096,ctrl:4096,alt:2048,option:2048,shift:512};
function heldChord(accelerator) {
 const parts=(accelerator||'').toLowerCase().split('+'),key=arrows[parts.pop()];let flags=0;
 if(key===undefined || !parts.length)return null;
 for(const part of parts){if(!modifiers[part])return null;flags|=modifiers[part];}
 return {key,modifiers:flags};
}
// Carbon delivers both shortcut press and release, including when another app
// has focus. Only configured arrow chords are registered; no keyboard tap.
class WindowMovement {
 constructor({helper,move,canMove=()=>true,launch=spawn,onError=()=>{}}){Object.assign(this,{helper,move,canMove,launch,onError});this.held=new Map();}
 async configure(shortcuts) {
  await this.dispose();this.shortcuts=shortcuts;
  const bindings=Object.keys(directions).flatMap(direction=>{const chord=heldChord(shortcuts['move'+direction]);return chord?[{direction,...chord}]:[];});
  if(!bindings.length)return;
  const child=this.launch(this.helper,['--move-shortcuts',JSON.stringify(bindings)],{stdio:['pipe','pipe','ignore']});
  const lines=createInterface({input:child.stdout});const active={child,lines};this.active=active;
  active.closed=new Promise(resolve=>child.once('close',()=>{lines.close();if(this.active===active){this.active=null;this.stop();}resolve();}));
  child.stdin.on('error',()=>{});
  await new Promise((resolve,reject)=>{
   let ready=false;
   const timer=setTimeout(()=>fail(new Error('Window movement helper did not start.')),3000);
   const fail=error=>{clearTimeout(timer);if(!ready)reject(error);else if(this.active===active)this.onError(error.message);};
   child.once('error',fail);
   child.once('close',()=>{clearTimeout(timer);if(!ready)reject(new Error('Window movement helper exited before registering shortcuts.'));});
   lines.on('line',line=>{
    if(this.active!==active)return;
    let event;try{event=JSON.parse(line);}catch{return;}
    if(event.type==='ready'){ready=true;clearTimeout(timer);resolve();return;}
    if(event.type==='error'){fail(new Error(event.message));return;}
    if(event.type==='press')this.press(event.direction);
    if(event.type==='release')this.release(event.direction);
   });
  }).catch(async error=>{await this.dispose();throw error;});
 }
 press(direction){
  if(!directions[direction] || this.held.has(direction) || !this.canMove())return;
  this.held.set(direction,Date.now());const [x,y]=directions[direction];this.move(x*80,y*80);
  if(!this.timer)this.timer=setInterval(()=>{
   if(!this.canMove()){this.stop();return;}
   for(const [direction,at] of this.held)if(Date.now()-at>=200){const [x,y]=directions[direction];this.move(x*8,y*8);}
  },16);
 }
 release(direction){this.held.delete(direction);if(!this.held.size){clearInterval(this.timer);this.timer=null;}}
 handleInput(input){
  const key=arrows[input.key.replace(/^Arrow/,'').toLowerCase()];
  if(input.type==='keyUp'){
   if(key!==undefined)for(const [direction,accelerator] of Object.entries(this.shortcuts||{}))if(heldChord(accelerator)?.key===key)this.release(direction.replace(/^move/,''));
   if(['Meta','Control','Alt','Shift'].includes(input.key))this.stop();
  }
  if(key===undefined)return false;
  const flags=(input.meta?256:0)|(input.control?4096:0)|(input.alt?2048:0)|(input.shift?512:0);
  for(const [name,accelerator] of Object.entries(this.shortcuts||{})){
   if(!name.startsWith('move'))continue;const chord=heldChord(accelerator);
   if(chord?.key===key && chord.modifiers===flags){if(input.type==='keyDown'&&!input.isAutoRepeat)this.press(name.slice(4));return true;}
  }
  return false;
 }
 stop(){this.held.clear();clearInterval(this.timer);this.timer=null;}
 async dispose(){this.stop();const active=this.active;this.active=null;if(active){active.lines.close();active.child.kill();await active.closed;}}
}
module.exports={WindowMovement,heldChord};
