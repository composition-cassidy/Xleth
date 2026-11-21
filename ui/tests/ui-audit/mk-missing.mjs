// Builds a second temp copy of the project whose external video source points at a file that does not exist (for the Missing media dialog).
// This edits ONLY the temp copy's project.json (a fixture); product code and the user's project are untouched.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const base = path.join(os.tmpdir(), 'xleth-ui-audit');
const src = path.join(base, 'tiki');
const dst = path.join(base, 'tiki-missing');
fs.rmSync(dst, { recursive: true, force: true });
fs.cpSync(src, dst, { recursive: true });
const pj = path.join(dst, 'project.json');
let s = fs.readFileSync(pj, 'utf8');
const jsonEsc = (p) => p.replace(/\\/g, '\\\\');
s = s.split(jsonEsc(src)).join(jsonEsc(dst));
const broken = s.split('tiktok_mi.gato.me.odia_7679606645164494098.mp4').join('tiktok_MISSING_for_audit.mp4');
fs.writeFileSync(pj, broken);
console.log(JSON.stringify({ dst, replaced: s.length !== broken.length }));
