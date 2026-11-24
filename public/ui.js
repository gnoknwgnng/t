/*
 * PostCraft AI — small shared UI helpers used by the generator and the
 * Publishing Hub (styles live in /theme.css):
 *
 *   PostCraftUI.toast(message, 'success' | 'error' | 'info')
 *       A short message in the corner of the screen. Replaces the blocking
 *       browser alert() pop-ups, and stays visible above open pop-ups.
 *
 *   PostCraftUI.withBusy(button, 'Saving…', async () => { ... })
 *       Disables the button and shows a spinner with the given label while
 *       the task runs, so slow requests don't look like nothing happened
 *       and can't be submitted twice.
 */
(function () {
    'use strict';

    let region = null;

    function getRegion() {
        if (!region) {
            region = document.createElement('div');
            region.className = 'toast-region';
            region.setAttribute('role', 'status');
            region.setAttribute('aria-live', 'polite');
            document.body.appendChild(region);
        }
        return region;
    }

    function toast(message, type, durationMs) {
        const kind = type || 'info';
        const element = document.createElement('div');
        element.className = 'toast toast-' + kind;
        element.textContent = String(message || '');
        element.title = 'Dismiss';
        getRegion().appendChild(element);

        // Errors stay longer: they usually need reading twice.
        const visibleFor = durationMs || (kind === 'error' ? 7000 : 4000);
        const dismiss = function () {
            element.classList.add('is-leaving');
            setTimeout(function () { element.remove(); }, 220);
        };
        const timer = setTimeout(dismiss, visibleFor);
        element.addEventListener('click', function () {
            clearTimeout(timer);
            dismiss();
        });
        return element;
    }

    async function withBusy(button, busyLabel, task) {
        if (!button) {
            return task();
        }

        const originalHtml = button.innerHTML;
        const wasDisabled = button.disabled;
        button.disabled = true;
        button.classList.add('is-busy');
        button.textContent = busyLabel;

        try {
            return await task();
        } finally {
            // The button may have been re-rendered meanwhile; restoring a
            // detached node is harmless.
            button.classList.remove('is-busy');
            button.innerHTML = originalHtml;
            button.disabled = wasDisabled;
        }
    }

    window.PostCraftUI = { toast: toast, withBusy: withBusy };
})();
