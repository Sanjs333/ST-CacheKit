/* World-info cache stability controls; based on ST-Vertex-PayGo (MPL-2.0). */
import { MACROS } from './prompt-migration.js';
import { mountExtensionSettings } from './extension-settings.js';
import { createLocalizer } from './i18n.js';

export function createWorldInfoStabilityUi({ feature, migration, documentRef = globalThis.document, clipboard = globalThis.navigator?.clipboard, localize = createLocalizer((fallback, key) => globalThis.SillyTavern?.getContext?.()?.translate?.(fallback, key) ?? fallback) }) {
    const t = localize;
    const make = (tag, text = '') => {
        const node = documentRef.createElement(tag);
        node.textContent = text;
        return node;
    };
    const root = make('section');
    root.id = 'vertex-paygo-worldinfo-stability';
    root.className = 'vertex-paygo-group';
    const title = make('h4', t("vertex_paygo.worldinfo.title"));
    title.className = 'vertex-paygo-group-title';
    const label = make('label'); label.className = 'vertex-paygo-toggle-row';
    const checkbox = make('input');
    checkbox.type = 'checkbox'; checkbox.className = 'vertex-paygo-compact-switch'; checkbox.setAttribute('role', 'switch'); checkbox.title = t("vertex_paygo.worldinfo.toggle_hint");
    checkbox.id = 'vertex-paygo-worldinfo-stability-enabled';
    label.append(make('span', t("vertex_paygo.worldinfo.enabled")), checkbox);
    const guidance = make('p', t("vertex_paygo.worldinfo.guidance"));
    guidance.id = 'vertex-paygo-worldinfo-stability-guidance';
    guidance.className = 'vertex-paygo-guidance';
    const status = make('p');
    status.id = 'vertex-paygo-worldinfo-stability-status';
    status.className = 'vertex-paygo-status';
    status.setAttribute('aria-live', 'polite');
    // Legacy bounded metadata is retained for compatibility, not presented as
    // the user-facing prompt viewer, which lives in the Logs settings tab.
    const details = make('details'); details.hidden = true;
    details.append(make('summary', t("vertex_paygo.worldinfo.plan_title")));
    const preview = make('pre');
    preview.id = 'vertex-paygo-worldinfo-stability-preview';
    details.append(preview);
    const macroRows = make('div'); macroRows.className = 'vertex-paygo-macro-rows';
    const controls = [], cleanup = [];
    for (const [owner, name] of [['green', t("vertex_paygo.worldinfo.migrate_green")], ['depth', t("vertex_paygo.worldinfo.migrate_depth")]]) {
        const row = make('div'); row.className = 'vertex-paygo-macro-row';
        const toggleLabel = make('label'); toggleLabel.className = 'vertex-paygo-toggle-row';
        const toggle = make('input'); toggle.type = 'checkbox'; toggle.className = 'vertex-paygo-compact-switch'; toggle.setAttribute('role', 'switch'); toggle.id = 'vertex-paygo-migrate-' + owner;
        const nameLabel = make('span', name);
        toggleLabel.append(nameLabel, toggle);
        const control = make('span'); control.className = 'vertex-paygo-macro-control';
        const code = make('code', MACROS[owner]);
        const copy = make('button'); copy.type = 'button'; copy.className = 'menu_button vertex-paygo-macro-copy';
        const copyIcon = make('i'); copyIcon.className = 'fa-solid fa-copy'; copyIcon.setAttribute('aria-hidden', 'true'); copy.append(copyIcon);
        copy.title = t("vertex_paygo.worldinfo.copy_macro") + MACROS[owner]; copy.setAttribute('aria-label', copy.title);
        copy.id = 'vertex-paygo-copy-' + owner;
        const onCopy = async () => {
            try { await clipboard.writeText(MACROS[owner]); copy.title = t("vertex_paygo.worldinfo.copied"); }
            catch { copy.title = t("vertex_paygo.worldinfo.copy_failed"); }
        };
        const onSwitch = () => { migration?.setEnabled(owner, toggle.checked); render(); };
        copy.addEventListener('click', onCopy); toggle.addEventListener('change', onSwitch);
        cleanup.push(() => { copy.removeEventListener('click', onCopy); toggle.removeEventListener('change', onSwitch); });
        control.append(code, copy); row.append(toggleLabel, control); macroRows.append(row); controls.push({ owner, toggle, copy, nameLabel, name });
    }
    const macroUsageHelp = t("vertex_paygo.worldinfo.macro_help");
    const macroHelp = make('small', macroUsageHelp);
    macroHelp.id = 'vertex-paygo-macro-guidance';
    macroHelp.className = 'vertex-paygo-guidance';
    const macroStatus = make('small'); macroStatus.id = 'vertex-paygo-macro-status'; macroStatus.setAttribute('aria-live', 'polite');
    root.append(title, label, guidance, macroRows, macroHelp, macroStatus, status, details);

    function render() {
        const state = feature.snapshot();
        const move = migration?.snapshot();
        const tauri = state.ordering === 'tauri-deterministic';
        guidance.textContent = tauri
            ? t("vertex_paygo.worldinfo.tauri_guidance")
            : t("vertex_paygo.worldinfo.guidance");
        for (const { owner, toggle, copy, nameLabel, name } of controls) {
            toggle.checked = move?.enabled?.[owner] === true; toggle.disabled = move?.supported !== true;
            copy.disabled = tauri && move?.supported !== true;
            nameLabel.textContent = owner === 'depth' ? t("vertex_paygo.worldinfo.migrate_depth_short") : name;
        }
        macroHelp.textContent = macroUsageHelp;
        macroHelp.hidden = tauri && move?.supported !== true;
        macroStatus.textContent = !move?.supported ? tauri
            ? t("vertex_paygo.worldinfo.tauri_migration_unavailable")
            : t("vertex_paygo.worldinfo.migration_unavailable")
            : move.last ? [Object.entries(move.last.collections ?? {}).map(([id, v]) => (id === 'green' ? t("vertex_paygo.worldinfo.green") : t("vertex_paygo.worldinfo.depth")) + '：' + v.count + t("vertex_paygo.worldinfo.segments_suffix") + v.groups + t("vertex_paygo.worldinfo.groups_suffix")).join(t('vertex_paygo.common.separator')),
                ''].filter(Boolean).join(t('vertex_paygo.common.separator')) || t("vertex_paygo.worldinfo.no_migration") : '';
        macroStatus.hidden = !macroStatus.textContent;
        if (Object.values(move?.last?.statuses ?? {}).includes('partial')) {
            macroStatus.textContent += t("vertex_paygo.worldinfo.partial_migration");
            macroStatus.hidden = false;
        }
        checkbox.checked = state.enabled;
        checkbox.disabled = !state.supported;
        const scan = state.lastScan;
        status.textContent = state.settingError ? t("vertex_paygo.worldinfo.save_failed")
            : !state.supported
            ? tauri ? t("vertex_paygo.worldinfo.tauri_order_unavailable")
                : t("vertex_paygo.worldinfo.order_unavailable")
            : !state.enabled || !scan ? ''
            : !scan.valid ? t("vertex_paygo.worldinfo.invalid_scan")
            : tauri ? t("vertex_paygo.worldinfo.tauri_scan", { p0: scan.after.length, p1: scan.groups, p2: scan.changed })
            : t("vertex_paygo.worldinfo.scan", { p0: scan.after.length, p1: scan.groups, p2: scan.retained ?? 0, p3: scan.added ?? 0, p4: scan.changed });
        const confirmation = state.lastConfirmation;
        if (state.enabled && confirmation) {
            status.textContent += confirmation.status === 'confirmed'
                ? (confirmation.phase === 'frontend' ? t("vertex_paygo.worldinfo.frontend_confirmed") : t("vertex_paygo.worldinfo.wire_confirmed")) + confirmation.confirmedGroups + t("vertex_paygo.worldinfo.confirmed_suffix")
                : confirmation.status === 'server-unavailable' ? t("vertex_paygo.worldinfo.server_unavailable")
                : confirmation.status === 'recording-unavailable' ? t("vertex_paygo.worldinfo.recording_unavailable")
                : t("vertex_paygo.worldinfo.confirmation_unavailable");
        }
        // The switch already communicates idle/on/off; keep results and warnings visible.
        status.hidden = !status.textContent.trim();
        // Bound the displayed list; no prompt bodies are stored or rendered.
        preview.textContent = scan?.valid
            ? JSON.stringify({ before: scan.before.slice(0, 50), after: scan.after.slice(0, 50),
                planned: scan.planned?.slice(0, 32), confirmation: state.lastConfirmation,
                omitted: Math.max(0, scan.after.length - 50) }, null, 2)
            : t("vertex_paygo.worldinfo.no_scan");
    }
    const onToggle = () => { feature.setEnabled(checkbox.checked); render(); };
    checkbox.addEventListener('change', onToggle);
    let unmount;
    try {
        unmount = mountExtensionSettings(root, { documentRef, tab: 'cache', label: t("vertex_paygo.settings.tab.cache"), onShow: render });
        render();
    } catch (error) {
        for (const fn of cleanup) fn();
        checkbox.removeEventListener('change', onToggle);
        unmount?.();
        throw error;
    }
    return {
        render,
        destroy() {
            for (const fn of cleanup) fn();
            checkbox.removeEventListener('change', onToggle);
            unmount();
        },
    };
}
