/* Copyright (c) 2026 Mana Nekoha; SPDX-License-Identifier: MPL-2.0 */
import { BILLING_SETTINGS_DEFAULTS, billingQuery } from './billing-model.js';

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const BIGQUERY_URL = 'https://bigquery.googleapis.com/bigquery/v2/projects/';
const PROJECT = /^[a-z][a-z0-9-]{4,62}[a-z0-9]$/;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]{0,1023}$/;
const USAGE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const LABEL = /^[a-z0-9_-]{1,63}$/;
const LABEL_KEYS = ['st_cachekit_chat', 'st_cachekit_request'];
const ROW_FIELDS = ['day', 'currency', 'grossCost', 'credits', 'netCost', 'lastExportTime', 'chatLabel', 'requestLabel'];
const MAX_BYTES = 2 * 1024 * 1024;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const encoder = new TextEncoder();
function failure(key, code = 'BILLING_QUERY_FAILED') {
    const error = new Error(code);
    error.code = code; error.translationKey = 'vertex_paygo.billing.' + key;
    return error;
}

export function validateTauriBillingSettings(input) {
    const fail = () => { throw failure('error_settings_invalid', 'INVALID_BILLING_SETTINGS'); };
    if (!object(input) || Object.keys(input).some(key => !Object.hasOwn(BILLING_SETTINGS_DEFAULTS, key))) fail();
    const value = { ...BILLING_SETTINGS_DEFAULTS, ...input, version: 1 };
    if (typeof value.enabled !== 'boolean' || !['off', 'chat', 'request'].includes(value.labelMode)) fail();
    for (const key of ['queryProject', 'datasetProject', 'projectFilter']) if (typeof value[key] !== 'string' || value[key] && !PROJECT.test(value[key])) fail();
    for (const key of ['dataset', 'table']) if (typeof value[key] !== 'string' || value[key] && !IDENTIFIER.test(value[key])) fail();
    if (typeof value.location !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(value.location)
        || typeof value.secretId !== 'string' || value.secretId.length > 256 || /[\x00-\x20\x7f]/.test(value.secretId)) fail();
    if (value.enabled && !['queryProject', 'dataset', 'table'].every(key => value[key])) throw failure('error_config_required', 'BILLING_NOT_CONFIGURED');
    if (value.enabled && !value.datasetProject) value.datasetProject = value.queryProject;
    return value;
}

function queryBody(settings, range, credentialProject, labels) {
    const parameter = (name, type, value) => ({ name, parameterType: { type }, parameterValue: { value } });
    const queryParameters = [parameter('start_date', 'DATE', range.startDate), parameter('end_date', 'DATE', range.endDate),
        parameter('project_id', 'STRING', settings.projectFilter || credentialProject)];
    if (range.chatId) queryParameters.push(parameter('chat_label', 'STRING', labels.st_cachekit_chat));
    if (range.requestId) queryParameters.push(parameter('request_label', 'STRING', labels.st_cachekit_request));
    return { query: `SELECT
      CAST(DATE(usage_start_time, 'Asia/Shanghai') AS STRING) AS day,
      currency,
      SUM(cost) AS grossCost,
      SUM(IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS credits,
      SUM(cost + IFNULL((SELECT SUM(c.amount) FROM UNNEST(credits) AS c), 0)) AS netCost,
      CAST(MAX(export_time) AS STRING) AS lastExportTime,
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'st_cachekit_chat' LIMIT 1) AS chatLabel,
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'st_cachekit_request' LIMIT 1) AS requestLabel
    FROM \`${settings.datasetProject}.${settings.dataset}.${settings.table}\`
    WHERE usage_start_time >= TIMESTAMP(@start_date, 'Asia/Shanghai')
      AND usage_start_time < TIMESTAMP(DATE_ADD(@end_date, INTERVAL 1 DAY), 'Asia/Shanghai')
      AND project.id = @project_id
      AND (LOWER(service.description) LIKE '%vertex%' OR LOWER(service.description) LIKE '%agent platform%')
      ${range.chatId ? "AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'st_cachekit_chat' AND l.value = @chat_label)" : ''}
      ${range.requestId ? "AND EXISTS (SELECT 1 FROM UNNEST(labels) l WHERE l.key = 'st_cachekit_request' AND l.value = @request_label)" : ''}
    GROUP BY day, currency, chatLabel, requestLabel
    ORDER BY day DESC, chatLabel, requestLabel
    LIMIT 1001`, useLegacySql: false, parameterMode: 'NAMED', queryParameters,
        maximumBytesBilled: '100000000', location: settings.location, timeoutMs: 1000, maxResults: 1000 };
}

