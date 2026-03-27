    (function()
    {
        'use strict';

        // ─── 0. CONFIG & STATE ────────────────────────────────────────────────────
        const CONFIG = {
            driftFactor: 1.0, // While hidden, clock advances
            forceRAF: 16, // Fallback RAF interval (ms) while hidden
            logPrefix: '[FocusSpoofer]',
            debounceThreshold: 50, // ms — ignore duplicate state-change events
            syncInterval: 500, // ms — BroadcastChannel / iframe / worker sync
        };
        
        let lastKnownActiveElement = null;

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

        // ─── 0.2. Cloudflare and similar checks...
        let SAFE_MODE = false;

        const evaluateInitSafeModeCheckPresence = () => {
            // 1. Direct Frame Check: Are we executing inside the Cloudflare challenge iframe?
            if (window.location.hostname.includes('challenges.cloudflare.com')) return true;
            
            // 2. Global Variable Check: Has Turnstile initialized?
            if (window.turnstile || window._cf_chl_opt) return true;

            // 3. DOM Fingerprint Check: Look for challenge wrappers or Turnstile iframes
            if (document.body) {
                const cfMarkers = document.querySelectorAll(
                    '#cf-please-wait, #challenge-running, #cf-spinner-allow-5-secs, [id^="cf-turnstile"], iframe[src*="challenges.cloudflare.com"]'
                );
                if (cfMarkers.length > 0) return true;
            }

            if (window.__CF$cv$params || window.__cfBeacon || window.__cf_chl_opt ||
                Array.from(document.scripts).some(s =>
                    s.src.includes('/cdn-cgi/') ||
                    s.src.includes('challenge-platform')
                ) ||
                document.querySelector('#cf-challenge-running') || document.querySelector('[data-cf-settings]')) return true;
            return false;
        };

        const initInitSafeModeCheckObserver = () => {
            const observer = new MutationObserver(() => {
                const currentlyDetected = evaluateInitSafeModeCheckPresence();
                if (currentlyDetected !== SAFE_MODE) {
                    SAFE_MODE = currentlyDetected;
                    _log(`${CONFIG.logPrefix} SAFE Mode is ${SAFE_MODE ? 'ENABLED' : 'DISABLED'}`);
                }
            });

            // Attach to documentElement to catch head/body injections as early as possible
            observer.observe(document.documentElement, { childList: true, subtree: true });
            
            // Run initial check
            SAFE_MODE = evaluateInitSafeModeCheckPresence();
        };

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
                    return originalMethod.apply(console, [ ...args ]);
                };

                // Spoof the [native code] string for this specific method
                markAsNative(console[method]);
            }
        });

        // Spoof console.memory — Chrome exposes this; Firefox doesn't.
        // Sites probe it to fingerprint the browser/runtime environment.
        if(!SAFE_MODE && isTabActuallyHidden && typeof console !== 'undefined')
        {
            Object.defineProperty(console, 'memory',
            {
                configurable: true,
                enumerable: true,
                get: () => undefined,
            });
        }

        // ...
        const isMediaPlaying = () => {
            const media = document.querySelectorAll('video, audio');
            return Array.from(media).some(m => !!(m.currentTime > 0 && !m.paused && !m.ended && m.readyState > 2));
        };

        // ─── 1. VIRTUAL CLOCK ─────────────────────────────────────────────────────
        const updateVirtualClock = () =>
        {
            const now = _realPerfNow();
            const delta = now - lastRealTime;
            virtualTime += ((isTabActuallyHidden && !isMediaPlaying()) ? (delta * CONFIG.driftFactor) : delta);
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
        const realHiddenGetter = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;

        const setHidden = (hidden, event = null) =>
        {
            const now = _realPerfNow();
            if (now - lastStateChange < CONFIG.debounceThreshold) return;
            if (isTabActuallyHidden === hidden) return;

            updateVirtualClock();
            isTabActuallyHidden = hidden;
            lastStateChange = now;

            if (!hidden && event && event.target) {
                const target = event.target;
                // Case 1: Only store if it's an actual Element (nodeType 1)
                if (target.nodeType === 1) {
                    lastKnownActiveElement = target;
                }
                // Case 2: Document or Window (Global focus)
                else if (target.nodeType === 9 || target === window) {
                    // Check if there is already a focused element in the DOM
                    // otherwise fallback to body.
                    lastKnownActiveElement = document.activeElement || document.body;
                }
                
                // Deep Stealth: If the target is inside a Shadow DOM, 
                // we should try to get the actual inner element.
                if (lastKnownActiveElement && lastKnownActiveElement.shadowRoot) {
                    const inner = lastKnownActiveElement.shadowRoot.activeElement;
                    if (inner) {
                        lastKnownActiveElement = inner;
                    }
                }
            }

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
        const internalListeners = new Set();
        const listenerMap = new Map();
        const _origAEL = EventTarget.prototype.addEventListener;
        const _origREL = EventTarget.prototype.removeEventListener;

        // Shortcut: attach via raw prototype call
        const rawListen = (target, type, fn, opts) => {
            internalListeners.add(type);
            return _origAEL.call(target, type, fn, opts);
        };
        
        const handleVisibility = (e) => {
            try {
                const isHidden = realHiddenGetter.call(document);
                setHidden(isHidden, e);
                
                // Re-assert the properties in case the site tries to overwrite them
                Object.defineProperty(document, 'visibilityState', { 
                    get: () => 'visible', 
                    configurable: true 
                });
                Object.defineProperty(document, 'hidden', { 
                    get: () => false, 
                    configurable: true 
                });
                Object.defineProperty(document, 'webkitVisibilityState', { 
                    get: () => 'visible', 
                    configurable: true 
                });
            } catch (err) {
                // Fallback if Document prototype is heavily mangled by other scripts
                setHidden(false, e); 
            }
        };

        rawListen(window, 'blur', (e) => setHidden(true, e), { capture: true, passive: true });
        rawListen(window, 'focus', (e) => setHidden(false, e), { capture: true, passive: true });
        rawListen(window, 'focusout', (e) => setHidden(true, e), { capture: true, passive: true });
        rawListen(window, 'focusin', (e) => setHidden(false, e), { capture: true, passive: true });
        rawListen(window, 'pagehide', (e) => setHidden(true, e), { capture: true, passive: true });
        rawListen(window, 'pageshow', (e) => setHidden(false, e), { capture: true, passive: true });
        rawListen(window, 'visibilitychange', (e) => handleVisibility(e), { capture: true, passive: true });
        rawListen(window, 'webkitvisibilitychange', (e) => handleVisibility(e), { capture: true, passive: true });
        rawListen(window, 'mozvisibilitychange', (e) => handleVisibility(e), { capture: true, passive: true });

        // ...
        // Initialize as soon as possible, or fallback to DOMContentLoaded
        if (document.documentElement) {
            initInitSafeModeCheckObserver();
        } else {
            rawListen(window, 'DOMContentLoaded', initInitSafeModeCheckObserver, { once: true });
        }

        // ─── 4. OVERRIDE performance.now ──────────────────────────────────────────
        const originalPerfNow = window.performance.now;
        window.performance.now = function()
        {
            if (SAFE_MODE || isMediaPlaying() || !isTabActuallyHidden) {
                return originalPerfNow.call(this);
            }

            updateVirtualClock();
            return virtualTime;
        };
        markAsNative(window.performance.now);

        // ─── 5. OVERRIDE Date.now & Date constructor ──────────────────────────────
        const OriginalDate = window.Date; // capture before we replace it

        // Override the static .now() first (before MockDate copies it)
        window.Date.now = function()
        {
            if (SAFE_MODE || !isTabActuallyHidden) {
                return _realDateNow(); 
            }
            return Math.floor(epochOffset + window.performance.now());
        };
        markAsNative(window.Date.now);

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
        Object.setPrototypeOf(MockDate, OriginalDate);
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

        const patchActiveElement = (Proto) => {
            const originalDescriptor = Object.getOwnPropertyDescriptor(Proto, 'activeElement');
            if (!originalDescriptor || !originalDescriptor.get) return;
            if (SAFE_MODE || !isTabActuallyHidden) return;

            Object.defineProperty(Proto, 'activeElement', {
                configurable: true,
                enumerable: true,
                get: function() {
                    const realActive = originalDescriptor.get.call(this);

                    // Logic: If the tab is virtually focused but the real browser says 
                    // focus is lost (null/body), return our last 'good' element.
                    if (!isTabActuallyHidden) {
                        return realActive;
                    }

                    // If we are spoofing focus, don't let the site see 'null' or 'body'
                    // if they previously had a specific input/button focused.
                    if (realActive === null || realActive === document.body) {
                        return lastKnownActiveElement || document.body;
                    }

                    return realActive;
                }
            });
        };

        // Patch both Document and ShadowRoot (for Web Components support)
        patchActiveElement(Document.prototype);
        if (window.ShadowRoot) {
            patchActiveElement(ShadowRoot.prototype);
        }

        const origHasFocus = document.hasFocus;
        document.hasFocus = function() {
            if (SAFE_MODE || !isTabActuallyHidden) return origHasFocus.call(this);
            return true; // Lie and say we still have focus
        };
        markAsNative(document.hasFocus);

        // ─── 8. EVENT INTERCEPTION ────────────────────────────────────────────────
        // Hijack addEventListener — site-registered handlers for blacklisted
        // events are replaced with a noop that also stops propagation.
        EventTarget.prototype.addEventListener = function(type, listener, options)
        {
            // If it's one of our "Nuke" events, we replace it with a noop
            // but ONLY if the tab is actually hidden to avoid freezes.
            if (internalListeners.has(type) && isTabActuallyHidden)
            {
                const noop = (e) =>
                {
                    e.stopImmediatePropagation();
                    e.stopPropagation();
                };
                return _origAEL.call(this, type, noop, options);
            }
            
            // NEVER touch real user interaction events
            if (['click', 'mousedown', 'mouseup', 'keydown', 'keyup', 'touchstart', 'touchend'].includes(type)) {
                return _origAEL.call(this, type, listener, options);
            }
            
            // NEVER interact with events when in SAFE Mode or TAB is really visible...
            if (SAFE_MODE || !isTabActuallyHidden) {
                return _origAEL.call(this, type, listener, options);
            }
            
            // For all other events, create a proxy to spoof isTrusted or other props if needed
            let wrapped = listenerMap.get(listener);
            if (!wrapped) {
                wrapped = function (event)
                {
                    // Ensure event identity is preserved while spoofing trust
                    if (event && event.isTrusted === false) {
                        const descriptor = Object.getOwnPropertyDescriptor(event, 'isTrusted');
                        // Only attempt to redefine if the property is configurable
                        if (!descriptor || descriptor.configurable) {
                            Object.defineProperty(event, 'isTrusted', { 
                                value: true, 
                                configurable: true,
                                writable: false 
                            });
                        }
                    }
                    return listener.call(this, event);
                };
                listenerMap.set(listener, wrapped);
            }
            return _origAEL.call(this, type, wrapped, options);
        };

        EventTarget.prototype.removeEventListener = function(type, listener, options) {
            // Look up our proxy/noop. If the site calls remove(OriginalFunc), 
            // we must call _origREL(WrappedFunc/Noop) for the browser to find it.
            const wrapped = listenerMap.get(listener);
            const targetListener = wrapped || listener;

            return _origREL.call(this, type, targetListener, options);
        };

        markAsNative(EventTarget.prototype.addEventListener);
        markAsNative(EventTarget.prototype.removeEventListener);

        // Belt-and-suspenders: raw capture listeners that kill the event *early*.
        const killEvent = (e) =>
        {
            if (SAFE_MODE) return;

            e.stopImmediatePropagation();
            e.stopPropagation();
            _log(`${CONFIG.logPrefix} Nuked ${e.type}`);
        };
        [window, document].forEach(target =>
        {
            new Set([
                'visibilitychange', 'webkitvisibilitychange', 'mozvisibilitychange',
                'blur', 'focusout', 'pagehide', 'pageshow', 'focusin', 'focus',
            ]).forEach(evt =>
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
            if(SAFE_MODE || !isTabActuallyHidden) return originalSetInterval.apply(this, [callback, delay, ...args]);
            if (typeof delay === 'number' && delay < 1000)
            {
                const id = ++callbackId;
                pendingCallbacks.set(id, { fn: () => callback(...args), oneShot: false });
                heartbeat.postMessage({ type: 'set', id, delay });
                return id;
            }
            return originalSetInterval.apply(this, [callback, delay, ...args]);
        };
        markAsNative(window.setInterval);
        window.clearInterval = function(id)
        {
            if(SAFE_MODE || !isTabActuallyHidden) return originalClearInterval.apply(this, [id]);
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
        markAsNative(window.clearInterval);

        // ─── 11. requestAnimationFrame / cancelAnimationFrame override ────────────
        const originalRAF = window.requestAnimationFrame;
        const originalCAF = window.cancelAnimationFrame;

        window.requestAnimationFrame = (callback) =>
        {
            if(SAFE_MODE || !isTabActuallyHidden) return originalRAF.apply(this, [callback]);
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
        markAsNative(window.requestAnimationFrame);
        window.cancelAnimationFrame = function(id)
        {
            if(SAFE_MODE || !isTabActuallyHidden) return originalCAF.apply(this, [id]);
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
        markAsNative(window.cancelAnimationFrame);

        // ─── 12. requestIdleCallback / cancelIdleCallback override ───────────────
        const originalRIC = window.requestIdleCallback;
        const originalCIC = window.cancelIdleCallback;

        window.requestIdleCallback = function(callback, opts)
        {
            if(SAFE_MODE || !isTabActuallyHidden) return originalRIC.apply(this, [callback, opts]);
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
        markAsNative(window.requestIdleCallback);
        window.cancelIdleCallback = function(id)
        {
            if(SAFE_MODE || !isTabActuallyHidden) return originalCIC.apply(this, [id]);
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
                if (!win) return;
                // CRITICAL: Check if we can actually touch the window (Same-Origin Check)
                // Accessing win.location.href on a cross-origin frame will throw.
                const isSameOrigin = () => {
                    try { return !!win.location.href || true; } 
                    catch(e) { return false; }
                };
                if (!isSameOrigin()) {
                    _log(`${CONFIG.logPrefix} Skipping Cross-Origin Frame`);
                    return;
                }

                if (win.__patched) return;
                win.__patched = true;
                
                const canAccess = () => {
                    try {
                        return !!(iframe.contentWindow && iframe.contentWindow.location.href);
                    } catch (e) {
                        return false;
                    }
                };
                
                const { markAsNative: markInner } = createToStringSpoofer(win);

                // Give the iframe's own scripts a tick to set up before we inject.
                const applyPatch = () => {
                    if (!canAccess()) return;
                    if (SAFE_MODE || !isTabActuallyHidden) return;
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
                    
                    patchDynamicCode(win);
                    patchAudioConstructor.call(win, 'AudioContext');
                    patchAudioConstructor.call(win, 'webkitAudioContext');
                };
                originalSetTimeout.call(window, applyPatch, 100);
                iframe.addEventListener('load', applyPatch, { once: true });

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
            if (SAFE_MODE || !isTabActuallyHidden) return originalCreateElement.apply(this, [tagName, ...args]);
            const el = originalCreateElement(tagName, ...args);
            if (typeof tagName === 'string' && tagName.toLowerCase() === 'iframe')
            {
                rawListen(el, 'load', () => patchIframe(el));
            }
            return el;
        };
        markAsNative(document.createElement);

        // Patch already-present iframes.
        if (!SAFE_MODE || isTabActuallyHidden)
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
            if (SAFE_MODE || !isTabActuallyHidden) return Reflect.construct(OriginalIO, [callback, options]);
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
        window.Worker = function WorkerProxy(scriptURL, options) {
            if (SAFE_MODE || !isTabActuallyHidden) {
                return OriginalWorker(scriptURL, options);
            }
            
            // 1. Resolve relative URLs (e.g., "/worker.js") to absolute URLs 
            // based on the current page's origin. This fixes the importScripts crash.
            const absoluteUrl = new URL(scriptURL, window.location.href).href;

            // 2. The code we want to execute INSIDE the worker BEFORE the real script runs
            const workerPatchCode = `
                let virtualTime = performance.now();
                let lastReal = performance.now();
                let hidden = false;
                const drift = ${CONFIG.driftFactor};

                const update = () => {
                    const now = performance.now();
                    const delta = now - lastReal;
                    virtualTime += hidden ? delta * drift : delta;
                    lastReal = now;
                };

                const epochOffset = Date.now() - performance.now();

                // Patch Globals
                const origPerfNow = performance.now;
                performance.now = function() { update(); return virtualTime; };
                Date.now = function() { return Math.floor(epochOffset + performance.now()); };

                // Hide our sync messages from the real worker script
                const origAddEventListener = self.addEventListener;
                self.addEventListener = function(type, listener, opts) {
                    if (type === 'message') {
                        const wrapped = (e) => {
                            if (e.data && e.data.__sync) return; // Drop our internal messages
                            return listener.call(this, e);
                        };
                        return origAddEventListener.call(this, type, wrapped, opts);
                    }
                    return origAddEventListener.apply(this, arguments);
                };

                // Listen for main-thread synchronization
                origAddEventListener.call(self, 'message', (e) => {
                    if (e.data && e.data.__sync) {
                        virtualTime = e.data.t;
                        hidden = e.data.h;
                        e.stopImmediatePropagation(); // Prevent other listeners from seeing this
                    }
                });
            `;

            // 3. Assemble the final Blob: Our patch runs FIRST, then we import the real script
            const blobContent = `${workerPatchCode}\n\nimportScripts("${absoluteUrl}");`;
            const blobUrl = URL.createObjectURL(new Blob([blobContent], { type: 'application/javascript' }));

            // 4. Initialize the real worker using our patched Blob
            const worker = new OriginalWorker(blobUrl, options);

            Object.defineProperty(worker, 'scriptURL', {
                configurable: true,
                enumerable: true,
                get: () => scriptURL,
            });

            // 5. Setup continuous synchronization from the Main Thread to the Worker
            const syncState = () => {
                try {
                    worker.postMessage({ 
                        __sync: true, 
                        t: virtualTime, // from your main extension.js state
                        h: isTabActuallyHidden 
                    });
                } catch (e) {}
            };

            // Piggyback off your existing originalSetInterval
            originalSetInterval.call(window, syncState, CONFIG.syncInterval);
            syncState();

            return worker;
        };

        Object.setPrototypeOf(window.Worker, OriginalWorker);
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
            if(SAFE_MODE || !isTabActuallyHidden) {
                return;
            }
            
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
            Object.setPrototypeOf(global.Function, OrigFunc);
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
                _log(`${CONFIG.logPrefix} DevTools gap compensated: +${gap.toFixed(1)}ms`);
            }
        }, 1000);

        // ─── 19. AUDIO CONTEXT TEMPORAL ALIGNMENT ─────────────────────────────────
        
        // Use a WeakMap to securely store the initial drift offset for each context
        // without polluting the object instance or exposing it to page scripts.
        const audioContextData = new WeakMap();

        const patchAudioConstructor = (GlobalName) => {
            if (!window[GlobalName]) return;
            if (SAFE_MODE || !isTabActuallyHidden) return;
            const OriginalCtx = window[GlobalName];

            const ProxyCtx = function(...args) {
                if (!(this instanceof ProxyCtx)) {
                    return Reflect.construct(OriginalCtx, args);
                }
                const ctx = Reflect.construct(OriginalCtx, args, ProxyCtx);
                
                // Capture the exact global drift (in ms) at the moment this specific context is born.
                // _realPerfNow() and window.performance.now() (virtual) must already be defined.
                const currentGlobalDrift = _realPerfNow() - window.performance.now();
                
                audioContextData.set(ctx, { creationDrift: currentGlobalDrift });
                return ctx;
            };

            // Reuse your existing patchConstructor utility to perfectly mirror the prototype
            ProxyCtx.prototype = OriginalCtx.prototype;
            ProxyCtx.prototype.constructor = ProxyCtx;
            Object.setPrototypeOf(ProxyCtx, OriginalCtx);

            window[GlobalName] = ProxyCtx;
            markAsNative(window[GlobalName]);
        };

        // Patch all relevant Audio constructors
        patchAudioConstructor('AudioContext');
        patchAudioConstructor('webkitAudioContext');
        patchAudioConstructor('OfflineAudioContext');

        // Patch the shared prototype getter (BaseAudioContext in modern browsers)
        const BaseCtx = window.BaseAudioContext || window.AudioContext;
        if (BaseCtx) {
            const origDescriptor = Object.getOwnPropertyDescriptor(BaseCtx.prototype, 'currentTime');
            
            if (origDescriptor && origDescriptor.get) {
                const origGet = origDescriptor.get;

                Object.defineProperty(BaseCtx.prototype, 'currentTime', {
                    configurable: true,
                    enumerable: true,
                    get: function() {
                        const realTime = origGet.call(this); // Hardware time in seconds
                        const state = audioContextData.get(this);
                        
                        if (!state || !isTabActuallyHidden) return realTime; // Safety fallback
                        
                        // Calculate how much the tab has drifted globally since this context was created
                        const currentGlobalDrift = _realPerfNow() - window.performance.now();
                        const localDriftMs = currentGlobalDrift - state.creationDrift;
                        
                        // AudioContext.currentTime is strictly in seconds
                        const localDriftSec = localDriftMs / 1000;
                        
                        // Subtract the drift, but prevent negative time
                        return Math.max(0, realTime - localDriftSec);
                    }
                });
            }

            // Deep Steath: spoof getOutputTimestamp() which links Audio time to Performance time
            if (BaseCtx.prototype.getOutputTimestamp) {
                const origTimestamp = BaseCtx.prototype.getOutputTimestamp;
                BaseCtx.prototype.getOutputTimestamp = function(...args) {
                    const ts = origTimestamp.apply(this, args);
                    const state = audioContextData.get(this);
                    
                    if (!state || !isTabActuallyHidden) return ts; // Safety fallback
                    
                    // Align the performance time directly to our spoofed virtual clock
                    if (ts.performanceTime !== undefined) {
                        ts.performanceTime = window.performance.now(); 
                    }
                    
                    // Align the context time using the same local drift math
                    if (ts.contextTime !== undefined && state) {
                        const currentGlobalDrift = _realPerfNow() - window.performance.now();
                        const localDriftSec = (currentGlobalDrift - state.creationDrift) / 1000;
                        ts.contextTime = Math.max(0, ts.contextTime - localDriftSec);
                    }
                    
                    return ts;
                };
                markAsNative(BaseCtx.prototype.getOutputTimestamp);
            }
        }

        // ─── 20. CLEANUP ─────────────────────────────────────────────────────────

        const cleanup = () =>
        {
            pendingCallbacks.forEach((_, id) =>
            {
                heartbeat.postMessage({ type: 'clear', id });
            });
            pendingCallbacks.clear();
            internalListeners.clear();
            listenerMap.clear();

            if (channel)
            {
                channel.close();
            }
            observer.disconnect();
        };

        rawListen(window, 'beforeunload', cleanup);

        rawListen(window, 'pagehide', cleanup, { capture: true });

    })();
