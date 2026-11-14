/* Copyright (c) 2026 Mana Nekoha
 * This Source Code Form is subject to the Mozilla Public License, v. 2.0. */

// QuickBar's message manager uses a plain content panel inside a transparent
// body overlay. Keep our readers on that same path, outside native .popup CSS.
import { EXTENSION_DISPLAY_NAME } from './constants.js';
import { isolateDialogEvents } from './panel-events.js';

export function createExtensionDialog(content, { okButton = false, leftAlign = true,
    wide = false, large = false, allowHorizontalScrolling = false, allowVerticalScrolling = true,
    onEscape = null } = {}) {
    const doc = content.ownerDocument;
    const overlay = doc.createElement('div');
    overlay.className = 'vertex-paygo-dialog-overlay';
    overlay.style.visibility = 'hidden';
    const dlg = doc.createElement('div');
    dlg.className = 'vertex-paygo-dialog-panel';
    if (wide) dlg.classList.add('vertex-paygo-dialog-wide');
    if (large) dlg.classList.add('vertex-paygo-dialog-large');
    dlg.setAttribute('role', 'dialog');
    dlg.setAttribute('aria-modal', 'true');
    dlg.setAttribute('aria-label', content.getAttribute('aria-label')
        || content.querySelector('h2, h3')?.textContent || EXTENSION_DISPLAY_NAME);
    dlg.tabIndex = -1;
    if (leftAlign) dlg.style.textAlign = 'start';
    const body = doc.createElement('div'); body.className = 'vertex-paygo-dialog-body';
    const viewport = doc.createElement('div'); viewport.className = 'vertex-paygo-dialog-content';
    viewport.style.overflowX = allowHorizontalScrolling ? 'auto' : 'hidden';
    viewport.style.overflowY = allowVerticalScrolling ? 'auto' : 'hidden';
    const buttonControls = doc.createElement('div'); buttonControls.className = 'vertex-paygo-dialog-controls';
    const closeButton = doc.createElement('button');
    closeButton.className = 'menu_button vertex-paygo-dialog-close';
    closeButton.type = 'button'; closeButton.textContent = typeof okButton === 'string' ? okButton : '关闭';
    closeButton.hidden = !okButton;
    viewport.append(content); body.append(viewport); buttonControls.append(closeButton);
    dlg.append(body, buttonControls); overlay.append(dlg);
    let showing = null, resolve, previousFocus, frame, disposeEvents;
    const complete = result => {
        if (!showing) return Promise.resolve(result);
        doc.defaultView.cancelAnimationFrame(frame);
        disposeEvents?.(); disposeEvents = null;
        overlay.remove(); showing = null;
        resolve?.(result); resolve = null;
        if (previousFocus?.isConnected) previousFocus.focus?.({ preventScroll: true });
        return Promise.resolve(result);
    };
    const onKey = event => {
        if (event.defaultPrevented) return;
        if (event.key !== 'Tab') return;
        const focusable = [...dlg.querySelectorAll('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), summary, [tabindex="0"]')]
            .filter(node => !node.closest('[hidden]') && node.getClientRects().length);
        const first = focusable[0], last = focusable.at(-1);
        if (!first) { event.preventDefault(); dlg.focus(); return; }
        if (event.shiftKey && (doc.activeElement === first || doc.activeElement === dlg)) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && (doc.activeElement === last || !dlg.contains(doc.activeElement))) { event.preventDefault(); first.focus(); }
    };
    dlg.addEventListener('keydown', onKey);
    closeButton.addEventListener('click', () => void complete(1));
    overlay.addEventListener('click', event => { event.stopPropagation(); if (event.target === overlay) void complete(0); });
    dlg.close = () => void complete(0);
    return { dlg, body, content: viewport, buttonControls, closeButton, okButton: closeButton, complete,
        show() {
            if (showing) return showing;
            showing = new Promise(done => { resolve = done; });
            previousFocus = doc.activeElement;
            dlg.setAttribute('open', ''); doc.body.append(overlay);
            disposeEvents = isolateDialogEvents(overlay, { onEscape: onEscape ?? (() => void complete(0)) });
            frame = doc.defaultView.requestAnimationFrame(() => { overlay.style.visibility = ''; dlg.focus({ preventScroll: true }); });
            return showing;
        },
    };
}

// Keep the host's confirmation controls/results, isolating only extension-owned popups.
export async function showExtensionConfirm(context, header, text, options = {}, documentRef = globalThis.document) {
    let disposeEvents;
    const bind = popup => {
        disposeEvents?.();
        disposeEvents = isolateDialogEvents(popup.dlg, {
            onEscape: () => void popup.complete(context.POPUP_RESULT.CANCELLED),
        });
    };
    try {
        if (typeof context.Popup === 'function' && context.POPUP_TYPE?.CONFIRM !== undefined) {
            const content = documentRef.createElement('div');
            if (header) {
                const heading = documentRef.createElement('h3');
                heading.textContent = header; content.append(heading);
            }
            const message = documentRef.createElement('div');
            message.textContent = text ?? ''; content.append(message);
            const popup = new context.Popup(content, context.POPUP_TYPE.CONFIRM, null, options);
            bind(popup);
            return await popup.show();
        }
        // Older hosts may expose only the public confirmation helper.
        return await context.Popup.show.confirm(header, text, {
            ...options,
            onOpen(popup) { bind(popup); return options.onOpen?.(popup); },
        });
    } finally { disposeEvents?.(); }
}
