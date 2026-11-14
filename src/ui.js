/*
 * Copyright (c) 2026 Mana Nekoha
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/.
 */

import { AI_STUDIO_SOURCE, CLIENT_VERSION, DEFAULT_STATE, isGoogleSource, TIER, UPDATE_POLL_INTERVAL_MS, VERTEX_SOURCE } from './constants.js';
import { getSafeErrorContext } from './client-logger.js';
import {
    createLocalizer,
    getTierLabel,
    localizeError,
    localizeSupport,
    localizeValidation,
} from './i18n.js';
import { getModelPolicy, getTierSupport } from './model-policy.js';
import { getModelTierOptions, replaceTierOptions, renderTierGuidance } from './tier-options.js';
import { createLogSettingsUi } from './log-settings-ui.js';
import { mountExtensionSettings } from './extension-settings.js';
import { bindExtensionTheme } from './theme.js';
import { showExtensionConfirm } from './dialog.js';
import { isolatePanelEvents } from './panel-events.js';
import {
    attachStateToProfile,
    getActiveProfile,
    normalizeImportedPreset,
    normalizeExportedPreset,
    readPersistedState,
    writeActiveProfileRegion,
    writePersistedState,
} from './persistence.js';
import { createReconcileGuard, planPersistedReconciliation, normalizeState, resolveModelChange, resolveRegionChange, resolveTierSelection, validatePluginState } from "./state-machine.js";


import { createMessageCostPlacementControl, DEFAULT_MESSAGE_COST_PLACEMENT } from './message-cost-settings.js';

const RECONCILE_STABILITY_MS = 250;
const PROFILE_TRANSITION_TIMEOUT_MS = 30_000;

function createElement(tag, attributes = {}, text = '') {
    const element = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
        if (name === 'class') {
            element.className = value;
        } else {
            element.setAttribute(name, value);
        }
    }
    if (text) {
        element.textContent = text;
    }
    return element;
}

export function resolveVertexModel({ profile, inputValue, settingsValue, selectValue, source = VERTEX_SOURCE } = {}) {
    const profileOwnsModel = profile?.mode === 'cc'
        && profile?.api === source
        && !profile?.exclude?.includes('model');
    const candidates = [
        inputValue,
        settingsValue,
        profileOwnsModel ? profile.model : '',
        selectValue,
    ];
    return candidates
        .map(value => typeof value === 'string' ? value.trim() : '')
        .find(Boolean) ?? '';
}

