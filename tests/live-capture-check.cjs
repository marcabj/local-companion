// Run while the installed app listens to the chosen known speech fixture.
// Reads only the current session, reporting counts rather than transcript content.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
async function main() {
  const pattern = new RegExp(process.argv[2] || 'college|graduation|three stories|connecting the dots', 'i');
  const source = process.argv[3] || 'Computer';
  const deadline = Date.now() + 25000;
  let lines = [];
  do {
    const data = JSON.parse(await fs.readFile(path.join(os.homedir(), 'Library/Application Support/Local Companion/history.json'), 'utf8'));
    lines = data.sessions[0].transcript.filter(t => t.source === source);
    if (lines.length >= 2 && pattern.test(lines.map(t => t.text).join(' '))) {
      console.log(`PASS: ${lines.length} ${source} segments; expected speech recognized.`);
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  } while (Date.now() < deadline);
  assert.fail(`Live capture failed: ${lines.length} ${source} segments; expected speech not recognized.`);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
