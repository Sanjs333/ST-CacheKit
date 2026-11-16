/* Evidence-based local cache analysis; SPDX-License-Identifier: MPL-2.0 */
import { cacheMinimumInputTokens } from './cache-diagnostics-policy.js';
import { formatCacheHitRate } from './cost-model.js';
import { createLocalizer } from './i18n.js';

const number = value => value.toLocaleString();
const rate = formatCacheHitRate;
export const sameCacheScope = (left, right) => !!right && ['model', 'source', 'region'].every(key => left[key] === right[key]);
const multipleRequests = value => value?.googleRequestCount > 1 || value?.storedRequestCount > 1;

function referenceView(current, reference) {
    if (!reference) return null;
    const elapsed = Date.parse(current.createdAt) - Date.parse(reference.createdAt);
    return { id: reference.id, createdAt: reference.createdAt, cacheRate: reference.usage.cacheRate,
        elapsedMs: Number.isSafeInteger(elapsed) && elapsed >= 0 ? elapsed : null };
}

function addObservedChanges(add, current, previous, reference, comparison, t) {
    const SCOPE_LABELS = { model: t("vertex_paygo.cache_diagnostics.model"), source: t("vertex_paygo.cache_diagnostics.provider"), region: t("vertex_paygo.cache_diagnostics.region") };
    const changedScope = previous ? Object.keys(SCOPE_LABELS).filter(key => current[key] !== previous[key]) : [];
    if (changedScope.length) add('scope_changed', 'observed', t("vertex_paygo.cache_diagnostics.scope_changed", { p0: changedScope.map(key => SCOPE_LABELS[key]).join(t('vertex_paygo.common.list_separator')) }),
        t("vertex_paygo.cache_diagnostics.scope_changed_detail"));
    if (previous && current.tier !== previous.tier) add('tier_changed', 'observed', t("vertex_paygo.cache_diagnostics.tier_changed"), t("vertex_paygo.cache_diagnostics.tier_changed_detail"));
    if (!reference || comparison.status !== 'compared') return;
    if (comparison.stablePrefix) add('stable_prefix_boundary', 'observed', comparison.stablePrefix.unchanged ? t("vertex_paygo.cache_diagnostics.stable_same") : t("vertex_paygo.cache_diagnostics.stable_changed"),
        t("vertex_paygo.cache_diagnostics.stable_detail", { p0: number(comparison.stablePrefix.previousChars), p1: number(comparison.stablePrefix.currentChars), p2: comparison.stablePrefix.unchanged ? t("vertex_paygo.cache_diagnostics.matching") : t("vertex_paygo.cache_diagnostics.different") }));
    if (!comparison.systemUnchanged) add('system_changed', 'observed', t("vertex_paygo.cache_diagnostics.system_changed"),
        t("vertex_paygo.cache_diagnostics.system_changed_detail"));
    else if (comparison.firstChangedBlock !== null) add('message_changed', 'observed',
        comparison.firstChangedBlock === 1 ? t("vertex_paygo.cache_diagnostics.first_block_changed") : t("vertex_paygo.cache_diagnostics.message_changed"),
        t("vertex_paygo.cache_diagnostics.message_changed_detail", { p0: comparison.firstChangedBlock, p1: comparison.commonBlocks }));
    else if (comparison.prefixUnchanged) add('prefix_unchanged', 'observed', t("vertex_paygo.cache_diagnostics.prefix_same"),
        t("vertex_paygo.cache_diagnostics.prefix_same_detail", { p0: number(comparison.commonTextChars) }));
    if (comparison.previousContentCount !== comparison.currentContentCount) add('message_count_changed', 'observed', t("vertex_paygo.cache_diagnostics.message_count_changed"),
        t("vertex_paygo.cache_diagnostics.message_count_detail", { p0: comparison.previousContentCount, p1: comparison.currentContentCount }));
    const exact = comparison.wireComparison;
    if (exact) {
        add('exact_text_prefix', 'observed', t("vertex_paygo.cache_diagnostics.exact_prefix_title"),
            t("vertex_paygo.cache_diagnostics.exact_prefix_detail", { p0: number(exact.commonTextChars), p1: number(exact.systemTextPrefixChars) }));
        const difference = exact.firstDifference;
        if (difference) {
            const location = difference.field === 'systemInstruction' ? t("vertex_paygo.cache_diagnostics.system_instructions") : t("vertex_paygo.cache_diagnostics.block_location", { p0: difference.block });
            add('first_wire_difference', 'observed', t("vertex_paygo.cache_diagnostics.first_difference"),
                difference.kind === 'text' ? t("vertex_paygo.cache_diagnostics.text_difference_location", { p0: location, p1: difference.part, p2: number(difference.offset + 1) })
                    : t("vertex_paygo.cache_diagnostics.structure_difference_location", { p0: location, p1: difference.part ? t("vertex_paygo.cache_diagnostics.part_location", { p0: difference.part }) : '', p2: difference.kind === 'role' ? t("vertex_paygo.cache_diagnostics.role") : t("vertex_paygo.cache_diagnostics.structure_or_media") }));
            if (exact.sourceHint?.kind === 'worldinfo') add('difference_worldinfo_source', 'observed', t("vertex_paygo.cache_diagnostics.worldinfo_source"),
                t("vertex_paygo.cache_diagnostics.worldinfo_source_detail", { p0: exact.sourceHint.groupId, p1: exact.sourceHint.itemId }));
            else add('difference_source_unknown', 'unknown', t("vertex_paygo.cache_diagnostics.source_unknown"),
                t("vertex_paygo.cache_diagnostics.source_unknown_detail"));
        }
    } else if (!comparison.sameBody && comparison.firstChangedBlock !== null) add('text_location_unavailable', 'unknown', t("vertex_paygo.cache_diagnostics.text_comparison_missing"),
        t("vertex_paygo.cache_diagnostics.text_comparison_missing_detail"));
    if (comparison.parametersComparable && !comparison.sameParameters) add('parameters_changed', 'observed', t("vertex_paygo.cache_diagnostics.parameters_changed"),
        t("vertex_paygo.cache_diagnostics.parameters_changed_detail"));
}

