/* Official Vertex regional price differences verified 2026-11-16; SPDX-License-Identifier: MPL-2.0 */
import { normalizePrice, pricingRegion } from './cost-model.js';

// Only models with explicit Global / Non-global rows in the official table.
// https://cloud.google.com/model-garden/pricing
const NON_GLOBAL_PREMIUM_MODELS = new Set([
    'gemini-4-hydrogen', 'gemini-4-carbon', 'gemini-4-argon',
    'gemini-4-carbon-cyber-permissive', 'gemini-4-argon-cyber-permissive',
    'gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-3.6-flash',
    'gemini-3.8-flash-cyber', 'gemini-3.5-flash', 'gemini-3.5-flash-lite',
    'gemini-3.1-flash-lite', 'gemini-3.1-flash-image',
]);
const MONETARY_FIELDS = ['input', 'cachedInput', 'output', 'longInput', 'longCachedInput', 'longOutput'];

export function regionalPriceMultiplier(key) {
    const region = pricingRegion(key);
    return region && region !== 'global' && NON_GLOBAL_PREMIUM_MODELS.has(key.model) ? 1.1 : 1;
}

export function regionalCatalogPrice(price, key) {
    const normalized = normalizePrice(price);
    if (!normalized) return null;
    const multiplier = regionalPriceMultiplier(key);
    if (multiplier === 1) return normalized;
    for (const field of MONETARY_FIELDS) if (normalized[field] !== undefined) {
        normalized[field] = Number((normalized[field] * multiplier).toPrecision(12));
    }
    return normalizePrice(normalized);
}
