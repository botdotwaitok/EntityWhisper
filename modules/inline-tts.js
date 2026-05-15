/**
 * Entity Whisper — Inline TTS Playback Module
 *
 * Parses <say tone="..."> tags from rendered chat messages, generates audio
 * via the GPT-SoVITS backend, and injects per-sentence playback panels
 * directly into the chat DOM.
 *
 * Inspired by GSVI Inline TTS (SkeMma72O), adapted for EntityWhisper's
 * <say tone> tag format and existing TTS provider settings.
 */

import { eventSource, event_types } from '../../../../../script.js';
import { getContext } from '../../../../extensions.js';
import { getStringHash } from '../../../../utils.js';

// ═══════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════

const LOG = '[EW-Inline]';
const SAY_TAG_REGEX = /<say(?:\s+tone="([^"]*?)")?\s*>([\s\S]*?)<\/say>/gi;

const IDB_NAME = 'ew_inline_tts_cache';
const IDB_STORE = 'audio';
const MAX_CONCURRENT = 2;

// ═══════════════════════════════════════════════════════════════
// Module State
// ═══════════════════════════════════════════════════════════════

/** @type {() => object|null} Getter for the TTS provider settings */
let _getProviderSettings = null;

/** @type {Map<string, { blob: Blob, url: string }>} hash → audio data */
const audioCache = new Map();

/** @type {Map<string, Promise>} hash → in-flight generation promise */
const pendingGenerations = new Map();

let currentGenerations = 0;
let lineCounter = 0;

/** @type {Array<{name: string, voice_id: string}>} Cached speaker list */
let _cachedVoices = [];

/** @type {HTMLAudioElement|null} Currently playing audio */
let currentAudio = null;
/** @type {string|null} ID of the currently playing button */
let currentPlayingBtnId = null;

// ═══════════════════════════════════════════════════════════════
// IndexedDB Persistent Cache
// ═══════════════════════════════════════════════════════════════

let _idb = null;

function openIDB() {
    if (_idb) return Promise.resolve(_idb);
    return new Promise((resolve, reject) => {
        const req = indexedDB.open(IDB_NAME, 1);
        req.onupgradeneeded = (e) => {
            e.target.result.createObjectStore(IDB_STORE);
        };
        req.onsuccess = (e) => { _idb = e.target.result; resolve(_idb); };
        req.onerror = (e) => reject(e.target.error);
    });
}

async function idbGet(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readonly');
            const req = tx.objectStore(IDB_STORE).get(key);
            req.onsuccess = () => resolve(req.result ?? null);
            req.onerror = () => resolve(null);
        });
    } catch { return null; }
}

async function idbSet(key, blob) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).put(blob, key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { /* silent */ }
}