function projectRows(data, fields) {
    if (data.rows !== undefined && !Array.isArray(data.rows)) throw failure('error_response');
    return (data.rows ?? []).slice(0, 1001).map(row => {
        if (!object(row) || !Array.isArray(row.f)) throw failure('error_response');
        return Object.fromEntries(fields.filter(name => ROW_FIELDS.includes(name)).map(name => {
            const value = row.f[fields.indexOf(name)]?.v;
            if (['grossCost', 'credits', 'netCost'].includes(name)) {
                const number = typeof value === 'number' || typeof value === 'string' && value.trim() ? Number(value) : NaN;
                return [name, Number.isFinite(number) ? number : null];
            }
            return [name, typeof value === 'string' ? value.slice(0, 128) : null];
        }));
    });
}

/** Credentials and OAuth tokens are memory-only; the native store contains public connection settings. */
export function createTauriBillingClient({ api, store = api?.extension?.store, target = globalThis,
    getContext, yaml, cryptoRef = target.crypto ?? globalThis.crypto, fetchImpl = target.fetch?.bind(target), now = Date.now } = {}) {
    let config, settingsTask, writeQueue = Promise.resolve(), destroyed = false, credentialEpoch = 0, configEpoch = 0;
    let imported = null, nativeCredential = null, tokenTask = null, token = null;
    const cache = new Map(), pending = new Map(), cancellations = new Set();
    const alive = () => { if (destroyed) throw failure('error_unavailable', 'BILLING_UNAVAILABLE'); };
    const hash = async text => {
        alive();
        if (!cryptoRef?.subtle?.digest) throw failure('error_crypto');
        const bytes = await cryptoRef.subtle.digest('SHA-256', encoder.encode(text)); alive();
        return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
    };
    const b64 = bytes => {
        let value = ''; for (const byte of bytes) value += String.fromCharCode(byte);
        return (target.btoa ?? globalThis.btoa)(value).replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
    };
    const encode = value => b64(encoder.encode(JSON.stringify(value)));
    function resetCredentials() { credentialEpoch++; imported = nativeCredential = token = tokenTask = null; cache.clear(); }
    async function bounded(operation, timeout = 10000) {
        alive(); let timer, cancel;
        const aborted = new Promise((_, reject) => {
            cancel = () => reject(failure('error_unavailable', 'BILLING_UNAVAILABLE'));
            cancellations.add(cancel); timer = setTimeout(cancel, timeout);
        });
        try { const result = await Promise.race([Promise.resolve().then(operation), aborted]); alive(); return result; }
        finally { clearTimeout(timer); cancellations.delete(cancel); }
    }
    async function readBillingSettings() {
        alive();
        if (settingsTask) return { ...await settingsTask };
        const readingEpoch = configEpoch;
        settingsTask = bounded(async () => {
            if (typeof store?.tryGetJson !== 'function' && typeof store?.getJson !== 'function') throw failure('error_unavailable');
            const address = { namespace: 'vertex-paygo', key: 'billing-settings' };
            let result;
            try { result = typeof store.tryGetJson === 'function' ? await store.tryGetJson(address) : await store.getJson(address); }
            catch (error) {
                if (typeof store.tryGetJson !== 'function' && typeof error?.message === 'string'
                    && error.message.startsWith('Extension store entry not found:')) result = null;
                else throw error;
            }
            const value = typeof result?.found === 'boolean' ? result.found ? result.value : BILLING_SETTINGS_DEFAULTS : result ?? BILLING_SETTINGS_DEFAULTS;
            const next = validateTauriBillingSettings(value);
            if (readingEpoch === configEpoch) {
                if (config && config.secretId !== next.secretId) resetCredentials();
                config = next;
            }
            return config ?? next;
        });
        try { return { ...await settingsTask }; } finally { settingsTask = null; }
    }
    async function saveBillingSettings(value) {
        alive(); const next = validateTauriBillingSettings(value);
        const task = writeQueue.then(async () => {
            alive(); if (typeof store?.setJson !== 'function') throw failure('error_unavailable');
            await bounded(() => store.setJson({ namespace: 'vertex-paygo', key: 'billing-settings', value: next }));
            if (config && config.secretId !== next.secretId) resetCredentials();
            configEpoch++; config = next; cache.clear(); return { ...next };
        });
        writeQueue = task.catch(() => {}); return task;
    }
    async function parseCredential(raw) {
        alive();
        if (!cryptoRef?.subtle?.importKey || !cryptoRef?.subtle?.sign) throw failure('error_crypto');
        if (typeof raw !== 'string' || encoder.encode(raw).byteLength > 65536) throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE');
        let value;
        try { value = JSON.parse(raw); } catch { throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE'); }
        if (!object(value) || value.type !== 'service_account' || !PROJECT.test(value.project_id)
            || typeof value.client_email !== 'string' || !/^[^\s@]{1,200}@[A-Za-z0-9.-]{1,200}$/.test(value.client_email)
            || typeof value.private_key !== 'string' || value.private_key.length > 32768) throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE');
        const match = /^-----BEGIN PRIVATE KEY-----\s+([A-Za-z0-9+/=\s]+)\s+-----END PRIVATE KEY-----\s*$/.exec(value.private_key);
        if (!match) throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE');
        let bytes;
        try {
            bytes = Uint8Array.from((target.atob ?? globalThis.atob)(match[1].replace(/\s/g, '')), char => char.charCodeAt(0));
            const key = await cryptoRef.subtle.importKey('pkcs8', bytes, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
            if (key.algorithm.modulusLength < 2048) throw failure('error_import');
            const identity = await hash(raw); alive();
            return { projectId: value.project_id, email: value.client_email, key, identity };
        } catch (error) { if (error?.translationKey) throw error; throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE'); }
        finally { bytes?.fill(0); value.private_key = ''; }
    }
    async function importServiceAccount(raw) {
        alive(); const importingEpoch = credentialEpoch;
        const credential = await parseCredential(raw);
        if (importingEpoch !== credentialEpoch) throw failure('error_import', 'BILLING_CREDENTIAL_UNAVAILABLE');
        resetCredentials(); imported = credential;
        return { projectId: credential.projectId };
    }
    async function resolveCredential(settings) {
        alive(); if (imported) return imported;
        const invoke = target.__TAURITAVERN__?.invoke;
        if (typeof invoke?.safeInvoke !== 'function') throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE');
        let guard;
        try { guard = await bounded(() => invoke.safeInvoke('read_secret_settings')); }
        catch { throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE'); }
        if (guard?.allowKeysExposure !== true) throw failure('error_protected', 'BILLING_CREDENTIAL_UNAVAILABLE');
        const resolvingEpoch = credentialEpoch;
        let secret;
        try { secret = await bounded(() => invoke.safeInvoke('find_secret', { dto: { key: 'vertexai_service_account_json', ...(settings.secretId ? { id: settings.secretId } : {}) } })); }
        catch { throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE'); }
        if (typeof secret?.value !== 'string' || !secret.value) throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE');
        const identity = await hash(secret.value);
        const credential = nativeCredential?.identity === identity ? nativeCredential : await parseCredential(secret.value);
        secret = null;
        alive(); if (resolvingEpoch !== credentialEpoch) throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE');
        nativeCredential = credential; return credential;
    }
    async function json(url, options, { oauth = false, deadline = now() + 20000, budget = { remaining: MAX_BYTES } } = {}) {
        alive(); if (!fetchImpl) throw failure('error_unavailable', 'BILLING_UNAVAILABLE');
        const remaining = deadline - now();
        if (remaining <= 0) throw failure('error_pending', 'BILLING_QUERY_PENDING');
        const controller = new AbortController();
        const cancel = () => controller.abort(); cancellations.add(cancel);
        const timer = setTimeout(cancel, Math.min(remaining, 20000));
        let response, reader;
        try {
            response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: 'error', credentials: 'omit', referrerPolicy: 'no-referrer' }); alive();
            if (!response.ok) {
                await response.body?.cancel?.();
                throw failure(oauth ? 'error_oauth' : response.status === 403 ? 'error_permissions' : response.status === 401 ? 'error_oauth' : 'error_query_failed',
                    !oauth && response.status === 403 ? 'BILLING_PERMISSION_REQUIRED' : 'BILLING_QUERY_FAILED');
            }
            if (Number(response.headers?.get?.('content-length')) > budget.remaining) throw failure('error_result_size', 'BILLING_RESPONSE_TOO_LARGE');
            let text;
            if (typeof response.body?.getReader === 'function') {
                reader = response.body.getReader(); const decoder = new TextDecoder(); const chunks = [];
                while (true) {
                    const chunk = await reader.read(); alive(); if (chunk.done) break;
                    budget.remaining -= chunk.value.byteLength;
                    if (budget.remaining < 0) throw failure('error_result_size', 'BILLING_RESPONSE_TOO_LARGE');
                    chunks.push(decoder.decode(chunk.value, { stream: true }));
                }
                chunks.push(decoder.decode()); text = chunks.join('');
            } else {
                text = await response.text(); budget.remaining -= encoder.encode(text).byteLength;
                if (budget.remaining < 0) throw failure('error_result_size', 'BILLING_RESPONSE_TOO_LARGE');
            }
            alive(); let data;
            try { data = JSON.parse(text); } catch { throw failure('error_response'); }
            if (!object(data) || data.error || data.errors?.length) throw failure(oauth ? 'error_oauth' : 'error_query_failed');
            return data;
        } catch (error) {
            if (error?.translationKey) throw error;
            throw failure('error_unavailable', 'BILLING_UNAVAILABLE');
        } finally {
            clearTimeout(timer); cancellations.delete(cancel);
            try { if (reader) { await reader.cancel(); reader.releaseLock(); } else await response?.body?.cancel?.(); } catch { /* The completed body may be locked or closed. */ }
        }
    }
    async function authorization(credential) {
        if (token?.identity === credential.identity && token.expiresAt > now() + 60000) return token.authorization;
        if (tokenTask?.identity === credential.identity) return tokenTask.promise;
        const authEpoch = credentialEpoch;
        const promise = (async () => {
            const issuedAt = Math.floor(now() / 1000);
            const unsigned = encode({ alg: 'RS256', typ: 'JWT' }) + '.' + encode({ iss: credential.email,
                scope: 'https://www.googleapis.com/auth/cloud-platform', aud: OAUTH_URL, iat: issuedAt, exp: issuedAt + 300 });
            let signature;
            try { signature = await cryptoRef.subtle.sign('RSASSA-PKCS1-v1_5', credential.key, encoder.encode(unsigned)); }
            catch { throw failure('error_crypto'); }
            const body = new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: unsigned + '.' + b64(new Uint8Array(signature)) }).toString();
            const data = await json(OAUTH_URL, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body }, { oauth: true, budget: { remaining: 131072 } });
            if (typeof data.access_token !== 'string' || !/^[^\x00-\x20\x7f]{1,16384}$/.test(data.access_token)
                || data.token_type?.toLowerCase() !== 'bearer' || !Number.isFinite(Number(data.expires_in)) || Number(data.expires_in) <= 0) throw failure('error_oauth');
            alive(); if (authEpoch !== credentialEpoch) throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE');
            token = { identity: credential.identity, authorization: 'Bearer ' + data.access_token, expiresAt: now() + Math.min(Number(data.expires_in), 3600) * 1000 };
            return token.authorization;
        })();
        const task = { identity: credential.identity, promise }; tokenTask = task;
        try { return await promise; } finally { if (tokenTask === task) tokenTask = null; }
    }
    const requestLabel = async requestId => LABEL.test(requestId) ? requestId : (await hash(requestId)).slice(0, 32);
    async function makeLabels(chatId, requestId, mode = 'request') {
        const labels = {};
        if (chatId) labels.st_cachekit_chat = (await hash(chatId)).slice(0, 32);
        if (mode === 'request' && requestId) labels.st_cachekit_request = await requestLabel(requestId);
        return labels;
    }
    async function execute(settings, range, credential) {
        const auth = await authorization(credential), deadline = now() + 30000, budget = { remaining: MAX_BYTES };
        const labels = await makeLabels(range.chatId, range.requestId);
        const base = BIGQUERY_URL + encodeURIComponent(settings.queryProject) + '/queries';
        const read = (url, options) => json(url, { ...options, headers: { Authorization: auth, 'Content-Type': 'application/json' } }, { deadline, budget });
        let data = await read(base, { method: 'POST', body: JSON.stringify(queryBody(settings, range, credential.projectId, labels)) });
        let reference;
        const jobUrl = value => {
            const next = value.jobReference ?? reference;
            if (!object(next) || typeof next.jobId !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(next.jobId)
                || next.projectId !== undefined && next.projectId !== settings.queryProject
                || next.location !== undefined && (typeof next.location !== 'string' || !/^[A-Za-z][A-Za-z0-9-]{0,62}$/.test(next.location)
                    || next.location.toLowerCase() !== settings.location.toLowerCase())
                || reference && next.jobId !== reference.jobId) throw failure('error_response');
            reference = next;
            return base + '/' + encodeURIComponent(next.jobId) + '?location=' + encodeURIComponent(next.location || settings.location) + '&timeoutMs=1000&maxResults=1000';
        };
        for (let attempt = 0; data.jobComplete === false && attempt < 3; attempt++) data = await read(jobUrl(data), { method: 'GET' });
        if (data.jobComplete === false) throw failure('error_pending', 'BILLING_QUERY_PENDING');
        if (data.jobComplete !== true) throw failure('error_response');
        if (data.schema?.fields !== undefined && (!Array.isArray(data.schema.fields) || data.schema.fields.length > 128)) throw failure('error_response');
        const fields = data.schema?.fields?.map(field => field?.name) ?? ROW_FIELDS;
        let rows = projectRows(data, fields), pages = 0;
        const readTotal = value => typeof value === 'string' && /^\d{1,30}$/.test(value) ? BigInt(value) : null;
        let totalRows = readTotal(data.totalRows);
        const seen = new Set();
        while (data.pageToken && rows.length < 1000 && pages < 3) {
            if (typeof data.pageToken !== 'string' || data.pageToken.length > 8192 || seen.has(data.pageToken)) throw failure('error_response');
            seen.add(data.pageToken);
            const url = jobUrl(data) + '&pageToken=' + encodeURIComponent(data.pageToken);
            data = await read(url, { method: 'GET' }); pages++;
            if (data.jobComplete !== true) throw failure('error_response');
            totalRows = readTotal(data.totalRows) ?? totalRows;
            rows = rows.concat(projectRows(data, fields));
        }
        return { ok: true, kind: 'billing-export', granularity: 'day', sourceGranularity: 'hour', reportingTimeZone: 'Asia/Shanghai',
            startDate: range.startDate, endDate: range.endDate, fetchedAt: new Date(now()).toISOString(), rows: rows.slice(0, 1000),
            truncated: Boolean(data.pageToken) || rows.length > 1000 || totalRows !== null && totalRows > BigInt(Math.min(rows.length, 1000)), linked: Boolean(range.chatId || range.requestId) };
    }
    async function readBilling(input) {
        alive();
        if (!object(input) || Object.keys(input).some(key => !['startDate', 'endDate', 'chatId', 'requestId'].includes(key))
            || input.chatId !== undefined && (typeof input.chatId !== 'string' || !USAGE_ID.test(input.chatId))
            || input.requestId !== undefined && (typeof input.requestId !== 'string' || !USAGE_ID.test(input.requestId))) throw failure('error_scope', 'INVALID_BILLING_QUERY');
        const range = billingQuery(input);
        if (input.chatId) range.chatId = input.chatId;
        if (input.requestId) range.requestId = input.requestId;
        const settings = await readBillingSettings();
        if (!settings.enabled) throw failure('error_config_required', 'BILLING_NOT_CONFIGURED');
        const credential = await resolveCredential(settings); alive();
        const key = JSON.stringify([settings, range, credential.identity]);
        const copy = result => ({ ...result, rows: result.rows.map(row => ({ ...row })) });
        const cached = cache.get(key);
        if (cached && now() - cached.at < 60000) return { ...copy(cached.result), cached: true };
        if (pending.has(key)) return { ...copy(await pending.get(key)), cached: true };
        if (pending.size >= 16) throw failure('error_pending', 'BILLING_QUERY_PENDING');
        const queryingEpoch = credentialEpoch, queryingConfig = configEpoch;
        const task = execute(settings, range, credential); pending.set(key, task);
        try {
            const result = await task; alive();
            if (queryingEpoch !== credentialEpoch) throw failure('error_credentials', 'BILLING_CREDENTIAL_UNAVAILABLE');
            if (queryingConfig === configEpoch) cache.set(key, { at: now(), result });
            while (cache.size > 32) cache.delete(cache.keys().next().value);
            return copy(result);
        } finally { pending.delete(key); }
    }
    async function applyLabels(data, metadata = {}) {
        alive();
        if (!object(data) || String(data.chat_completion_source ?? data.source ?? data.provider ?? '').toLowerCase() !== 'vertexai'
            || typeof metadata.chatId !== 'string' || !USAGE_ID.test(metadata.chatId)) return null;
        const settings = config ?? await readBillingSettings();
        if (!settings.enabled || settings.labelMode === 'off') return null;
        const containers = [data, object(data.parameters) ? data.parameters : null].filter(Boolean);
        const aliases = ['custom_include_body', 'include_body', 'customIncludeBody'];
        const parameterAliases = [...aliases, 'custom_exclude_body', 'exclude_body', 'customExcludeBody', 'custom_include_headers', 'include_headers', 'customIncludeHeaders'];
        const owner = containers.slice().reverse().find(container => parameterAliases.some(key => Object.hasOwn(container, key))) ?? containers.at(-1);
        const keys = aliases.filter(key => Object.hasOwn(owner, key)); if (!keys.length) keys.push('custom_include_body');
        const parse = value => {
            if (value == null || value === '') return {};
            if (object(value)) return value;
            if (typeof value !== 'string') throw failure('error_settings_invalid');
            let parsed; try { parsed = yaml?.parse ? yaml.parse(value) : JSON.parse(value); } catch { throw failure('error_settings_invalid'); }
            if (!object(parsed)) throw failure('error_settings_invalid'); return parsed;
        };
        const requestId = typeof metadata.requestId === 'string' && USAGE_ID.test(metadata.requestId) ? metadata.requestId : null;
        for (const key of ['custom_exclude_body', 'exclude_body', 'customExcludeBody']) {
            let excluded = owner[key];
            if (excluded == null || excluded === '') continue;
            if (typeof excluded === 'string') {
                try { excluded = yaml?.parse ? yaml.parse(excluded) : JSON.parse(excluded); } catch { throw failure('error_settings_invalid'); }
            }
            const excludedKeys = Array.isArray(excluded) ? excluded : object(excluded) ? Object.keys(excluded) : typeof excluded === 'string' ? [excluded] : [];
            if (excludedKeys.some(key => typeof key === 'string' && key.trim() === 'labels')) return null;
        }
        const labels = await makeLabels(metadata.chatId, requestId, settings.labelMode); alive();
        const updates = keys.map(key => {
            const original = owner[key], body = parse(original);
            const existing = object(body.labels) ? body.labels : {};
            const entries = Object.entries(existing).filter(([name]) => !LABEL_KEYS.includes(name));
            if (entries.length + Object.keys(labels).length > 64) return null;
            const next = { ...body, labels: { ...Object.fromEntries(entries), ...labels } };
            return [key, typeof original === 'string' || original == null ? yaml?.stringify ? yaml.stringify(next) : JSON.stringify(next) : next];
        });
        if (updates.some(value => value === null)) return null;
        for (const [key, value] of updates) owner[key] = value;
        return { ...labels };
    }
    return { readBillingSettings, saveBillingSettings, readBilling, applyLabels, importServiceAccount,
        acceptsUsageRequestIds: true,
        destroy() { if (destroyed) return; destroyed = true; for (const cancel of cancellations) cancel(); cancellations.clear(); resetCredentials(); config = null; pending.clear(); } };
}
