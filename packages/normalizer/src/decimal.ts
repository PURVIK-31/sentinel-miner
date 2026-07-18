/**
 * Exact decimal-to-scaled-integer conversion.
 *
 * This module exists because the obvious implementation is wrong. Converting a
 * rate to basis points by multiplying looks harmless:
 *
 * ```ts
 * Math.ceil(parseFloat('0.07') * 10000)  // 701, not 700
 * ```
 *
 * `0.07 * 10000` evaluates to `700.0000000000001` in IEEE-754, so ceiling it
 * fabricates a basis point. A 7% tax becomes 7.01%, which is enough to flip a
 * decision at a 700bp threshold. Rounding the other way is just as bad:
 * `0.57 * 10000` is `5699.999999999999`, which floors to 5699.
 *
 * So no arithmetic is performed on floats at all. The input is parsed into its
 * exact decimal digits, the decimal point is *moved* by the scale factor, and
 * rounding is decided by inspecting the discarded digits. Magnitudes are carried
 * in BigInt, which has no precision limit, and the result is range-checked before
 * being handed back as a Number.
 */

import { NormalizationError } from '@sentinel/shared';

/**
 * Rounding direction.
 *
 * Both modes round toward an extreme rather than to-nearest, because the caller
 * is choosing a *safety* direction, not the closest approximation. See
 * docs/adr/0003-fail-closed-normalization.md.
 */
export type RoundingMode = 'floor' | 'ceil';

/** A decimal parsed into exact digits: `-12.34` becomes `{ negative, "1234", 2 }`. */
interface ParsedDecimal {
  readonly negative: boolean;
  /** All significant digits with the decimal point removed. */
  readonly digits: string;
  /** How many of those digits fall after the decimal point. */
  readonly fractionLength: number;
}

/** Matches a plain decimal, with or without a fractional part. */
const PLAIN_DECIMAL = /^([+-]?)(\d*)(?:\.(\d*))?$/;

/** Matches scientific notation, which `String(1e-7)` produces. */
const SCIENTIFIC = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/;

/** Rejects the input with context a debugger can act on. */
function reject(raw: unknown, reason: string): never {
  throw new NormalizationError(`Cannot normalize value to an integer: ${reason}`, {
    details: { value: typeof raw === 'string' ? raw : String(raw), reason },
  });
}

/**
 * Parses a decimal into exact digits, without ever converting through a float.
 *
 * Accepts plain decimals and scientific notation, since `String(0.0000001)`
 * yields `'1e-7'` and provider payloads carry both forms.
 */
function parseDecimal(raw: string): ParsedDecimal {
  const trimmed = raw.trim();
  if (trimmed === '') {
    reject(raw, 'the value is empty');
  }

  const scientific = SCIENTIFIC.exec(trimmed);
  if (scientific !== null) {
    const [, sign = '', whole = '', fraction = '', exponentText = '0'] = scientific;
    const exponent = Number(exponentText);
    const digits = `${whole}${fraction}`;
    if (digits === '') {
      reject(raw, 'the value has no digits');
    }
    // Moving the point right by `exponent` shortens the fractional part.
    const fractionLength = fraction.length - exponent;
    return normalizeParsed(sign === '-', digits, fractionLength);
  }

  const plain = PLAIN_DECIMAL.exec(trimmed);
  if (plain === null) {
    reject(raw, 'the value is not a decimal number');
  }
  const [, sign = '', whole = '', fraction = ''] = plain;
  const digits = `${whole}${fraction}`;
  if (digits === '') {
    reject(raw, 'the value has no digits');
  }
  return normalizeParsed(sign === '-', digits, fraction.length);
}

/**
 * Settles a parsed decimal into canonical form.
 *
 * A negative `fractionLength` (from a positive exponent, e.g. `1e3`) means the
 * point moved past the last digit, so trailing zeros are materialised.
 */
