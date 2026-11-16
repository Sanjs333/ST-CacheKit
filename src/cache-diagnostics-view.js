/* Local cache diagnostics presentation; SPDX-License-Identifier: MPL-2.0 */
import { CACHE_POLICY_REVIEWED_AT, CACHE_POLICY_URLS } from './cache-diagnostics-policy.js';
import { formatCacheHitRate } from './cost-model.js';
import { createLocalizer } from './i18n.js';

export function createCacheDiagnosticsViewer({ documentRef = globalThis.document, onRefresh, onSelect, onClose,
    coverageNotice = '', coverageSummary = '', localize = createLocalizer() }) {
    const t = localize;
    const number = value => value === null || value === undefined ? t("vertex_paygo.cache_diagnostics.unknown") : value.toLocaleString(undefined);
    const cacheRate = value => formatCacheHitRate(value, t("vertex_paygo.cache_diagnostics.unknown"));
    const CONFIDENCE_LABELS = { observed: t("vertex_paygo.cache_diagnostics.observed"), possible: t("vertex_paygo.cache_diagnostics.possible"), unknown: t("vertex_paygo.cache_diagnostics.insufficient") };
    const ROLE_LABELS = { system: t("vertex_paygo.cache_diagnostics.role_system"), user: t("vertex_paygo.cache_diagnostics.role_user"), model: t("vertex_paygo.cache_diagnostics.role_model"), tool: t("vertex_paygo.cache_diagnostics.role_tool"), unknown: t("vertex_paygo.cache_diagnostics.role_unknown") };
    const SOURCE_LABELS = { vertexai: 'Vertex AI', makersuite: 'Google AI Studio' };
    const STATUS_LABELS = { pending: t("vertex_paygo.cache_diagnostics.status_pending"), complete: t("vertex_paygo.cache_diagnostics.status_complete"), incomplete: t("vertex_paygo.cache_diagnostics.status_incomplete"), failed: t("vertex_paygo.cache_diagnostics.status_failed"), unknown: t("vertex_paygo.cache_diagnostics.unknown") };
    const time = value => {
        const date = new Date(value);
        return Number.isFinite(date.getTime()) ? date.toLocaleString(undefined, { month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : value;
    };
    const interval = value => {
        if (value === null) return t("vertex_paygo.cache_diagnostics.unknown");
        if (value < 1000) return t("vertex_paygo.cache_diagnostics.interval_short");
        const seconds = Math.floor(value / 1000);
        if (seconds < 60) return t("vertex_paygo.cache_diagnostics.interval_seconds", { p0: seconds });
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return t("vertex_paygo.cache_diagnostics.interval_minutes", { p0: minutes, p1: seconds % 60 });
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return t("vertex_paygo.cache_diagnostics.interval_hours", { p0: hours, p1: minutes % 60 });
        return t("vertex_paygo.cache_diagnostics.interval_days", { p0: Math.floor(hours / 24), p1: hours % 24 });
    };


    const make = (tag, className = '', value, attributes = {}) => {
        const node = documentRef.createElement(tag);
        if (className) node.className = className;
        if (value !== undefined) node.textContent = String(value);
        for (const [name, item] of Object.entries(attributes)) node.setAttribute(name, String(item));
        return node;
    };
    const disposers = [];
    const listen = (node, event, callback) => {
        node.addEventListener(event, callback); disposers.push(() => node.removeEventListener(event, callback));
    };
    const iconButton = (label, icon, action) => {
        const button = make('button', 'vertex-paygo-icon-button vertex-paygo-log-tool', undefined,
            { type: 'button', title: label, 'aria-label': label, 'data-cache-action': action });
        button.append(make('i', `fa-solid ${icon}`, undefined, { 'aria-hidden': 'true' }));
        return button;
    };
    const disclosure = label => {
        const details = make('details', 'vertex-paygo-log-json vertex-paygo-cache-detail');
        const summary = make('summary', 'vertex-paygo-log-json-summary');
        summary.append(make('i', 'fa-solid fa-angle-right vertex-paygo-log-disclosure', undefined, { 'aria-hidden': 'true' }),
            make('span', '', label));
        details.append(summary); return details;
    };
    const root = make('section', 'vertex-paygo-log-viewer vertex-paygo-cache-viewer', undefined,
        { 'aria-label': t("vertex_paygo.cache_diagnostics.title") });
    const header = make('header', 'vertex-paygo-log-header');
    const heading = make('div', 'vertex-paygo-log-heading-row');
    const tools = make('div', 'vertex-paygo-log-tools');
    const refresh = iconButton(t("vertex_paygo.cache_diagnostics.refresh"), 'fa-rotate-right', 'refresh');
    refresh.id = 'vertex-paygo-cache-diagnostics-refresh';
    const close = iconButton(t("vertex_paygo.cache_diagnostics.close"), 'fa-xmark', 'close');
    close.classList.add('vertex-paygo-log-close');
    tools.append(refresh, close); heading.append(make('h3', '', t("vertex_paygo.cache_diagnostics.title")), tools);
    const selector = make('select', 'text_pole', undefined, { id: 'vertex-paygo-cache-diagnostics-select', 'aria-label': t("vertex_paygo.cache_diagnostics.select_label") });
    const selectLabel = make('label', 'vertex-paygo-cache-selector');
    selectLabel.append(make('span', '', t("vertex_paygo.cache_diagnostics.view_request")), selector);
    header.append(heading, make('p', 'vertex-paygo-log-description', t("vertex_paygo.cache_diagnostics.description")), selectLabel);
    if (coverageSummary) header.append(make('p', 'vertex-paygo-cache-note', coverageSummary));
    const body = make('div', 'vertex-paygo-cache-viewer-body', undefined, { tabindex: '0' });
    const status = make('p', 'vertex-paygo-log-empty', '', { 'aria-live': 'polite' });
    const content = make('div', 'vertex-paygo-cache-content');
    const metadata = make('p', 'vertex-paygo-cache-request-meta');
    const metrics = make('div', 'vertex-paygo-cache-metrics', undefined, { id: 'vertex-paygo-cache-diagnostics-usage' });
    const values = new Map();
    for (const [id, label, unit] of [['input', t("vertex_paygo.cache_diagnostics.input"), 'tokens'], ['cached', t("vertex_paygo.cache_diagnostics.cached"), 'tokens'], ['rate', t("vertex_paygo.cache_diagnostics.hit_rate"), '']]) {
        const metric = make('div', 'vertex-paygo-cache-metric');
        const value = make('strong', '', t("vertex_paygo.cache_diagnostics.unknown"), { 'data-cache-metric': id }); values.set(id, value);
        const valueRow = make('div', 'vertex-paygo-cache-metric-value');
        valueRow.append(value); if (unit) valueRow.append(make('small', '', unit));
        metric.append(make('span', 'vertex-paygo-cache-metric-label', label), valueRow); metrics.append(metric);
    }
    const progress = make('progress', 'vertex-paygo-cache-progress', undefined, { max: '1', 'aria-label': t("vertex_paygo.cache_diagnostics.progress_label") });
    const warning = make('p', 'vertex-paygo-cache-warning', '', { 'data-cache-warning': '' });
    const multi = make('p', 'vertex-paygo-cache-note', '', { 'data-cache-subrequests': '' });
    const analysis = make('section', 'vertex-paygo-cache-analysis', undefined,
        { id: 'vertex-paygo-cache-diagnostics-analysis', 'aria-label': t("vertex_paygo.cache_diagnostics.analysis_label") });
    const analysisSummary = make('p', 'vertex-paygo-cache-analysis-summary');
    const reference = make('p', 'vertex-paygo-cache-note', '', { 'data-cache-reference': '' });
    const findings = make('ul', 'vertex-paygo-cache-findings');
    const analysisNote = make('p', 'vertex-paygo-cache-note', '', { 'data-cache-analysis-note': '' });
    analysis.append(make('h4', '', t("vertex_paygo.cache_diagnostics.analysis_title")), analysisSummary, reference, findings, analysisNote);
    const advanced = disclosure(t("vertex_paygo.cache_diagnostics.structure_title"));
    const structure = make('p', 'vertex-paygo-cache-note', '', { id: 'vertex-paygo-cache-diagnostics-structure' });
    const comparison = make('p', 'vertex-paygo-cache-note', '', { id: 'vertex-paygo-cache-diagnostics-comparison' });
    const comparisonNote = make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.block_prefix_note"));
    const blockWrap = make('div', 'vertex-paygo-cost-table-wrap');
    const blockTable = make('table', 'vertex-paygo-cost-table', undefined, { 'aria-label': t("vertex_paygo.cache_diagnostics.block_table") });
    const blockHead = make('thead'), blockHeadRow = make('tr');
    for (const label of [t("vertex_paygo.cache_diagnostics.previous_block"), t("vertex_paygo.cache_diagnostics.current_block"), t("vertex_paygo.cache_diagnostics.correspondence"), t("vertex_paygo.cache_diagnostics.text_length")]) blockHeadRow.append(make('th', '', label));
    blockHead.append(blockHeadRow);
    const blockRows = make('tbody'); blockTable.append(blockHead, blockRows); blockWrap.append(blockTable);
    const blockNote = make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.alignment_note"));
    const prefixStatus = make('p', 'vertex-paygo-cache-note');
    const segmentWrap = make('div', 'vertex-paygo-cost-table-wrap');
    const segmentTable = make('table', 'vertex-paygo-cost-table', undefined, { 'aria-label': t("vertex_paygo.cache_diagnostics.segment_table") });
    const segmentHead = make('thead'), segmentHeadRow = make('tr');
    for (const label of [t("vertex_paygo.cache_diagnostics.block"), t("vertex_paygo.cache_diagnostics.part"), t("vertex_paygo.cache_diagnostics.area"), t("vertex_paygo.cache_diagnostics.length")]) segmentHeadRow.append(make('th', '', label));
    segmentHead.append(segmentHeadRow);
    const segmentRows = make('tbody'); segmentTable.append(segmentHead, segmentRows); segmentWrap.append(segmentTable);
    const raw = disclosure(t("vertex_paygo.cache_diagnostics.raw_summary"));
    const preview = make('pre', 'vertex-paygo-log-record-raw', '', { id: 'vertex-paygo-cache-diagnostics-preview' });
    raw.append(preview); advanced.append(structure, prefixStatus, segmentWrap, comparison, comparisonNote, blockWrap, blockNote, raw);
    const explanation = disclosure(t("vertex_paygo.cache_diagnostics.data_notes"));
    explanation.append(make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.rate_formula")),
        make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.usage_note")),
        make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.reference_note")),
        make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.memory_note")),
        make('p', 'vertex-paygo-cache-note', coverageNotice || t("vertex_paygo.cache_diagnostics.coverage_note")));
    const policyNote = make('p', 'vertex-paygo-cache-note', t("vertex_paygo.cache_diagnostics.policy_note", { p0: CACHE_POLICY_REVIEWED_AT }));
    policyNote.append(make('a', '', 'AI Studio', { href: CACHE_POLICY_URLS.makersuite, target: '_blank', rel: 'noopener noreferrer' }),
        documentRef.createTextNode(' · '), make('a', '', 'Vertex AI', { href: CACHE_POLICY_URLS.vertexai, target: '_blank', rel: 'noopener noreferrer' }));
    explanation.append(policyNote);
    content.append(metadata, metrics, progress, warning, multi, analysis, advanced, explanation);
    body.append(status, content);
    const footer = make('footer', 'vertex-paygo-cache-viewer-footer');
    const counter = make('small', '', '', { id: 'vertex-paygo-cache-diagnostics-status', 'aria-live': 'polite' });
    footer.append(counter); root.append(header, body, footer);
    listen(refresh, 'click', onRefresh); listen(selector, 'change', () => onSelect(selector.value)); listen(close, 'click', onClose);
    return {
        root,
        render({ views, selected, state, comparisonText }) {
            const current = views.find(view => view.id === selected);
            const previous = selector.value;
            const labels = views.map(view => t("vertex_paygo.cache_diagnostics.request_option", { p0: time(view.createdAt), p1: view.model, p2: STATUS_LABELS[view.status], p3: cacheRate(view.usage.cacheRate) }));
            if (selector.options.length !== views.length || [...selector.options].some((option, index) => option.value !== views[index].id
                || option.textContent !== labels[index])) {
                selector.replaceChildren(...views.map((view, index) => make('option', '', labels[index], { value: view.id })));
            }
            selector.value = selected ?? ''; selector.disabled = !views.length; refresh.disabled = state === 'loading';
            root.setAttribute('aria-busy', String(state === 'loading'));
            status.textContent = state === 'loading' ? t("vertex_paygo.cache_diagnostics.loading") : state === 'error' ? t("vertex_paygo.cache_diagnostics.load_retry")
                : state === 'no_chat' ? t("vertex_paygo.cache_diagnostics.open_chat") : !current ? t("vertex_paygo.cache_diagnostics.no_usage") : '';
            status.hidden = !status.textContent; content.hidden = !current;
            counter.textContent = views.length ? t("vertex_paygo.cache_diagnostics.record_count", { p0: views.length }) : t("vertex_paygo.cache_diagnostics.no_records");
            if (!current) { values.forEach(value => { value.textContent = t("vertex_paygo.cache_diagnostics.unknown"); }); preview.textContent = ''; return; }
            if (previous !== selector.value) body.scrollTop = 0;
            const { usage } = current;
            metadata.textContent = [SOURCE_LABELS[current.source] ?? current.source, current.model, current.region, STATUS_LABELS[current.status]].filter(Boolean).join(' · ');
            values.get('input').textContent = number(usage.promptTokens); values.get('cached').textContent = number(usage.cachedTokens);
            values.get('rate').textContent = cacheRate(usage.cacheRate);
            progress.hidden = usage.cacheRate === null;
            if (usage.cacheRate !== null) progress.value = usage.cacheRate;
            const warnings = [];
            if (usage.cacheField === 'missing' || usage.cacheField === 'omitted') warnings.push(t("vertex_paygo.cache_diagnostics.cache_missing"));
            else if (usage.cacheField === 'mixed') warnings.push(t("vertex_paygo.cache_diagnostics.cache_mixed"));
            else if (usage.cacheField === 'invalid') warnings.push(t("vertex_paygo.cache_diagnostics.cache_invalid"));
            else if (usage.cacheField === 'default-zero') warnings.push(t("vertex_paygo.cache_diagnostics.cache_default_zero"));
            if (usage.partial) warnings.push(t("vertex_paygo.cache_diagnostics.usage_partial"));
            warning.textContent = warnings.join(' '); warning.hidden = !warning.textContent;
            multi.textContent = current.googleRequestCount > 1 ? t("vertex_paygo.cache_diagnostics.subrequests", { p0: current.googleRequestCount }) : '';
            multi.hidden = !multi.textContent;
            const diagnosis = current.diagnosis;
            analysis.hidden = !diagnosis;
            if (diagnosis) {
                analysis.setAttribute('data-cache-outcome', diagnosis.outcome);
                analysisSummary.textContent = diagnosis.summary;
                reference.textContent = diagnosis.reference ? t("vertex_paygo.cache_diagnostics.reference", { p0: time(diagnosis.reference.createdAt), p1: interval(diagnosis.reference.elapsedMs), p2: cacheRate(diagnosis.reference.cacheRate) }) : '';
                reference.hidden = !reference.textContent;
                findings.replaceChildren(...diagnosis.findings.map(finding => {
                    const item = make('li', '', undefined, { 'data-cache-reason': finding.code });
                    const title = make('div', 'vertex-paygo-cache-finding-title');
                    title.append(make('small', 'vertex-paygo-cache-confidence', CONFIDENCE_LABELS[finding.confidence],
                        { 'data-cache-confidence': finding.confidence }), make('strong', '', finding.title));
                    item.append(title, make('p', '', finding.detail));
                    if (finding.advice) item.append(make('p', 'vertex-paygo-cache-advice', finding.advice));
                    return item;
                }));
                findings.hidden = !diagnosis.findings.length;
                analysisNote.textContent = diagnosis.note; analysisNote.hidden = !diagnosis.note;
            }
            const summary = current.preview;
            structure.textContent = summary.status === 'available'
                ? t("vertex_paygo.cache_diagnostics.structure", { p0: summary.captureKind === 'tauri-frontend' ? t("vertex_paygo.cache_diagnostics.tauri_capture") : '', p1: summary.systemInstruction ? t("vertex_paygo.cache_diagnostics.yes") : t("vertex_paygo.cache_diagnostics.no"), p2: number(summary.contentCount), p3: summary.contents.slice(0, 8).map(item => ROLE_LABELS[item?.role] ?? t("vertex_paygo.cache_diagnostics.role_unknown")).join(' → '), p4: summary.contents.length > 8 || summary.omittedContents > 0 ? ' → …' : '' })
                : t("vertex_paygo.cache_diagnostics.no_structure");
            comparison.textContent = comparisonText(current.comparison);
            const boundary = summary.cacheBoundary;
            prefixStatus.textContent = boundary ? t("vertex_paygo.cache_diagnostics.boundary", { p0: boundary.status === 'split' ? t("vertex_paygo.cache_diagnostics.boundary_split") : t("vertex_paygo.cache_diagnostics.boundary_separate"), p1: number(boundary.stableTextChars), p2: boundary.block, p3: boundary.part })
                : t("vertex_paygo.cache_diagnostics.boundary_unknown");
            const segments = [];
            for (const part of summary.systemInstruction?.textSegments ?? []) segments.push({ block: t("vertex_paygo.cache_diagnostics.role_system"), ...part, area: t("vertex_paygo.cache_diagnostics.area_system") });
            summary.contents?.forEach((content, index) => {
                for (const part of content?.textSegments ?? []) segments.push({ block: index + 1, ...part,
                    area: boundary ? index + 1 < boundary.block || index + 1 === boundary.block && part.part < boundary.part ? t("vertex_paygo.cache_diagnostics.area_stable") : t("vertex_paygo.cache_diagnostics.area_history") : t("vertex_paygo.cache_diagnostics.area_unmarked") });
            });
            segmentWrap.hidden = !segments.length;
            segmentRows.replaceChildren(...segments.slice(0, 128).map(segment => {
                const row = make('tr'); for (const value of [segment.block, segment.part, segment.area, number(segment.textChars)]) row.append(make('td', '', value)); return row;
            }));
            const rows = current.comparison?.status === 'compared' ? current.comparison.alignment ?? [] : [];
            blockWrap.hidden = !rows.length; blockNote.hidden = !rows.length;
            blockRows.replaceChildren(...rows.map(change => {
                const row = make('tr');
                const label = change.kind === 'same' ? t("vertex_paygo.cache_diagnostics.block_same") : change.kind === 'changed' ? t("vertex_paygo.cache_diagnostics.block_changed")
                    : change.kind === 'unmatched-previous' ? t("vertex_paygo.cache_diagnostics.block_previous_unmatched") : t("vertex_paygo.cache_diagnostics.block_current_unmatched");
                for (const value of [change.previous ?? '—', change.current ?? '—', label,
                    `${number(change.previousChars)} → ${number(change.currentChars)}`]) row.append(make('td', '', value));
                return row;
            }));
            preview.textContent = summary.status === 'available' ? JSON.stringify(summary, null, 2)
                : summary.reason === 'BODY_TOO_LARGE' ? t("vertex_paygo.cache_diagnostics.body_too_large")
                    : t("vertex_paygo.cache_diagnostics.structure_missing");
        },
        destroy() { for (const dispose of disposers) dispose(); root.remove(); },
    };
}
