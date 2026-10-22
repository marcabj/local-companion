const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { packager } = require('@electron/packager');
const { signBundle, loadIdentity } = require('./signing.cjs');
async function main() {
  const project = path.resolve(__dirname, '..'); process.chdir(project);
  loadIdentity(); // Fail before replacing the app if its persistent identity is missing.
  fs.mkdirSync('.build', { recursive: true });
  execFileSync('/usr/bin/xcrun', ['swiftc', '-parse-as-library', '-swift-version', '5', '-O', '-module-cache-path', '.build/module-cache', '-framework', 'AppKit', '-framework', 'AVFoundation', '-framework', 'CoreAudio', 'native/Capture.swift', '-o', '.build/CompanionCapture'], { stdio: 'inherit' });
  fs.writeFileSync('runtime.json', JSON.stringify({ project }));
  const paths = await packager({ dir: project, name: 'Local Companion', appBundleId: 'local.marc.companion', platform: 'darwin', arch: 'arm64', out: '.build/package', overwrite: true, asar: false, prune: true,
    ignore: [/^\/\.analysis/, /^\/\.build/, /^\/\.venv/, /^\/\.git/, /^\/tests/, /^\/native/],
    extraResource: ['.build/CompanionCapture'],
    extendInfo: { NSMicrophoneUsageDescription: 'Transcribe your microphone locally with Parakeet when you start listening.', NSScreenCaptureUsageDescription: 'Attach a screenshot when you request screen context.', NSAudioCaptureUsageDescription: 'Transcribe computer audio locally when you start listening.', LSMinimumSystemVersion: '15.0' }
  });
  const packaged = path.join(paths[0], 'Local Companion.app');
  signBundle(path.join(packaged, 'Contents/Resources/CompanionCapture'));
  signBundle(packaged);
  const destination = path.join(os.homedir(), 'Applications', 'Local Companion.app');
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  if (fs.existsSync(destination)) fs.rmSync(destination, { recursive: true });
  fs.cpSync(packaged, destination, { recursive: true, verbatimSymlinks: true });
  execFileSync('/usr/bin/codesign', ['--verify', '--deep', '--strict', destination], { stdio: 'inherit' });
  console.log(`Built ${destination}`);
}
main().catch(e => { console.error(e.message); process.exitCode = 1; });
