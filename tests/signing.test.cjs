const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const {signBundle}=require('../scripts/signing.cjs');
function requirement(bundle) {
 const r=spawnSync('/usr/bin/codesign',['-d','-r-',bundle],{encoding:'utf8'});
 assert.equal(r.status,0,r.stderr);
 return r.stdout.split('\n').find(s=>s.includes('designated =>'))?.replace(/^#?\s*designated =>\s*/,'');
}
test('updated app satisfies the permission identity of its previous build',{skip:process.platform!=='darwin'},t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'companion-signing-test-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const bundle=path.join(dir,'IdentityFixture.app');
 fs.mkdirSync(path.join(bundle,'Contents/MacOS'),{recursive:true});
 fs.mkdirSync(path.join(bundle,'Contents/Resources'));
 fs.copyFileSync('/usr/bin/true',path.join(bundle,'Contents/MacOS/IdentityFixture'));
 fs.writeFileSync(path.join(bundle,'Contents/Info.plist'),'<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.marc.companion.identity-test</string><key>CFBundleExecutable</key><string>IdentityFixture</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
 const resource=path.join(bundle,'Contents/Resources/version.txt');
 fs.writeFileSync(resource,'version one');signBundle(bundle);
 const original=requirement(bundle);assert.ok(original,'First build must have a designated requirement');
 fs.writeFileSync(resource,'version two with a toolbar change');signBundle(bundle);
 const verified=spawnSync('/usr/bin/codesign',['--verify','--strict','-R','='+original,bundle],{encoding:'utf8'});
 assert.equal(verified.status,0,'An update must satisfy the identity macOS saved when permission was granted: '+verified.stderr);
 assert.equal(requirement(bundle),original);
 const impostor=spawnSync('/usr/bin/codesign',['--force','--deep','--sign','-',bundle],{encoding:'utf8'});
 assert.equal(impostor.status,0,impostor.stderr);
 const rejected=spawnSync('/usr/bin/codesign',['--verify','-R','='+original,bundle],{encoding:'utf8'});
 assert.notEqual(rejected.status,0,'The same bundle identifier with a different signer must not inherit the permission identity');
});
