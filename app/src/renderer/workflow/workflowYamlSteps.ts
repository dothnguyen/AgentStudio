// Preserve source retry counts: compiled visit limits combine overlapping retries.
export function yamlSteps(text: string): unknown[] | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  let pos = lines.findIndex(line => /^steps\s*:/.test(line));
  if (pos < 0) return undefined;
  function scalar(s: string): any {
    let i = 0;
    const space = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    function read(key = false, flow = false): any {
      space(); const c = s[i];
      if (c === '[' || c === '{') {
        i++; const array = c === '['; const out: any = array ? [] : {};
        space(); while (i < s.length && s[i] !== (array ? ']' : '}')) {
          if (array) out.push(read(false, true)); else { const k = read(true, true); space(); if (s[i++] !== ':') throw Error(); out[k] = read(false, true); }
          space(); if (s[i] !== ',') break; i++;
        }
        if (s[i++] !== (array ? ']' : '}')) throw Error(); return out;
      }
      if (c === '"') { const start = i++; while (i < s.length) { if (s[i++] === '\\') i++; else if (s[i - 1] === '"') break; } return JSON.parse(s.slice(start, i)); }
      if (c === "'") { i++; let out = ''; while (i < s.length) { const ch = s[i++]; if (ch === "'") { if (s[i] === "'") { out += "'"; i++; } else return out; } else out += ch; } throw Error(); }
      const start = i; while (i < s.length && !((flow && ',]}'.includes(s[i])) || (key && s[i] === ':') || (s[i] === '#' && (i === start || /\s/.test(s[i - 1]))))) i++;
      const v = s.slice(start, i).trim(); if (!v) throw Error();
      if (v === 'true') return true; if (v === 'false') return false; if (v === 'null' || v === '~') return null; if (/^(0|-?[1-9]\d*)$/.test(v)) return Number(v); return v;
    }
    const result = read(); space(); if (i < s.length && s[i] !== '#') throw Error(); return result;
  }
  const indent = (s: string) => s.length - s.trimStart().length;
  const skip = () => { while (pos < lines.length && (!lines[pos].trim() || lines[pos].trimStart().startsWith('#'))) pos++; };
  function block(level: number): any {
    skip(); const array = lines[pos]?.slice(level).startsWith('- '); const out: any = array ? [] : {};
    function entry(obj: any, content: string, parent: number) {
      const m = /^([^:]+):(?:\s+(.*)|\s*)$/.exec(content); if (!m) throw Error();
      const key = String(scalar(m[1])); const rest = m[2]?.trim() ?? '';
      if (/^\|-?(?:\s+#.*)?$/.test(rest)) {
        const parts: string[] = []; let n = -1;
        while (pos < lines.length && (!lines[pos].trim() || indent(lines[pos]) > parent)) { if (lines[pos].trim() && n < 0) n = indent(lines[pos]); parts.push(lines[pos].trim() ? lines[pos].slice(n) : ''); pos++; }
        while (parts.at(-1) === '') parts.pop(); obj[key] = parts.join('\n') + (rest.startsWith('|-') ? '' : '\n');
      } else if (rest && !rest.startsWith('#')) obj[key] = scalar(rest);
      else { skip(); obj[key] = pos < lines.length && (indent(lines[pos]) > parent || (indent(lines[pos]) === parent && lines[pos].slice(parent).startsWith('- '))) ? block(indent(lines[pos])) : null; }
    }
    while (pos < lines.length) {
      skip(); if (pos >= lines.length || indent(lines[pos]) !== level) break;
      const line = lines[pos].slice(level); if (array !== line.startsWith('- ')) break; pos++;
      if (!array) entry(out, line, level);
      else { const item = line.slice(2); if (/^[^\[\]{},:]+:(?:\s|$)/.test(item)) { const obj = {}; entry(obj, item, level + 2); skip(); if (pos < lines.length && indent(lines[pos]) === level + 2 && !lines[pos].slice(level + 2).startsWith('- ')) Object.assign(obj, block(level + 2)); out.push(obj); } else out.push(scalar(item)); }
    }
    return out;
  }
  try { const rest = lines[pos++].replace(/^steps\s*:\s*/, ''); skip(); const result = rest && !rest.startsWith('#') ? scalar(rest) : block(indent(lines[pos] ?? '')); skip(); if (pos < lines.length && indent(lines[pos]) > 0) return undefined; return Array.isArray(result) ? result : undefined; } catch { return undefined; }
}
