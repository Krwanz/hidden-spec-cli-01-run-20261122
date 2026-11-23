// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.get(p) !== null) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

/** Section 5: three-tier line matching, and the file-lines view sections 5 to 8 share. */

const LEAD_WS = /^[ \t]+/;
const TRAIL_WS = /[ \t]+$/;

function tierKey(line: string, tier: number): string {
  if (tier === 0) return line;
  if (tier === 1) return line.replace(TRAIL_WS, '');
  return line.replace(LEAD_WS, '').replace(TRAIL_WS, '');
}

function leadingWs(line: string): string {
  const m = /^[ \t]*/.exec(line);
  return m === null ? '' : m[0];
}

function findOccurrences(lines: string[], old: string[], tier: number): number[] {
  const out: number[] = [];
  if (old.length === 0 || old.length > lines.length) return out;
  const want = old.map((l) => tierKey(l, tier));
  for (let i = 0; i + old.length <= lines.length; i++) {
    let ok = true;
    for (let j = 0; j < old.length; j++) {
      if (tierKey(lines[i + j]!, tier) !== want[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

interface TierHit {
  tier: number;
  positions: number[];
}

function findTier(lines: string[], old: string[], strict: boolean): TierHit | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(lines, old, t);
    if (positions.length > 0) return { tier: t, positions };
  }
  return null;
}

interface FileView {
  lines: string[];
  br: string;
  final: boolean;
}

function splitFile(text: string): FileView {
  if (text === '') return { lines: [], br: '\n', final: false };
  const nl = text.indexOf('\n');
  const br = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const final = text.endsWith(br);
  if (final) parts.pop();
  return { lines: parts, br, final };
}

function joinFile(f: FileView): string {
  if (f.lines.length === 0) return '';
  return f.lines.join(f.br) + (f.final ? f.br : '');
}

/** One line of a replacement: a context line names its index in the old lines, a new line names none. */
interface NewLine {
  text: string;
  ctx: number | null;
}

function renderNew(n: NewLine[], matched: string[], old: string[], tier: number): string[] {
  const out: string[] = [];
  if (tier === 2 && old.length > 0) {
    const f = leadingWs(matched[0]!);
    const p = leadingWs(old[0]!);
    for (const e of n) {
      if (e.ctx !== null) {
        out.push(matched[e.ctx]!);
        continue;
      }
      const t = e.text;
      if (t !== '' && t.trim() !== '' && t.startsWith(p)) out.push(f + t.slice(p.length));
      else out.push(t);
    }
    return out;
  }
  for (const e of n) out.push(e.ctx !== null ? matched[e.ctx]! : e.text);
  return out;
}

/** A body line of a unified hunk or a V4A chunk: ' ' context, '-' old, '+' new, '\' marker. */
interface BodyLine {
  kind: ' ' | '-' | '+' | '\\';
  text: string;
}

function bodyToOldNew(body: BodyLine[]): { o: string[]; n: NewLine[] } {
  const o: string[] = [];
  const n: NewLine[] = [];
  for (const b of body) {
    if (b.kind === ' ') {
      o.push(b.text);
      n.push({ text: b.text, ctx: o.length - 1 });
    } else if (b.kind === '-') o.push(b.text);
    else if (b.kind === '+') n.push({ text: b.text, ctx: null });
  }
  return { o, n };
}

/** A `\` line follows the hunk's last context or `+` line (the last `+` line for a created file). */
function backslashAfter(body: BodyLine[], plusOnly: boolean): boolean {
  let last = -1;
  for (let k = 0; k < body.length; k++) {
    const kind = body[k]!.kind;
    if (kind === '+' || (!plusOnly && kind === ' ')) last = k;
  }
  return last >= 0 && body[last + 1] !== undefined && body[last + 1]!.kind === '\\';
}

/** Moves a move edit performed, so the output can print `R <old> -> <new>` for them. */
const movedPairs: [string, string][] = [];
function noteMove(oldP: string, newP: string): void {
  movedPairs.push([oldP, newP]);
}

/** Section 6: unified diffs. */

interface Hunk {
  a: number;
  body: BodyLine[];
  o: string[];
  n: NewLine[];
  noEol: boolean;
  plusNoEol: boolean;
}

interface DiffSection {
  oldP?: string;
  newP?: string;
  renameFrom?: string;
  renameTo?: string;
  diffOld?: string;
  diffNew?: string;
  createMode: boolean;
  deleteMode: boolean;
  hunks: Hunk[];
}

function headerPath(line: string): string {
  let p = line.slice(4);
  const tab = p.indexOf('\t');
  if (tab >= 0) p = p.slice(0, tab);
  p = p.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

function parseUnified(lines: string[]): DiffSection[] {
  const sections: DiffSection[] = [];
  let sec: DiffSection | null = null;
  let hunk: Hunk | null = null;
  let inHeader = false;
  let havePair = false;
  const freshSection = (): DiffSection => ({ createMode: false, deleteMode: false, hunks: [] });
  const closeHunk = (): void => {
    if (hunk === null || sec === null) return;
    while (hunk.body.length > 0) {
      const last = hunk.body[hunk.body.length - 1]!;
      if (last.kind === ' ' && last.text === '') hunk.body.pop();
      else break;
    }
    const built = bodyToOldNew(hunk.body);
    hunk.o = built.o;
    hunk.n = built.n;
    hunk.noEol = backslashAfter(hunk.body, false);
    hunk.plusNoEol = backslashAfter(hunk.body, true);
    sec.hunks.push(hunk);
    hunk = null;
  };
  const closeSection = (): void => {
    closeHunk();
    if (sec !== null) sections.push(sec);
    sec = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const next = lines[i + 1];
    if (line.startsWith('diff --git ')) {
      closeSection();
      const m = /^diff --git a\/([^ ]+) b\/(.+)$/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      sec = freshSection();
      sec.diffOld = m[1]!;
      sec.diffNew = m[2]!.trim();
      if (sec.diffOld === '' || sec.diffNew === '') throw new Exit2(`error: parse ${i + 1}`);
      inHeader = true;
      havePair = false;
      continue;
    }
    if (line.startsWith('--- ') && next !== undefined && next.startsWith('+++ ')) {
      closeHunk();
      const oldP = headerPath(line);
      const newP = headerPath(next);
      if (sec === null || !inHeader || havePair) {
        if (sec !== null) sections.push(sec);
        sec = freshSection();
        inHeader = true;
        havePair = false;
      }
      sec.oldP = oldP;
      sec.newP = newP;
      havePair = true;
      i++;
      continue;
    }
    if (line.startsWith('@@')) {
      if (sec === null) throw new Exit2(`error: parse ${i + 1}`);
      const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
      if (m === null) throw new Exit2(`error: parse ${i + 1}`);
      closeHunk();
      hunk = { a: Number(m[1]), body: [], o: [], n: [], noEol: false, plusNoEol: false };
      inHeader = false;
      continue;
    }
    if (hunk !== null) {
      if (line === '' || line[0] === ' ' || line[0] === '-' || line[0] === '+' || line[0] === '\\') {
        hunk.body.push({ kind: line === '' ? ' ' : (line[0] as ' ' | '-' | '+' | '\\'), text: line === '' ? '' : line.slice(1) });
        continue;
      }
      closeHunk();
    }
    if (sec !== null && inHeader) {
      if (line.startsWith('--- ')) throw new Exit2(`error: parse ${i + 2}`);
      if (line.startsWith('rename from ')) sec.renameFrom = line.slice('rename from '.length).trim();
      else if (line.startsWith('rename to ')) sec.renameTo = line.slice('rename to '.length).trim();
      else if (line.startsWith('new file mode')) sec.createMode = true;
      else if (line.startsWith('deleted file mode')) sec.deleteMode = true;
    }
  }
  closeSection();
  return sections;
}

function applyHunks(text: string, hunks: Hunk[], failPath: string, strict: boolean): string {
  const f = splitFile(text);
  let d = 0;
  for (const h of hunks) {
    if (h.o.length === 0) {
      let pos = h.a + d;
      if (pos < 0) pos = 0;
      if (pos > f.lines.length) pos = f.lines.length;
      const ins = h.n.map((e) => e.text);
      const atEnd = pos === f.lines.length;
      f.lines.splice(pos, 0, ...ins);
      if (atEnd) f.final = !h.noEol;
      d += h.n.length;
      continue;
    }
    const found = findTier(f.lines, h.o, strict);
    if (found === null) throw new Fail('no-match', failPath);
    const target = h.a - 1 + d;
    let best = found.positions[0]!;
    let bestDist = Math.abs(best - target);
    for (const p of found.positions) {
      const dist = Math.abs(p - target);
      if (dist < bestDist) {
        best = p;
        bestDist = dist;
      }
    }
    const atEnd = best + h.o.length === f.lines.length;
    const matched = f.lines.slice(best, best + h.o.length);
    const rep = renderNew(h.n, matched, h.o, found.tier);
    f.lines.splice(best, h.o.length, ...rep);
    if (atEnd) f.final = !h.noEol;
    d += h.n.length - h.o.length;
  }
  return joinFile(f);
}

function unifiedSectionEdit(sec: DiffSection, strict: boolean): Edit {
  return (tree) => {
    const oldP = sec.oldP ?? sec.renameFrom ?? sec.diffOld ?? sec.newP ?? sec.renameTo ?? sec.diffNew ?? '';
    const newP = sec.newP ?? sec.renameTo ?? sec.diffNew ?? sec.oldP ?? sec.renameFrom ?? sec.diffOld ?? '';
    const isCreate = oldP === '/dev/null' || sec.createMode;
    const isDelete = !isCreate && (newP === '/dev/null' || sec.deleteMode);
    if (isCreate) {
      if (!safe(newP)) throw new Fail('unsafe', newP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const added: string[] = [];
      let noBreak = false;
      for (const h of sec.hunks) {
        let hasPlus = false;
        for (const e of h.n) {
          if (e.ctx === null) {
            added.push(e.text);
            hasPlus = true;
          }
        }
        if (hasPlus) noBreak = h.plusNoEol;
      }
      tree.now.set(newP, added.length === 0 ? '' : added.join('\n') + (noBreak ? '' : '\n'));
      return;
    }
    if (isDelete) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (tree.get(oldP) === null) throw new Fail('missing', oldP);
      tree.now.set(oldP, null);
      return;
    }
    if (oldP !== newP) {
      if (!safe(oldP)) throw new Fail('unsafe', oldP);
      if (!safe(newP)) throw new Fail('unsafe', newP);
      const before = tree.get(oldP);
      if (before === null) throw new Fail('missing', oldP);
      if (tree.get(newP) !== null) throw new Fail('exists', newP);
      const out = applyHunks(before, sec.hunks, oldP, strict);
      tree.now.set(newP, out);
      tree.now.set(oldP, null);
      noteMove(oldP, newP);
      return;
    }
    if (!safe(oldP)) throw new Fail('unsafe', oldP);
    const before = tree.get(oldP);
    if (before === null) throw new Fail('missing', oldP);
    tree.now.set(oldP, applyHunks(before, sec.hunks, oldP, strict));
  };
}

function unifiedEdits(lines: string[], strict: boolean): Edit[] {
  return parseUnified(lines).map((sec) => unifiedSectionEdit(sec, strict));
}

/** Section 7: SEARCH/REPLACE blocks. */

function searchReplaceEdit(path: string, oldLines: string[], newLines: string[], strict: boolean): Edit {
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (oldLines.length === 0) {
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      return;
    }
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    const f = splitFile(text);
    const found = findTier(f.lines, oldLines, strict);
    if (found === null) throw new Fail('no-match', path);
    if (found.positions.length > 1) throw new Fail('ambiguous', path);
    const pos = found.positions[0]!;
    const matched = f.lines.slice(pos, pos + oldLines.length);
    const n: NewLine[] = newLines.map((t) => ({ text: t, ctx: null }));
    const rep = renderNew(n, matched, oldLines, found.tier);
    f.lines.splice(pos, oldLines.length, ...rep);
    tree.now.set(path, joinFile(f));
  };
}

function searchReplaceEdits(lines: string[], strict: boolean): Edit[] {
  const edits: Edit[] = [];
  let prevEnd = 0;
  let prevPath: string | null = null;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trimEnd() !== '<<<<<<< SEARCH') continue;
    let path: string | null = null;
    for (let j = i - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) {
      if (prevPath === null) throw new Exit2(`error: parse ${i + 1}`);
      path = prevPath;
    }
    let eq = -1;
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j]!.trimEnd() === '=======') {
        eq = j;
        break;
      }
    }
    let rep = -1;
    if (eq >= 0) {
      for (let j = eq + 1; j < lines.length; j++) {
        if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
          rep = j;
          break;
        }
      }
    }
    if (eq < 0 || rep < 0) throw new Exit2(`error: parse ${i + 1}`);
    const oldLines = lines.slice(i + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    edits.push(searchReplaceEdit(path, oldLines, newLines, strict));
    prevEnd = rep + 1;
    prevPath = path;
    i = rep;
  }
  return edits;
}