async function idbDelete(key) {
    try {
        const db = await openIDB();
        return new Promise((resolve) => {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            tx.objectStore(IDB_STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
        });
    } catch { /* silent */ }
}

async function warmCacheFromIDB(keys) {
    for (const key of keys) {
        if (audioCache.has(key)) continue;
        const blob = await idbGet(key);
        if (blob) {
            const url = URL.createObjectURL(blob);
            audioCache.set(key, { blob, url });
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Cache Key
// ═══════════════════════════════════════════════════════════════

function hashKey(text, voiceId, emotion) {
    return String(getStringHash(`${text}|||${voiceId}|||${emotion}`));
}

// ═══════════════════════════════════════════════════════════════
// CORS-safe URL resolver (same as tts-provider.js)
// ═══════════════════════════════════════════════════════════════

function resolveUrl(url) {
    if (window.isSecureContext && url.startsWith('http://')) {
        return `/proxy/${url}`;
    }
    return url;
}

// ═══════════════════════════════════════════════════════════════
// Audio Generation
// ═══════════════════════════════════════════════════════════════

/**
 * Generate audio for a single text segment.
 * Uses the same API endpoint and parameters as EntityWhisperProvider.
 */
async function generateAudio(text, voiceId, emotion) {
    const s = _getProviderSettings?.();
    if (!s) throw new Error('Provider settings not available');

    const targetVoice = emotion && emotion !== 'default'
        ? `${voiceId}/${emotion}`
        : voiceId;

    const params = {
        text,
        target_voice: targetVoice,
        use_st_adapter: true,
        text_lang: s.text_lang || 'zh',
        text_split_method: s.text_split_method || 'cut5',
        batch_size: 1,
        media_type: 'wav',
        streaming_mode: false,
        speed_factor: s.speed ?? 1.0,
        top_k: s.top_k ?? 15,
        top_p: s.top_p ?? 1.0,
        temperature: s.temperature ?? 1.0,
        repetition_penalty: s.repetition_penalty ?? 1.35,
    };

    const response = await fetch(resolveUrl(`${s.provider_endpoint}/`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
    });

    if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }

    const arrayBuf = await response.arrayBuffer();
    const blob = new Blob([arrayBuf], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    // Dispatch event for Singularity or other plugins to capture
    try {
        document.dispatchEvent(new CustomEvent('entity-whisper-audio', {
            detail: { blob, text },
        }));
    } catch (e) {
        console.warn(`${LOG} Failed to dispatch audio event:`, e);
    }

    return { blob, url };
}

/**
 * Generate with cache + concurrency control.
 */
async function generateWithCache(text, voiceId, emotion) {
    const key = hashKey(text, voiceId, emotion);

    // 1. Memory cache
    if (audioCache.has(key)) {
        return { ...audioCache.get(key), key };
    }

    // 2. IndexedDB cache
    const persisted = await idbGet(key);
    if (persisted) {
        const url = URL.createObjectURL(persisted);
        audioCache.set(key, { blob: persisted, url });
        return { blob: persisted, url, key };
    }

    // 3. Already in-flight
    if (pendingGenerations.has(key)) {
        await pendingGenerations.get(key);
        if (audioCache.has(key)) {
            return { ...audioCache.get(key), key };
        }
    }

    // 4. Wait for concurrency slot
    while (currentGenerations >= MAX_CONCURRENT) {
        await new Promise(r => setTimeout(r, 100));
    }

    currentGenerations++;

    const promise = generateAudio(text, voiceId, emotion)
        .then(async (result) => {
            audioCache.set(key, result);
            if (result.blob) await idbSet(key, result.blob);
            return result;
        })
        .finally(() => {
            currentGenerations--;
            pendingGenerations.delete(key);
        });

    pendingGenerations.set(key, promise);

    const result = await promise;
    return { ...result, key };
}

// ═══════════════════════════════════════════════════════════════
// Playback
// ═══════════════════════════════════════════════════════════════

function resetPlayback() {
    if (currentAudio) {
        currentAudio.pause();
        currentAudio.currentTime = 0;
        currentAudio = null;
    }
    if (currentPlayingBtnId) {
        const btn = document.getElementById(currentPlayingBtnId);
        const lineDiv = btn?.closest('.ew-audio-line');
        if (btn) {
            btn.classList.remove('ew--playing');
            btn.classList.add('ew--ready');
            btn.innerHTML = '<i class="ph-bold ph-play"></i>';
        }
        if (lineDiv) {
            lineDiv.style.setProperty('--ew-progress', '0%');
        }
        currentPlayingBtnId = null;
    }
}

function stopCurrentPlayback() {
    if (currentAudio) {
        currentAudio.pause();
    }
    if (currentPlayingBtnId) {
        const btn = document.getElementById(currentPlayingBtnId);
        if (btn) {
            btn.classList.remove('ew--playing');
            btn.classList.add('ew--ready');
            btn.innerHTML = '<i class="ph-bold ph-play"></i>';
        }
    }
}

function playAudioBlob(blobUrl, playBtnId) {
    const btn = document.getElementById(playBtnId);
    const lineDiv = btn?.closest('.ew-audio-line');

    // If same audio and paused → resume
    if (currentPlayingBtnId === playBtnId && currentAudio && currentAudio.paused) {
        currentAudio.play();
        if (btn) {
            btn.classList.remove('ew--ready');
            btn.classList.add('ew--playing');
            btn.innerHTML = '<i class="ph-bold ph-pause"></i>';
        }
        return;
    }

    // Otherwise start new playback
    resetPlayback();

    const audio = new Audio(blobUrl);
    currentAudio = audio;
    currentPlayingBtnId = playBtnId;

    if (btn) {
        btn.classList.remove('ew--ready');
        btn.classList.add('ew--playing');
        btn.innerHTML = '<i class="ph-bold ph-pause"></i>';
    }

    // Duration display
    audio.addEventListener('loadedmetadata', () => {
        const durationEl = lineDiv?.querySelector('.ew-audio-line__duration');
        if (durationEl) {
            const mins = Math.floor(audio.duration / 60);
            const secs = Math.floor(audio.duration % 60);
            durationEl.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
        }
    });

    // Progress bar
    audio.addEventListener('timeupdate', () => {
        if (lineDiv && audio.duration) {
            const progress = (audio.currentTime / audio.duration) * 100;
            lineDiv.style.setProperty('--ew-progress', `${progress}%`);
        }
    });

    audio.onended = () => {
        if (btn) {
            btn.classList.remove('ew--playing');
            btn.classList.add('ew--ready');
            btn.innerHTML = '<i class="ph-bold ph-play"></i>';
        }
        if (lineDiv) {
            lineDiv.style.setProperty('--ew-progress', '0%');
        }
        currentAudio = null;
        currentPlayingBtnId = null;

        // Auto-advance: play next line in the same message if mode is 'all'
        const settings = _getProviderSettings?.();
        if (settings?.inline_playback_mode === 'all' && btn) {
            const mesBlock = btn.closest('div.mes');
            if (mesBlock) {
                const allPlayBtns = Array.from(
                    mesBlock.querySelectorAll('.ew-audio-line__btn:not(.ew-audio-line__btn--regen)'),
                );
                const idx = allPlayBtns.indexOf(btn);
                const nextBtn = allPlayBtns[idx + 1];
                if (nextBtn && nextBtn.classList.contains('ew--ready') && nextBtn.dataset.cacheKey) {
                    const nextKey = nextBtn.dataset.cacheKey;
                    if (audioCache.has(nextKey)) {
                        playAudioBlob(audioCache.get(nextKey).url, nextBtn.id);
                    }
                }
            }
        }
    };

    audio.onerror = () => {
        if (btn) {
            btn.classList.remove('ew--playing');
            btn.classList.add('ew--error');
            btn.innerHTML = '<i class="ph-bold ph-warning-circle"></i>';
        }
        currentAudio = null;
        currentPlayingBtnId = null;
    };

    audio.play().catch(err => {
        console.error(`${LOG} Playback error:`, err);
    });
}

// ═══════════════════════════════════════════════════════════════
// DOM Rendering
// ═══════════════════════════════════════════════════════════════

/**
 * Fetch and cache the speakers list from the GPT-SoVITS backend.
 * Only fetches once; subsequent calls return the cached list.
 */
async function fetchVoicesOnce() {
    if (_cachedVoices.length > 0) return _cachedVoices;
    const s = _getProviderSettings?.();
    if (!s?.provider_endpoint) return [];
    try {
        const url = resolveUrl(`${s.provider_endpoint}/speakers`);
        const resp = await fetch(url);
        if (resp.ok) {
            _cachedVoices = await resp.json();
        }
    } catch (e) {
        console.warn(`${LOG} Failed to fetch speakers:`, e);
    }
    return _cachedVoices;
}

/**
 * Resolve the voiceId to use. Fetches from the API on first call,
 * then uses cached result. Returns the first available voice.
 */
async function resolveVoiceId() {
    const voices = await fetchVoicesOnce();
    if (voices.length > 0) {
        return voices[0].voice_id ?? voices[0].name ?? '';
    }
    return '';
}

/**
 * Process a rendered message element: parse <say> tags, inject audio panels.
 * @param {boolean} isHistoryLoad If true, do not auto-generate uncached lines —
 *   render an idle button instead and let the user opt in by clicking play.
 */
async function processMessageElement(mesElement, chatMsg, isHistoryLoad = false) {
    const mesTextEl = mesElement.querySelector('.mes_text');
    if (!mesTextEl) return;

    const rawText = chatMsg ? chatMsg.mes : mesElement.getAttribute('mes');
    if (!rawText || !/<say[\s>]/i.test(rawText)) return;

    const s = _getProviderSettings?.();
    if (!s) return;

    const voiceId = await resolveVoiceId();
    const generations = [];

    SAY_TAG_REGEX.lastIndex = 0;
    let match;

    while ((match = SAY_TAG_REGEX.exec(rawText)) !== null) {
        const toneRaw = match[1] ?? '';
        const dialogue = match[2].trim();
        if (!dialogue) continue;

        // Take first comma-separated tone
        const emotion = toneRaw.split(',').map(t => t.trim()).filter(Boolean)[0] || s.fallback_emotion || 'default';

        const lineId = `ew-line-${++lineCounter}`;
        const playBtnId = `${lineId}-play`;
        const regenBtnId = `${lineId}-regen`;
        const key = hashKey(dialogue, voiceId, emotion);

        generations.push({
            lineId, playBtnId, regenBtnId,
            text: dialogue, voiceId, emotion, key,
            isCached: audioCache.has(key),
        });
    }

    if (generations.length === 0) return;

    // Pre-warm from IndexedDB
    await warmCacheFromIDB(generations.map(g => g.key));

    // Update isCached after warm
    for (const gen of generations) {
        gen.isCached = audioCache.has(gen.key);
    }

    // Clean up previously injected inline TTS decorations
    mesTextEl.querySelectorAll('.ew-audio-line').forEach(el => {
        el.classList.remove('ew-audio-line');
        el.style.removeProperty('--ew-progress');
        el.querySelectorAll('.ew-audio-line__progress, .ew-audio-line__controls').forEach(c => c.remove());
    });

    // Find all text paragraphs for smart placement
    const paragraphs = Array.from(mesTextEl.querySelectorAll('p, div, blockquote, span'));

    /**
     * Normalize text for fuzzy matching between raw source and rendered DOM.
     * Markdown renderers may convert:
     *   ... → …   " " → " "   -- → —   ' → '   etc.
     */
    const normalizeForMatch = (s) => s
        .replace(/\u2026/g, '...')           // … → ...
        .replace(/[\u201C\u201D]/g, '"')     // " " → "
        .replace(/[\u2018\u2019]/g, "'")     // ' ' → '
        .replace(/\u2014/g, '--')            // — → --
        .replace(/\u2013/g, '-')             // – → -
        .replace(/\s+/g, ' ')               // collapse whitespace
        .trim();

    for (const gen of generations) {
        // Three initial states:
        //   ew--ready  : audio in cache, click = play
        //   ew--idle   : not cached + history load, click = generate then play
        //   ew--loading: not cached + fresh render, auto-generating now
        let stateClass;
        let playIcon;
        let btnTitle;
        if (gen.isCached) {
            stateClass = 'ew--ready';
            playIcon = '<i class="ph-bold ph-play"></i>';
            btnTitle = '播放';
        } else if (isHistoryLoad) {
            stateClass = 'ew--idle';
            playIcon = '<i class="ph-bold ph-play"></i>';
            btnTitle = '点击生成并播放';
        } else {
            stateClass = 'ew--loading';
            playIcon = '<i class="ph-bold ph-spinner ew-spin"></i>';
            btnTitle = '生成中...';
        }

        // Find the paragraph containing this dialogue text
        let targetP = null;
        const normalizedText = normalizeForMatch(gen.text);
        const searchSnippet = normalizedText.substring(0, Math.min(20, normalizedText.length));
        for (let i = paragraphs.length - 1; i >= 0; i--) {
            const pText = normalizeForMatch(paragraphs[i].textContent);
            if (pText.includes(searchSnippet) || pText.includes(normalizedText)) {
                targetP = paragraphs[i];
                break;
            }
        }

        if (!targetP) {
            console.warn(`${LOG} Could not find DOM paragraph for: "${gen.text.substring(0, 40)}..."`);
            continue;
        }

        // Apply ew-audio-line styling directly to the paragraph
        targetP.classList.add('ew-audio-line');
        targetP.style.setProperty('--ew-progress', '0%');

        // Inject progress overlay
        const progressEl = document.createElement('div');
        progressEl.className = 'ew-audio-line__progress';
        targetP.prepend(progressEl);

        // Append inline controls at the end of text
        const controls = document.createElement('span');
        controls.className = 'ew-audio-line__controls';
        controls.innerHTML = `
            <span class="ew-audio-line__duration">0:00</span>
            <button id="${gen.playBtnId}" class="ew-audio-line__btn ${stateClass}"
                    title="${btnTitle}"
                    ${gen.isCached ? `data-cache-key="${gen.key}"` : ''}>
                ${playIcon}
            </button>
            <button id="${gen.regenBtnId}" class="ew-audio-line__btn ew-audio-line__btn--regen" title="重新生成">
                <i class="ph-bold ph-arrows-clockwise"></i>
            </button>
        `;
        targetP.appendChild(controls);

        // Bind events
        bindLineEvents(gen, chatMsg);

        // Trigger generation only for fresh renders. History loads stay idle
        // until the user clicks play, so we don't re-run TTS on every refresh.
        if (!gen.isCached && !isHistoryLoad) {
            triggerGeneration(gen, chatMsg);
        } else if (gen.isCached) {
            // Load duration from cached audio
            const data = audioCache.get(gen.key);
            if (data?.url) {
                const tempAudio = new Audio(data.url);
                tempAudio.addEventListener('loadedmetadata', () => {
                    const dEl = targetP.querySelector('.ew-audio-line__duration');
                    if (dEl) {
                        const m = Math.floor(tempAudio.duration / 60);
                        const s = Math.floor(tempAudio.duration % 60);
                        dEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
                    }
                });
            }
        }
    }
}

function bindLineEvents(gen, chatMsg) {
    const playBtn = document.getElementById(gen.playBtnId);
    const regenBtn = document.getElementById(gen.regenBtnId);

    if (playBtn) {
        playBtn.addEventListener('click', async () => {
            if (playBtn.classList.contains('ew--loading')) return;
            if (playBtn.classList.contains('ew--error')) return;

            if (playBtn.classList.contains('ew--playing')) {
                stopCurrentPlayback();
                return;
            }

            // Idle (history-loaded, never generated): generate now, then play.
            if (playBtn.classList.contains('ew--idle')) {
                playBtn.classList.remove('ew--idle');
                playBtn.classList.add('ew--loading');
                playBtn.innerHTML = '<i class="ph-bold ph-spinner ew-spin"></i>';
                playBtn.title = '生成中...';
                await triggerGeneration(gen, chatMsg);
                if (audioCache.has(gen.key)) {
                    playAudioBlob(audioCache.get(gen.key).url, gen.playBtnId);
                }
                return;
            }

            // Play
            const key = playBtn.dataset.cacheKey;
            if (key && audioCache.has(key)) {
                playAudioBlob(audioCache.get(key).url, gen.playBtnId);
            }
        });
    }

    if (regenBtn) {
        regenBtn.addEventListener('click', async () => {
            if (regenBtn.classList.contains('ew-spin')) return;
            if (!gen.voiceId) return;

            // Remove from cache
            const oldKey = gen.key;
            if (oldKey) {
                if (audioCache.has(oldKey)) {
                    const data = audioCache.get(oldKey);
                    if (data.url?.startsWith('blob:')) URL.revokeObjectURL(data.url);
                    audioCache.delete(oldKey);
                }
                await idbDelete(oldKey);
            }

            // Stop if currently playing this line
            if (currentPlayingBtnId === gen.playBtnId) {
                resetPlayback();
            }

            // Reset play button to loading
            if (playBtn) {
                playBtn.classList.remove('ew--ready', 'ew--error', 'ew--playing');
                playBtn.classList.add('ew--loading');
                playBtn.innerHTML = '<i class="ph-bold ph-spinner ew-spin"></i>';
                playBtn.title = '生成中...';
            }

            // Spin regen icon
            regenBtn.classList.add('ew-spin');

            triggerGeneration(gen, chatMsg).finally(() => {
                regenBtn.classList.remove('ew-spin');
            });
        });
    }
}

async function triggerGeneration(gen, chatMsg) {
    try {
        const result = await generateWithCache(gen.text, gen.voiceId, gen.emotion);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.dataset.cacheKey = result.key;
            btn.classList.remove('ew--loading');
            btn.classList.add('ew--ready');
            btn.innerHTML = '<i class="ph-bold ph-play"></i>';
            btn.title = '播放';
        }

        // Update key on gen object for future regen
        gen.key = result.key;

        // Show duration
        const lineDiv = btn?.closest('.ew-audio-line');
        if (lineDiv && result.url) {
            const tempAudio = new Audio(result.url);
            tempAudio.addEventListener('loadedmetadata', () => {
                const dEl = lineDiv.querySelector('.ew-audio-line__duration');
                if (dEl) {
                    const m = Math.floor(tempAudio.duration / 60);
                    const s = Math.floor(tempAudio.duration % 60);
                    dEl.textContent = `${m}:${s.toString().padStart(2, '0')}`;
                }
            });
        }
    } catch (err) {
        console.error(`${LOG} Generation failed for "${gen.text.substring(0, 30)}...":`, err);
        const btn = document.getElementById(gen.playBtnId);
        if (btn) {
            btn.classList.remove('ew--loading');
            btn.classList.add('ew--error');
            btn.innerHTML = '<i class="ph-bold ph-warning-circle"></i>';
            btn.title = `生成失败: ${err.message}`;
        }
    }
}

// ═══════════════════════════════════════════════════════════════
// Event Handlers
// ═══════════════════════════════════════════════════════════════

function onMessageRendered(messageId) {
    const context = getContext();
    if (!context?.chat) return;

    let chatMsg = context.chat[messageId];
    if (!chatMsg) {
        const numId = parseInt(messageId, 10);
        if (!isNaN(numId)) chatMsg = context.chat[numId];
    }

    const mesElement = document.querySelector(`div.mes[mesid="${messageId}"]`);
    if (!mesElement) return;

    processMessageElement(mesElement, chatMsg);
}

// ═══════════════════════════════════════════════════════════════
// Initialization
// ═══════════════════════════════════════════════════════════════

/**
 * Initialize the inline TTS system.
 * @param {() => object} getProviderSettings Getter that returns the current
 *   EntityWhisperProvider settings (endpoint, text_lang, etc.)
 */
export function initInlineTts(getProviderSettings) {
    _getProviderSettings = getProviderSettings;

    // Dynamically load inline TTS stylesheet (ST manifest only supports single CSS)
    const scriptDir = import.meta.url.substring(0, import.meta.url.lastIndexOf('/'));
    const cssUrl = `${scriptDir}/../ui/inline-tts.css`;
    if (!document.querySelector(`link[href="${cssUrl}"]`)) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = cssUrl;
        document.head.appendChild(link);
    }

    // Load Phosphor Icons (Bold) — ST ships Font Awesome only
    const phCdn = 'https://unpkg.com/@phosphor-icons/web@2/src/bold/style.css';
    if (!document.querySelector(`link[href="${phCdn}"]`)) {
        const phLink = document.createElement('link');
        phLink.rel = 'stylesheet';
        phLink.href = phCdn;
        document.head.appendChild(phLink);
    }

    // Listen for message render events
    eventSource.on(event_types.CHARACTER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.USER_MESSAGE_RENDERED, onMessageRendered);
    eventSource.on(event_types.MESSAGE_UPDATED, onMessageRendered);

    // Process existing messages when chat changes (page refresh, chat switch).
    // These are historical lines — render idle buttons, do NOT auto-regenerate.
    eventSource.on(event_types.CHAT_CHANGED, () => {
        setTimeout(() => {
            const context = getContext();
            document.querySelectorAll('div.mes').forEach(mes => {
                const mesId = mes.getAttribute('mesid');
                let chatMsg = null;
                if (context?.chat) {
                    chatMsg = context.chat[mesId] || context.chat[parseInt(mesId, 10)];
                }
                processMessageElement(mes, chatMsg, true);
            });
        }, 500);
    });

    console.info(`${LOG} Inline TTS initialized.`);
}
