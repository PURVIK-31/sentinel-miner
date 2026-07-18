import { describe, it, expect } from 'vitest';
import { NormalizationError } from '@sentinel/shared';
import { toScaledInteger, toBasisPoints, toWholeUnits } from './decimal.js';

describe('float-representation regressions', () => {
  /**
   * These are the cases that motivated exact decimal arithmetic. Each one is a
   * value where `parseFloat(x) * 10000` lands just off the true product, so a
   * naive ceil or floor fabricates or loses a basis point.
   */
  it.each([
    // input   expected bp   what the float product actually is
    ['0.07', 700, '700.0000000000001'],
    ['0.29', 2900, '2900.0000000000005'],
    ['0.57', 5700, '5699.999999999999'],
    ['0.145', 1450, '1450.0000000000002'],
    ['1.005', 10050, '10049.999999999998'],
  ])('converts %s to exactly %i basis points (float gives %s)', (input, expected) => {
    // Both directions must agree: the value is exact, so there is nothing to round.
    expect(toBasisPoints(input, 'ceil')).toBe(expected);
    expect(toBasisPoints(input, 'floor')).toBe(expected);
  });

  it('never rounds up a value that is exactly representable in basis points', () => {
    // The naive implementation turns a 7% tax into 7.01%, which is enough to
    // flip a decision at a 700bp threshold.
    expect(toBasisPoints('0.07', 'ceil')).toBe(700);
    expect(toBasisPoints('0.07', 'ceil')).not.toBe(701);
  });

  it('does not inherit float error when the input arrives as a number', () => {
    expect(toBasisPoints(0.07, 'ceil')).toBe(700);
    expect(toBasisPoints(0.57, 'floor')).toBe(5700);
  });
});

describe('toBasisPoints — rounding direction', () => {
  it('rounds a genuinely imprecise rate up, overstating the cost', () => {
    // 0.070001 is 700.01bp; a tax must never be understated.
    expect(toBasisPoints('0.070001', 'ceil')).toBe(701);
  });

  it('rounds the same rate down under floor', () => {
    expect(toBasisPoints('0.070001', 'floor')).toBe(700);
  });

  it('converts common tax rates exactly', () => {
    expect(toBasisPoints('0', 'ceil')).toBe(0);
    expect(toBasisPoints('0.01', 'ceil')).toBe(100);
    expect(toBasisPoints('0.025', 'ceil')).toBe(250);
    expect(toBasisPoints('0.05', 'ceil')).toBe(500);
    expect(toBasisPoints('1', 'ceil')).toBe(10000);
  });

  it('keeps sub-basis-point precision from vanishing silently', () => {
    // 0.000001 is a hundredth of a basis point. Under ceil it must become 1bp,
    // not 0 — otherwise a nonzero tax reads as no tax at all.
    expect(toBasisPoints('0.000001', 'ceil')).toBe(1);
    expect(toBasisPoints('0.000001', 'floor')).toBe(0);
  });
});

describe('toWholeUnits — rounding direction', () => {
  it('floors a fractional amount, understating available liquidity', () => {
    expect(toWholeUnits('4200.99', 'floor')).toBe(4200);
    expect(toWholeUnits('4200.01', 'floor')).toBe(4200);
  });

  it('ceils a fractional amount when overstating is the safe direction', () => {
    expect(toWholeUnits('4200.01', 'ceil')).toBe(4201);
  });

  it('leaves whole amounts untouched in both directions', () => {
    expect(toWholeUnits('4200', 'floor')).toBe(4200);
    expect(toWholeUnits('4200', 'ceil')).toBe(4200);
    expect(toWholeUnits('4200.000', 'ceil')).toBe(4200);
  });

  it('floors a value just below one to zero rather than up', () => {
    // A pool holding $0.99 must not read as $1 of liquidity.
    expect(toWholeUnits('0.99', 'floor')).toBe(0);
    expect(toWholeUnits('0.99', 'ceil')).toBe(1);
  });
});

