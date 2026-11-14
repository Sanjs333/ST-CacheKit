/* World-info cache stability controls; based on ST-Vertex-PayGo (MPL-2.0). */
import { MACROS } from './prompt-migration.js';
import { mountExtensionSettings } from './extension-settings.js';

export function createWorldInfoStabilityUi({ feature, migration, documentRef = globalThis.document, clipboard = globalThis.navigator?.clipboard }) {
    const make = (tag, text = '') => {
        const node = documentRef.createElement(tag);
        node.textContent = text;
        return node;
    };
    const root = make('section');
    root.id = 'vertex-paygo-worldinfo-stability';
    root.className = 'vertex-paygo-group';
    const title = make('h4', '世界书缓存顺序');
    title.className = 'vertex-paygo-group-title';
    const label = make('label'); label.className = 'vertex-paygo-toggle-row';
    const checkbox = make('input');
    checkbox.type = 'checkbox'; checkbox.className = 'vertex-paygo-compact-switch'; checkbox.setAttribute('role', 'switch'); checkbox.title = '稳定世界书排序默认开启，可手动关闭';
    checkbox.id = 'vertex-paygo-worldinfo-stability-enabled';
    label.append(make('span', '稳定世界书排序'), checkbox);
    const guidance = make('p', '适用于聊天补全（Vertex / AI Studio / 自定义 / OpenAI / Claude）。按世界书、排序号及位置/深度/身份/出口配置分组，仅重排已触发条目。同组蓝灯在前；绿灯沿用上一轮发送顺序，新增或内容变化的条目追加，不保留未触发条目的顺序。');
    guidance.id = 'vertex-paygo-worldinfo-stability-guidance';
    guidance.className = 'vertex-paygo-guidance';
    const status = make('p');
    status.id = 'vertex-paygo-worldinfo-stability-status';
    status.className = 'vertex-paygo-status';
    status.setAttribute('aria-live', 'polite');
    // Legacy bounded metadata is retained for compatibility, not presented as
    // the user-facing prompt viewer, which lives in the Logs settings tab.
    const details = make('details'); details.hidden = true;
    details.append(make('summary', '查看顺序计划与发送确认'));
    const preview = make('pre');
    preview.id = 'vertex-paygo-worldinfo-stability-preview';
    details.append(preview);
    const macroRows = make('div'); macroRows.className = 'vertex-paygo-macro-rows';
    const controls = [], cleanup = [];
    for (const [owner, name] of [['green', '搬迁绿灯'], ['depth', '搬迁 @D / 作者注释']]) {
        const row = make('div'); row.className = 'vertex-paygo-macro-row';
        const toggleLabel = make('label'); toggleLabel.className = 'vertex-paygo-toggle-row';
        const toggle = make('input'); toggle.type = 'checkbox'; toggle.className = 'vertex-paygo-compact-switch'; toggle.setAttribute('role', 'switch'); toggle.id = 'vertex-paygo-migrate-' + owner;
        const nameLabel = make('span', name);
        toggleLabel.append(nameLabel, toggle);
        const control = make('span'); control.className = 'vertex-paygo-macro-control';
        const code = make('code', MACROS[owner]);
        const copy = make('button'); copy.type = 'button'; copy.className = 'menu_button vertex-paygo-macro-copy';
        const copyIcon = make('i'); copyIcon.className = 'fa-solid fa-copy'; copyIcon.setAttribute('aria-hidden', 'true'); copy.append(copyIcon);
        copy.title = '复制宏 ' + MACROS[owner]; copy.setAttribute('aria-label', copy.title);
        copy.id = 'vertex-paygo-copy-' + owner;
        const onCopy = async () => {
            try { await clipboard.writeText(MACROS[owner]); copy.title = '已复制'; }
            catch { copy.title = '复制失败，请手动选择宏文本复制'; }
        };
        const onSwitch = () => { migration?.setEnabled(owner, toggle.checked); render(); };
        copy.addEventListener('click', onCopy); toggle.addEventListener('change', onSwitch);
        cleanup.push(() => { copy.removeEventListener('click', onCopy); toggle.removeEventListener('change', onSwitch); });
        control.append(code, copy); row.append(toggleLabel, control); macroRows.append(row); controls.push({ owner, toggle, copy, nameLabel, name });
    }
    const macroUsageHelp = '在预设中加入对应宏并启用开关；每种宏仅放置一次。';
    const macroHelp = make('small', macroUsageHelp);
    macroHelp.id = 'vertex-paygo-macro-guidance';
    macroHelp.className = 'vertex-paygo-guidance';
    const macroStatus = make('small'); macroStatus.id = 'vertex-paygo-macro-status'; macroStatus.setAttribute('aria-live', 'polite');
    root.append(title, label, guidance, macroRows, macroHelp, macroStatus, status, details);

    function render() {
        const state = feature.snapshot();
        const move = migration?.snapshot();
        const tauri = state.ordering === 'tauri-deterministic';
        const pluginRuntime = move?.mode === 'plugin-runtime';
        guidance.textContent = tauri
            ? 'TauriTavern：最终扫描后按世界书、排序号及位置/深度/身份/出口配置分组，仅重排已触发条目。同组蓝灯在前，蓝灯与绿灯分别按 UID 固定排序，不继承上一轮发送顺序。'
            : '适用于聊天补全（Vertex / AI Studio / 自定义 / OpenAI / Claude）。按世界书、排序号及位置/深度/身份/出口配置分组，仅重排已触发条目。同组蓝灯在前；绿灯沿用上一轮发送顺序，新增或内容变化的条目追加，不保留未触发条目的顺序。';
        for (const { owner, toggle, copy, nameLabel, name } of controls) {
            toggle.checked = move?.enabled?.[owner] === true; toggle.disabled = move?.supported !== true;
            copy.disabled = tauri && move?.supported !== true;
            nameLabel.textContent = owner === 'depth' ? '搬迁 @D／作者注释' : name;
        }
        macroHelp.textContent = pluginRuntime ? macroUsageHelp + ' ' + move.scopeDetails : macroUsageHelp;
        macroHelp.hidden = tauri && move?.supported !== true;
        macroStatus.textContent = !move?.supported ? tauri
            ? '当前 TauriTavern 未提供所需的提示词接口，宏搬迁暂不可用。'
            : '当前酒馆未提供可用的提示词处理对象，宏搬迁暂不可用。'
            : move.last ? [Object.entries(move.last.collections ?? {}).map(([id, v]) => (id === 'green' ? '绿灯' : '@D／作者注释') + '：' + v.count + ' 段 / ' + v.groups + ' 组').join('；'),
                pluginRuntime ? move.last.message : ''].filter(Boolean).join('；') || '本轮未搬迁（无有效宏或保留原位）。' : '';
        macroStatus.hidden = !macroStatus.textContent;
        if (Object.values(move?.last?.statuses ?? {}).includes('partial')) {
            macroStatus.textContent += ' 已搬迁可确认的部分，其余保持原位。';
            macroStatus.hidden = false;
        }
        checkbox.checked = state.enabled;
        checkbox.disabled = !state.supported;
        const scan = state.lastScan;
        status.textContent = state.settingError ? '排序设置保存失败，已恢复原设置。'
            : !state.supported
            ? tauri ? '当前 TauriTavern 缺少最终扫描或设置接口，稳定排序暂不可用。'
                : '当前酒馆缺少世界书扫描或设置接口，稳定排序暂不可用。'
            : !state.enabled || !scan ? ''
            : !scan.valid ? '扫描事件数据格式不受支持：本次未作修改。'
            : tauri ? `本轮排序：${scan.after.length} 条已触发条目，${scan.groups} 组；${scan.changed} 个集合位置调整。`
            : `本轮计划：${scan.after.length} 条已触发条目，${scan.groups} 组；继承 ${scan.retained ?? 0} 条绿灯，新增 ${scan.added ?? 0} 条；${scan.changed} 个集合位置调整。`;
        const confirmation = state.lastConfirmation;
        if (state.enabled && confirmation) {
            status.textContent += confirmation.status === 'confirmed'
                ? (confirmation.phase === 'frontend' ? ' 已记录上一轮前端发送顺序：' : ' 已核验上一轮实际发送：') + confirmation.confirmedGroups + ' 组。'
                : confirmation.status === 'server-unavailable' ? ' 服务端未提供发送核验，暂不建立记忆。'
                : confirmation.status === 'recording-unavailable' ? ' 无法关联本次用量记录，暂不建立记忆。'
                : ' 此次未建立发送记忆（未发送、核验不完整或已过期）。';
        }
        // The switch already communicates idle/on/off; keep results and warnings visible.
        status.hidden = !status.textContent.trim();
        // Bound the displayed list; no prompt bodies are stored or rendered.
        preview.textContent = scan?.valid
            ? JSON.stringify({ before: scan.before.slice(0, 50), after: scan.after.slice(0, 50),
                planned: scan.planned?.slice(0, 32), confirmation: state.lastConfirmation,
                omitted: Math.max(0, scan.after.length - 50) }, null, 2)
            : '暂无扫描记录。';
    }
    const onToggle = () => { feature.setEnabled(checkbox.checked); render(); };
    checkbox.addEventListener('change', onToggle);
    let unmount;
    try {
        unmount = mountExtensionSettings(root, { documentRef, tab: 'cache', label: '缓存', onShow: render });
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