/** Section 8: V4A patches. */

interface V4aChunk {
  anchor: string | null;
  body: BodyLine[];
  eof: boolean;
  o: string[];
  n: NewLine[];
}

function parseV4aChunks(raw: { text: string; num: number }[]): V4aChunk[] {
  const chunks: V4aChunk[] = [];
  let cur: V4aChunk | null = null;
  const close = (): void => {
    if (cur === null) return;
    const built = bodyToOldNew(cur.body);
    cur.o = built.o;
    cur.n = built.n;
    chunks.push(cur);
    cur = null;
  };
  for (const r of raw) {
    const l = r.text;
    if (l.startsWith('@@')) {
      close();
      const anchor = l.slice(2).trim();
      cur = { anchor: anchor === '' ? null : anchor, body: [], eof: false, o: [], n: [] };
      continue;
    }
    if (l === '*** End of File') {
      if (cur === null) throw new Exit2(`error: parse ${r.num}`);
      cur.eof = true;
      close();
      continue;
    }
    if (l === '' || l[0] === ' ' || l[0] === '-' || l[0] === '+') {
      if (cur === null) {
        if (chunks.length > 0) throw new Exit2(`error: parse ${r.num}`);
        cur = { anchor: null, body: [], eof: false, o: [], n: [] };
      }
      cur.body.push({ kind: l === '' ? ' ' : (l[0] as ' ' | '-' | '+'), text: l === '' ? '' : l.slice(1) });
      continue;
    }
    throw new Exit2(`error: parse ${r.num}`);
  }
  close();
  return chunks;
}

