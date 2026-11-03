const test=require('node:test');const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');const {PassThrough}=require('node:stream');
const {WindowMovement,heldChord}=require('../src/window-movement.cjs');
const wait=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){
 const moves=[],children=[];let visible=true;
 const movement=new WindowMovement({helper:'/helper',move:(x,y)=>moves.push([x,y]),canMove:()=>visible,launch:(file,args)=>{
  const child=new EventEmitter();child.stdout=new PassThrough();child.stdin=new PassThrough();child.kill=()=>{child.killed=true;child.emit('close');};
  child.args=args;children.push(child);queueMicrotask(()=>child.stdout.write('{"type":"ready"}\n'));return child;
 }});
 return {movement,moves,children,hide:()=>{visible=false;}};
}
test('global shortcut press repeats while held, deduplicates keydown and stops on release',async t=>{
 const f=fixture();t.after(()=>f.movement.dispose());await f.movement.configure({moveLeft:'Command+Left'});const child=f.children[0];
 assert.deepEqual(JSON.parse(child.args[1]),[{direction:'Left',key:123,modifiers:256}]);
 child.stdout.write('{"type":"press","direction":"Left"}\n{"type":"press","direction":"Left"}\n');
 assert.deepEqual(f.moves,[[-80,0]]);await wait(260);assert.ok(f.moves.length>1);
 child.stdout.write('{"type":"release","direction":"Left"}\n');const count=f.moves.length;await wait(50);assert.equal(f.moves.length,count);assert.equal(f.movement.timer,null);
});
test('focused input uses the same hold state and releasing Command stops movement',async t=>{
 const f=fixture();t.after(()=>f.movement.dispose());await f.movement.configure({moveDown:'Command+Down'});
 assert.equal(f.movement.handleInput({type:'keyDown',key:'ArrowDown',meta:true}),true);
 f.movement.handleInput({type:'keyDown',key:'ArrowDown',meta:true,isAutoRepeat:true});assert.deepEqual(f.moves,[[0,80]]);
 await wait(260);assert.ok(f.moves.length>1);f.movement.handleInput({type:'keyUp',key:'Meta'});
 const count=f.moves.length;await wait(50);assert.equal(f.moves.length,count);assert.equal(f.movement.timer,null);
});
test('reconfiguring releases registrations; hidden windows and helper exits stop repeats',async t=>{
 const f=fixture();t.after(()=>f.movement.dispose());await f.movement.configure({moveRight:'Command+Right'});const first=f.children[0];
 f.movement.press('Right');await f.movement.configure({moveUp:'Command+Up'});assert.ok(first.killed);assert.equal(f.movement.timer,null);
 first.stdout.write('{"type":"press","direction":"Right"}\n');assert.equal(f.moves.length,1);
 f.movement.press('Up');f.hide();await wait(30);assert.equal(f.movement.timer,null);
 f.children[1].emit('close');assert.equal(f.movement.active,null);
 assert.deepEqual(heldChord('CmdOrCtrl+Shift+Right'),{key:124,modifiers:768});assert.equal(heldChord('Command+K'),null);
});
