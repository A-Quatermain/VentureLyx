/**
 * Venturelyx :: LeadSource business-type guess.
 *
 * filing_type (DOMP/FLAL/FORP/...) is the entity's real, recorded LEGAL
 * structure — never a guess. This is a different, genuinely-guessed
 * field: a plain keyword match against the entity NAME, since Sunbiz's
 * data says nothing about industry. Per the v2 spec: allowed, but must
 * be labeled "guessed" everywhere it's shown — the boolean below is
 * always true when a guess is returned, kept explicit (not just "a
 * value is present") so a UI/export can't drop the label by accident.
 */

// First match wins — ordered roughly longest/most-specific keyword first
// within a few groups so "AUTO BODY" doesn't get shadowed by a later,
// broader "AUTO" (it isn't here, but the ordering principle is why this
// is a list, not an unordered map).
const KEYWORD_LABELS: Array<[string, string]> = [
  ['PLUMBING', 'Plumbing'], ['ELECTRIC', 'Electrical'], ['ROOFING', 'Roofing'],
  ['LANDSCAPING', 'Landscaping'], ['LAWN', 'Landscaping'], ['HVAC', 'HVAC'],
  ['AIR CONDITIONING', 'HVAC'], ['PAINTING', 'Painting'], ['FLOORING', 'Flooring'],
  ['PEST CONTROL', 'Pest Control'], ['CONSTRUCTION', 'Construction'],
  ['REMODELING', 'Construction'], ['CONTRACTING', 'Construction'],
  ['CLEANING', 'Cleaning'], ['JANITORIAL', 'Cleaning'], ['TRUCKING', 'Trucking'],
  ['TRANSPORT', 'Transportation'], ['LOGISTICS', 'Transportation'],
  ['AUTO BODY', 'Auto Repair'], ['AUTO REPAIR', 'Auto Repair'], ['AUTOMOTIVE', 'Automotive'],
  ['TOWING', 'Towing'], ['SALON', 'Salon / Beauty'], ['BARBER', 'Salon / Beauty'],
  ['SPA', 'Salon / Beauty'], ['NAILS', 'Salon / Beauty'], ['RESTAURANT', 'Restaurant'],
  ['CAFE', 'Restaurant'], ['CATERING', 'Catering'], ['BAKERY', 'Bakery'],
  ['DENTAL', 'Dental'], ['MEDICAL', 'Medical'], ['CLINIC', 'Medical'],
  ['THERAPY', 'Healthcare / Therapy'], ['LAW FIRM', 'Legal'], ['LEGAL', 'Legal'],
  ['ATTORNEY', 'Legal'], ['REALTY', 'Real Estate'], ['REAL ESTATE', 'Real Estate'],
  ['PROPERTY MANAGEMENT', 'Property Management'], ['INSURANCE', 'Insurance'],
  ['CONSULTING', 'Consulting'], ['MARKETING', 'Marketing'], ['PHOTOGRAPHY', 'Photography'],
  ['FITNESS', 'Fitness'], ['GYM', 'Fitness'], ['DAYCARE', 'Childcare'],
  ['CHILDCARE', 'Childcare'], ['ACADEMY', 'Education'], ['TUTORING', 'Education'],
  ['SECURITY', 'Security'], ['IT SERVICES', 'IT Services'], ['TECHNOLOGY', 'Technology'],
  ['PEST', 'Pest Control'], ['MOVING', 'Moving Services'],
];

export interface BusinessTypeGuessResult {
  business_type_guess: string | null;
  business_type_guess_is_guess: true | null; // always true when a guess exists, null otherwise — never false
}

export function guessBusinessType(entityName: string | null | undefined): BusinessTypeGuessResult {
  const upper = (entityName ?? '').toUpperCase();
  for (const [keyword, label] of KEYWORD_LABELS) {
    if (upper.includes(keyword)) {
      return { business_type_guess: label, business_type_guess_is_guess: true };
    }
  }
  return { business_type_guess: null, business_type_guess_is_guess: null };
}
