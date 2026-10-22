// Documented Electron controls found in the REA-extracted Cluely client.
// Content protection is an OS request, not proof of capture exclusion.
class WindowPrivacy {
  constructor({app, win, platform=process.platform, onError=()=>{}, onChange=()=>{}, now=Date.now, schedule=setTimeout, cancel=clearTimeout}) {
    Object.assign(this,{app,win,platform,onError,onChange,now,schedule,cancel});
    this.enabled=false; this.noFocus=false; this.lastDockChange=-Infinity;
  }
  apply({contentProtection=false,noFocusWhenPrivate=false}) {
    this.enabled=!!contentProtection;
    this.noFocus=this.enabled && !!noFocusWhenPrivate;
    this.win.setContentProtection(this.enabled);
    if(this.noFocus && this.win.isFocused()) this.win.blur();
    this.win.setFocusable(!this.noFocus);
    this.win.setSkipTaskbar(this.enabled);
    if(this.platform==='darwin') {
      this.win.setHiddenInMissionControl(this.enabled);
      this.syncDock();
    }
  }
  syncDock() {
    this.cancel(this.dockTimer);
    if(this.disposed || !this.app.dock || this.dockChanging) return;
    if(this.app.dock.isVisible()===!this.enabled) return;
    const delay=1100-(this.now()-this.lastDockChange);
    // Electron/macOS ignores Dock hide calls made less than a second apart.
    if(delay>0) {this.dockTimer=this.schedule(()=>this.syncDock(),delay);return;}
    this.lastDockChange=this.now(); this.dockChanging=true;
    const requested=this.enabled;
    Promise.resolve().then(()=>requested?this.app.dock.hide():this.app.dock.show())
      .catch(e=>this.onError(`Could not update Dock visibility: ${e.message}`))
      .finally(()=>{this.dockChanging=false;this.onChange();if(requested!==this.enabled)this.syncDock();});
  }
  show({focus=true}={}) {
    if(this.noFocus || !focus) this.win.showInactive();
    else {this.win.show();this.win.focus();}
  }
  toggle() {
    if(this.win.isVisible() && (this.noFocus || this.win.isFocused())) this.win.hide();
    else this.show();
  }
  state() {
    return {contentProtection:this.win.isContentProtected(),keyboardFocus:this.win.isFocusable(),
      hiddenInMissionControl:this.platform==='darwin'?this.win.isHiddenInMissionControl():null,
      dockVisible:this.platform==='darwin'?this.app.dock?.isVisible():null};
  }
  dispose() {this.disposed=true;this.cancel(this.dockTimer);}
}
module.exports={WindowPrivacy};