function buildControls(localize) {
    const iconButton = (key, icon, attributes = {}) => {
        const label = localize(key);
        // Do not translate button contents: a plain data-i18n key would replace its icon.
        const button = createElement('button', { type: 'button', ...attributes,
            class: `${attributes.class ?? 'menu_button'} vertex-paygo-icon-button`,
            title: label, 'aria-label': label });
        button.append(createElement('i', { class: `fa-solid ${icon}`, 'aria-hidden': 'true' }));
        return button;
    };
    const root = createElement('section', { id: 'vertex-paygo-settings', class: 'vertex-paygo-settings' });

    const tierRow = createElement('div', { class: 'vertex-paygo-row flex-container alignItemsCenter' });
    const tierLabel = createElement(
        'label',
        { for: 'vertex-paygo-tier', 'data-i18n': 'vertex_paygo.service_tier' },
        localize('vertex_paygo.service_tier'),
    );
    const tierSelect = createElement('select', { id: 'vertex-paygo-tier', class: 'text_pole flex1' });
    for (const tier of [TIER.STANDARD, TIER.FLEX]) {
        const key = `vertex_paygo.tier.${tier}`;
        tierSelect.append(createElement('option', { value: tier, 'data-i18n': key }, localize(key)));
    }
    tierRow.append(tierLabel, tierSelect);

    const guidance = createElement('div', { class: 'vertex-paygo-guidance', 'aria-live': 'polite' });

    const policyStatus = createElement('small', { class: 'vertex-paygo-status', 'aria-live': 'polite' });

    const updateRow = createElement('div', { id: 'vertex-paygo-update-row', class: 'vertex-paygo-update-row' });
    const checkUpdateButton = createElement(
        'button',
        { id: 'vertex-paygo-update-check', type: 'button', class: 'menu_button vertex-paygo-update-check', 'data-i18n': 'vertex_paygo.update.check' },
        localize('vertex_paygo.update.check'),
    );
    const applyUpdateButton = createElement(
        'button',
        { id: 'vertex-paygo-update-apply', type: 'button', class: 'menu_button vertex-paygo-update-apply', 'data-i18n': 'vertex_paygo.update.apply' },
        localize('vertex_paygo.update.apply'),
    );
    const updateNotice = createElement(
        'small',
        { class: 'vertex-paygo-update-notice', 'data-i18n': 'vertex_paygo.update.notice' },
        localize('vertex_paygo.update.notice'),
    );
    const updateStatus = createElement('small', { id: 'vertex-paygo-update-status', class: 'vertex-paygo-update-status', 'aria-live': 'polite' });
    updateRow.append(checkUpdateButton, applyUpdateButton, updateNotice, updateStatus);

    const tierFixed = createElement('span', { id: 'vertex-paygo-tier-fixed', class: 'vertex-paygo-tier-fixed' });
    const tierRestore = createElement('button', { type: 'button', id: 'vertex-paygo-tier-restore', class: 'menu_button' }, localize('vertex_paygo.tier.restore_standard'));
    tierRow.append(tierFixed, tierRestore);
    root.append(tierRow, guidance, policyStatus);

    const settingsRoot = createElement('section', { id: 'vertex-paygo-general-settings', class: 'vertex-paygo-settings' });
    const displayGroup = createElement('div', { class: 'vertex-paygo-group', id: 'vertex-paygo-display-group' });
    const maintenanceGroup = createElement('div', { class: 'vertex-paygo-group', id: 'vertex-paygo-maintenance-group' });
    const generalServerRow = createElement('div', { class: 'vertex-paygo-general-server-row' });
    const generalServerStatus = createElement(
        'small',
        { class: 'vertex-paygo-general-server-status', 'aria-live': 'polite' },
        localize('vertex_paygo.server.checking'),
    );
    const generalRetryButton = iconButton('vertex_paygo.retry', 'fa-rotate-right', {
        id: 'vertex-paygo-general-retry', class: 'vertex-paygo-general-retry vertex-paygo-maintenance-refresh',
    });
    const componentVersions = createElement('div', { class: 'vertex-paygo-component-versions' });
    const clientVersion = createElement('span', { class: 'vertex-paygo-component-version', id: 'vertex-paygo-client-version', title: CLIENT_VERSION },
        `${localize('vertex_paygo.version.frontend')} ${CLIENT_VERSION.replace(/\.0$/u, '')}`);
    const backendVersion = createElement('span', { class: 'vertex-paygo-component-version', id: 'vertex-paygo-backend-version' },
        `${localize('vertex_paygo.version.backend')} —`);
    componentVersions.append(clientVersion, backendVersion);
    generalServerRow.append(generalServerStatus, componentVersions, generalRetryButton);
    maintenanceGroup.append(updateRow);
    settingsRoot.append(generalServerRow, displayGroup, maintenanceGroup);
    return {
        root,
        settingsRoot,
        generalServerRow,
        backendVersion,
        displayGroup,
        maintenanceGroup,
        generalServerStatus,
        generalRetryButton,
        guidance,
        tierSelect,
        tierFixed,
        tierRestore,
        policyStatus,
        updateRow,
        checkUpdateButton,
        applyUpdateButton,
        updateStatus,
        updateNotice,
    };
}

