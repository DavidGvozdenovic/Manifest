// Links packages/ai-panel into the user's CEP extensions folder and enables unsigned panels (PlayerDebugMode).
import { execSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const ID = 'com.f2a.illustrator';
const source = resolve('packages/ai-panel');

const extensions =
  process.platform === 'win32'
    ? join(process.env.APPDATA, 'Adobe', 'CEP', 'extensions')
    : join(homedir(), 'Library', 'Application Support', 'Adobe', 'CEP', 'extensions');

mkdirSync(extensions, { recursive: true });
const target = join(extensions, ID);

if (existsSync(target) || lstatSync(target, { throwIfNoEntry: false })) {
  if (!lstatSync(target).isSymbolicLink()) throw new Error(`${target} exists and is not a link; remove it manually.`);
  unlinkSync(target);
}
symlinkSync(source, target, process.platform === 'win32' ? 'junction' : 'dir');
console.log(`Linked ${target} -> ${source}`);

for (const v of [9, 10, 11, 12]) {
  if (process.platform === 'win32') {
    execSync(`reg add "HKCU\\Software\\Adobe\\CSXS.${v}" /v PlayerDebugMode /t REG_SZ /d 1 /f`, { stdio: 'ignore' });
  } else {
    execSync(`defaults write com.adobe.CSXS.${v} PlayerDebugMode 1`);
  }
}
console.log('PlayerDebugMode enabled (dev only). Restart Illustrator — F2A starts in the background, or open Window > Extensions > F2A.');
