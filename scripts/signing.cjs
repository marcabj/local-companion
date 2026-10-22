const {execFileSync}=require('node:child_process');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {randomBytes}=require('node:crypto');
const directory=path.join(os.homedir(),'Library/Application Support/Local Companion Signing');
const keychain=path.join(directory,'signing.keychain-db');
const configPath=path.join(directory,'identity.json');
function run(binary,args,options={}) {
  try { return execFileSync(binary,args,{encoding:'utf8',stdio:'pipe',...options}); }
  catch(e) { throw new Error(`${path.basename(binary)} failed: ${String(e.stderr||'').trim()}`); }
}
function setupIdentity() {
  if(fs.existsSync(configPath)) return loadIdentity();
  if(fs.existsSync(directory)) throw new Error('Signing setup is incomplete. Preserve the existing keychain and repair it; do not generate a replacement identity.');
  fs.mkdirSync(directory,{recursive:true,mode:0o700});
  const password=randomBytes(32).toString('hex');
  fs.writeFileSync(path.join(directory,'password'),password,{mode:0o600});
  const temporary=fs.mkdtempSync(path.join(directory,'setup-'));
  try {
    const key=path.join(temporary,'key.pem'),cert=path.join(temporary,'cert.pem'),p12=path.join(temporary,'identity.p12');
    const config=path.join(temporary,'openssl.cnf');
    fs.writeFileSync(config,'[req]\ndistinguished_name=dn\nx509_extensions=extensions\nprompt=no\n[dn]\nCN=Local Companion Personal Signing\n[extensions]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=critical,codeSigning\nsubjectKeyIdentifier=hash\n');
    run('/usr/bin/openssl',['req','-new','-x509','-newkey','rsa:3072','-nodes','-days','3650','-config',config,'-keyout',key,'-out',cert]);
    run('/usr/bin/openssl',['pkcs12','-export','-inkey',key,'-in',cert,'-out',p12,'-passout','env:COMPANION_SIGNING_PASSWORD'],{env:{...process.env,COMPANION_SIGNING_PASSWORD:password}});
    run('/usr/bin/security',['create-keychain','-p',password,keychain]);
    run('/usr/bin/security',['set-keychain-settings','-lut','300',keychain]);
    run('/usr/bin/security',['unlock-keychain','-p',password,keychain]);
    run('/usr/bin/security',['import',p12,'-k',keychain,'-P',password,'-T','/usr/bin/codesign']);
    const fingerprint=run('/usr/bin/openssl',['x509','-in',cert,'-noout','-fingerprint','-sha1']).trim().split('=').pop().replaceAll(':','');
    fs.copyFileSync(cert,path.join(directory,'certificate.pem'));
    const identity={fingerprint,keychain};
    fs.writeFileSync(configPath,JSON.stringify(identity,null,2)+'\n',{mode:0o600});
    return identity;
  } finally {
    fs.rmSync(temporary,{recursive:true,force:true});
    if(fs.existsSync(keychain)) run('/usr/bin/security',['lock-keychain',keychain]);
  }
}
function loadIdentity() {
  if(!fs.existsSync(configPath)) throw new Error('Run node scripts/signing.cjs --setup once to create the persistent local signing identity.');
  const identity=JSON.parse(fs.readFileSync(configPath,'utf8'));
  if(!/^[A-F0-9]{40}$/.test(identity.fingerprint)||identity.keychain!==keychain||!fs.existsSync(keychain)) throw new Error('Persistent signing identity is unavailable. Restore it instead of replacing it or using ad-hoc signing.');
  return identity;
}
function signBundle(bundle) {
  const identity=loadIdentity();
  const password=fs.readFileSync(path.join(directory,'password'),'utf8');
  const searchList=run('/usr/bin/security',['list-keychains','-d','user']).trim().split('\n').filter(Boolean).map(line=>JSON.parse(line.trim()));
  try {
    run('/usr/bin/security',['list-keychains','-d','user','-s',...new Set([...searchList,keychain])]);
    run('/usr/bin/security',['unlock-keychain','-p',password,keychain]);
    run('/usr/bin/codesign',['--force','--deep','--timestamp=none','--keychain',keychain,'--sign',identity.fingerprint,bundle]);
    run('/usr/bin/codesign',['--verify','--deep','--strict',bundle]);
  } finally {
    try { run('/usr/bin/security',['lock-keychain',keychain]); }
    finally { run('/usr/bin/security',['list-keychains','-d','user','-s',...searchList]); }
  }
}
module.exports={signBundle,loadIdentity};
if(require.main===module && process.argv.includes('--setup')) {
  try {setupIdentity();console.log('Persistent local signing identity ready. No system trust settings changed.');}
  catch(e){console.error(e.message);process.exitCode=1;}
}
