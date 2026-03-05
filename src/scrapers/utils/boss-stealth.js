/**
 * Boss Zhipin Anti-Scraping Stealth Module
 * Injects hooks into the browser to bypass `disable-devtool`, `performance.now` timing checks,
 * `Function.prototype.toString` validation, and hides `navigator.webdriver`.
 */

async function injectAntiAntiHook(page) {
    await page.evaluateOnNewDocument(`
      (function () {
        'use strict';
        
        // 1. Proxy performance.now to hide sluggish automation connections
        const navStart = (typeof performance !== 'undefined' && performance.timing) ? performance.timing.navigationStart : Date.now();
        console.table = function () {};
        performance.now = function () { return Date.now() - navStart; };
        
        const methods = ['console.table', 'performance.now'];
        function initAntiAntiHook() {
            try {
                const hookedFunctions = new Map();
                for (let methodPath of methods) {
                    let ref = window; let parts = methodPath.split('.');
                    for (let i = 0; i < parts.length - 1; i++) { ref = ref[parts[i]]; if (!ref) break; }
                    if (ref) {
                        const fn = ref[parts[parts.length - 1]];
                        if (typeof fn === 'function') hookedFunctions.set(fn, parts[parts.length - 1]);
                    }
                }
                if (hookedFunctions.size === 0) return;
                
                // 2. Disguise Function.prototype.toString
                let temp_toString = Function.prototype.toString;
                Function.prototype.toString = function () {
                    if (this === Function.prototype.toString) return 'function toString() { [native code] }';
                    if (this === Function.prototype.constructor && hookedFunctions.has(Function.prototype.constructor)) return 'function Function() { [native code] }';
                    if (hookedFunctions.has(this)) return \`function \${hookedFunctions.get(this).name || hookedFunctions.get(this)}() { [native code] }\`;
                    return temp_toString.apply(this, arguments);
                };
                
                const hookedMethodNames = new Map();
                methods.forEach(path => {
                    let ref = window; let parts = path.split('.');
                    for (let i = 0; i < parts.length - 1; i++) { ref = ref[parts[i]]; if (!ref) break; }
                    if (ref) {
                        const fn = ref[parts[parts.length - 1]];
                        if (typeof fn === 'function') hookedMethodNames.set(path, fn);
                    }
                });
                const objectHooksMap = new Map();
                methods.forEach(path => {
                    const parts = path.split('.');
                    const rootParts = parts[0] === 'window' ? parts.slice(1) : parts;
                    if (rootParts.length < 2) return;
                    const rootName = rootParts[0]; const remaining = rootParts.slice(1);
                    const fn = hookedMethodNames.get(path); if (!fn) return;
                    if (!objectHooksMap.has(rootName)) objectHooksMap.set(rootName, []);
                    objectHooksMap.get(rootName).push({ remaining, fn });
                });
                if (!objectHooksMap.has('Function')) objectHooksMap.set('Function', []);
                if (!objectHooksMap.get('Function').some(({ remaining }) => remaining.join('.') === 'prototype.toString')) {
                    objectHooksMap.get('Function').push({ remaining: ['prototype', 'toString'], fn: Function.prototype.toString });
                }
                
                // 3. Transparently proxy iframe contentWindow
                let property_accessor = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, "contentWindow");
                let get_accessor = property_accessor.get;
                Object.defineProperty(HTMLIFrameElement.prototype, "contentWindow", {
                    get: function () {
                        let iframe_window = get_accessor.apply(this);
                        iframe_window = new Proxy(iframe_window, {
                            get: function (target, property, receiver) {
                                if (typeof property === 'string') {
                                    for (const [fullPath, fn] of hookedMethodNames.entries()) {
                                        if (fullPath.endsWith('.' + property) || fullPath === property) return fn;
                                    }
                                    if (objectHooksMap.has(property)) {
                                        const obj = Reflect.get(target, property, target);
                                        if (obj !== null && (typeof obj === 'object' || typeof obj === 'function')) {
                                            objectHooksMap.get(property).forEach(({ remaining, fn }) => {
                                                let ref = obj;
                                                for (let i = 0; i < remaining.length - 1; i++) { ref = ref[remaining[i]]; if (!ref) return; }
                                                ref[remaining[remaining.length - 1]] = fn;
                                            });
                                        }
                                        return obj;
                                    }
                                }
                                const value = Reflect.get(target, property, target);
                                return (typeof value === 'function') ? value.bind(target) : value;
                            },
                        });
                        return iframe_window;
                    }
                });
            } catch (e) {}
        }
        initAntiAntiHook();
        
        // 4. Scrub WebDriver traces
        Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
        try {
            for (let key in window) { if (key.match(/cdc_[a-zA-Z0-9]/)) delete window[key]; }
            window.navigator.chrome = { runtime: {} };
        } catch(e) {}
      })();
    `);
}

module.exports = {
    injectAntiAntiHook
};
