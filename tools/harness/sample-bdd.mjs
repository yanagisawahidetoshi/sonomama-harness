import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
// Trusted acceptance assertions live outside the agent writable directory.
try {
  const { greet } = await import(pathToFileURL(join(process.argv[2], 'greeting.mjs')));
  const scenarios = [
    ['AC-1', 'Given a name, When greeting, Then use Japanese', () => assert.equal(greet('太郎'), 'こんにちは、太郎さん')],
    ['AC-2', 'Given padded name, When greeting, Then trim whitespace', () => assert.equal(greet(' 太郎 '), 'こんにちは、太郎さん')],
    ['AC-3', 'Given missing name, When greeting, Then use guest', () => {
      for (const name of ['', '  ', undefined]) assert.equal(greet(name), 'こんにちは、ゲストさん');
    }],
  ];
  const acceptance = [];
  for (const [id, name, test] of scenarios) { test(); acceptance.push(id); console.error(`PASS ${id}: ${name}`); }
  console.log(JSON.stringify({ acceptance }));
} catch (error) { console.error(error.stack); process.exitCode = 1; }
