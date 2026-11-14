/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

// Sample native controls in their drawer, rather than assuming that a theme
// changes SmartTheme variables. Only extension-owned UI is registered here.
const managers = new WeakMap();
const ROOT = 'data-vertex-paygo-theme';
const CONTROL = 'data-vertex-paygo-control';
const PROBE = 'data-vertex-paygo-probe';
const PROBE_STATE = 'data-vertex-paygo-probe-state';
const OWN_STYLE = 'data-vertex-paygo-probe-style';
const PENDING = 'data-vertex-paygo-theme-pending';
const MIN_PANEL_ALPHA = 0.82;
const CONTROLS = 'button, .menu_button, input, textarea, select';
const FLOATING_SURFACES = '.popup-body, .popup-content, .vertex-paygo-pi-sidebar';
const KINDS = ['button', 'text', 'number', 'search', 'textarea', 'select'];
const STATES = ['base', 'hover', 'active', 'focus', 'disabled'];
const CONTROL_STYLES = Object.entries({ color: 'var(--vertex-paygo-control-color)',
    'background-color': 'var(--vertex-paygo-control-background)', 'background-image': 'none',
    'border-color': 'var(--vertex-paygo-control-border)', 'box-shadow': 'var(--vertex-paygo-control-shadow)',
    'background-clip': 'border-box', '-webkit-text-fill-color': 'currentColor' });

function themeSource(root) {
    let doc = root.ownerDocument;
    // Use the document that actually owns the drawer; parent access can fail
    // for cross-origin frames, in which case the current document still works.
    try {
        if (!doc.querySelector('.drawer-content') && doc.defaultView?.parent?.document.querySelector('.drawer-content')) {
            doc = doc.defaultView.parent.document;
        }
    } catch { /* Sample the current document. */ }
    const drawer = (root.ownerDocument === doc ? root.closest('.drawer-content') : null)
        ?? doc.getElementById('extensions_settings2')?.closest('.drawer-content')
        ?? doc.getElementById('extensions_settings')?.closest('.drawer-content')
        ?? doc.querySelector('.drawer-content') ?? doc.body;
    return { doc, win: doc.defaultView, drawer };
}

// Resolve the SmartTheme tint to rgba and enforce a minimum alpha of .82.
function messageManagerTheme({ doc, win, drawer }) {
    const foreground = win.getComputedStyle(drawer).color;
    const raw = win.getComputedStyle(doc.documentElement).getPropertyValue('--SmartThemeBlurTintColor').trim();
    const probe = doc.createElement('div');
    probe.style.cssText = 'position:fixed;left:-99999px;top:0;visibility:hidden;pointer-events:none;';
    probe.style.setProperty('color', raw || 'rgb(23, 23, 23)', 'important');
    probe.setAttribute(PROBE, 'tint');
    let tint;
    try {
        (doc.body ?? doc.documentElement).append(probe);
        tint = win.getComputedStyle(probe).color;
    } finally { probe.remove(); }
    const bg = tint.match(/^rgba?\(([^)]+)\)$/u)?.[1].match(/[\d.]+/gu)?.map(Number) ?? [23, 23, 23, 1];
    const fg = foreground.match(/^rgba?\(([^)]+)\)$/u)?.[1].match(/[\d.]+/gu)?.map(Number);
    const luma = rgb => rgb[0] * .299 + rgb[1] * .587 + rgb[2] * .114;
    const background = fg && luma(bg) < 128 && luma(fg) < 128
        ? 'rgba(255, 255, 255, 0.88)'
        : `rgba(${bg[0]}, ${bg[1]}, ${bg[2]}, ${Math.max(bg[3] ?? 1, MIN_PANEL_ALPHA)})`;
    const result = { foreground, background, 'background-image': 'none', 'background-size': 'cover',
        'background-position': 'center', 'background-repeat': 'no-repeat' };
    for (const node of [drawer, ...doc.querySelectorAll('.drawer-content')]) {
        const cs = win.getComputedStyle(node);
        if (!cs.backgroundImage || cs.backgroundImage === 'none') continue;
        for (const key of ['image', 'size', 'position', 'repeat']) result[`background-${key}`] = cs.getPropertyValue(`background-${key}`);
        break;
    }
    return result;
}

