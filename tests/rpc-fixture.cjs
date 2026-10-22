const { createInterface } = require('node:readline');
createInterface({ input: process.stdin }).on('line', line => {
  const m = JSON.parse(line);
  if (m.method === 'hang') return;
  if (m.method === 'exit') return process.exit(7);
  if (m.method === 'fail') return process.stdout.write(JSON.stringify({ id: m.id, error: { message: 'Deliberate failure' } }) + '\n');
  process.stdout.write('{"method":"progress","params":{"text":"hello"}}\n');
  const response = JSON.stringify({ id: m.id, result: m.params }) + '\n';
  process.stdout.write(response.slice(0, 7));
  setTimeout(() => process.stdout.write(response.slice(7)), 10);
});
