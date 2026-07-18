/**
 * @packageDocumentation
 * Converts provider payloads into deterministic integer evidence.
 *
 * Rounding is fail-closed: costs round up, resources round down. The ruleset is
 * versioned, because changing a direction changes decisions and proof hashes.
 */

export type { RoundingMode } from './decimal.js';
export { toScaledInteger, toBasisPoints, toWholeUnits } from './decimal.js';

export type { FieldUnit, FieldSpec, CatalogField } from './fields.js';
export {
  NORMALIZATION_VERSION,
  FIELD_CATALOG,
  CATALOG_FIELDS,
  getFieldSpec,
  isCatalogField,
} from './fields.js';

export type {
  ProviderSnapshot,
  FieldContribution,
  NormalizationIssue,
  SupersededClaim,
  NormalizedBundle,
} from './normalize.js';
export { normalizeEvidence, normalizeField, isDeterministicEvidence } from './normalize.js';
