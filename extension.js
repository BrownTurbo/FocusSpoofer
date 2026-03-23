(function()
{
    'use strict';

    // ─── 0. CONFIG & STATE ────────────────────────────────────────────────────
    const CONFIG = {
        driftFactor: 0.01, // While hidden, clock advances at 1% speed
        forceRAF: 16, // Fallback RAF interval (ms) while hidden
        logPrefix: '[FocusSpoofer]',
        debounceThreshold: 50, // ms — ignore duplicate state-change events
        syncInterval: 500, // ms — BroadcastChannel / iframe / worker sync
    };

    // Capture performance.now / Date.now *before any patching* so the
    // internal clock always runs on real wall-clock time.
    const _realPerfNow = performance.now.bind(performance);
    const _realDateNow = Date.now.bind(Date);
    const epochOffset = _realDateNow() - _realPerfNow(); // ms offset

    let lastRealTime = _realPerfNow();
    let virtualTime = _realPerfNow();
    let isTabActuallyHidden = false;
    let lastStateChange = 0;

    // ─── 0.1. IMMEDIATE CONSOLE CAPTURE ──────────────────────────────────────
    // Capture real console methods immediately so internal engine logs never fail.
    const _log = (typeof console !== 'undefined' && console.log) ? console.log.bind(console) : () => {};
    const _warn = (typeof console !== 'undefined' && console.warn) ? console.warn.bind(console) : () => {};
    const _error = (typeof console !== 'undefined' && console.error) ? console.error.bind(console) : () => {};

    // ─── CROSS-TAB LEADER ELECTION ────────────────────────────────────────────
    const tabId = Math.random().toString(36).slice(2);
    let isLeader = true; // assume leader until a rival claims it

    const channel = new BroadcastChannel('focus-spoof-sync');

    // ...
    const createToStringSpoofer = (global) =>
    {
        const originalToString = global.Function.prototype.toString;
        const nativeLike = new global.WeakSet();

        const markAsNative = (fn) =>
        {
            try { nativeLike.add(fn); }
            catch (_) {}
        };

        global.Function.prototype.toString = function()
        {
            if (nativeLike.has(this))
            {
                return `function ${this.name || ''}() { [native code] }`;
            }
            return originalToString.call(this);
        };

        markAsNative(global.Function.prototype.toString);
        return { markAsNative };
    };

    const { markAsNative } = createToStringSpoofer(window);
    // ─── 0.5 CONSOLE STEALTH ─────────────────────────────────────────────────
    // Passthrough wrapper keeps console.log functional while hiding the real
    // reference (prevents sites from detecting extension-patched globals via
    // console.log.toString() tricks).
    ['log', 'warn', 'error', 'debug', 'info', 'trace'].forEach(method =>
    {
        if (typeof console !== 'undefined' && console[method])
        {
            const originalMethod = console[method]; // Captured in a unique block scope

            console[method] = function(...args)
            {
                // Ensure the original context 'console' is maintained
                return originalMethod.apply(console, args);
            };

            // Spoof the [native code] string for this specific method
            markAsNative(console[method]);
        }
    });

    // Spoof console.memory — Chrome exposes this; Firefox doesn't.
    // Sites probe it to fingerprint the browser/runtime environment.
    if (typeof console !== 'undefined')
    {
        Object.defineProperty(console, 'memory',
        {
            configurable: true,
            enumerable: true,
            get: () => undefined,
        });
    }

    // ─── 1. VIRTUAL CLOCK ─────────────────────────────────────────────────────
    const updateVirtualClock = () =>
    {
        const now = _realPerfNow();
        const delta = now - lastRealTime;
        virtualTime += isTabActuallyHidden ? (delta * CONFIG.driftFactor) : delta;
        lastRealTime = now;
    };

    // ─── HELPER: consistent time-state object ─────────────────────────────────
    const getTimeState = () => ({ t: virtualTime, h: isTabActuallyHidden });

    // Full sync — used only internally (e.g. worker injection inside this tab).
    const applyTimeState = (state) =>
    {
        if (!state || typeof state.t !== 'number') return;
        virtualTime = state.t;
        isTabActuallyHidden = !!state.h;
    };

    // Time-only sync — used for ALL external sources (BroadcastChannel, iframes,
    // postMessage). Each tab / frame owns its own physical hidden state; we must
    // never let a remote tab's `h` flag overwrite our real visibility.
    const applyTimeOnly = (state) =>
    {
        if (!state || typeof state.t !== 'number') return;
        virtualTime = state.t;
        // intentionally does NOT touch isTabActuallyHidden
    };

    // ─── 2. HIDDEN-STATE TRACKER ──────────────────────────────────────────────
    // Capture the *real* hidden getter before we override Document.prototype.
    const realHiddenGetter =
        Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;

    const setHidden = (hidden) =>
    {
        const now = _realPerfNow();
        if (now - lastStateChange < CONFIG.debounceThreshold) return;
        if (isTabActuallyHidden === hidden) return;

        updateVirtualClock();
        isTabActuallyHidden = hidden;
        lastStateChange = now;

        if (!hidden)
        {
            // We just became visible — claim leadership.
            isLeader = true;

            // peer tabs can (a) yield leadership AND (b) sync their clocks.
            channel.postMessage({ type: 'claim_leader', id: tabId, ...getTimeState() });
        }

        if (isLeader)
        {

            channel.postMessage({ type: 'sync', ...getTimeState() });
        }

        _log(`${CONFIG.logPrefix} Tab: ${hidden ? 'HIDDEN' : 'VISIBLE'}`);
    };

    // ─── 3. REAL EVENT LISTENERS (registered on raw addEventListener) ─────────
    // These must be installed *before* we hijack addEventListener so that our
    // own state-tracking is never nuked by the blacklist logic below.
    const _origAEL = EventTarget.prototype.addEventListener;
    const _origREL = EventTarget.prototype.removeEventListener;

    // Shortcut: attach via raw prototype call
    const rawListen = (target, type, fn, opts) =>
        _origAEL.call(target, type, fn, opts);

    rawListen(window, 'blur', () => setHidden(true), { capture: true, passive: true });
    rawListen(window, 'focus', () => setHidden(false), { capture: true, passive: true });
    rawListen(window, 'focusout', () => setHidden(true), { capture: true, passive: true });
    rawListen(window, 'focusin', () => setHidden(false), { capture: true, passive: true });
    rawListen(window, 'pagehide', () => setHidden(true), { capture: true, passive: true });
    rawListen(window, 'pageshow', () => setHidden(false), { capture: true, passive: true });
    rawListen(window, 'visibilitychange', () => setHidden(realHiddenGetter.call(document)), { capture: true, passive: true });
    rawListen(window, 'webkitvisibilitychange', () => setHidden(realHiddenGetter.call(document)), { capture: true, passive: true });
    rawListen(window, 'mozvisibilitychange', () => setHidden(realHiddenGetter.call(document)), { capture: true, passive: true });

    // ─── 4. OVERRIDE performance.now ──────────────────────────────────────────
    window.performance.now = function()
    {
        updateVirtualClock();
        return virtualTime;
    };

    // ─── 5. OVERRIDE Date.now & Date constructor ──────────────────────────────
    const OriginalDate = window.Date; // capture before we replace it

    // Override the static .now() first (before MockDate copies it)
    window.Date.now = function()
    {
        return Math.floor(epochOffset + window.performance.now());
    };

    // (We use _realDateNow internally; window.Date.now is the public override.)

    function MockDate(...args)
    {
        // When called as a plain function (not constructor) Date() returns a string.
        if (!(this instanceof MockDate))
        {
            return new OriginalDate(window.Date.now()).toString();
        }
        if (args.length === 0)
        {
            return new OriginalDate(window.Date.now());
        }
        return new OriginalDate(...args);
    }
    MockDate.prototype = OriginalDate.prototype;
    MockDate.prototype.constructor = MockDate;

    // Copy static methods (now, parse, UTC) — window.Date.now is already patched.
    Object.getOwnPropertyNames(OriginalDate).forEach(prop =>
    {
        try
        {
            if (!(prop in MockDate))
            {
                MockDate[prop] = OriginalDate[prop];
            }
        }
        catch (_) {}
    });

    window.Date = MockDate;

    // ─── 6. FIX performance.timeOrigin ───────────────────────────────────────

    // Use a pure accessor descriptor (no writable key at all).
    try
    {
        Object.defineProperty(performance, 'timeOrigin',
        {
            configurable: true,
            enumerable: true,
            get: () => epochOffset,
            // NO `writable` key — accessor descriptors must not have writable/value
        });
    }
    catch (_) {}

    // ─── 7. PROPERTY & FOCUS MOCKING ─────────────────────────────────────────
    const visibilityProps = {
        visibilityState: 'visible',
        webkitVisibilityState: 'visible',
        mozVisibilityState: 'visible',
        hidden: false,
        mozHidden: false,
        webkitHidden: false,
        onvisibilitychange: null,
        onwebkitvisibilitychange: null,
        onmozvisibilitychange: null,
    };

    for (const [prop, value] of Object.entries(visibilityProps))
    {
        const descriptor = {
            configurable: true,
            enumerable: true,
            get: () => value,
            set: (_v) => {},
        };
        try { Object.defineProperty(Document.prototype, prop, descriptor); }
        catch (_) {}
        try { Object.defineProperty(document, prop, descriptor); }
        catch (_) {}
    }

    const hasFocusTrue = () => true;
    const hasFocusDescriptor = { configurable: false, writable: false, value: hasFocusTrue };
    try { Object.defineProperty(Document.prototype, 'hasFocus', hasFocusDescriptor); }
    catch (_) {}
    try { Object.defineProperty(document, 'hasFocus', hasFocusDescriptor); }
    catch (_) {}

    // ─── 8. EVENT INTERCEPTION ────────────────────────────────────────────────
    const blacklistedEvents = new Set([
        'visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange',
        'blur', 'focusout', 'pagehide', 'pageshow', 'focusin', 'focus',
    ]);

    // Hijack addEventListener — site-registered handlers for blacklisted
    // events are replaced with a noop that also stops propagation.
    EventTarget.prototype.addEventListener = function(type, listener, options)
    {
        if (blacklistedEvents.has(type))
        {
            const noop = (e) =>
            {
                e.stopImmediatePropagation();
                e.stopPropagation();
            };
            return _origAEL.call(this, type, noop, options);
        }
        return _origAEL.apply(this, arguments);
    };

    // Belt-and-suspenders: raw capture listeners that kill the event *early*.
    const killEvent = (e) =>
    {
        e.stopImmediatePropagation();
        e.stopPropagation();
        _log(`${CONFIG.logPrefix} Nuked ${e.type}`);
    };
    [window, document].forEach(target =>
    {
        blacklistedEvents.forEach(evt =>
        {
            // Must use the *raw* prototype call so our killEvent isn't itself wrapped.
            rawListen(target, evt, killEvent, { capture: true });
        });
    });

    // ─── 9. WORKER HEARTBEAT (timer proxy) ────────────────────────────────────
    const workerCode = `
        const timerMap = new Map();
        self.onmessage = ({ data: { type, id, delay, isTimeout } }) => {
            if (type === 'set') {
                const fn = isTimeout
                    ? setTimeout (() => { self.postMessage({ id }); timerMap.delete(id); }, delay)
                    : setInterval(() => self.postMessage({ id }), delay);
                timerMap.set(id, { fn, isTimeout });
            } else if (type === 'clear') {
                const entry = timerMap.get(id);
                if (entry) {
                    (entry.isTimeout ? clearTimeout : clearInterval)(entry.fn);
                    timerMap.delete(id);
                }
            }
        };
    `;

    const heartbeatBlob = new Blob([workerCode], { type: 'application/javascript' });
    // Use the *original* Worker constructor so our patched Worker() doesn't
    // intercept this internal blob worker.
    const OriginalWorker = window.Worker;
    const heartbeat = new OriginalWorker(URL.createObjectURL(heartbeatBlob));
    const pendingCallbacks = new Map();
    let callbackId = 0;

    heartbeat.onmessage = ({ data }) =>
    {
        const entry = pendingCallbacks.get(data.id);
        if (!entry) return;
        entry.fn();
        // One-shot callbacks (RAF, idle) must be removed after firing.
        // Interval callbacks stay in the map until explicitly cleared.
        if (entry.oneShot) pendingCallbacks.delete(data.id);
    };

    // ─── 10. setInterval / clearInterval override ─────────────────────────────
    const originalSetInterval = window.setInterval;
    const originalClearInterval = window.clearInterval;
    const originalSetTimeout = window.setTimeout;
    const originalClearTimeout = window.clearTimeout;

    window.setInterval = function(callback, delay, ...args)
    {
        if (typeof delay === 'number' && delay < 1000)
        {
            const id = ++callbackId;
            pendingCallbacks.set(id, { fn: () => callback(...args), oneShot: false });
            heartbeat.postMessage({ type: 'set', id, delay });
            return id;
        }
        return originalSetInterval.apply(this, [callback, delay, ...args]);
    };

    window.clearInterval = function(id)
    {
        if (pendingCallbacks.has(id))
        {
            heartbeat.postMessage({ type: 'clear', id });
            pendingCallbacks.delete(id);
        }
        else
        {
            originalClearInterval(id);
        }
    };

    // ─── 11. requestAnimationFrame / cancelAnimationFrame override ────────────
    const originalRAF = window.requestAnimationFrame;
    const originalCAF = window.cancelAnimationFrame;

    window.requestAnimationFrame = (callback) =>
    {
        const wrapped = () => callback(window.performance.now());

        if (isTabActuallyHidden)
        {
            const id = ++callbackId;
            // oneShot:true — RAF fires exactly once; heartbeat.onmessage will
            // auto-delete after the callback runs, preventing a memory leak.
            pendingCallbacks.set(id, { fn: wrapped, oneShot: true });
            heartbeat.postMessage({ type: 'set', id, delay: CONFIG.forceRAF, isTimeout: true });
            return id;
        }
        return originalRAF(wrapped);
    };

    window.cancelAnimationFrame = function(id)
    {
        if (pendingCallbacks.has(id))
        {
            heartbeat.postMessage({ type: 'clear', id });
            pendingCallbacks.delete(id);
        }
        else
        {
            originalCAF(id);
        }
    };

    // ─── 12. requestIdleCallback / cancelIdleCallback override ───────────────

    window.requestIdleCallback = function(callback, opts)
    {
        const delay = (opts && opts.timeout) ? Math.min(opts.timeout, 50) : 1;
        const id = ++callbackId;
        // oneShot:true — idle callbacks fire once per request, same as RAF.
        pendingCallbacks.set(id,
        {
            fn: () => callback({ didTimeout: false, timeRemaining: () => 50 }),
            oneShot: true,
        });
        heartbeat.postMessage({ type: 'set', id, delay, isTimeout: true });
        return id;
    };

    window.cancelIdleCallback = function(id)
    {
        if (pendingCallbacks.has(id))
        {
            heartbeat.postMessage({ type: 'clear', id });
            pendingCallbacks.delete(id);
        }
        else
        {
            originalClearTimeout(id);
        }
    };

    // ─── 13. NATIVE toString SPOOFER ──────────────────────────────────────────
    markAsNative(window.performance.now);
    markAsNative(window.Date.now);
    markAsNative(window.requestAnimationFrame);
    markAsNative(window.cancelAnimationFrame);
    markAsNative(window.setInterval);
    markAsNative(window.clearInterval);
    markAsNative(window.requestIdleCallback);
    markAsNative(window.cancelIdleCallback);
    markAsNative(window.Worker);
    markAsNative(window.eval);

    // ─── 14. IFRAME PATCHING ──────────────────────────────────────────────────
    const patchedIframes = new WeakSet();

    const patchIframe = (iframe) =>
    {
        if (patchedIframes.has(iframe)) return;
        patchedIframes.add(iframe);

        try
        {
            const win = iframe.contentWindow;
            if (!win || win.__patched) return;
            win.__patched = true;

            const { markAsNative: markInner } = createToStringSpoofer(win);

            // Give the iframe's own scripts a tick to set up before we inject.
            originalSetTimeout.call(window, () =>
            {
                try
                {
                    markInner(win.performance.now);
                    markInner(win.Date.now);
                    markInner(win.requestAnimationFrame);
                    markInner(win.cancelAnimationFrame);
                    markInner(win.setInterval);
                    markInner(win.clearInterval);
                    markInner(win.requestIdleCallback);
                    markInner(win.cancelAnimationFrame);
                    markInner(win.Function);
                    markInner(win.Function.prototype.toString);
                    markInner(win.eval);
                }
                catch (_) {}
            }, 100);

            const sendSync = () => win.postMessage({ __sync: true, ...getTimeState() }, '*');
            const iframeSyncId = originalSetInterval.call(window, sendSync, CONFIG.syncInterval);
            sendSync();

            // Store interval on the iframe element for potential cleanup.
            iframe._syncIntervalId = iframeSyncId;

            rawListen(win, 'message', (e) =>
            {
                if (e.data && e.data.__sync)
                {
                    applyTimeOnly(e.data);
                }
            });
        }
        catch (_)
        {
            // Cross-origin frame — cannot patch.
        }
    };

    // (The sendSync above now includes __sync: true, so this will trigger.)
    rawListen(window, 'message', (e) =>
    {
        if (e.data && e.data.__sync)
        {
            applyTimeOnly(e.data);
        }
    });

    // Hook createElement — FIX #8: single registration point only.
    const originalCreateElement = document.createElement.bind(document);
    document.createElement = function(tagName, ...args)
    {
        const el = originalCreateElement(tagName, ...args);
        if (typeof tagName === 'string' && tagName.toLowerCase() === 'iframe')
        {
            rawListen(el, 'load', () => patchIframe(el));
        }
        return el;
    };

    // Hook appendChild — FIX #8: do NOT add another load listener here;
    // it was already added by createElement hook above.
    const originalAppendChild = Node.prototype.appendChild;
    Node.prototype.appendChild = function(node)
    {
        return originalAppendChild.call(this, node);
    };

    // Patch already-present iframes.
    document.querySelectorAll('iframe').forEach(patchIframe);

    // Observe future iframes via MutationObserver.
    const observer = new MutationObserver((mutations) =>
    {
        for (const m of mutations)
        {
            for (const node of m.addedNodes)
            {
                if (node.nodeName === 'IFRAME')
                {
                    rawListen(node, 'load', () => patchIframe(node));
                }
            }
        }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });

    const OriginalIO = window.IntersectionObserver;
    window.IntersectionObserver = function(callback, options)
    {
        const wrappedCallback = (entries, observer) =>
        {
            const spoofedEntries = entries.map(entry =>
            {
                // Force every entry to appear visible and in-viewport
                return new Proxy(entry,
                {
                    get: (target, prop) =>
                    {
                        if (prop === 'isIntersecting') return true;
                        if (prop === 'intersectionRatio') return 1;
                        return target[prop];
                    }
                });
            });
            return callback(spoofedEntries, observer);
        };
        return new OriginalIO(wrappedCallback, options);
    };
    markAsNative(window.IntersectionObserver);

    // ─── 15. WORKER PATCHING ─────────────────────────────────────────────────
    const workerInjection = `
        let virtualTime = performance.now();
        let lastW       = performance.now();
        let hiddenW     = false;
        const driftW    = ${CONFIG.driftFactor};

        const updateW = () => {
            const now   = performance.now();
            const delta = now - lastW;
            virtualTime += hiddenW ? delta * driftW : delta;
            lastW = now;
        };

        const _origNow  = performance.now.bind(performance);
        const epochOffW = Date.now() - _origNow();

        performance.now = function () { updateW(); return virtualTime; };
        Date.now        = function () { return Math.floor(epochOffW + performance.now()); };

        self.onmessage = (e) => {
            if (e.data && e.data.__sync) {
                virtualTime = e.data.t;
                hiddenW     = !!e.data.h;
            }
        };

        self.Worker = function () { throw new Error('Nested workers are blocked.'); };

        /* FIX #1: pure accessor descriptor — no writable key */
        try {
            Object.defineProperty(performance, 'timeOrigin', {
                configurable: true,
                enumerable:   true,
                get: () => epochOffW,
            });
        } catch (_) {}
    `;

    window.Worker = function WorkerProxy(scriptURL, options)
    {
        try
        {
            const blobSrc = new Blob([
                workerInjection,
                `\ntry {
    importScripts(${JSON.stringify(String(scriptURL))});
} catch (_importErr) {
    fetch(${JSON.stringify(String(scriptURL))})
        .then(r => r.text())
        .then(code => (0, eval)(code))
        .catch(() => {});
}`,
            ], { type: 'application/javascript' });

            const proxied = new OriginalWorker(URL.createObjectURL(blobSrc), options);

            Object.defineProperty(proxied, 'scriptURL',
            {
                configurable: true,
                enumerable: true,
                get: () => scriptURL,
            });

            // Sync loop — use originalSetInterval to avoid recursion.
            originalSetInterval.call(window, () =>
            {
                proxied.postMessage({ __sync: true, ...getTimeState() });
            }, CONFIG.syncInterval);

            return proxied;
        }
        catch (_)
        {
            return new OriginalWorker(scriptURL, options);
        }
    };

    window.Worker.prototype = OriginalWorker.prototype;
    markAsNative(window.Worker);

    // ─── 16. BROADCAST CHANNEL — CROSS-TAB SYNC ──────────────────────────────
    channel.postMessage({ type: 'hello', id: tabId, ...getTimeState() });

    channel.onmessage = ({ data }) =>
    {
        if (!data) return;

        if (data.type === 'hello')
        {
            // Deterministic leader: lowest string ID wins.
            if (data.id < tabId) isLeader = false;
        }

        if (data.type === 'claim_leader')
        {
            if (data.id !== tabId) isLeader = false;
            // Sync the virtual clock from the new leader — time only, never `h`.
            if (typeof data.t === 'number') applyTimeOnly(data);
        }

        // Sync clock from leader (type 'sync' or bare object with t).
        // applyTimeOnly: follower tabs keep their OWN physical hidden state;
        // adopting the leader's `h` would drift a visible tab at 1% speed.
        if ((data.type === 'sync' || data.t !== undefined) && !isLeader)
        {
            applyTimeOnly(data);
        }
    };

    // Periodic leader broadcast.
    originalSetInterval.call(window, () =>
    {
        try
        {
            if (isLeader && channel)
            {
                channel.postMessage({ type: 'sync', ...getTimeState() });
            }
        }
        catch (e)
        {
            // If the channel is closed, stop trying to broadcast
            isLeader = false;
        }
    }, CONFIG.syncInterval);

    // ─── 17. FUNCTION / EVAL PATCHING ────────────────────────────────────────

    // cannot escape the spoofed environment through any global reference.
    const patchDynamicCode = (global) =>
    {
        const OrigFunc = global.Function;
        const origEval = global.eval;

        const wrapCode = (code) =>
        {
            if (typeof code !== 'string') return code;
            return `(function(performance, Date) {
${code}
})(window.performance, window.Date);`;
        };

        global.Function = function(...args)
        {
            const body = args.pop();
            const wrapped = wrapCode(body);
            return OrigFunc.apply(this, [...args, wrapped]);
        };
        global.Function.prototype = OrigFunc.prototype;

        global.eval = function(code)
        {
            return origEval.call(global, wrapCode(code));
        };

        markAsNative(global.Function);
        markAsNative(global.eval);
    };

    patchDynamicCode(window);

    // ─── 18. DEVTOOLS TIMING COMPENSATION ────────────────────────────────────

    // do NOT fire a random debugger statement in normal operation.
    originalSetInterval.call(window, () =>
    {
        const start = _realPerfNow();
        const end = _realPerfNow(); // near-zero under normal conditions
        const gap = end - start;

        if (gap > 100)
        {
            // DevTools likely paused execution — push the internal clock forward
            // so the virtual clock doesn't think time passed while paused.
            lastRealTime += gap;
            console.log(`${CONFIG.logPrefix} DevTools gap compensated: +${gap.toFixed(1)}ms`);
        }
    }, 1000);

    // ─── 20. CLEANUP ─────────────────────────────────────────────────────────

    const cleanup = () =>
    {
        pendingCallbacks.forEach((_, id) =>
        {
            heartbeat.postMessage({ type: 'clear', id });
        });
        pendingCallbacks.clear();

        if (channel)
        {
            channel.close();
        }
        observer.disconnect();
    };

    rawListen(window, 'beforeunload', cleanup);

    rawListen(window, 'pagehide', cleanup, { capture: true });

})();