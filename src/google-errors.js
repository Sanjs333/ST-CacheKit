/* SPDX-License-Identifier: MPL-2.0 */

const REASON_DIAGNOSES = Object.freeze({
    SERVICE_DISABLED: 'api_disabled',
    BILLING_DISABLED: 'billing_disabled', BILLING_NOT_ACTIVE: 'billing_disabled',
    API_KEY_INVALID: 'key_invalid', API_KEY_EXPIRED: 'key_invalid',
    API_KEY_SERVICE_BLOCKED: 'key_restricted', API_KEY_IP_ADDRESS_BLOCKED: 'key_restricted',
    API_KEY_HTTP_REFERRER_BLOCKED: 'key_restricted', API_KEY_ANDROID_APP_BLOCKED: 'key_restricted',
    API_KEY_IOS_APP_BLOCKED: 'key_restricted',
    IAM_PERMISSION_DENIED: 'iam_denied', ACCESS_TOKEN_SCOPE_INSUFFICIENT: 'permission_denied',
    CREDENTIALS_MISSING: 'unauthenticated', ACCESS_TOKEN_EXPIRED: 'unauthenticated',
    RATE_LIMIT_EXCEEDED: 'resource_exhausted', QUOTA_EXCEEDED: 'resource_exhausted',
});
const STATUS_DIAGNOSES = Object.freeze({
    INVALID_ARGUMENT: 'invalid_request', UNAUTHENTICATED: 'unauthenticated',
    PERMISSION_DENIED: 'permission_denied', NOT_FOUND: 'resource_missing',
    RESOURCE_EXHAUSTED: 'resource_exhausted', UNAVAILABLE: 'unavailable',
});
const HTTP_DIAGNOSES = Object.freeze({
    400: 'invalid_request', 401: 'unauthenticated', 403: 'permission_denied',
    404: 'resource_missing', 429: 'resource_exhausted', 500: 'upstream_failed',
    502: 'upstream_failed', 503: 'unavailable', 504: 'upstream_failed',
});
const validStatus = value => Number.isSafeInteger(value) && value >= 100 && value <= 599;
const safeTag = value => typeof value === 'string' && /^[A-Z][A-Z0-9_]{0,127}$/u.test(value) ? value : '';

export function localizeGoogleUpstreamError(localize, details, fallbackStatus) {
    if (typeof localize !== 'function') return null;
    const status = validStatus(details?.upstreamStatus) ? details.upstreamStatus : fallbackStatus;
    if (!validStatus(status)) return null;
    const googleStatus = safeTag(details?.googleStatus), reason = safeTag(details?.googleReason);
    // A typed Google reason takes precedence over the broad HTTP category.
    // Never turn a generic 403 into a claim that billing or model access is missing.
    const diagnosis = REASON_DIAGNOSES[reason] ?? STATUS_DIAGNOSES[googleStatus]
        ?? HTTP_DIAGNOSES[status] ?? 'unknown';
    const message = typeof details?.upstreamMessage === 'string'
        ? details.upstreamMessage.replace(/\s+/gu, ' ').trim().slice(0, 500) : '';
    const codes = [googleStatus, reason].filter(Boolean).join(' / ');
    const evidence = message || (reason ? '' : localize('vertex_paygo.google_error.details_missing'));
    return localize('vertex_paygo.google_error.summary', {
        status, diagnosis: localize('vertex_paygo.google_error.' + diagnosis),
        details: [codes ? '[' + codes + ']' : '', evidence].filter(Boolean).join(' '),
    });
}
