const test=require('node:test');const assert=require('node:assert/strict');
const {WindowPrivacy}=require('../src/privacy.cjs');
function harness(){
 const state={protected:false,focusable:true,focused:true,mission:false,skip:false,dock:true,visible:true};const calls=[];let time=0,timer;
 const win={setContentProtection:v=>state.protected=v,setFocusable:v=>state.focusable=v,setSkipTaskbar:v=>state.skip=v,setHiddenInMissionControl:v=>state.mission=v,isFocused:()=>state.focused,blur(){state.focused=false;calls.push('blur')},isContentProtected:()=>state.protected,isFocusable:()=>state.focusable,isHiddenInMissionControl:()=>state.mission,isVisible:()=>state.visible,hide(){state.visible=false},show(){state.visible=true;calls.push('show')},showInactive(){state.visible=true;calls.push('inactive')},focus(){state.focused=true;calls.push('focus')}};
 const dock={isVisible:()=>state.dock,hide(){state.dock=false;calls.push('dock-hide')},async show(){state.dock=true;calls.push('dock-show')}};
 const privacy=new WindowPrivacy({app:{dock},win,platform:'darwin',now:()=>time,schedule:fn=>{timer=fn;return 1},cancel:()=>timer=null});
 return {privacy,state,calls,tick(){time+=1200;const fn=timer;timer=null;fn?.()}};
}
const settled=()=>new Promise(r=>setImmediate(r));
test('privacy restores normal visibility and keyboard access when disabled',async()=>{
 const h=harness();h.privacy.apply({contentProtection:true,noFocusWhenPrivate:true});await settled();
 assert.equal(h.state.protected,true);assert.equal(h.state.dock,false);assert.equal(h.state.mission,true);assert.equal(h.state.skip,true);assert.equal(h.state.focusable,false);assert.equal(h.state.focused,false);
 h.privacy.show();assert.equal(h.calls.at(-1),'inactive');assert.equal(h.state.focused,false);
 h.privacy.toggle();assert.equal(h.state.visible,false);h.privacy.toggle();assert.equal(h.state.visible,true);assert.equal(h.state.focused,false);
 h.privacy.apply({contentProtection:false,noFocusWhenPrivate:true});h.tick();await settled();
 assert.equal(h.state.protected,false);assert.equal(h.state.dock,true);assert.equal(h.state.mission,false);assert.equal(h.state.skip,false);assert.equal(h.state.focusable,true);
 h.privacy.show();assert.equal(h.state.focused,true);h.privacy.dispose();
});
test('rapid privacy changes settle on the latest Dock preference',async()=>{
 const h=harness();h.privacy.apply({contentProtection:true});h.privacy.apply({contentProtection:false});await settled();h.tick();await settled();assert.equal(h.state.dock,true);
 h.privacy.apply({contentProtection:true});h.privacy.apply({contentProtection:false});h.privacy.apply({contentProtection:true});h.tick();await settled();assert.equal(h.state.dock,false);assert.equal(h.state.focusable,true);h.privacy.dispose();
});
test('restoring a background window after a screenshot does not take keyboard focus',()=>{
 const h=harness();h.privacy.apply({contentProtection:true});h.state.focused=false;h.privacy.show({focus:false});assert.equal(h.state.focused,false);assert.equal(h.calls.at(-1),'inactive');h.privacy.dispose();
});