function splitSelectors(value) {
    const result = [];
    let start = 0, depth = 0, quote = '';
    for (let i = 0; i < value.length; i++) {
        const char = value[i];
        if (char === '\\') { i++; continue; }
        if (quote) { if (char === quote) quote = ''; continue; }
        if (char === '"' || char === "'") { quote = char; continue; }
        if (char === '(' || char === '[') depth++;
        else if (char === ')' || char === ']') depth--;
        else if (char === ',' && !depth) { result.push(value.slice(start, i).trim()); start = i + 1; }
    }
    result.push(value.slice(start).trim());
    return result;
}

function probeSelector(selector) {
    // Preserve selector specificity, including :is() / :not() branches. Fake
    // states affect the probes only and never move focus or the real pointer.
    if (/::|:(?:before|after)\b/u.test(selector)) return null;
    return selector.replace(/("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')|:(hover|active|focus-visible|focus)(?![\w-])/gu,
        (match, quoted, state) => quoted ?? `[${PROBE_STATE}~="${state.startsWith('focus') ? 'focus' : state}"]`);
}

function stateRules(doc, probes) {
    const declaredBackgrounds = new Set();
    const visit = rules => {
        let css = '';
        for (const rule of rules) {
            if (rule.selectorText && rule.style) {
                const declaresBackground = Boolean(rule.style.background || rule.style.backgroundColor);
                const selectors = splitSelectors(rule.selectorText).map(probeSelector).filter(Boolean).filter(selector => {
                    try {
                        if (!declaresBackground) return probes.some(probe => probe.matches(selector));
                        const matches = probes.filter(probe => probe.matches(selector));
                        matches.forEach(probe => declaredBackgrounds.add(probe));
                        return matches.length > 0;
                    } catch { return false; }
                });
                if (selectors.length) css += `${selectors.map(selector => `${selector}:where([${PROBE}])`).join(',')}{${rule.style.cssText}}\n`;
            } else if (rule.cssRules) {
                if (rule.media && !doc.defaultView.matchMedia(rule.media.mediaText).matches) continue;
                if (rule.cssText.startsWith('@supports') && !doc.defaultView.CSS.supports(rule.conditionText)) continue;
                // Keep @media, @supports and named @layer wrappers intact.
                const inner = visit(rule.cssRules);
                if (inner) css += `${rule.cssText.slice(0, rule.cssText.indexOf('{'))}{${inner}}\n`;
            } else if (rule.styleSheet) {
                try {
                    const inner = visit(rule.styleSheet.cssRules);
                    css += rule.media?.mediaText ? `@media ${rule.media.mediaText}{${inner}}` : inner;
                } catch { /* Cross-origin stylesheet: computed base styles remain available. */ }
            }
        }
        return css;
    };
    let css = '';
    for (const sheet of doc.styleSheets) {
        if (sheet.disabled || sheet.ownerNode?.hasAttribute(OWN_STYLE)) continue;
        try {
            const inner = visit(sheet.cssRules);
            css += sheet.media?.mediaText ? `@media ${sheet.media.mediaText}{${inner}}` : inner;
        } catch { /* A theme may load its CSS from another origin. */ }
    }
    return { css, declaredBackgrounds };
}

function colorTools(doc) {
    const canvas = doc.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const cache = new Map();
    const rgba = value => {
        if (cache.has(value)) return cache.get(value);
        context.clearRect(0, 0, 1, 1);
        context.fillStyle = value || 'transparent';
        context.fillRect(0, 0, 1, 1);
        const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
        const result = [r, g, b, alpha / 255];
        cache.set(value, result);
        return result;
    };
    const css = ([r, g, b, a = 1]) => `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${a})`;
    const composite = (front, back) => front.slice(0, 3).map((value, i) => value * front[3] + back[i] * (1 - front[3]));
    const luminance = rgb => rgb.slice(0, 3).map(value => {
        const channel = value / 255;
        return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
    const contrast = (front, back) => {
        const left = luminance(front), right = luminance(back);
        return (Math.max(left, right) + 0.05) / (Math.min(left, right) + 0.05);
    };
    const luma = rgb => rgb[0] * 0.299 + rgb[1] * 0.587 + rgb[2] * 0.114;
    const surface = (background, foreground, minimumAlpha = 0) => {
        const bg = [...rgba(background)], fg = rgba(foreground);
        bg[3] = Math.max(bg[3], minimumAlpha);
        // Keep the popup readable when both the drawer tint and text are dark.
        if (luma(bg) < 128 && luma(fg) < 128 && (minimumAlpha > 0 || contrast(bg, fg) < 3)) return 'rgba(255, 255, 255, 0.88)';
        if (luma(bg) >= 128 && luma(fg) >= 128 && contrast(bg, fg) < 3) return 'rgba(23, 23, 23, 0.9)';
        return css(bg);
    };
    const panel = (background, foreground) => {
        const [r, g, b, alpha] = rgba(background);
        // Clamp low alpha and use a white fallback for dark text on a dark tint.
        if (luma([r, g, b]) < 128 && luma(rgba(foreground)) < 128) {
            return 'rgba(255, 255, 255, 0.88)';
        }
        return css([r, g, b, Math.max(alpha, MIN_PANEL_ALPHA)]);
    };
    const accent = (value, background, foreground) => {
        const original = rgba(value), bg = rgba(background), fg = rgba(foreground);
        for (let step = 0; step <= 20; step++) {
            const mix = step / 20;
            const candidate = original.slice(0, 3).map((channel, i) => channel * (1 - mix) + fg[i] * mix);
            if (contrast(candidate, bg) >= 4.5 || step === 20) return css(candidate);
        }
    };
    return { rgba, css, composite, contrast, surface, panel, accent };
}

function sampleTheme({ doc, win, drawer }) {
    const probes = [], styles = doc.createElement('style');
    styles.setAttribute(OWN_STYLE, '');
    const colors = colorTools(doc);
    const drawerStyle = win.getComputedStyle(drawer);
    const rawForeground = drawerStyle.color;
    const paletteProbe = doc.createElement('div');
    paletteProbe.setAttribute(PROBE, '');
    const hide = probe => {
        probe.setAttribute('aria-hidden', 'true'); probe.tabIndex = -1;
        for (const [key, value] of Object.entries({ position: 'fixed', left: '-100000px', top: '0', width: '1px', height: '1px',
            opacity: '0', 'pointer-events': 'none', animation: 'none', transition: 'none', visibility: 'hidden' })) {
            probe.style.setProperty(key, value, 'important');
        }
    };
    try {
        hide(paletteProbe);
        paletteProbe.style.setProperty('color', 'var(--SmartThemeBodyColor, inherit)', 'important');
        paletteProbe.style.setProperty('background-color', 'var(--SmartThemeBlurTintColor, #171717)', 'important');
        paletteProbe.style.setProperty('border-color', 'var(--SmartThemeBorderColor, currentColor)', 'important');
        drawer.append(paletteProbe);
        const variableStyle = win.getComputedStyle(paletteProbe);
        const foreground = colors.rgba(rawForeground)[3] ? rawForeground : variableStyle.color;
        const tint = variableStyle.backgroundColor;
        // Independent surfaces use alpha >= .82; dark-on-dark falls back to .88 white.
        const background = colors.panel(tint, foreground);
        const border = colors.rgba(drawerStyle.borderTopColor)[3] ? drawerStyle.borderTopColor
            : colors.rgba(variableStyle.borderTopColor)[3] ? variableStyle.borderTopColor : `color-mix(in srgb, ${foreground} 22%, transparent)`;
        const readVariable = (name, fallback) => {
            paletteProbe.style.setProperty('color', `var(${name}, ${fallback})`, 'important');
            return win.getComputedStyle(paletteProbe).color;
        };
        const originalAccent = readVariable('--SmartThemeQuoteColor', foreground);
        const palette = { foreground, background, tint, border,
            accent: colors.accent(originalAccent, background, foreground),
            error: colors.accent(readVariable('--error-color', 'var(--SmartThemeEmColor, #c85858)'), background, foreground),
            warning: colors.accent(readVariable('--warning-color', '#b88431'), background, foreground),
            success: colors.accent(readVariable('--success-color', '#48946a'), background, foreground),
            'background-image': 'none', 'background-size': 'cover', 'background-position': 'center', 'background-repeat': 'no-repeat',
            'backdrop-filter': drawerStyle.backdropFilter || 'none' };
        for (const candidate of [drawer, ...doc.querySelectorAll('.drawer-content')]) {
            const cs = win.getComputedStyle(candidate);
            if (cs.backgroundImage && cs.backgroundImage !== 'none') {
                for (const key of ['image', 'size', 'position', 'repeat']) palette[`background-${key}`] = cs.getPropertyValue(`background-${key}`);
                break;
            }
        }
        for (const kind of KINDS) for (const state of STATES) {
            const probe = doc.createElement(['button', 'textarea', 'select'].includes(kind) ? kind : 'input');
            if (probe.tagName === 'INPUT') probe.type = kind;
            probe.className = kind === 'button' ? 'menu_button' : 'text_pole';
            probe.setAttribute(PROBE, kind); probe.setAttribute(PROBE_STATE, state);
            if (state === 'active') probe.classList.add('active');
            if (state === 'disabled') { probe.disabled = true; probe.classList.add('disabled'); }
            hide(probe); drawer.append(probe); probes.push(probe);
        }
        const rules = stateRules(doc, probes);
        styles.textContent = rules.css;
        (doc.head ?? doc.documentElement).append(styles);
        for (const probe of probes) {
            const kind = probe.getAttribute(PROBE), state = probe.getAttribute(PROBE_STATE);
            const cs = win.getComputedStyle(probe);
            let bg = cs.backgroundColor, fg = colors.rgba(cs.color)[3] ? cs.color : foreground;
            const channels = colors.rgba(bg);
            const defaultWhite = channels.slice(0, 3).every(value => value === 255) && !rules.declaredBackgrounds.has(probe);
            // Gradients have a transparent backgroundColor; an
            // unstyled input can instead report the browser's default white.
            if (!channels[3] || defaultWhite) bg = background;
            else if (channels[3] < 0.82 && colors.contrast(colors.rgba(fg), colors.composite(channels, colors.rgba(background))) < 3) {
                bg = colors.css([...channels.slice(0, 3), 0.9]);
            }
            bg = colors.surface(bg, fg);
            const values = { color: fg, background: bg, border: colors.rgba(cs.borderTopColor)[3] ? cs.borderTopColor : border, shadow: cs.boxShadow };
            for (const [key, value] of Object.entries(values)) palette[`${kind}-${state}-${key}`] = value;
        }
        // A readable fallback also gives cross-origin themes a hover response
        // when their stylesheet's pseudo-state declarations cannot be read.
        for (const kind of KINDS) {
            if (palette[`${kind}-hover-background`] === palette[`${kind}-base-background`]) {
                palette[`${kind}-hover-background`] = `color-mix(in srgb, ${palette[`${kind}-base-color`]} 9%, ${palette[`${kind}-base-background`]})`;
            }
            if (palette[`${kind}-active-background`] === palette[`${kind}-base-background`]) {
                palette[`${kind}-active-background`] = `color-mix(in srgb, ${palette[`${kind}-base-color`]} 14%, ${palette[`${kind}-base-background`]})`;
            }
        }
        palette['select-accent'] = colors.accent(originalAccent, palette['select-base-background'], palette['select-base-color']);
        return palette;
    } finally {
        // Never leave probes or their state stylesheet in a native drawer.
        probes.forEach(probe => probe.remove()); paletteProbe.remove(); styles.remove();
    }
}

function controlKind(node) {
    if (node.closest('.no-theme-sync')) return null;
    if (node.tagName === 'SELECT') return 'select';
    if (node.tagName === 'TEXTAREA') return 'textarea';
    if (node.tagName === 'INPUT') {
        if (['checkbox', 'radio', 'range', 'color', 'file', 'hidden'].includes(node.type)) return null;
        return ['button', 'submit', 'reset'].includes(node.type) ? 'button' : ['number', 'search'].includes(node.type) ? node.type : 'text';
    }
    if (node.matches('[role="tab"], [data-log-mode]')) return 'tab';
    if (node.matches('.vertex-paygo-log-tool, .vertex-paygo-cost-icon-button, .vertex-paygo-maintenance-refresh, .vertex-paygo-macro-copy, .vertex-paygo-message-cost-close, [data-pi-action="copy-message"], [data-pi-action="drawer-close"]')) return 'icon';
    if (node.matches('.vertex-paygo-pi-chip, .vertex-paygo-pi-source-tag')) return 'chip';
    if (node.matches('.vertex-paygo-pi-source-row')) return 'row';
    return 'button';
}

function rememberStyle(node, originals, key, value) {
    if (!originals.has(key)) originals.set(key, [node.style.getPropertyValue(key), node.style.getPropertyPriority(key)]);
    const cssValue = String(value);
    if (node.style.getPropertyValue(key) !== cssValue || node.style.getPropertyPriority(key) !== 'important') {
        node.style.setProperty(key, cssValue, 'important');
    }
}

function restoreStyle(node, originals) {
    for (const [key, [value, priority]] of originals) {
        if (value) node.style.setProperty(key, value, priority);
        else node.style.removeProperty(key);
    }
}

function createManager(source) {
    const { doc, win } = source;
    let cache = new WeakMap(), timer = null;
    const entries = new Set();
    const schedule = () => {
        win.clearTimeout(timer);
        timer = win.setTimeout(() => { cache = new WeakMap(); entries.forEach(entry => entry.sync()); }, 150);
    };
    const isStylesheet = node => node?.nodeType === 1 && node.matches('style, link[rel="stylesheet"]') && !node.hasAttribute(OWN_STYLE);
    const observer = new win.MutationObserver(mutations => {
        if (mutations.some(mutation => mutation.type === 'attributes'
            ? mutation.target === doc.documentElement || mutation.target === doc.body || isStylesheet(mutation.target)
            : isStylesheet(mutation.target) || isStylesheet(mutation.target.parentElement)
                || [...mutation.addedNodes, ...mutation.removedNodes].some(isStylesheet))) schedule();
    });
    observer.observe(doc.documentElement, { attributes: true, attributeFilter: ['style', 'class'] });
    if (doc.body) observer.observe(doc.body, { attributes: true, attributeFilter: ['style', 'class'] });
    if (doc.head) observer.observe(doc.head, { childList: true, subtree: true, characterData: true,
        attributes: true, attributeFilter: ['href', 'media', 'disabled', 'rel'] });
    const change = event => { if (event.target?.matches?.('#themes, #customCSS')) schedule(); };
    const load = event => { if (isStylesheet(event.target)) schedule(); };
    doc.addEventListener('change', change); doc.addEventListener('input', change); doc.addEventListener('load', load, true);
    win.addEventListener('resize', schedule);
    const manager = {
        entries,
        sample(current) {
            let palette = cache.get(current.drawer);
            if (!palette) { palette = sampleTheme(current); cache.set(current.drawer, palette); }
            return palette;
        },
        release(entry) {
            entries.delete(entry);
            if (entries.size) return;
            win.clearTimeout(timer); observer.disconnect();
            doc.removeEventListener('change', change); doc.removeEventListener('input', change); doc.removeEventListener('load', load, true);
            win.removeEventListener('resize', schedule); managers.delete(doc);
        },
    };
    managers.set(doc, manager);
    return manager;
}

/**
 * Synchronize an extension surface before its first paint and on theme changes.
 * Embedded settings use skipBg; independent dialogs include the native backdrop.
 * Inline !important contains variable references, so CSS can still change those
 * variables for hover / active / focus / disabled instead of freezing base colors.
 */
export function bindExtensionTheme(root, { skipBg = Boolean(root?.closest?.('.drawer-content')) } = {}) {
    const noop = { sync() {}, destroy() {} };
    if (!root?.ownerDocument?.defaultView?.getComputedStyle || root.closest('.mes, #chat')) return noop;
    const source = themeSource(root);
    if (!source.win?.MutationObserver || !source.drawer) return noop;
    const manager = managers.get(source.doc) ?? createManager(source);
    const win = root.ownerDocument.defaultView;
    const originalRoot = new Map(), controls = new Map(), regions = new Map();
    const originalMarker = root.getAttribute(ROOT);
    let disposed = false, queued = false, frame = null;
    root.setAttribute(ROOT, skipBg ? 'embedded' : 'floating');
    root.setAttribute(PENDING, '');
    const collectRegions = () => {
        for (const [node, region] of regions) {
            if (root.contains(node)) continue;
            restoreStyle(node, region.styles); regions.delete(node);
        }
        for (const node of root.querySelectorAll(FLOATING_SURFACES)) {
            if (node.closest(`[${ROOT}]`) !== root || regions.has(node)) continue;
            regions.set(node, { styles: new Map() });
        }
    };
    const adaptRegions = palette => {
        for (const [node, region] of regions) {
            if (node.matches('.vertex-paygo-pi-sidebar')) {
                rememberStyle(node, region.styles, 'background-color', palette.background);
            }
        }
    };
    const refreshControls = () => {
        if (disposed) return;
        for (const [node, original] of controls) {
            if (!root.contains(node) || !controlKind(node)) {
                restoreStyle(node, original.styles);
                if (original.marker === null) node.removeAttribute(CONTROL); else node.setAttribute(CONTROL, original.marker);
                controls.delete(node);
            }
        }
        for (const node of root.querySelectorAll(CONTROLS)) {
            if (node.closest(`[${ROOT}]`) !== root) continue;
            const kind = controlKind(node);
            if (!kind) continue;
            let original = controls.get(node);
            if (!original) { original = { styles: new Map(), marker: node.getAttribute(CONTROL) }; controls.set(node, original); }
            if (node.getAttribute(CONTROL) !== kind) node.setAttribute(CONTROL, kind);
            for (const [property, value] of CONTROL_STYLES) rememberStyle(node, original.styles, property, value);
            // Never transfer the host's SVG arrow, including in interaction states.
            if (kind === 'select') rememberStyle(node, original.styles, 'appearance', 'var(--vertex-paygo-select-appearance, auto)');
        }
    };
    const entry = {
        sync() {
            if (disposed) return;
            try {
                const source = themeSource(root);
                const panel = messageManagerTheme(source);
                // Paint first. Optional control-state sampling cannot prevent
                // the message manager's background from being applied.
                if (!skipBg) {
                    rememberStyle(root, originalRoot, 'background-color', panel.background);
                    rememberStyle(root, originalRoot, 'color', panel.foreground);
                    for (const key of ['image', 'size', 'position', 'repeat']) {
                        rememberStyle(root, originalRoot, `background-${key}`, panel[`background-${key}`]);
                    }
                }
                const palette = { ...manager.sample(source), ...panel };
                for (const [key, value] of Object.entries(palette)) rememberStyle(root, originalRoot, `--vertex-paygo-${key}`, value);
                rememberStyle(root, originalRoot, 'color', 'var(--vertex-paygo-foreground)');
                if (!skipBg) {
                    collectRegions();
                    adaptRegions(palette);
                }
                refreshControls();
            } catch (error) { console.warn('[提示词缓存优化] Theme synchronization failed.', error); }
        },
        destroy() {
            if (disposed) return;
            disposed = true; childObserver.disconnect();
            root.removeEventListener('animationend', onAnimationEnd);
            if (frame !== null) win.cancelAnimationFrame(frame);
            root.removeAttribute(PENDING); restoreStyle(root, originalRoot);
            if (originalMarker === null) root.removeAttribute(ROOT); else root.setAttribute(ROOT, originalMarker);
            for (const [node, original] of controls) {
                restoreStyle(node, original.styles);
                if (original.marker === null) node.removeAttribute(CONTROL); else node.setAttribute(CONTROL, original.marker);
            }
            controls.clear(); manager.release(entry);
            for (const [node, region] of regions) restoreStyle(node, region.styles);
            regions.clear();
        },
    };
    const childObserver = new win.MutationObserver(mutations => {
        if (queued || disposed) return;
        const popupChanged = !skipBg && mutations.some(mutation => mutation.type === 'childList'
            || mutation.target === root || mutation.target.matches?.(FLOATING_SURFACES));
        queued = true;
        Promise.resolve().then(() => {
            queued = false;
            if (popupChanged && root.isConnected) entry.sync(); else refreshControls();
        });
    });
    childObserver.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'open'] });
    const onAnimationEnd = event => { if (!skipBg && event.target === root) entry.sync(); };
    root.addEventListener('animationend', onAnimationEnd);
    manager.entries.add(entry); entry.sync();
    frame = win.requestAnimationFrame(() => {
        frame = null;
        if (disposed) return;
        // Reapply the same host tint after mounting, before the first paint.
        if (!skipBg && root.isConnected) entry.sync();
        root.removeAttribute(PENDING);
    });
    return entry;
}