export function createPayGoUi({
    context,
    serverClient,
    notifyError = () => {},
    notifyWarning = () => {},
    logger = console,
    localize,
    getMessageCostPlacement = () => DEFAULT_MESSAGE_COST_PLACEMENT,
    setMessageCostPlacement = () => {},
    getMessageCostRecentCount = () => 20, setMessageCostRecentCount = () => {},
}) {
    localize ??= createLocalizer((fallback, key) => context?.translate?.(fallback, key));
    const regionInput = document.getElementById('vertexai_region');
    const modelSelect = document.getElementById('model_vertexai_select');
    const googleModelSelect = document.getElementById('model_google_select');
    const googleContainer = document.getElementById('makersuite_form');
    if (!(regionInput instanceof HTMLInputElement) || !(modelSelect instanceof HTMLSelectElement)) {
        throw new Error(localize('vertex_paygo.error.controls_missing'));
    }

    const controls = buildControls(localize);
    const placementControl = createMessageCostPlacementControl({ localize, getMessageCostPlacement, setMessageCostPlacement,
        getMessageCostRecentCount, setMessageCostRecentCount });
    controls.displayGroup.append(placementControl.root);
    const unmountSettings = mountExtensionSettings(controls.settingsRoot, {
        tab: 'general',
        label: localize('vertex_paygo.settings.tab.general'),
    });
    const logSettings = createLogSettingsUi({ context, serverClient, logger, notifyError, localize,
        onRetry: () => refreshHealth() });
    const regionContainer = regionInput.closest('.flex-container.flexFlowColumn') ?? regionInput.parentElement;
    regionContainer.after(controls.root);
    const controlsTheme = bindExtensionTheme(controls.root, { skipBg: true });
    const disposeControlsEvents = isolatePanelEvents(controls.root);

    let state = readPersistedState(context);
    let lastModel = getModel();
    let transitionPending = false;
    let revertingModel = false;
    let healthState = {
        status: 'checking',
        message: localize('vertex_paygo.server.checking'),
        logsAvailable: false,
        updaterAvailable: false,
    };
    let appReady = false;
    let reconcileQueued = false;
    let reconcileTimer = null;
    let profileTransitionPending = false;
    let profileTransitionTimer = null;
    let profileTransitionTargetId = null;

    let updateState = { status: 'idle' };
    let updatePending = false;
    let destroyed = false;
    let updatePollTimer = null;
    let finishUpdatePoll = null;
    const reconcileGuard = createReconcileGuard();

    const popupResult = context.POPUP_RESULT;

    function getSource() {
        return context.chatCompletionSettings.chat_completion_source;
    }

    function getModelSelect() {
        return getSource() === AI_STUDIO_SOURCE ? googleModelSelect : modelSelect;
    }

    function getModelInput() {
        if (getSource() === AI_STUDIO_SOURCE) return null;
        const element = document.getElementById('vertexai_model_id');
        return element instanceof HTMLInputElement ? element : null;
    }

    function getModel() {
        const modelInput = getModelInput();
        return resolveVertexModel({
            source: getSource(),
            profile: getActiveProfile(context),
            inputValue: modelInput instanceof HTMLInputElement ? modelInput.value : '',
            settingsValue: getSource() === AI_STUDIO_SOURCE
                ? context.chatCompletionSettings.google_model : context.chatCompletionSettings.vertexai_model,
            selectValue: getModelSelect()?.value,
        });
    }

    function getRegion() {
        return String(context.chatCompletionSettings.vertexai_region || regionInput.value || 'us-central1');
    }

    function isVertexSelected() {
        return context.chatCompletionSettings.chat_completion_source === VERTEX_SOURCE;
    }

    function syncPersistedState() {
        state = readPersistedState(context);
        render();
    }

    function schedulePersistedReconciliation({ invalidate = true } = {}) {
        if (invalidate) {
            reconcileGuard.invalidate();
        }
        reconcileQueued = true;
        if (!appReady || transitionPending || profileTransitionPending) return;

        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
        }
        reconcileTimer = setTimeout(() => {
            reconcileTimer = null;
            if (!appReady || transitionPending || profileTransitionPending || !reconcileQueued) return;
            reconcileQueued = false;
            void reconcilePersistedState().catch(error => {
                console.error('[提示词缓存优化] Saved-state reconciliation failed.', error);
            });
        }, RECONCILE_STABILITY_MS);
    }

    function beginProfileTransition() {
        const profileSelect = document.getElementById('connection_profiles');
        const selectedProfileId = profileSelect instanceof HTMLSelectElement
            ? profileSelect.value
            : context.extensionSettings?.connectionManager?.selectedProfile;
        profileTransitionTargetId = String(selectedProfileId ?? '');
        profileTransitionPending = true;
        reconcileGuard.invalidate();
        reconcileQueued = true;
        if (reconcileTimer !== null) {
            clearTimeout(reconcileTimer);
            reconcileTimer = null;
        }
        if (profileTransitionTimer !== null) {
            clearTimeout(profileTransitionTimer);
        }
        profileTransitionTimer = setTimeout(() => {
            profileTransitionTimer = null;
            profileTransitionPending = false;
            profileTransitionTargetId = null;
            syncPersistedState();
            schedulePersistedReconciliation();
        }, PROFILE_TRANSITION_TIMEOUT_MS);
    }

    function finishProfileTransition(loadedProfileName) {
        if (profileTransitionPending && typeof loadedProfileName === 'string') {
            const manager = context.extensionSettings?.connectionManager;
            const selectedProfileId = String(manager?.selectedProfile ?? '');
            const selectedProfile = manager?.profiles?.find(profile => profile?.id === selectedProfileId);
            const expectedName = selectedProfile?.name ?? '<None>';
            if (selectedProfileId !== profileTransitionTargetId || loadedProfileName !== expectedName) {
                return;
            }
        }
        if (profileTransitionTimer !== null) {
            clearTimeout(profileTransitionTimer);
            profileTransitionTimer = null;
        }
        profileTransitionPending = false;
        profileTransitionTargetId = null;
        syncPersistedState();
        schedulePersistedReconciliation();
    }

    function finishTransition() {
        transitionPending = false;
        render();
        if (reconcileQueued) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    }

    function applyState(nextState, { persist = true } = {}) {
        state = normalizeState(nextState);
        if (persist) {
            void Promise.resolve(writePersistedState(context, state)).catch(error => {
                notifyError(localize('vertex_paygo.error.persist', {
                    error: error instanceof Error ? error.message : String(error),
                }));
            });
        }
        render();
        return state;
    }

    function setRegion(region, { updateProfile = true } = {}) {
        regionInput.value = region;
        regionInput.dispatchEvent(new Event('input', { bubbles: true }));
        if (updateProfile) {
            writeActiveProfileRegion(context, region);
        }
    }

    function renderPolicyStatus(policy) {
        controls.policyStatus.classList.remove('vertex-paygo-status--warning', 'vertex-paygo-status--error');

        if (!policy.model) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.model_unresolved');
            return;
        }

        if (!policy.isGemini) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.non_gemini');
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        const support = state.tier === TIER.STANDARD ? null : getTierSupport(policy.model, state.tier, getSource());
        if (support?.level === 'unverified') {
            controls.policyStatus.textContent = localizeSupport(localize, support, state.tier);
            controls.policyStatus.classList.add('vertex-paygo-status--warning');
            return;
        }

        const validation = validatePluginState({ state, model: policy.model, region: getRegion(), source: getSource() });
        if (!validation.ok) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.blocked', {
                message: localizeValidation(localize, validation, state),
            });
            controls.policyStatus.classList.add('vertex-paygo-status--error');
            return;
        }

        if (state.tier === TIER.STANDARD) {
            controls.policyStatus.textContent = localize('vertex_paygo.status.native_standard');
        } else {
            controls.policyStatus.textContent = localize(getSource() === AI_STUDIO_SOURCE
                ? 'vertex_paygo.ai_studio.status' : 'vertex_paygo.status.tier_global', {
                tier: getTierLabel(localize, state.tier),
            });
        }
    }

    function render() {
        if (destroyed) return;
        placementControl.render();
        const aiStudio = getSource() === AI_STUDIO_SOURCE;

        if (aiStudio && googleContainer && controls.root.parentElement !== googleContainer) {
            googleContainer.append(controls.root);
        } else if (!aiStudio && controls.root.previousElementSibling !== regionContainer) {
            regionContainer.after(controls.root);
        }
        const policy = getModelPolicy(getModel(), getSource());
        const choices = getModelTierOptions(policy.model, getSource());
        const available = replaceTierOptions(controls.tierSelect, choices, { selected: state.tier, localize, documentRef: document });
        const single = choices.length === 1;
        controls.tierSelect.hidden = single;
        controls.tierSelect.disabled = transitionPending;
        controls.tierFixed.hidden = !single;
        controls.tierFixed.textContent = getTierLabel(localize, choices[0]?.tier ?? TIER.STANDARD);
        controls.tierRestore.hidden = !single || available || !policy.model;
        controls.tierRestore.disabled = transitionPending;
        renderTierGuidance(controls.guidance, policy.model, getSource(), { localize, documentRef: document });
        controls.root.dataset.active = String(isGoogleSource(getSource()));
        controls.root.dataset.serverStatus = healthState.status;
        controls.settingsRoot.dataset.serverStatus = healthState.status;
        controls.generalServerStatus.textContent = localize(`vertex_paygo.server.state.${healthState.status}`);
        const version = healthState.version ?? '—';
        controls.backendVersion.textContent = `${localize('vertex_paygo.version.backend')} ${version.replace(/\.0$/u, '')}`;
        controls.backendVersion.title = version;
        controls.generalServerStatus.title = healthState.detail || '';
        controls.generalRetryButton.disabled = healthState.status === 'checking';
        logSettings.setHealth(healthState);

        // The panel offers updates only where the backend supports them and the
        // current session may use them; an older backend simply hides the row.
        controls.updateRow.hidden = !healthState.updaterAvailable;
        const updateBusy = updatePending || updateState.status === 'checking' || updateState.status === 'running';
        controls.checkUpdateButton.disabled = updateBusy;
        controls.applyUpdateButton.hidden = updateState.status !== 'available';
        controls.applyUpdateButton.disabled = updateBusy;
        controls.updateNotice.hidden = updateState.status !== 'idle';
        controls.updateStatus.textContent = describeUpdateState();
        renderPolicyStatus(policy);
    }

    function componentLabel(component) {
        return ['frontend', 'server'].includes(component?.name)
            ? localize(`vertex_paygo.update.component.${component.name}`)
            : String(component?.label ?? component?.name ?? '');
    }

    function describeTargets(components = []) {
        return components.filter(component => component.status === 'update').map(component => (component.target?.tag
            ? localize('vertex_paygo.update.target_tag', { component: componentLabel(component), tag: component.target.tag })
            : localize('vertex_paygo.update.target_commit', {
                component: componentLabel(component),
                branch: component.channel?.branch ?? '',
                commit: (component.target?.commit ?? '').slice(0, 7),
            }))).join(localize('vertex_paygo.update.separator'));
    }

    function describeHeld(components = []) {
        return components
            .filter(component => !['update', 'updated', 'unchanged', 'keep-ahead'].includes(component.status))
            .map(component => localize('vertex_paygo.update.held', {
                component: componentLabel(component),
                reason: component.reason ?? component.status ?? '',
            }));
    }

    function describeUpdateState() {
        const held = describeHeld(updateState.components);
        const withHeld = text => [text, ...held].join('\n');
        switch (updateState.status) {
            case 'checking':
                return localize('vertex_paygo.update.checking');
            case 'available':
                return withHeld(localize('vertex_paygo.update.available', { components: describeTargets(updateState.components) }));
            case 'uptodate':
                return localize('vertex_paygo.update.uptodate');
            case 'blocked':
                return localize('vertex_paygo.update.blocked', { reason: held.join(' ') });
            case 'running':
                return localize('vertex_paygo.update.running', { phase: localize(`vertex_paygo.update.phase.${updateState.phase ?? 'checking'}`) });
            case 'done':
                return withHeld(localize('vertex_paygo.update.done'));
            case 'failed':
                return localize('vertex_paygo.update.failed', { message: updateState.message ?? '' });
            default:
                return '';
        }
    }

    function setUpdaterState(next) {
        updateState = next;
        render();
    }

    async function checkForUpdates() {
        if (destroyed || updatePending || updateState.status === 'running') return;
        updatePending = true;
        setUpdaterState({ status: 'checking' });
        recordClientEvent('info', 'update.check_started', { phase: 'started' });
        try {
            const report = await serverClient.checkUpdate();
            if (destroyed) return;
            const status = report.status === 'update-available' ? 'available'
                : report.status === 'blocked' ? 'blocked' : 'uptodate';
            setUpdaterState({ status, components: report.components });
            recordClientEvent('info', 'update.check_ready', { phase: 'ready' });
        } catch (error) {
            recordClientEvent('error', 'update.check_failed', { phase: 'failed', ...getSafeErrorContext(error) });
            setUpdaterState({ status: 'failed', message: localizeError(localize, error) });
        } finally {
            updatePending = false;
            render();
        }
    }

    function waitForUpdatePoll() {
        return new Promise(resolve => {
            finishUpdatePoll = resolve;
            updatePollTimer = setTimeout(() => {
                updatePollTimer = null;
                finishUpdatePoll = null;
                resolve();
            }, UPDATE_POLL_INTERVAL_MS);
        });
    }

    async function pollUpdateUntilSettled() {
        for (;;) {
            await waitForUpdatePoll();
            if (destroyed) return;
            let status;
            try {
                status = await serverClient.readUpdateStatus();
            } catch (error) {
                setUpdaterState({ status: 'failed', message: localizeError(localize, error) });
                return;
            }
            if (destroyed) return;
            if (status.running) {
                setUpdaterState({ status: 'running', phase: status.job?.phase ?? 'checking' });
                continue;
            }
            const result = status.lastResult;
            if (result?.status === 'updated') {
                recordClientEvent('info', 'update.completed', { phase: 'ready' });
                setUpdaterState({ status: 'done', components: result.components });
            } else if (result?.status === 'no-change') {
                setUpdaterState({ status: 'uptodate' });
            } else {
                setUpdaterState({ status: 'failed', message: result?.message ?? String(result?.code ?? '') });
            }
            return;
        }
    }

    async function applyUpdate() {
        if (destroyed || updatePending || updateState.status !== 'available' || !healthState.updaterAvailable) return;
        const components = describeTargets(updateState.components);
        updatePending = true;
        render();
        try {
            const confirmed = await showExtensionConfirm(context,
                localize('vertex_paygo.update.popup.title'),
                localize('vertex_paygo.update.popup.body', { components }),
                {
                    okButton: localize('vertex_paygo.update.popup.accept'),
                    cancelButton: localize('vertex_paygo.update.popup.decline'),
                    defaultResult: popupResult.NEGATIVE,
                },
            );
            if (destroyed || confirmed !== popupResult.AFFIRMATIVE) return;
            setUpdaterState({ status: 'running', phase: 'checking' });
            recordClientEvent('info', 'update.start_requested', { phase: 'started' });
            await serverClient.startUpdate();
            if (destroyed) return;
            await pollUpdateUntilSettled();
        } catch (error) {
            recordClientEvent('error', 'update.start_failed', { phase: 'failed', ...getSafeErrorContext(error) });
            setUpdaterState({ status: 'failed', message: localizeError(localize, error) });
        } finally {
            updatePending = false;
            render();
        }
    }

    function recordClientEvent(level, event, context = {}) {
        try {
            logger?.event?.(level, event, context);
        } catch {
            // Diagnostics must never affect settings or request routing.
        }
    }

    async function showTierRegionConflict(tier, decision) {
        const tierLabel = getTierLabel(localize, tier);
        return await showExtensionConfirm(context,
            localize('vertex_paygo.popup.tier_region.title', { tier: tierLabel }),
            localize('vertex_paygo.popup.tier_region.body', { region: decision.decline.region }),
            {
                okButton: localize('vertex_paygo.popup.tier_region.accept', { tier: tierLabel }),
                cancelButton: localize('vertex_paygo.popup.tier_region.decline'),
                defaultResult: popupResult.NEGATIVE,
            },
        );
    }

    function commitTierRegionChoice(requestedTier, result) {
        const latestDecision = resolveTierSelection({
            source: getSource(),
            state,
            requestedTier,
            region: getRegion(),
            model: getModel(),
        });

        if (result === popupResult.AFFIRMATIVE) {
            if (latestDecision.type === 'reject') {
                notifyError(localizeSupport(localize, latestDecision.support, requestedTier));
                render();
                return false;
            }
            const selected = latestDecision.type === 'conflict'
                ? latestDecision.accept
                : latestDecision;
            if (selected.region !== getRegion()) setRegion(selected.region);
            applyState(selected.state);
            return true;
        }

        // The negative button promises to keep the current region and use
        // Standard, even if the live policy changed while the popup was open.
        const selected = latestDecision.type === 'conflict'
            ? latestDecision.decline
            : { state: { ...state, tier: TIER.STANDARD }, region: getRegion() };
        if (selected.region !== getRegion()) setRegion(selected.region);
        applyState(selected.state);
        return true;
    }

    async function onTierChanged() {
        if (transitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            render();
            return;
        }
        const requestedTier = controls.tierSelect.value;
        const decision = resolveTierSelection({ state, requestedTier, region: getRegion(), model: getModel(), source: getSource() });

        if (decision.type === 'reject') {
            notifyError(localizeSupport(localize, decision.support, requestedTier));
            render();
            return;
        }

        if (decision.type === 'apply') {
            applyState(decision.state);
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            await reconcileGuard.settle(
                token,
                showTierRegionConflict(requestedTier, decision),
                result => commitTierRegionChoice(requestedTier, result),
            );
        } finally {
            finishTransition();
        }
    }

    async function onRegionChanged() {
        if (!isVertexSelected()) return;
        if (transitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            render();
            return;
        }
        const decision = resolveRegionChange({ state, requestedRegion: regionInput.value });
        if (decision.type === 'apply') {
            render();
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const tierLabel = getTierLabel(localize, state.tier);
            await reconcileGuard.settle(
                token,
                showExtensionConfirm(context,
                    localize('vertex_paygo.popup.region.title'),
                    localize('vertex_paygo.popup.region.body', { tier: tierLabel }),
                    {
                        okButton: localize('vertex_paygo.popup.region.accept'),
                        cancelButton: localize('vertex_paygo.popup.region.decline', { tier: tierLabel }),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const selected = result === popupResult.AFFIRMATIVE ? decision.accept : decision.decline;
                    const regionChanged = selected.region !== getRegion();
                    if (regionChanged) {
                        setRegion(selected.region);
                    }
                    const latestValidation = validatePluginState({
                        state: selected.state,
                        region: selected.region,
                        model: getModel(),
                    });
                    if (!latestValidation.ok) {
                        notifyError(localizeValidation(localize, latestValidation, selected.state));
                        render();
                        return;
                    }
                    if (!regionChanged) {
                        writeActiveProfileRegion(context, selected.region);
                    }
                    applyState(selected.state);
                },
            );
        } finally {
            finishTransition();
        }
    }

    async function onModelChanged() {
        const nextModel = getModel();
        if (!isGoogleSource(getSource())) {
            reconcileGuard.invalidate();
            render();
            return;
        }

        if (!nextModel) {
            reconcileGuard.invalidate();
            if (appReady) {
                reconcileQueued = true;
            }
            render();
            return;
        }

        if (profileTransitionPending) {
            reconcileGuard.invalidate();
            reconcileQueued = true;
            lastModel = nextModel;
            render();
            return;
        }

        if (revertingModel) {
            revertingModel = false;
            lastModel = nextModel;
            render();
            if (reconcileQueued) {
                schedulePersistedReconciliation();
            }
            return;
        }

        if (!appReady) {
            reconcileGuard.invalidate();
            lastModel = nextModel;
            render();
            return;
        }

        if (nextModel === lastModel) {
            render();
            if (reconcileQueued) {
                schedulePersistedReconciliation();
            }
            return;
        }

        if (transitionPending) {
            reconcileGuard.invalidate();
            lastModel = nextModel;
            schedulePersistedReconciliation({ invalidate: false });
            render();
            return;
        }

        const previousModel = lastModel;
        lastModel = nextModel;
        const decision = resolveModelChange({ state, model: nextModel, source: getSource() });
        if (decision.type === 'apply') {
            render();
            schedulePersistedReconciliation();
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const reason = decision.code === 'PAYGO_REQUIRES_GEMINI'
                ? localize('vertex_paygo.popup.model.reason_gemini')
                : localize('vertex_paygo.popup.model.reason_unsupported');
            await reconcileGuard.settle(
                token,
                showExtensionConfirm(context,
                    localize('vertex_paygo.popup.model.title'),
                    localize('vertex_paygo.popup.model.body', { reason }),
                    {
                        okButton: localize('vertex_paygo.popup.model.accept'),
                        cancelButton: localize('vertex_paygo.popup.model.decline'),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const latestDecision = resolveModelChange({ state, model: nextModel, source: getSource() });
                    if (result === popupResult.AFFIRMATIVE || !previousModel || previousModel === nextModel) {
                        if (latestDecision.type === 'apply') {
                            render();
                        } else {
                            applyState(latestDecision.accept.state);
                        }
                        return;
                    }

                    const restoreDecision = resolveModelChange({ state, model: previousModel, source: getSource() });
                    if (restoreDecision.type !== 'apply') {
                        const previousValidation = validatePluginState({
                            source: getSource(),
                            state,
                            region: getRegion(),
                            model: previousModel,
                        });
                        notifyError(localizeValidation(localize, previousValidation, state));
                        render();
                        schedulePersistedReconciliation({ invalidate: false });
                        return;
                    }

                    lastModel = previousModel;
                    const modelInput = getModelInput();
                    if (modelInput) {
                        modelInput.value = previousModel;
                        modelInput.dispatchEvent(new Event('input', { bubbles: true }));
                    } else {
                        revertingModel = true;
                        const select = getModelSelect();
                        select.value = previousModel;
                        select.dispatchEvent(new Event('change', { bubbles: true }));
                    }
                },
            );
        } finally {
            finishTransition();
        }
    }

    async function refreshHealth() {
        const startedAt = Date.now();
        recordClientEvent('info', 'server.health_started', { phase: 'started' });
        healthState = {
            status: 'checking',
            message: localize('vertex_paygo.server.checking'),
            logsAvailable: false,
            updaterAvailable: false,
        };
        render();
        try {
            const health = await serverClient.checkHealth();
            logger?.setDeliveryEnabled?.(health.capabilities?.clientLogging === true);
            const version = health.pluginVersion ? ` ${health.pluginVersion}` : '';
            healthState = {
                status: 'ready',
                message: localize('vertex_paygo.server.ready', { version }),
                detail: localize('vertex_paygo.server.ready_detail'),
                version: typeof health.pluginVersion === 'string' ? health.pluginVersion : undefined,
                logsAvailable: health.capabilities?.logs === true,
                updaterAvailable: health.capabilities?.updater === true,
            };
            recordClientEvent('info', 'server.health_ready', {
                phase: 'ready',
                serverStatus: 'ready',
                durationMs: Date.now() - startedAt,
            });
        } catch (error) {
            healthState = {
                status: 'unavailable',
                message: localize('vertex_paygo.server.unavailable'),
                detail: localizeError(localize, error),
                logsAvailable: false,
                updaterAvailable: false,
            };
            recordClientEvent('warn', 'server.health_unavailable', {
                phase: 'failed',
                serverStatus: 'unavailable',
                durationMs: Date.now() - startedAt,
                ...getSafeErrorContext(error),
            });
        }
        render();
        return healthState;
    }

    function onModelPolicyChanged() {
        render();
        // Do not silently invalidate a confirmation already shown to the user.
        // The queued reconciliation revalidates its result after that transition.
        schedulePersistedReconciliation({ invalidate: false });
    }

    async function reconcilePersistedState() {
        if (!appReady || transitionPending || profileTransitionPending) {
            reconcileQueued = true;
            return;
        }

        syncPersistedState();
        if (document.activeElement === getModelInput()) {
            reconcileQueued = true;
            return;
        }
        const model = getModel();
        if (model) {
            lastModel = model;
        }

        const region = getRegion();
        const plan = planPersistedReconciliation({
            state,
            source: context.chatCompletionSettings.chat_completion_source,
            model,
            region,
        });
        if (plan.type === 'defer') {
            reconcileQueued = true;
            return;
        }
        if (plan.type !== 'conflict') return;

        const validation = plan.validation;

        if (validation.code === 'TIER_REQUIRES_GLOBAL') {
            const decision = resolveTierSelection({ state, requestedTier: state.tier, region, model });
            if (decision.type === 'conflict') {
                const token = reconcileGuard.begin();
                transitionPending = true;
                render();
                try {
                    await reconcileGuard.settle(
                        token,
                        showTierRegionConflict(state.tier, decision),
                        result => commitTierRegionChoice(state.tier, result),
                    );
                } finally {
                    finishTransition();
                }
            }
            return;
        }

        const token = reconcileGuard.begin();
        transitionPending = true;
        render();
        try {
            const validationMessage = localizeValidation(localize, validation, state);
            await reconcileGuard.settle(
                token,
                showExtensionConfirm(context,
                    localize('vertex_paygo.popup.saved.title'),
                    localize('vertex_paygo.popup.saved.body', { message: validationMessage }),
                    {
                        okButton: localize('vertex_paygo.popup.saved.accept'),
                        cancelButton: localize('vertex_paygo.popup.saved.decline'),
                        defaultResult: popupResult.NEGATIVE,
                    },
                ),
                result => {
                    const latestValidation = validatePluginState({ state, region: getRegion(), model: getModel(), source: getSource() });
                    if (latestValidation.ok) {
                        render();
                        return;
                    }
                    if (result === popupResult.AFFIRMATIVE) {
                        applyState({ ...DEFAULT_STATE });
                    }
                },
            );
        } finally {
            finishTransition();
        }
    }

    controls.tierSelect.addEventListener('change', onTierChanged);
    controls.tierRestore.addEventListener('click', () => { controls.tierSelect.value = TIER.STANDARD; void onTierChanged(); });
    regionInput.addEventListener('change', onRegionChanged);
    const onVertexModelInput = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        reconcileGuard.invalidate();
        render();
        if (reconcileQueued || transitionPending || profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    };
    const onVertexModelChange = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        void onModelChanged();
    };
    const onVertexModelFocusOut = event => {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.id !== 'vertexai_model_id') return;
        if (reconcileQueued) {
            schedulePersistedReconciliation();
        }
    };
    const jquery = globalThis.jQuery ?? globalThis.$;
    if (typeof jquery === 'function') {
        jquery(document).on('input.vertexPaygo', '#vertexai_model_id', onVertexModelInput);
        jquery(document).on('change.vertexPaygo', '#vertexai_model_id', onVertexModelChange);
        jquery(document).on('focusout.vertexPaygo', '#vertexai_model_id', onVertexModelFocusOut);
    } else {
        document.addEventListener('input', onVertexModelInput);
        document.addEventListener('change', onVertexModelChange);
        document.addEventListener('focusout', onVertexModelFocusOut);
    }
    document.addEventListener('change', event => {
        const target = event.target;
        if (target instanceof Element && target.closest('#connection_profiles')) {
            beginProfileTransition();
        }
    }, true);
    document.addEventListener('click', event => {
        const target = event.target;
        if (!(target instanceof Element)) return;
        const profileSelect = document.getElementById('connection_profiles');
        if (target.closest('#reload_connection_profile')
            && profileSelect instanceof HTMLSelectElement
            && profileSelect.value) {
            beginProfileTransition();
        }
    }, true);
    controls.generalRetryButton.addEventListener('click', refreshHealth);
    controls.checkUpdateButton.addEventListener('click', () => void checkForUpdates());
    controls.applyUpdateButton.addEventListener('click', () => void applyUpdate());

    const events = context.eventTypes;
    context.eventSource.on(events.CHATCOMPLETION_SOURCE_CHANGED, () => {
        syncPersistedState();
        const model = getModel();
        if (model) {
            lastModel = model;
        }
        render();
        schedulePersistedReconciliation();
    });
    context.eventSource.on(events.CHATCOMPLETION_MODEL_CHANGED, onModelChanged);
    context.eventSource.on(events.OAI_PRESET_CHANGED_AFTER, () => {
        syncPersistedState();
        schedulePersistedReconciliation();
    });
    context.eventSource.on(events.OAI_PRESET_IMPORT_READY, normalizeImportedPreset);
    context.eventSource.on(events.OAI_PRESET_EXPORT_READY, normalizeExportedPreset);
    context.eventSource.on(events.CONNECTION_PROFILE_CREATED, profile => {
        reconcileGuard.invalidate();
        if (profile?.mode === 'cc' && isGoogleSource(profile?.api)) {
            attachStateToProfile(profile, state);

            context.saveSettingsDebounced();
        }
        syncPersistedState();
        if (!profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    });
    context.eventSource.on(events.CONNECTION_PROFILE_LOADED, finishProfileTransition);
    context.eventSource.on(events.CONNECTION_PROFILE_UPDATED, (_oldProfile, newProfile) => {
        reconcileGuard.invalidate();
        if (newProfile?.mode === 'cc' && isGoogleSource(newProfile?.api) && !Object.hasOwn(newProfile, 'vertex-paygo')) {
            attachStateToProfile(newProfile, state);
            context.saveSettingsDebounced();
        }
        syncPersistedState();
        if (!profileTransitionPending) {
            schedulePersistedReconciliation({ invalidate: false });
        }
    });

    context.eventSource.once(events.APP_READY, () => {
        appReady = true;
        syncPersistedState();
        schedulePersistedReconciliation();
    });

    render();
    void refreshHealth();

    return {
        destroy() {
            destroyed = true;
            if (updatePollTimer !== null) clearTimeout(updatePollTimer);
            updatePollTimer = null;
            finishUpdatePoll?.();
            finishUpdatePoll = null;
            placementControl.destroy();
            logSettings.destroy();
            unmountSettings();
            controlsTheme.destroy();
            disposeControlsEvents();
            controls.root.remove();
        },
        getState: () => ({ ...state }),
        refreshHealth,
        viewLogs: logSettings.viewLogs,
        saveLogs: logSettings.saveLogs,
        checkForUpdates,
        applyUpdate,
        onModelPolicyChanged,
        render,
    };
}
