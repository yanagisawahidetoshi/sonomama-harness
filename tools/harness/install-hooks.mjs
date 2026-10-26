import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
if (process.env.CI !== 'true') {
  const root=fileURLToPath(new URL('../../',import.meta.url));
  execFileSync('git',['config','--local','core.hooksPath','.githooks'],{cwd:root,stdio:'inherit'});
  console.log('Repository pre-push quality gate installed.');
}