function normalizeParsed(negative: boolean, digits: string, fractionLength: number): ParsedDecimal {
  if (fractionLength < 0) {
    return { negative, digits: digits + '0'.repeat(-fractionLength), fractionLength: 0 };
  }
  // Left-pad so the fractional part is always fully represented, e.g. `1e-3`
  // arrives as digits `1` with fractionLength 3 and must read as `0.001`.
  if (fractionLength > digits.length) {
    return {
      negative,
      digits: '0'.repeat(fractionLength - digits.length) + digits,
      fractionLength,
    };
  }
  // No digit re-validation here: `digits` is assembled only from `\d*` capture
  // groups, so it cannot contain a non-digit. A check would be unreachable.
  return { negative, digits, fractionLength };
}

/** True when any digit in the string is non-zero. */
function hasNonZero(digits: string): boolean {
  return /[1-9]/.test(digits);
}

/**
 * Converts a decimal to an integer scaled by a power of ten, exactly.
 *
 * @param input     The value, as a string or a finite number. Strings are
 *                  preferred: a provider that sends `"0.07"` has told us exactly
 *                  what it means, whereas a JSON number has already been through
 *                  a float.
 * @param scale     Power of ten to multiply by. `4` converts a rate to basis
 *                  points; `0` converts to whole units.
 * @param rounding  Direction to round any discarded precision.
 *
 * @throws {NormalizationError} if the input is not a finite decimal, or if the
 * result falls outside the safe-integer range where comparison stops being
 * reliable.
 */
export function toScaledInteger(
  input: string | number,
  scale: number,
  rounding: RoundingMode,
): number {
  if (!Number.isInteger(scale) || scale < 0) {
    reject(input, `scale must be a non-negative integer, received ${String(scale)}`);
  }
  if (typeof input === 'number' && !Number.isFinite(input)) {
    reject(input, 'the value is not finite');
  }

  // `String(number)` is the shortest round-tripping representation, so it
  // reproduces the author's decimal for any value that was written as one.
  const { negative, digits, fractionLength } = parseDecimal(
    typeof input === 'number' ? String(input) : input,
  );

  // Move the decimal point right by `scale` places.
  const remainingFraction = fractionLength - scale;

  let wholeDigits: string;
  let discarded: string;
  if (remainingFraction <= 0) {
    // The point moved past every digit: pad with zeros, nothing is discarded.
    wholeDigits = digits + '0'.repeat(-remainingFraction);
    discarded = '';
  } else {
    wholeDigits = digits.slice(0, digits.length - remainingFraction);
    discarded = digits.slice(digits.length - remainingFraction);
  }

  let magnitude = BigInt(wholeDigits === '' ? '0' : wholeDigits);

  // Round only when precision was actually lost. Both modes are defined on the
  // signed value, so `ceil` on a negative number truncates toward zero.
  if (hasNonZero(discarded)) {
    const roundsAwayFromZero = negative ? rounding === 'floor' : rounding === 'ceil';
    if (roundsAwayFromZero) {
      magnitude += 1n;
    }
  }

  const signed = negative ? -magnitude : magnitude;

  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    reject(
      input,
      `the scaled result ${signed.toString()} falls outside the safe-integer range where comparison is reliable`,
    );
  }

  // `-0` and `0` are the same value but not the same key under Object.is, which
  // would be an invisible source of hash instability.
  return Number(signed) === 0 ? 0 : Number(signed);
}

/**
 * Converts a rate expressed as a fraction (`0.07`) into basis points (`700`).
 *
 * Providers express taxes as fractions of one. Basis points give integer
 * precision to a hundredth of a percent, which is finer than any provider
 * reports, so the conversion is lossless in practice.
 */
export function toBasisPoints(input: string | number, rounding: RoundingMode): number {
  return toScaledInteger(input, 4, rounding);
}

/** Converts a monetary amount to whole units, discarding sub-unit precision. */
export function toWholeUnits(input: string | number, rounding: RoundingMode): number {
  return toScaledInteger(input, 0, rounding);
}
