import { fromPaise, lineTotal, toPaise } from './money';

describe('money in paise (REQ-102)', () => {
  it('converts decimal strings and numbers to paise', () => {
    expect(toPaise('20')).toBe(2000);
    expect(toPaise('20.5')).toBe(2050);
    expect(toPaise(0.07)).toBe(7);
    expect(toPaise('-1.25')).toBe(-125);
    expect(() => toPaise('1.234')).toThrow(/Invalid money/);
  });

  it('formats paise as 2-dp strings', () => {
    expect(fromPaise(12000)).toBe('120.00');
    expect(fromPaise(5)).toBe('0.05');
    expect(fromPaise(-125)).toBe('-1.25');
    expect(() => fromPaise(1.5)).toThrow(/integer/);
  });

  it('REQ-099: line total is unit price × quantity without float drift', () => {
    expect(lineTotal('20.00', 6)).toBe('120.00');
    expect(lineTotal('0.10', 3)).toBe('0.30');
    expect(() => lineTotal('20', 1.5)).toThrow(/whole number/);
  });
});