function findAnchor(lines: string[], anchor: string, cursor: number, strict: boolean): number {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const key = tierKey(anchor, t);
    for (let i = cursor; i < lines.length; i++) {
      if (tierKey(lines[i]!, t) === key) return i;
    }
  }
  return -1;
}

function findFrom(lines: string[], old: string[], cursor: number, strict: boolean, eof: boolean): { tier: number; pos: number } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const positions = findOccurrences(lines, old, t).filter((p) => p >= cursor && (!eof || p + old.length === lines.length));
    if (positions.length > 0) return { tier: t, pos: positions[0]! };
  }
  return null;
}

function v4aSectionEdit(kind: 'add' | 'delete' | 'update', path: string, raw: { text: string; num: number }[], headerNum: number, strict: boolean): Edit {
  if (kind === 'add') {
    const content: string[] = [];
    for (const r of raw) {
      if (r.text === '') content.push('');
      else if (r.text.startsWith('+')) content.push(r.text.slice(1));
      else throw new Exit2(`error: parse ${r.num}`);
    }
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) !== null) throw new Fail('exists', path);
      tree.now.set(path, content.length === 0 ? '' : content.join('\n') + '\n');
    };
  }
  if (kind === 'delete') {
    for (const r of raw) throw new Exit2(`error: parse ${r.num}`);
    return (tree) => {
      if (!safe(path)) throw new Fail('unsafe', path);
      if (tree.get(path) === null) throw new Fail('missing', path);
      tree.now.set(path, null);
    };
  }
  let moveTo: string | null = null;
  let rest = raw;
  if (rest.length > 0 && rest[0]!.text.startsWith('*** Move to: ')) {
    moveTo = rest[0]!.text.slice('*** Move to: '.length).trim();
    rest = rest.slice(1);
  }
  const chunks = parseV4aChunks(rest);
  if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${headerNum}`);
  return (tree) => {
    if (!safe(path)) throw new Fail('unsafe', path);
    if (moveTo !== null && !safe(moveTo)) throw new Fail('unsafe', moveTo);
    const text = tree.get(path);
    if (text === null) throw new Fail('missing', path);
    if (moveTo !== null && tree.get(moveTo) !== null) throw new Fail('exists', moveTo);
    const f = splitFile(text);
    let cursor = 0;
    for (const ch of chunks) {
      if (ch.anchor !== null) {
        const at = findAnchor(f.lines, ch.anchor, cursor, strict);
        if (at < 0) throw new Fail('no-match', path);
        cursor = at + 1;
      }
      if (ch.o.length === 0) {
        const pos = ch.eof ? f.lines.length : cursor;
        const ins = ch.n.map((e) => e.text);
        f.lines.splice(pos, 0, ...ins);
        cursor = pos + ins.length;
        continue;
      }
      const found = findFrom(f.lines, ch.o, cursor, strict, ch.eof);
      if (found === null) throw new Fail('no-match', path);
      const matched = f.lines.slice(found.pos, found.pos + ch.o.length);
      const rep = renderNew(ch.n, matched, ch.o, found.tier);
      f.lines.splice(found.pos, ch.o.length, ...rep);
      cursor = found.pos + rep.length;
    }
    const out = joinFile(f);
    if (moveTo !== null) {
      tree.now.set(moveTo, out);
      tree.now.set(path, null);
      noteMove(path, moveTo);
    } else {
      tree.now.set(path, out);
    }
  };
}

function v4aEdits(lines: string[], strict: boolean): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = lines.length - 1;
  while (last >= 0 && blank(lines[last]!)) last--;
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  let i = first + 1;
  while (i < last) {
    const line = lines[i]!;
    if (blank(line)) {
      i++;
      continue;
    }
    let kind: 'add' | 'delete' | 'update';
    let path: string;
    if (line.startsWith('*** Add File: ')) {
      kind = 'add';
      path = line.slice('*** Add File: '.length).trim();
    } else if (line.startsWith('*** Delete File: ')) {
      kind = 'delete';
      path = line.slice('*** Delete File: '.length).trim();
    } else if (line.startsWith('*** Update File: ')) {
      kind = 'update';
      path = line.slice('*** Update File: '.length).trim();
    } else throw new Exit2(`error: parse ${i + 1}`);
    const headerNum = i + 1;
    const raw: { text: string; num: number }[] = [];
    i++;
    while (i < last) {
      const l = lines[i]!;
      if (l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ')) break;
      raw.push({ text: l, num: i + 1 });
      i++;
    }
    while (raw.length > 0 && blank(raw[raw.length - 1]!.text)) raw.pop();
    edits.push(v4aSectionEdit(kind, path, raw, headerNum, strict));
  }
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let edits: Edit[];
  try {
    edits = kind === 'json' ? jsonEdits(text, lines) : kind === 'unified' ? unifiedEdits(lines, strict) : kind === 'search-replace' ? searchReplaceEdits(lines, strict) : v4aEdits(lines, strict);
    if (edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const changed: { path: string; was: string | null; now: string | null }[] = [];
  for (const p of tree.now.keys()) {
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was !== now) changed.push({ path: p, was, now });
  }
  const consumed = new Set<string>();
  const rows: { key: string; line: string; ops: { path: string; content: string | null }[] }[] = [];
  for (const [oldP, newP] of movedPairs) {
    if (consumed.has(oldP) || consumed.has(newP)) continue;
    const oldC = changed.find((c) => c.path === oldP);
    const newC = changed.find((c) => c.path === newP);
    if (oldC !== undefined && newC !== undefined && oldC.was !== null && oldC.now === null && newC.was === null && newC.now !== null) {
      consumed.add(oldP);
      consumed.add(newP);
      rows.push({ key: newP, line: `R ${oldP} -> ${newP}`, ops: [{ path: oldP, content: null }, { path: newP, content: newC.now }] });
    }
  }
  for (const c of changed) {
    if (consumed.has(c.path)) continue;
    rows.push({ key: c.path, line: `${c.was === null ? 'A' : c.now === null ? 'D' : 'M'} ${c.path}`, ops: [{ path: c.path, content: c.now }] });
  }
  rows.sort((x, y) => Buffer.compare(Buffer.from(x.key), Buffer.from(y.key)));
  if (!check) {
    for (const r of rows) {
      for (const op of r.ops) {
        if (op.content === null) rmSync(op.path, { force: true });
        else {
          mkdirSync(dirname(op.path), { recursive: true });
          writeFileSync(op.path, op.content);
        }
      }
    }
  }
  return { code: 0, out: [...rows.map((r) => r.line), `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}
