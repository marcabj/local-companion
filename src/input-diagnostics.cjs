const fs = require('node:fs/promises');
const path = require('node:path');

// Local, bounded operational metadata. Never record keys, text, audio, or images.
class InputDiagnostics {
  constructor({win, ipcMain, directory, getContext=()=>({}), intervalMs=5000, maxBytes=1024*1024, now=Date.now}) {
    Object.assign(this, {win, ipcMain, directory, getContext, maxBytes, now});
    this.file=path.join(directory,'input.jsonl');
    this.previous=path.join(directory,'input.previous.jsonl');
    this.nativeKeys=0;this.nativeClicks=0;this.sequence=0;this.listeners=[];
    this.chain=fs.mkdir(directory,{recursive:true,mode:0o700})
      .then(()=>fs.stat(this.file).then(s=>{this.bytes=s.size},()=>{this.bytes=0}));
    for(const event of ['focus','blur','show','hide','resized','unresponsive','responsive','sheet-begin','sheet-end'])
      this.listen(win,event,()=>this.record(event));
    this.listen(win.webContents,'before-input-event',(_event,input)=>{if(input.type==='keyDown')this.nativeKeys++;});
    this.listen(win.webContents,'before-mouse-event',(_event,input)=>{if(input.type==='mouseDown')this.nativeClicks++;});
    this.listen(win.webContents,'render-process-gone',(_event,details)=>this.record('renderer-exit',{reason:details.reason,exitCode:details.exitCode}));
    this.listen(ipcMain,'input-health', (event,data)=>{
      if(event.sender!==win.webContents || !data || data.sequence!==this.sequence)return;
      const count=value=>Number.isSafeInteger(value)&&value>=0?value:0;
      this.record('renderer-health',{
        roundTripMs:this.now()-this.pingAt,
        domKeys:count(data.keys),domClicks:count(data.clicks),domInputs:count(data.inputs),
        errors:count(data.errors),rejections:count(data.rejections),
        documentFocused:data.focused===true,documentVisible:data.visible===true,
      });
    });
    this.record('start',{pid:process.pid,electron:process.versions.electron});
    this.timer=setInterval(()=>this.ping(),intervalMs);this.timer.unref?.();
  }
  listen(target,event,handler){target.on(event,handler);this.listeners.push(()=>target.removeListener(event,handler));}
  record(event,extra={}) {
    if(this.disposed || this.win.isDestroyed())return;
    const w=this.win;
    const line=JSON.stringify({at:this.now(),event,focused:w.isFocused(),focusable:w.isFocusable(),
      enabled:w.isEnabled(),visible:w.isVisible(),webFocused:w.webContents.isFocused(),
      nativeKeys:this.nativeKeys,nativeClicks:this.nativeClicks,...this.getContext(),...extra})+'\n';
    this.chain=this.chain.then(async()=>{
      if(this.bytes+Buffer.byteLength(line)>this.maxBytes){
        await fs.rm(this.previous,{force:true});
        await fs.rename(this.file,this.previous).catch(e=>{if(e.code!=='ENOENT')throw e;});
        this.bytes=0;
      }
      await fs.appendFile(this.file,line,{mode:0o600});this.bytes+=Buffer.byteLength(line);
    }).catch(()=>{}); // Diagnostics must never break normal app operation.
  }
  ping(){
    if(this.disposed || this.win.isDestroyed())return;
    this.pingAt=this.now();this.sequence++;
    this.record('main-health',{sequence:this.sequence});
    this.win.webContents.send('input-health-ping',this.sequence);
  }
  dispose(){
    this.record('stop');this.disposed=true;clearInterval(this.timer);
    for(const remove of this.listeners)remove();
    return this.chain;
  }
}
module.exports={InputDiagnostics};
