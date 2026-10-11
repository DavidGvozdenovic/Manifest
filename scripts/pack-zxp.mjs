// Builds dist/F2A-<version>.zxp from packages/ai-panel. Signs when ZXPSignCmd + cert env vars are set.
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zipStore } from './zip-store.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'packages', 'ai-panel');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version ?? '0.1.0';
const skip = new Set(['.debug', '.DS_Store']);

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (skip.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

const files = walk(source).map((full) => ({
  name: relative(source, full).replace(/\\/g, '/'),
  data: readFileSync(full),
}));

const dist = join(root, 'dist');
mkdirSync(dist, { recursive: true });
const zxp = join(dist, `F2A-${version}.zxp`);
writeFileSync(zxp, zipStore(files));
console.log(`Wrote ${zxp} (${files.length} files, unsigned)`);

const cert = process.env.F2A_ZXP_CERT;
const pass = process.env.F2A_ZXP_PASS ?? '';
const signCmd = process.env.ZXPSIGNCMD || 'ZXPSignCmd';
if (cert && existsSync(cert)) {
  const staging = join(dist, 'zxp-staging');
  rmSync(staging, { recursive: true, force: true });
  mkdirSync(staging, { recursive: true });
  for (const file of files) {
    const dest = join(staging, file.name);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.data);
  }
  const signed = join(dist, `F2A-${version}-signed.zxp`);
  try {
    execFileSync(signCmd, ['-sign', staging, signed, cert, pass], { stdio: 'inherit' });
    cpSync(signed, zxp);
    console.log(`Signed ${signed}`);
    console.log(`Public file: ${zxp}`);
  } catch (e) {
    console.warn('Signing failed. Install ZXPSignCmd and set F2A_ZXP_CERT / F2A_ZXP_PASS.');
    console.warn(e.message);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
} else {
  console.log('No F2A_ZXP_CERT set — shipping an unsigned .zxp. Sign before a public GitHub Release.');
  console.log('See docs/publish.md');
}
