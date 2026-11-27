// ==UserScript==
// @name         YouTube Live Chat Verifier
// @namespace    yt-live-chat-verifier
// @version      2.0
// @description  Fast and lightweight public YouTube live chat verification.
// @author       Enteranon
// @match        https://www.youtube.com/live_chat*
// @icon         https://www.youtube.com/favicon.ico
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_registerMenuCommand
// @grant        GM_addStyle
// @sandbox      DOM
// @run-at       document-idle
// ==/UserScript==

(() => {
    'use strict';

    if (location.pathname !== '/live_chat') return;

    // ==================================================
    // CONFIGURATION
    // ==================================================

    const CONFIG = {
        minPollInterval: 2000,
        defaultPollInterval: 4000,
        verificationTimeout: 12000,
        minSuccessfulPolls: 2,
        timestampTolerance: 1000,
        coverageMargin: 3000,
        retryInterval: 10000,
        rateLimitInterval: 60000,
        requestTimeout: 30000,
        cacheLifetime: 300000,
        maxCachedMessages: 4000,
        maxTrackedMessages: 200
    };

    const SEL = 'yt-live-chat-text-message-renderer';
    const ATTR = 'data-yt-verifier-status';

    const seen = new Map();
    const pending = new Map();
    const claimed = new Map();
    const queue = new Map();

    const controller = new AbortController();

    let identity = null;
    let initialIdentity = null;

    let manual = GM_getValue('manualUsername', '');
    let debug = GM_getValue('debug', false);

    let container = null;
    let observer = null;

    let batchTimer = null;
    let pollTimer = null;
    let verificationTimer = null;

    let stopped = false;
    let token = '';
    let clientVersion = '';
    let visitorData = '';
    let apiKey = '';

    let fullChat = false;
    let epoch = 0;
    let polls = 0;
    let connected = false;

    let lastError = '';
    let lastSuccess = 0;
    let latestPublicTime = 0;
    let sessionVideo = '';
    let failures = 0;

    // ==================================================
    // CSS-ONLY STATUS INDICATORS
    // ==================================================

    GM_addStyle(`
        ${SEL} #message[${ATTR}]::after {
            display: inline;
            margin-left: 6px;
            font-size: 10px;
            font-weight: bold;
            white-space: nowrap;
            pointer-events: none;
            user-select: none;
        }

        ${SEL} #message[${ATTR}="delivered"]::after {
            content: "✓ Delivered";
            color: #35c759;
        }

        ${SEL} #message[${ATTR}="likely"]::after {
            content: "? Likely delivered";
            color: #eab308;
        }

        ${SEL} #message[${ATTR}="checking"]::after {
            content: "◷ Checking...";
            color: #eab308;
        }

        ${SEL} #message[${ATTR}="not-found"]::after {
            content: "✗ Not found";
            color: #ff4444;
        }

        ${SEL} #message[${ATTR}="not-seen-yet"]::after {
            content: "? Not seen yet";
            color: #eab308;
        }

        ${SEL} #message[${ATTR}="unconfirmed"]::after {
            content: "? Not confirmed";
            color: #eab308;
        }

        ${SEL} #message[${ATTR}="error"]::after {
            content: "⚠ Verification failed";
            color: #aaa;
        }

        #yt-verifier-panel {
            position: fixed;
            top: 48px;
            right: 8px;
            z-index: 10;
            background: #191919;
            border: 1px solid #444;
            border-radius: 6px;
            padding: 6px 10px;
            font: 11px Arial, sans-serif;
            max-width: 250px;
            overflow-wrap: anywhere;
            pointer-events: none;
            user-select: none;
        }
    `);

    // ==================================================
    // CONNECTION STATUS
    // ==================================================

    const panel = document.createElement('div');

    panel.id = 'yt-verifier-panel';

    document.body.appendChild(panel);

    function status(text, color = '#eab308') {
        if (panel.textContent !== text) {
            panel.textContent = text;
        }

        if (panel.dataset.color !== color) {
            panel.style.color = color;
            panel.dataset.color = color;
        }
    }

    function log(...args) {
        if (debug) {
            console.info('[Chat Verifier]', ...args);
        }
    }

    // ==================================================
    // TAMPERMONKEY MENU
    // ==================================================

    GM_registerMenuCommand(
        'Configure Username Override',
        () => {
            const name = prompt(
                'Optional username override. Leave empty for automatic detection.',
                manual
            );

            if (name !== null) {
                GM_setValue(
                    'manualUsername',
                    name.trim()
                );

                location.reload();
            }
        }
    );

    GM_registerMenuCommand(
        'Enable Automatic Detection',
        () => {
            GM_setValue('manualUsername', '');
            location.reload();
        }
    );

    GM_registerMenuCommand(
        'Toggle Debug Logging',
        () => {
            debug = !debug;

            GM_setValue('debug', debug);

            console.info(
                '[Chat Verifier] Debug:',
                debug
            );
        }
    );

    GM_registerMenuCommand(
        'Restart Verifier',
        () => location.reload()
    );

    // ==================================================
    // JSON AND TEXT UTILITIES
    // ==================================================

    function findAll(obj, key, out = []) {
        if (!obj || typeof obj !== 'object') {
            return out;
        }

        for (const [k, v] of Object.entries(obj)) {
            if (k === key) out.push(v);

            if (v && typeof v === 'object') {
                findAll(v, key, out);
            }
        }

        return out;
    }

    function text(v) {
        if (typeof v === 'string') {
            return v;
        }

        if (typeof v?.simpleText === 'string') {
            return v.simpleText;
        }

        return (v?.runs || []).map(r =>
            r.text ??
            r.emoji?.shortcuts?.[0] ??
            r.emoji?.image?.accessibility
                ?.accessibilityData?.label ??
            ''
        ).join('');
    }

    const normalizeName = s =>
        String(s || '')
            .trim()
            .replace(/^@/, '')
            .toLowerCase();

    const normalizeText = s =>
        String(s || '')
            .normalize('NFC')
            .replace(/\s+/gu, ' ')
            .trim();

    function avatar(s) {
        try {
            const u = new URL(s);

            return u.hostname +
                u.pathname.replace(/=[^/]*$/, '');

        } catch {
            return '';
        }
    }

    function timestamp(v) {
        const n = Number(v);

        if (!Number.isFinite(n) || n <= 0) {
            return 0;
        }

        return n > 1e14
            ? n / 1000
            : n > 1e11
                ? n
                : 0;
    }

    function initialData(html) {
        const m = html.match(
            /(?:var\s+ytInitialData|window\["ytInitialData"\])\s*=\s*(\{[\s\S]*?\});/
        );

        if (!m) {
            throw new Error(
                'Initial chat data not found'
            );
        }

        return JSON.parse(m[1]);
    }

    // ==================================================
    // AUTOMATIC ACCOUNT DETECTION
    // ==================================================

    function accountData(d = {}, el = null) {
        d ||= {};

        const image = el?.querySelector(
            '#author-photo img'
        );

        return {
            channel:
                d.authorExternalChannelId ||
                d.authorEndpoint
                    ?.browseEndpoint
                    ?.browseId ||
                '',

            name:
                text(d.authorName) ||
                el?.querySelector('#author-name')
                    ?.textContent?.trim() ||
                '',

            avatar: avatar(
                image?.currentSrc ||
                image?.src ||
                d.authorPhoto
                    ?.thumbnails?.[0]?.url
            )
        };
    }

    function readInitialIdentity() {
        for (const script of document.scripts) {
            if (
                !script.textContent.includes(
                    'liveChatMessageInputRenderer'
                )
            ) {
                continue;
            }

            try {
                const input = findAll(
                    initialData(script.textContent),
                    'liveChatMessageInputRenderer'
                )[0];

                if (input) {
                    return accountData(input);
                }

            } catch {}
        }

        return null;
    }

    function detectIdentity() {
        if (manual) {
            return {
                channel: '',
                name: manual,
                avatar: ''
            };
        }

        const el = document.querySelector(
            'yt-live-chat-message-input-renderer'
        );

        if (!el) return null;

        const a = accountData(el.data, el);
        const b = initialIdentity;

        if (
            b && (
                (a.channel &&
                    a.channel === b.channel) ||

                (a.avatar &&
                    a.avatar === b.avatar) ||

                (a.name &&
                    normalizeName(a.name) ===
                    normalizeName(b.name)) ||

                (!a.channel && !a.name && !a.avatar)
            )
        ) {
            if (!a.channel) a.channel = b.channel;
            if (!a.name) a.name = b.name;
            if (!a.avatar) a.avatar = b.avatar;
        }

        return a.channel || a.name || a.avatar
            ? a
            : null;
    }

    function own(el) {
        if (!identity) return false;

        const a = accountData(el.data, el);

        a.channel ||=
            el.getAttribute(
                'author-external-channel-id'
            ) || '';

        if (a.channel && identity.channel) {
            return a.channel === identity.channel;
        }

        if (
            a.name &&
            identity.name &&
            normalizeName(a.name) ===
            normalizeName(identity.name)
        ) {
            return true;
        }

        return Boolean(
            a.avatar &&
            identity.avatar &&
            a.avatar === identity.avatar
        );
    }

    // ==================================================
    // MESSAGE DATA EXTRACTION
    // ==================================================

    function domText(el) {
        const msg = el.querySelector('#message');

        if (!msg) return '';

        const walker = document.createTreeWalker(
            msg,
            NodeFilter.SHOW_TEXT |
            NodeFilter.SHOW_ELEMENT
        );

        let n;
        let out = '';

        while ((n = walker.nextNode())) {
            if (n.nodeType === 3) {
                out += n.nodeValue;
            } else if (n.tagName === 'IMG') {
                out += n.alt || '';
            }
        }

        return out;
    }

    function localRecord(el) {
        const d = el.data || {};
        const a = accountData(d, el);

        const ids = [
            ...new Set([
                d.id,
                el.getAttribute('id')
            ].filter(Boolean))
        ];

        return {
            id: ids[0],
            ids,

            channel:
                a.channel ||
                el.getAttribute(
                    'author-external-channel-id'
                ) || '',

            name: a.name,
            avatar: a.avatar,

            message: normalizeText(
                text(d.message) || domText(el)
            ),

            time: timestamp(
                d.timestampUsec ||
                el.getAttribute('timestamp-usec')
            )
        };
    }

    function publicRecord(d) {
        const a = accountData(d);

        return {
            id: d.id,
            channel: a.channel,
            name: a.name,
            avatar: a.avatar,
            message: normalizeText(text(d.message)),
            time: timestamp(d.timestampUsec),
            received: Date.now()
        };
    }

    function sameAuthor(a, b) {
        if (a.channel && b.channel) {
            return a.channel === b.channel;
        }

        if (
            a.name?.startsWith('@') &&
            b.name?.startsWith('@')
        ) {
            return normalizeName(a.name) ===
                normalizeName(b.name);
        }

        return Boolean(
            a.name &&
            b.name &&
            normalizeName(a.name) ===
                normalizeName(b.name) &&
            a.avatar &&
            b.avatar &&
            a.avatar === b.avatar
        );
    }

    // ==================================================
    // NON-INTRUSIVE CSS STATUS
    // ==================================================

    function mark(entry, s) {
        if (!entry.el?.isConnected) return;

        const msg = entry.el.querySelector(
            '#message'
        );

        if (
            msg &&
            msg.getAttribute(ATTR) !== s
        ) {
            msg.setAttribute(ATTR, s);
        }

        entry.state = s;
    }

    function clearMarks() {
        container?.querySelectorAll(
            `[${ATTR}]`
        ).forEach(el =>
            el.removeAttribute(ATTR)
        );
    }

    function refreshIdentity() {
        const a = detectIdentity();

        if (
            JSON.stringify(a) ===
            JSON.stringify(identity)
        ) {
            return;
        }

        identity = a;

        pending.clear();
        claimed.clear();
        clearMarks();

        if (a) {
            container?.querySelectorAll(
                SEL
            ).forEach(el =>
                processMessage(el, true)
            );
        }

        log(
            'Account:',
            a?.name ||
            a?.channel ||
            'unknown'
        );
    }

    // ==================================================
    // FAST VERIFICATION TIMER
    // ==================================================

    function scheduleVerification() {
        clearTimeout(verificationTimer);

        if (stopped) return;

        let next = Infinity;

        const now = Date.now();

        for (const e of pending.values()) {
            if (
                e.confirmed ||
                !e.el.isConnected
            ) {
                continue;
            }

            const deadline =
                e.start + CONFIG.verificationTimeout;

            if (deadline > now) {
                next = Math.min(next, deadline);
            }
        }

        if (Number.isFinite(next)) {
            verificationTimer = setTimeout(
                reconcile,
                Math.max(50, next - now + 10)
            );
        }
    }

    // ==================================================
    // MULTI-METHOD MESSAGE VERIFICATION
    // ==================================================

    function confirm(entry, pub, method) {
        claimed.set(pub.id, {
            local: entry.id,
            time: Date.now()
        });

        entry.confirmed = true;
        entry.method = method;

        mark(entry, 'delivered');

        log(
            'Confirmed:',
            method,
            entry.id,
            pub.id
        );
    }

    function reconcile() {
        if (stopped) return;

        const now = Date.now();

        const active = [
            ...pending.values()
        ].filter(e =>
            e.el.isConnected &&
            !e.confirmed
        );

        if (!active.length) {
            clearTimeout(verificationTimer);
            return;
        }

        // Method 1: Exact message ID matching.

        for (const e of active) {
            for (const id of e.ids) {
                const p = seen.get(id);

                if (
                    p &&
                    (
                        !claimed.has(id) ||
                        claimed.get(id).local === e.id
                    )
                ) {
                    confirm(e, p, 'message ID');
                    break;
                }
            }
        }

        // Method 2:
        // Author + message text + timestamp.

        const remaining = active.filter(
            e => !e.confirmed
        );

        const byText = new Map();

        const wanted = new Set(
            remaining
                .map(e => e.message)
                .filter(Boolean)
        );

        if (wanted.size) {
            for (const p of seen.values()) {
                if (
                    !wanted.has(p.message) ||
                    claimed.has(p.id)
                ) {
                    continue;
                }

                if (!byText.has(p.message)) {
                    byText.set(p.message, []);
                }

                byText.get(p.message).push(p);
            }
        }

        const matches = new Map();
        const counts = new Map();

        for (const e of remaining) {
            if (!e.message) continue;

            const candidates = [];

            for (
                const p of
                byText.get(e.message) || []
            ) {
                if (
                    claimed.has(p.id) ||
                    !p.message ||
                    p.message !== e.message ||
                    !sameAuthor(e, p)
                ) {
                    continue;
                }

                const exactTime =
                    e.time &&
                    p.time &&
                    Math.abs(e.time - p.time) <=
                        CONFIG.timestampTolerance;

                const weakTime =
                    (
                        !e.time &&
                        !e.historical &&
                        p.time &&
                        Math.abs(e.start - p.time) <= 12000 &&
                        p.received >= e.start - 12000
                    ) ||
                    (
                        e.time &&
                        p.time &&
                        Math.abs(e.time - p.time) <= 5000
                    );

                if (!exactTime && !weakTime) {
                    continue;
                }

                candidates.push({
                    p,
                    strong: Boolean(exactTime)
                });

                counts.set(
                    p.id,
                    (counts.get(p.id) || 0) + 1
                );
            }

            matches.set(e.id, candidates);
        }

        for (const e of remaining) {
            const list =
                matches.get(e.id) || [];

            if (
                list.length === 1 &&
                counts.get(list[0].p.id) === 1
            ) {
                const {p, strong} = list[0];

                if (strong) {
                    confirm(
                        e,
                        p,
                        'author + text + timestamp'
                    );

                    continue;
                }

                mark(e, 'likely');
                continue;
            }

            if (list.length > 0) {
                mark(e, 'unconfirmed');
                continue;
            }

            if (lastError) {
                mark(e, 'error');
                continue;
            }

            const age = now - e.start;

            if (
                age <
                CONFIG.verificationTimeout
            ) {
                mark(e, 'checking');
                continue;
            }

            // Faster negative verification.
            // Still require independent chat coverage.

            const enoughPolls =
                polls - e.polls >=
                CONFIG.minSuccessfulPolls;

            const validConnection =
                connected &&
                fullChat &&
                e.epoch === epoch &&
                !e.historical &&
                !e.gap &&
                now - lastSuccess < 30000;

            const reliableIdentity =
                Boolean(
                    identity?.channel ||
                    identity?.name?.startsWith('@')
                );

            const timelineCovered =
                Boolean(
                    e.time &&
                    latestPublicTime >=
                        e.time + CONFIG.coverageMargin
                );

            const enoughEvidence =
                validConnection && reliableIdentity && enoughPolls;

            const covered = enoughEvidence && timelineCovered;

            // Idle chats may not provide enough
            // timestamp evidence. Do not mark red
            // solely because a timer has expired.

            mark(
                e,
                covered ? 'not-found' :
                    enoughEvidence ? 'not-seen-yet' : 'unconfirmed'
            );

            if (
                covered &&
                !e.loggedMissing
            ) {
                e.loggedMissing = true;

                log(
                    'Not found:',
                    e.id,
                    'elapsed:',
                    age,
                    'polls:',
                    polls - e.polls,
                    'local timestamp:',
                    e.time,
                    'public latest:',
                    latestPublicTime
                );
            }
        }

        scheduleVerification();
    }

    // ==================================================
    // PROCESS OWN MESSAGES
    // ==================================================

    function processMessage(
        el,
        historical = false
    ) {
        if (
            !el.isConnected ||
            !own(el)
        ) {
            return false;
        }

        const r = localRecord(el);

        if (!r.id) return false;

        let entry = pending.get(r.id);

        if (!entry) {
            entry = {
                ...r,
                el,
                historical,
                start: Date.now(),
                polls,
                epoch,
                gap: !connected,
                confirmed: false
            };

            pending.set(r.id, entry);

        } else {
            entry.el = el;

            entry.ids = [
                ...new Set([
                    ...entry.ids,
                    ...r.ids
                ])
            ];

            if (!entry.time && r.time) {
                entry.time = r.time;
            }

            if (!entry.message && r.message) {
                entry.message = r.message;
            }

            if (!entry.channel && r.channel) {
                entry.channel = r.channel;
            }
        }

        if (entry.confirmed) {
            mark(entry, 'delivered');

        } else if (!entry.state) {
            mark(entry, 'checking');
        }

        scheduleVerification();

        return true;
    }

    // ==================================================
    // LIGHTWEIGHT MESSAGE OBSERVER
    // ==================================================

    function enqueue(
        el,
        historical = false
    ) {
        if (queue.size >= 1000) return;

        queue.set(el, historical);

        if (batchTimer !== null) return;

        batchTimer = setTimeout(() => {
            batchTimer = null;

            if (stopped) return;

            const list = [...queue];

            queue.clear();

            let changed = false;

            for (const [el, old] of list) {
                if (!el.isConnected) continue;

                changed =
                    processMessage(el, old) ||
                    changed;

                if (
                    !el.querySelector('#author-name') ||
                    !el.querySelector('#message')
                ) {
                    setTimeout(() => {
                        if (
                            !stopped &&
                            processMessage(el, old)
                        ) {
                            reconcile();
                        }
                    }, 250);
                }
            }

            if (changed) reconcile();

        }, 50);
    }

    function attachObserver() {
        const c = document.querySelector(
            'yt-live-chat-item-list-renderer #items'
        );

        if (!c || c === container) return;

        observer?.disconnect();

        container = c;

        observer = new MutationObserver(records => {
            for (const record of records) {
                for (const n of record.addedNodes) {
                    if (n.nodeType !== 1) continue;

                    if (n.matches(SEL)) {
                        enqueue(n);

                    } else {
                        n.querySelectorAll(SEL)
                            .forEach(el =>
                                enqueue(el)
                            );
                    }
                }
            }
        });

        // Observe only direct message additions.
        // Never observe menus or status attributes.

        observer.observe(c, {
            childList: true,
            subtree: false
        });

        c.querySelectorAll(SEL).forEach(
            el => enqueue(el, true)
        );
    }

    // ==================================================
    // MEMORY MANAGEMENT
    // ==================================================

    function prune() {
        const now = Date.now();

        for (const [id, p] of seen) {
            if (
                now - p.received >
                CONFIG.cacheLifetime
            ) {
                seen.delete(id);
            }
        }

        while (
            seen.size >
            CONFIG.maxCachedMessages
        ) {
            seen.delete(
                seen.keys().next().value
            );
        }

        for (const [id, e] of pending) {
            if (
                !e.el.isConnected ||
                now - e.start >
                    CONFIG.cacheLifetime
            ) {
                pending.delete(id);
            }
        }

        while (
            pending.size >
            CONFIG.maxTrackedMessages
        ) {
            pending.delete(
                pending.keys().next().value
            );
        }

        for (const [id, p] of claimed) {
            if (
                now - p.time >
                CONFIG.cacheLifetime
            ) {
                claimed.delete(id);
            }
        }

        while (
            claimed.size >
            CONFIG.maxCachedMessages
        ) {
            claimed.delete(
                claimed.keys().next().value
            );
        }
    }

    // ==================================================
    // PUBLIC CHAT MESSAGE COLLECTION
    // ==================================================

    function collect(chat) {
        const items = [];

        for (const action of chat.actions || []) {
            if (
                action.addChatItemAction?.item
            ) {
                items.push(
                    action.addChatItemAction.item
                );
            }

            if (
                action.replaceChatItemAction
                    ?.replacementItem
            ) {
                items.push(
                    action.replaceChatItemAction
                        .replacementItem
                );
            }
        }

        if (chat.contents) {
            items.push(chat.contents);
        }

        for (const item of items) {
            for (
                const d of findAll(
                    item,
                    'liveChatTextMessageRenderer'
                )
            ) {
                if (!d.id) continue;

                const p = publicRecord(d);

                seen.delete(p.id);
                seen.set(p.id, p);

                latestPublicTime = Math.max(
                    latestPublicTime,
                    p.time || 0
                );
            }
        }

        prune();
    }

    // ==================================================
    // SERVER CONTINUATION AND TIMING
    // ==================================================

    function continuation(obj) {
        const keys = [
            'timedContinuationData',
            'invalidationContinuationData',
            'reloadContinuationData',
            'reloadContinuation',
            'continuationCommand'
        ];

        for (const key of keys) {
            for (
                const item of findAll(obj, key)
            ) {
                const t =
                    item?.continuation ||
                    item?.token;

                if (t) {
                    return {
                        token: t,
                        wait:
                            Number(item.timeoutMs) ||
                            0,
                        kind: key
                    };
                }
            }
        }

        return null;
    }

    function getPollDelay(info) {
        // Respect YouTube's server timing.

        return Math.max(
            CONFIG.minPollInterval,
            info?.wait ||
            CONFIG.defaultPollInterval
        );
    }

    function videoId() {
        let id = new URL(
            location.href
        ).searchParams.get('v');

        try {
            id ||= new URL(
                window.parent.location.href
            ).searchParams.get('v');
        } catch {}

        return id || '';
    }

    // ==================================================
    // CONNECTION GAP DETECTION
    // ==================================================

    function gap() {
        connected = false;

        epoch++;
        polls = 0;
        latestPublicTime = 0;

        for (const e of pending.values()) {
            if (!e.confirmed) {
                e.gap = true;
            }
        }
    }

    // ==================================================
    // ANONYMOUS NETWORK REQUESTS
    // ==================================================

    async function request(
        url,
        options = {}
    ) {
        const r = await fetch(url, {
            ...options,

            credentials: 'omit',
            cache: 'no-store',

            signal: AbortSignal.any([
                controller.signal,
                AbortSignal.timeout(
                    CONFIG.requestTimeout
                )
            ])
        });

        if (!r.ok) {
            const error = new Error(
                'HTTP ' + r.status
            );

            error.status = r.status;

            const raw =
                r.headers.get('Retry-After');

            if (raw) {
                error.retryAfter =
                    /^\d+$/.test(raw)
                        ? Number(raw) * 1000
                        : Math.max(
                            0,
                            Date.parse(raw) -
                            Date.now()
                        ) || 0;
            }

            throw error;
        }

        return r;
    }

    // ==================================================
    // INITIALIZE INDEPENDENT PUBLIC CHAT
    // ==================================================

    async function initialize(id) {
        fullChat = false;

        status('● Connecting...');

        const url = new URL(
            'https://www.youtube.com/live_chat'
        );

        url.search = new URLSearchParams({
            v: id,
            hl: 'en',
            is_popout: '1'
        });

        const html =
            await (await request(url)).text();

        clientVersion = html.match(
            /"INNERTUBE_CLIENT_VERSION"\s*:\s*"([^"]+)"/
        )?.[1] || '';

        visitorData = html.match(
            /"VISITOR_DATA"\s*:\s*"([^"]+)"/
        )?.[1] || '';

        apiKey = html.match(
            /"INNERTUBE_API_KEY"\s*:\s*"([^"]+)"/
        )?.[1] || '';

        if (!clientVersion) {
            throw new Error(
                'Client version unavailable'
            );
        }

        const data = initialData(html);

        const chat = findAll(
            data,
            'liveChatRenderer'
        )[0];

        if (!chat) {
            throw new Error(
                'Public chat unavailable'
            );
        }

        let menus = findAll(
            chat,
            'subMenuItems'
        ).flat();

        if (!menus.length) {
            menus = findAll(
                data,
                'subMenuItems'
            ).flat();
        }

        const live = menus.find(m =>
            /^(live\s*chat|live-chat|all messages)$/i
                .test(text(m.title).trim())
        );

        const choice = live || menus[1];

        let info = choice
            ? continuation(choice)
            : null;

        if (!info && choice?.selected) {
            info = continuation(
                chat.continuations
            );
        }

        if (info && live) {
            fullChat = true;
        }

        if (choice?.selected) {
            collect(chat);
        }

        if (!info) {
            info = continuation(
                chat.continuations
            );

            fullChat = false;
        }

        if (!info) {
            throw new Error(
                'Public continuation token missing'
            );
        }

        token = info.token;

        log(
            'Chat mode:',
            fullChat
                ? 'Live Chat'
                : 'unconfirmed',
            'interval:',
            info.wait
        );

        return info;
    }

    // ==================================================
    // PUBLIC CHAT POLLING
    // ==================================================

    async function poll() {
        if (stopped) return;

        let delay =
            CONFIG.defaultPollInterval;

        try {
            attachObserver();
            refreshIdentity();

            if (!identity) {
                if (connected || token) {
                    gap();
                    token = '';
                }

                status(
                    '● Detecting account...'
                );

                return;
            }

            const id = videoId();

            if (!id) {
                throw new Error(
                    'Video ID unavailable'
                );
            }

            if (id !== sessionVideo) {
                const previousVideo = sessionVideo;

                sessionVideo = id;
                token = '';

                gap();

                seen.clear();
                claimed.clear();

                if (previousVideo) {
                    pending.clear();
                    clearMarks();

                    container?.querySelectorAll(
                        SEL
                    ).forEach(el =>
                        enqueue(el, true)
                    );
                }
            }

            if (!token) {
                const first = await initialize(id);

                delay = getPollDelay(first);

                return;
            }

            const url = new URL(
                'https://www.youtube.com/youtubei/v1/live_chat/get_live_chat'
            );

            url.searchParams.set(
                'prettyPrint',
                'false'
            );

            if (apiKey) {
                url.searchParams.set(
                    'key',
                    apiKey
                );
            }

            const r = await request(url, {
                method: 'POST',

                headers: {
                    'Content-Type':
                        'application/json'
                },

                body: JSON.stringify({
                    context: {
                        client: {
                            clientName: 'WEB',
                            clientVersion,
                            visitorData,
                            hl: 'en'
                        }
                    },

                    continuation: token
                })
            });

            const data = await r.json();

            const chat = data.continuationContents
                ?.liveChatContinuation;

            if (!chat) {
                throw new Error(
                    'Invalid public chat response'
                );
            }

            if (videoId() !== sessionVideo) {
                token = '';

                gap();

                return;
            }

            collect(chat);

            const next = continuation(
                chat.continuations
            );

            if (!next) {
                throw new Error(
                    'Next continuation token missing'
                );
            }

            if (
                next.kind === 'reloadContinuationData' ||
                next.kind === 'reloadContinuation'
            ) {
                gap();
            }

            token = next.token;

            delay = getPollDelay(next);

            connected = true;

            polls++;

            lastSuccess = Date.now();
            lastError = '';
            failures = 0;

            status(
                fullChat
                    ? '● Verifier online'
                    : '● Online - limited mode',

                fullChat
                    ? '#35c759'
                    : '#eab308'
            );

            log(
                'Poll:',
                polls,

                'cached:',
                seen.size,

                'next:',
                delay,

                'latest public time:',
                latestPublicTime
            );

        } catch (error) {
            if (stopped) return;

            lastError = error.message;

            token = '';

            gap();

            failures++;

            delay = Math.max(
                Math.min(
                    120000,

                    CONFIG.retryInterval *
                    2 ** Math.min(failures - 1, 4)
                ),

                error.retryAfter || 0
            );

            if (error.status === 429) {
                delay = Math.max(
                    delay,
                    CONFIG.rateLimitInterval
                );
            }

            status(
                error.status === 429
                    ? '● Rate limited - waiting'
                    : '⚠ ' + lastError,

                '#aaa'
            );

            console.warn(
                '[Chat Verifier]',
                error.message
            );

        } finally {
            if (!stopped) {
                prune();

                reconcile();

                // No overlapping network requests.

                pollTimer = setTimeout(
                    poll,
                    delay
                );
            }
        }
    }

    // ==================================================
    // CLEANUP
    // ==================================================

    function stop() {
        stopped = true;

        observer?.disconnect();

        controller.abort();

        clearTimeout(pollTimer);
        clearTimeout(batchTimer);
        clearTimeout(verificationTimer);

        queue.clear();
        pending.clear();
        seen.clear();
        claimed.clear();
    }

    window.addEventListener(
        'pagehide',
        stop,
        {once: true}
    );

    // ==================================================
    // STARTUP
    // ==================================================

    initialIdentity = readInitialIdentity();

    status('● Verifier starting...');

    refreshIdentity();
    attachObserver();

    poll();

    console.info(
        '[Chat Verifier] Version 2.0 started'
    );

})();