describe('boundary values', () => {
  it('handles zero identically in both directions and never yields -0', () => {
    for (const mode of ['floor', 'ceil'] as const) {
      expect(toScaledInteger('0', 4, mode)).toBe(0);
      expect(toScaledInteger('0.0', 4, mode)).toBe(0);
      expect(toScaledInteger('-0', 4, mode)).toBe(0);
      // Object.is distinguishes -0 from 0, which would destabilise hashing.
      expect(Object.is(toScaledInteger('-0.0', 0, mode), -0)).toBe(false);
    }
  });

  it('rounds negatives toward the correct extreme, not toward zero', () => {
    // floor goes to -inf, ceil goes to +inf. Getting this backwards on negative
    // values is the classic truncation bug.
    expect(toWholeUnits('-1.5', 'floor')).toBe(-2);
    expect(toWholeUnits('-1.5', 'ceil')).toBe(-1);
    expect(toWholeUnits('-0.5', 'floor')).toBe(-1);
    expect(toWholeUnits('-0.5', 'ceil')).toBe(0);
  });

  it('does not round an exact negative', () => {
    expect(toWholeUnits('-2', 'floor')).toBe(-2);
    expect(toWholeUnits('-2', 'ceil')).toBe(-2);
  });

  it('accepts a value at the safe-integer boundary', () => {
    expect(toScaledInteger(String(Number.MAX_SAFE_INTEGER), 0, 'floor')).toBe(
      Number.MAX_SAFE_INTEGER,
    );
    expect(toScaledInteger(String(Number.MIN_SAFE_INTEGER), 0, 'ceil')).toBe(
      Number.MIN_SAFE_INTEGER,
    );
  });

  it('rejects a value one past the safe-integer boundary', () => {
    expect(() => toScaledInteger('9007199254740992', 0, 'floor')).toThrow(NormalizationError);
  });

  it('rejects a scaled result that overflows even though the input did not', () => {
    // 1e15 is fine as a number but becomes 1e19 basis points.
    expect(() => toBasisPoints('1000000000000000', 'ceil')).toThrow(NormalizationError);
  });

  it('carries very long decimals without precision loss', () => {
    // Well beyond what a double could represent, handled exactly via BigInt.
    expect(toScaledInteger('123456789012345.678901234', 0, 'floor')).toBe(123456789012345);
  });

  it('treats a long run of zeros in the discarded digits as exact', () => {
    expect(toWholeUnits('7.00000000000000000001', 'ceil')).toBe(8);
    expect(toWholeUnits('7.00000000000000000000', 'ceil')).toBe(7);
  });
});

describe('input formats', () => {
  it('accepts scientific notation, which String() produces for small numbers', () => {
    expect(String(0.0000001)).toBe('1e-7');
    expect(toBasisPoints(0.0000001, 'ceil')).toBe(1);
    expect(toBasisPoints(0.0000001, 'floor')).toBe(0);
  });

  it('accepts scientific notation with a positive exponent', () => {
    expect(toWholeUnits('1.5e3', 'floor')).toBe(1500);
    expect(toWholeUnits(1e3, 'floor')).toBe(1000);
  });

  it('accepts an explicit positive sign', () => {
    expect(toWholeUnits('+42', 'floor')).toBe(42);
  });

  it('accepts values with no integer part and no fractional part', () => {
    expect(toWholeUnits('.5', 'ceil')).toBe(1);
    expect(toWholeUnits('5.', 'ceil')).toBe(5);
  });

  it('accepts surrounding whitespace from a sloppy provider', () => {
    expect(toWholeUnits('  42  ', 'floor')).toBe(42);
  });

  it('preserves leading zeros without misreading them as octal', () => {
    expect(toWholeUnits('0042', 'floor')).toBe(42);
  });
});

describe('rejection', () => {
  it('rejects exponent notation carrying no digits', () => {
    expect(() => toWholeUnits('e5', 'floor')).toThrow(NormalizationError);
    expect(() => toWholeUnits('.e5', 'floor')).toThrow(NormalizationError);
  });

  it.each(['', '   ', 'abc', '1.2.3', '--1', '1,000', 'NaN', 'Infinity', '0x10', '1e', '.'])(
    'rejects the malformed input %s',
    (input) => {
      expect(() => toWholeUnits(input, 'floor')).toThrow(NormalizationError);
    },
  );

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    'rejects the non-finite number %s',
    (input) => {
      expect(() => toWholeUnits(input, 'floor')).toThrow(NormalizationError);
    },
  );

  it('rejects a negative or fractional scale', () => {
    expect(() => toScaledInteger('1', -1, 'floor')).toThrow(NormalizationError);
    expect(() => toScaledInteger('1', 1.5, 'floor')).toThrow(NormalizationError);
  });

  it('reports the offending value in the error details for debugging', () => {
    try {
      toWholeUnits('not a number', 'floor');
      expect.unreachable('expected a NormalizationError');
    } catch (error) {
      expect(error).toBeInstanceOf(NormalizationError);
      expect((error as NormalizationError).details).toMatchObject({ value: 'not a number' });
    }
  });
});

describe('determinism', () => {
  it('returns an identical result across repeated conversions', () => {
    const inputs = ['0.07', '4200.99', '-1.5', '1e-7', '0'];
    for (const input of inputs) {
      const first = toBasisPoints(input, 'ceil');
      for (let i = 0; i < 100; i += 1) {
        expect(toBasisPoints(input, 'ceil')).toBe(first);
      }
    }
  });

  it('always produces a safe integer, which the engine requires', () => {
    const inputs = ['0.07', '4200.99', '-1.5', '1e-7', '0', '0.000001'];
    for (const input of inputs) {
      for (const mode of ['floor', 'ceil'] as const) {
        expect(Number.isSafeInteger(toBasisPoints(input, mode))).toBe(true);
      }
    }
  });

  it('agrees with Math.floor and Math.ceil wherever floats are exact', () => {
    // Cross-check against the standard library on values with no representation
    // error, so the exact path cannot drift from ordinary arithmetic.
    for (const value of [0.5, 1.25, 2.75, 100.5, -3.25]) {
      expect(toWholeUnits(value, 'floor')).toBe(Math.floor(value));
      expect(toWholeUnits(value, 'ceil')).toBe(Math.ceil(value));
    }
  });
});
