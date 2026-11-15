/* Google cache eligibility snapshots; SPDX-License-Identifier: MPL-2.0 */
export const CACHE_POLICY_REVIEWED_AT = '2026-11-15';
export const CACHE_POLICY_URLS = Object.freeze({
    makersuite: 'https://ai.google.dev/gemini-api/docs/caching?generate-content=true',
    vertexai: 'https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/context-cache/context-cache-overview',
});

// Only documented model IDs are included. AI Studio and Vertex have different
// limits; never infer a new model's threshold from its name or a character count.
const MINIMUM_INPUT_TOKENS = Object.freeze({
    makersuite: Object.freeze({
        'gemini-4-hydrogen': 4096,
        'gemini-4-carbon': 4096,
        'gemini-4-argon': 4096,
        'gemini-3.8-flash': 4096,
        'gemini-3.6-flash': 4096,
        'gemini-3.1-pro-preview': 4096,
        'gemini-2.5-flash': 2048,
        'gemini-2.5-pro': 2048,
    }),
    vertexai: Object.freeze({
        'gemini-4-hydrogen': 4096,
        'gemini-4-carbon': 4096,
        'gemini-4-argon': 4096,
        'gemini-3.8-flash': 6144,
        'gemini-3.7-flash': 6144,
        'gemini-3.6-flash': 4096,
        'gemini-3.5-flash': 4096,
        'gemini-3.5-flash-lite': 4096,
        'gemini-3.1-pro-preview': 6144,
        'gemini-3-flash-preview': 6144,
        'gemini-2.5-flash': 2048,
        'gemini-2.5-flash-lite': 2048,
        'gemini-2.5-pro': 2048,
    }),
});

export function cacheMinimumInputTokens(source, model) {
    const limits = Object.hasOwn(MINIMUM_INPUT_TOKENS, source) ? MINIMUM_INPUT_TOKENS[source] : null;
    const id = typeof model === 'string' ? model.replace(/^models\//u, '') : '';
    return limits && Object.hasOwn(limits, id) ? limits[id] : null;
}
