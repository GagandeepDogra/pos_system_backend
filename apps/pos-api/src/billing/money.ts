// Money is computed in integer paise and stored as 2-dp decimal strings.

/** "20" / "20.5" / 20.5 → 2050 paise. Rejects more than 2 decimals. */
export function toPaise(value: string | number): number {
  const str = typeof value === 'number' ? String(value) : value.trim();
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(str);
  if (!m) throw new Error(`Invalid money amount "${str}"`);
  const paise = Number(m[2]) * 100 + Number((m[3] ?? '').padEnd(2, '0'));
  return m[1] ? -paise : paise;
}

/** 12000 paise → "120.00". */
export function fromPaise(paise: number): string {
  if (!Number.isInteger(paise)) throw new Error(`Paise must be an integer, got ${paise}`);
  const sign = paise < 0 ? '-' : '';
  const abs = Math.abs(paise);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** unit_price × quantity as a 2-dp decimal string. */
export function lineTotal(unitPrice: string, quantity: number): string {
  if (!Number.isInteger(quantity)) throw new Error('Quantity must be a whole number');
  return fromPaise(toPaise(unitPrice) * quantity);
}
