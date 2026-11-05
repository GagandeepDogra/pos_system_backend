import fs from 'fs';
import path from 'path';
import * as shared from '@dhaba/shared';

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return sourceFiles(p);
    return p.endsWith('.ts') && !p.endsWith('.spec.ts') ? [p] : [];
  });
}

describe('shared enums live only in packages/shared (REQ-136)', () => {
  const enumValues = Object.values(shared).filter(Array.isArray) as unknown as readonly (readonly string[])[];

  it('REQ-136: pos-api source declares no enum lists of its own', () => {
    const offenders: string[] = [];
    for (const file of sourceFiles(path.join(__dirname, '..', 'src'))) {
      const text = fs.readFileSync(file, 'utf8');
      if (/\]\s*as const/.test(text) || /^\s*(export\s+)?(const\s+)?enum\s/m.test(text)) offenders.push(file);
      for (const values of enumValues) {
        // A quoted copy of a whole enum list (e.g. 'OPEN', 'BILLED', ...) outside shared.
        const literal = values.map((v) => `'${v}'`).join(', ');
        if (values.length > 1 && text.includes(literal)) offenders.push(`${file}: ${literal}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