export function buildCacheMissAnalysis(current, { previous = null, reference = null, comparison = { status: 'no_previous' }, localize = createLocalizer() } = {}) {
    const t = localize;
    const ERROR_FINDINGS = Object.freeze({
        VERTEX_UPSTREAM_TIMEOUT: ['request_timeout', t("vertex_paygo.cache_diagnostics.upstream_timeout"), t("vertex_paygo.cache_diagnostics.google_timeout_detail")],
        NATIVE_RELAY_UPSTREAM_TIMEOUT: ['request_timeout', t("vertex_paygo.cache_diagnostics.upstream_timeout"), t("vertex_paygo.cache_diagnostics.upstream_timeout_detail")],
        UPSTREAM_HTTP_408: ['request_timeout', t("vertex_paygo.cache_diagnostics.http_408"), t("vertex_paygo.cache_diagnostics.http_408_detail")],
        UPSTREAM_HTTP_504: ['request_timeout', t("vertex_paygo.cache_diagnostics.http_504"), t("vertex_paygo.cache_diagnostics.http_504_detail")],
        USAGE_CAPTURE_TIMEOUT: ['capture_timeout', t("vertex_paygo.cache_diagnostics.capture_timeout"), t("vertex_paygo.cache_diagnostics.capture_timeout_detail")],
        PROCESS_RESTARTED: ['process_restarted', t("vertex_paygo.cache_diagnostics.process_restart"), t("vertex_paygo.cache_diagnostics.process_restart_detail")],
        CLIENT_DISCONNECTED: ['client_disconnected', t("vertex_paygo.cache_diagnostics.client_disconnected"), t("vertex_paygo.cache_diagnostics.client_disconnected_detail")],
        CLIENT_ABORTED: ['client_disconnected', t("vertex_paygo.cache_diagnostics.client_cancelled"), t("vertex_paygo.cache_diagnostics.client_cancelled_detail")],
        USAGE_METADATA_MISSING: ['usage_missing', t("vertex_paygo.cache_diagnostics.usage_missing"), t("vertex_paygo.cache_diagnostics.usage_missing_detail")],
        USAGE_CAPTURE_LIMIT: ['capture_limit', t("vertex_paygo.cache_diagnostics.capture_incomplete"), t("vertex_paygo.cache_diagnostics.capture_incomplete_detail")],
        USAGE_COMPRESSED_RESPONSE: ['capture_unavailable', t("vertex_paygo.cache_diagnostics.compressed_response"), t("vertex_paygo.cache_diagnostics.compressed_response_detail")],
    });

    const findings = [];
    const add = (code, confidence, title, detail, advice = '') => findings.push({ code, confidence, title, detail, advice });
    const result = { outcome: 'unknown', summary: '', reference: referenceView(current, reference), findings, note: '' };
    const { usage } = current;
    addObservedChanges(add, current, previous, reference, comparison, t);
    if (current.status === 'pending') {
        result.outcome = 'pending'; result.summary = t("vertex_paygo.cache_diagnostics.pending_summary");
        return result;
    }
    if (usage.partial) {
        result.outcome = 'incomplete'; result.summary = current.status === 'complete'
            ? t("vertex_paygo.cache_diagnostics.invalid_complete_summary")
            : t("vertex_paygo.cache_diagnostics.incomplete_summary");
        const error = Object.hasOwn(ERROR_FINDINGS, current.errorCode) ? ERROR_FINDINGS[current.errorCode] : null;
        if (error) add(error[0], 'observed', error[1], error[2]);
        else if (current.status === 'complete') add('usage_invalid', 'observed', t("vertex_paygo.cache_diagnostics.invalid_usage_title"), t("vertex_paygo.cache_diagnostics.invalid_usage_detail"));
        else add('request_incomplete', 'observed', current.status === 'failed' ? t("vertex_paygo.cache_diagnostics.request_failed") : t("vertex_paygo.cache_diagnostics.request_incomplete"),
            current.errorCode ? t("vertex_paygo.cache_diagnostics.error_code_detail", { p0: current.errorCode }) : t("vertex_paygo.cache_diagnostics.no_error_detail"));
        result.note = t("vertex_paygo.cache_diagnostics.request_process_note");
        return result;
    }
    if (usage.cacheRate === null) {
        result.summary = t("vertex_paygo.cache_diagnostics.unknown_summary");
        if (usage.cacheField === 'mixed') add('cache_count_mixed', 'unknown', t("vertex_paygo.cache_diagnostics.mixed_cache_title"),
            t("vertex_paygo.cache_diagnostics.mixed_cache_detail"));
        else if (usage.cacheField === 'invalid') add('cache_count_invalid', 'observed', t("vertex_paygo.cache_diagnostics.invalid_cache_title"),
            t("vertex_paygo.cache_diagnostics.invalid_cache_detail"));
        else if (usage.promptTokens === 0) add('empty_input', 'observed', t("vertex_paygo.cache_diagnostics.empty_input_title"), t("vertex_paygo.cache_diagnostics.empty_input_detail"));
        else add('cache_count_missing', 'observed', t("vertex_paygo.cache_diagnostics.missing_cache_title"),
            usage.cacheField === 'omitted' ? t("vertex_paygo.cache_diagnostics.omitted_cache_detail")
                : t("vertex_paygo.cache_diagnostics.missing_cache_detail"));
        result.note = t("vertex_paygo.cache_diagnostics.observations_note");
        return result;
    }
    if (usage.cacheRate > 0) {
        result.outcome = 'hit'; result.summary = t("vertex_paygo.cache_diagnostics.hit_summary", { p0: number(usage.cachedTokens), p1: rate(usage.cacheRate) });
        if (usage.cacheRate < 0.001) add('rate_rounding', 'observed', t("vertex_paygo.cache_diagnostics.rounding_title"),
            t("vertex_paygo.cache_diagnostics.rounding_detail", { p0: number(usage.cachedTokens) }));
        return result;
    }

    result.outcome = ['unverified', 'normalized'].includes(usage.cacheField) ? 'unknown' : 'miss';
    result.summary = usage.cacheField === 'unverified'
        ? t("vertex_paygo.cache_diagnostics.legacy_zero_summary")
        : usage.cacheField === 'normalized' ? t("vertex_paygo.cache_diagnostics.normalized_zero_summary")
            : usage.cacheField === 'default-zero' ? t("vertex_paygo.cache_diagnostics.default_zero_summary")
            : t("vertex_paygo.cache_diagnostics.miss_summary");
    result.note = t("vertex_paygo.cache_diagnostics.miss_note");
    if (usage.cacheField === 'unverified') add('legacy_zero', 'unknown', t("vertex_paygo.cache_diagnostics.legacy_zero_title"),
        t("vertex_paygo.cache_diagnostics.legacy_zero_detail"));
    if (usage.cacheField === 'normalized') add('normalized_usage', 'unknown', t("vertex_paygo.cache_diagnostics.normalized_title"),
        t("vertex_paygo.cache_diagnostics.normalized_detail"));
    if (current.preview.captureKind === 'tauri-frontend') {
        result.note += t("vertex_paygo.cache_diagnostics.tauri_note");
    }

    const currentAggregate = multipleRequests(current);
    const aggregate = currentAggregate || multipleRequests(reference);
    if (aggregate) add('aggregate_usage', 'unknown', t("vertex_paygo.cache_diagnostics.aggregate_title"),
        t("vertex_paygo.cache_diagnostics.aggregate_detail"));
    const minimum = cacheMinimumInputTokens(current.source, current.model);
    const belowMinimum = !currentAggregate && current.preview.status === 'available' && !current.preview.hasExplicitCache
        && current.preview.cacheMode !== 'unknown'
        && minimum !== null && usage.promptTokens < minimum;
    if (belowMinimum) add('below_minimum', 'observed', t("vertex_paygo.cache_diagnostics.minimum_title"),
        t("vertex_paygo.cache_diagnostics.minimum_detail", { p0: number(usage.promptTokens), p1: number(minimum) }),
        t("vertex_paygo.cache_diagnostics.minimum_advice"));

    if (!reference) {
        if (current.preview.hasExplicitCache) add('explicit_cache_unconfirmed', 'unknown', t("vertex_paygo.cache_diagnostics.explicit_title"),
            t("vertex_paygo.cache_diagnostics.explicit_detail"));
        else add('no_reference', 'possible', t("vertex_paygo.cache_diagnostics.no_reference_title"),
            t("vertex_paygo.cache_diagnostics.no_reference_detail"),
            t("vertex_paygo.cache_diagnostics.no_reference_advice"));
    } else if (comparison.status === 'compared') {
        if (!aggregate && !belowMinimum && (comparison.sameBody || comparison.prefixUnchanged)) {
            if (current.preview.hasExplicitCache) add('explicit_cache_unconfirmed', 'unknown', t("vertex_paygo.cache_diagnostics.explicit_title"),
                t("vertex_paygo.cache_diagnostics.explicit_detail"));
            else add('cache_unavailable', 'possible', t("vertex_paygo.cache_diagnostics.unavailable_title"),
                t("vertex_paygo.cache_diagnostics.unavailable_detail", { p0: reference.usage.cacheRate > 0 ? t("vertex_paygo.cache_diagnostics.previous_hit_detail", { p0: rate(reference.usage.cacheRate) }) : t("vertex_paygo.cache_diagnostics.previous_no_hit_detail") }),
                t("vertex_paygo.cache_diagnostics.unavailable_advice"));
        }
    } else {
        add('comparison_unavailable', 'unknown', t("vertex_paygo.cache_diagnostics.unavailable_comparison_title"),
            comparison.status === 'different_epoch' ? t("vertex_paygo.cache_diagnostics.epoch_detail")
                : t("vertex_paygo.cache_diagnostics.incomplete_comparison_detail"));
        if (!belowMinimum && !aggregate) add('cache_conditions_unknown', 'possible', t("vertex_paygo.cache_diagnostics.conditions_title"),
            t("vertex_paygo.cache_diagnostics.conditions_detail"));
    }
    return result;
}
