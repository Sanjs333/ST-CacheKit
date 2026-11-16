/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

// Display-name changes must keep existing storage and protocol identifiers.
export const EXTENSION_ID = 'vertex-paygo';
export const EXTENSION_DISPLAY_NAME = '提示词缓存优化';
export const CLIENT_VERSION = '1.1.1';
export const CONFIG_VERSION = 1;
export const PROTOCOL_VERSION = 2;
export const REQUIRED_TRANSPORT = 'loopback-http';
export const CLIENT_LOG_MEDIA_TYPE = 'application/vnd.st-vertex-paygo.client-log+json';
export const MAX_USAGE_RECORDS_PER_CHAT = 100;

export const VERTEX_SOURCE = 'vertexai';
export const AI_STUDIO_SOURCE = 'makersuite';

export function isGoogleSource(source) {
    return source === VERTEX_SOURCE || source === AI_STUDIO_SOURCE;
}

export const TIER = Object.freeze({
    STANDARD: 'standard',
    FLEX: 'flex',
    // Kept only to recognize legacy presets and historical ledger labels.
    PRIORITY: 'priority',
});

export const DEFAULT_STATE = Object.freeze({
    version: CONFIG_VERSION,
    tier: TIER.STANDARD,
    paygoOnly: false,
});

export const SERVER_ROUTES = Object.freeze({
    HEALTH: '/api/plugins/vertex-paygo/health',
    PREPARE: '/api/plugins/vertex-paygo/prepare',
    REJECTED: '/api/plugins/vertex-paygo/rejected',
    LOGS: '/api/plugins/vertex-paygo/logs',
    CLIENT_LOG: '/api/plugins/vertex-paygo/logs/client',
    USAGE: '/api/plugins/vertex-paygo/usage',
    BILLING_SETTINGS: '/api/plugins/vertex-paygo/billing/settings',
    BILLING_QUERY: '/api/plugins/vertex-paygo/billing/query',
    UPDATE: '/api/plugins/vertex-paygo/update',
    UPDATE_STATUS: '/api/plugins/vertex-paygo/update/status',
});

export const HEALTH_TIMEOUT_MS = 5_000;
export const LOG_TIMEOUT_MS = 5_000;
export const MAX_LOG_RESPONSE_BYTES = 5 * 1024 * 1024;
// Allow service-account OAuth exchanges to complete on slower connections
// before issuing the proxy ticket. This does not limit model generation.
export const PREPARE_TIMEOUT_MS = 180_000;
// A check clones both repositories before it can decide anything, and starting
// an update only acknowledges a job that keeps running in the background.
export const UPDATE_CHECK_TIMEOUT_MS = 120_000;
export const UPDATE_START_TIMEOUT_MS = 10_000;
export const UPDATE_STATUS_TIMEOUT_MS = 10_000;
export const UPDATE_POLL_INTERVAL_MS = 1_000;
