/**
 * Entity Whisper TTS Provider
 *
 * Connects to a GPT-SoVITS backend (via the ST Compat layer injected by
 * gptsovits_panel.py). Supports emotion-aware TTS via <say tone> tags.
 *
 * API contract (matches _ST_COMPAT_TEMPLATE in gptsovits_panel.py):
 *   GET  /speakers              → [{name, voice_id}]
 *   GET  /character_emotions    → [string]  (emotions for a character)
 *   POST /                      → audio blob (wav)
 */

import { saveTtsProviderSettings } from '../../../tts/index.js';
import { getPreviewString } from '../../../tts/index.js';

export { EntityWhisperProvider };

class EntityWhisperProvider {
    //########//
    // Config //
    //########//

    settings;
    ready = false;
    voices = [];
    separator = '. ';
    audioElement = document.createElement('audio');

    /**
     * When the page runs in a Secure Context (HTTPS, e.g. Tailscale),
     * rewrite plain HTTP URLs to go through SillyTavern's built-in
     * CORS proxy at /proxy/<url> to avoid Mixed Content blocking.
     *
     * @param {string} url - The original HTTP URL
     * @returns {string} Possibly rewritten URL
     */
    _resolveUrl(url) {
        if (window.isSecureContext && url.startsWith('http://')) {
            return `/proxy/${url}`;
        }
        return url;
    }

    /** @type {string|null} Current emotion extracted by processText */
    _currentTone = null;

    /**
     * Parse <say tone="..."> tags from AI output.
     *
     * Input:  <say tone="whisper,confused">"为什么？"</say>
     * Output: "为什么？"
     * Side effect: this._currentTone = "whisper"
     *
     * Multiple tones: takes the first one (e.g. "whisper" from "whisper,confused")
     * No <say> tag: _currentTone = null → backend uses default emotion
     *
     * @param {string} text Raw text from ST
     * @returns {string} Clean text with tags stripped
     */
    processText(text) {
        // Reset tone for this generation
        this._currentTone = null;

        // Match <say tone="...">...</say>
        const sayRegex = /<say\s+tone="([^"]*?)"\s*>(.*?)<\/say>/gis;
        let match;
        let cleanParts = [];
        let lastIndex = 0;
        let firstTone = null;

        while ((match = sayRegex.exec(text)) !== null) {
            // Capture text before this <say> block
            if (match.index > lastIndex) {
                cleanParts.push(text.slice(lastIndex, match.index));
            }

            // Extract tone (first comma-separated value)
            if (!firstTone && match[1]) {
                const tones = match[1].split(',').map(t => t.trim()).filter(Boolean);
                if (tones.length > 0) {
                    firstTone = tones[0];
                }
            }

            // Capture inner text
            cleanParts.push(match[2]);
            lastIndex = match.index + match[0].length;
        }

        // If no <say> tags found, return text as-is
        if (cleanParts.length === 0) {
            return text;
        }

        // Capture remaining text after last </say>
        if (lastIndex < text.length) {
            cleanParts.push(text.slice(lastIndex));
        }

        this._currentTone = firstTone;
        const cleanText = cleanParts.join('').trim();
        console.info(`[Entity Whisper] processText: tone=${firstTone || 'none'}, text="${cleanText.substring(0, 40)}..."`);
        return cleanText;
    }

    langKey2LangCode = {
        'zh': 'zh-CN',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
    };

    /** @type {string[]} Cached emotion list for the current voice */
    _availableEmotions = [];

    defaultSettings = {
        provider_endpoint: 'http://localhost:9881',
        text_lang: 'zh',
        text_split_method: 'cut5',
        fallback_emotion: 'default',
        inline_playback_mode: 'single',
        speed: 1.0,
        top_k: 15,
        top_p: 1.0,
        temperature: 1.0,
        repetition_penalty: 1.35,
    };

    //################//
    //  Settings UI   //
    //################//

    get settingsHtml() {
        const currentSettings = this.settings || this.defaultSettings;

        let html = `
        <div class="ew-settings">
            <div class="ew-settings__header">
                <span class="ew-settings__title">Entity Whisper</span>
                <span class="ew-settings__subtitle">GPT-SoVITS 语音合成</span>
            </div>

            <label for="ew_provider_endpoint">服务地址：</label>
            <input id="ew_provider_endpoint" type="text" class="text_pole"
                   maxlength="250" value="${currentSettings.provider_endpoint}"
                   placeholder="http://localhost:9881" />

            <label for="ew_text_lang">文本语言：</label>
            <select id="ew_text_lang" class="text_pole">
                <option value="zh" ${currentSettings.text_lang === 'zh' ? 'selected' : ''}>中文</option>
                <option value="en" ${currentSettings.text_lang === 'en' ? 'selected' : ''}>英语</option>
                <option value="ja" ${currentSettings.text_lang === 'ja' ? 'selected' : ''}>日本語</option>
                <option value="ko" ${currentSettings.text_lang === 'ko' ? 'selected' : ''}>한국어</option>
            </select>

            <label for="ew_text_split_method">切句方式：</label>
            <select id="ew_text_split_method" class="text_pole">
                <option value="cut0" ${currentSettings.text_split_method === 'cut0' ? 'selected' : ''}>不切</option>
                <option value="cut1" ${currentSettings.text_split_method === 'cut1' ? 'selected' : ''}>凑四句一切</option>
                <option value="cut2" ${currentSettings.text_split_method === 'cut2' ? 'selected' : ''}>凑50字一切</option>
                <option value="cut3" ${currentSettings.text_split_method === 'cut3' ? 'selected' : ''}>按中文句号。切</option>
                <option value="cut4" ${currentSettings.text_split_method === 'cut4' ? 'selected' : ''}>按英文句号.切</option>
                <option value="cut5" ${currentSettings.text_split_method === 'cut5' ? 'selected' : ''}>按标点符号切</option>
            </select>

            <div class="ew-settings__divider"></div>

            <label>语速：<span id="ew_speed_value">${currentSettings.speed}</span></label>
            <input id="ew_speed" type="range" class="ew-range" min="0.25" max="2.0" step="0.05" value="${currentSettings.speed}" />

            <label>Top K: <span id="ew_top_k_value">${currentSettings.top_k}</span></label>
            <input id="ew_top_k" type="range" class="ew-range" min="1" max="50" step="1" value="${currentSettings.top_k}" />

            <label>Top P: <span id="ew_top_p_value">${currentSettings.top_p}</span></label>
            <input id="ew_top_p" type="range" class="ew-range" min="0.0" max="1.0" step="0.05" value="${currentSettings.top_p}" />

            <label>采样温度：<span id="ew_temperature_value">${currentSettings.temperature}</span></label>
            <input id="ew_temperature" type="range" class="ew-range" min="0.01" max="2.0" step="0.05" value="${currentSettings.temperature}" />

            <label>重复惩罚：<span id="ew_repetition_penalty_value">${currentSettings.repetition_penalty}</span></label>
            <input id="ew_repetition_penalty" type="range" class="ew-range" min="1.0" max="2.0" step="0.05" value="${currentSettings.repetition_penalty}" />

            <div class="ew-settings__divider"></div>

            <label for="ew_inline_playback_mode">逐句播放模式：</label>
            <select id="ew_inline_playback_mode" class="text_pole">
                <option value="single" ${currentSettings.inline_playback_mode === 'single' ? 'selected' : ''}>逐条播放</option>
                <option value="all" ${currentSettings.inline_playback_mode === 'all' ? 'selected' : ''}>连续播放本轮全部</option>
            </select>
            <small class="ew-settings__hint">「连续播放」会在点击任意播放按钮后自动按顺序播放同一条消息中的所有语音。</small>

            <div class="ew-settings__divider"></div>

            <label for="ew_fallback_emotion">备用情感：</label>
            <div class="ew-settings__row">
                <select id="ew_fallback_emotion" class="text_pole">
                    <option value="default">default</option>
                </select>
                <div id="ew_refresh_emotions" class="menu_button menu_button_icon" title="从后端刷新情感列表">
                    <i class="ph-bold ph-arrows-clockwise"></i>
                </div>
            </div>
            <small class="ew-settings__hint">当 AI 输出中没有 &lt;say tone&gt; 标签时，使用此情感作为默认值。</small>

            <label>可用情感列表：</label>
            <div id="ew_emotions_display" class="ew-emotions-grid">
                <span class="ew-emotion-chip ew-emotion-chip--empty">点击刷新加载</span>
            </div>
        </div>
        `;

        return html;
    }

    onSettingsChange() {
        this.settings.provider_endpoint = $('#ew_provider_endpoint').val();
        this.settings.text_lang = $('#ew_text_lang').val();
        this.settings.text_split_method = $('#ew_text_split_method').val();
        this.settings.fallback_emotion = $('#ew_fallback_emotion').val();
        this.settings.inline_playback_mode = $('#ew_inline_playback_mode').val();
        this.settings.speed = parseFloat($('#ew_speed').val());
        this.settings.top_k = parseInt($('#ew_top_k').val(), 10);
        this.settings.top_p = parseFloat($('#ew_top_p').val());
        this.settings.temperature = parseFloat($('#ew_temperature').val());
        this.settings.repetition_penalty = parseFloat($('#ew_repetition_penalty').val());

        // Live readout
        $('#ew_speed_value').text(Number(this.settings.speed).toFixed(2));
        $('#ew_top_k_value').text(String(this.settings.top_k));
        $('#ew_top_p_value').text(Number(this.settings.top_p).toFixed(2));
        $('#ew_temperature_value').text(Number(this.settings.temperature).toFixed(2));
        $('#ew_repetition_penalty_value').text(Number(this.settings.repetition_penalty).toFixed(2));

        saveTtsProviderSettings();
    }

    async loadSettings(settings) {
        if (Object.keys(settings).length === 0) {
            console.info('[Entity Whisper] Using default settings');
        }

        // Merge saved settings over defaults
        this.settings = { ...this.defaultSettings };
        for (const key in settings) {
            if (key in this.settings) {
                this.settings[key] = settings[key];
            }
        }

        // Populate UI
        $('#ew_provider_endpoint')
            .val(this.settings.provider_endpoint)
            .on('input', () => this.onSettingsChange());

        $('#ew_text_lang')
            .val(this.settings.text_lang)
            .on('change', () => this.onSettingsChange());

        $('#ew_text_split_method')
            .val(this.settings.text_split_method)
            .on('change', () => this.onSettingsChange());

        // Inference parameter sliders
        for (const id of ['ew_speed', 'ew_top_k', 'ew_top_p', 'ew_temperature', 'ew_repetition_penalty']) {
            const key = id.replace('ew_', '');
            $(`#${id}`).val(this.settings[key]).on('input', () => this.onSettingsChange());
        }

        // Sync readout spans with saved values (settingsHtml only bakes in defaults)
        $('#ew_speed_value').text(Number(this.settings.speed).toFixed(2));
        $('#ew_top_k_value').text(String(this.settings.top_k));
        $('#ew_top_p_value').text(Number(this.settings.top_p).toFixed(2));
        $('#ew_temperature_value').text(Number(this.settings.temperature).toFixed(2));
        $('#ew_repetition_penalty_value').text(Number(this.settings.repetition_penalty).toFixed(2));

        $('#ew_inline_playback_mode')
            .val(this.settings.inline_playback_mode)
            .on('change', () => this.onSettingsChange());

        $('#ew_fallback_emotion')
            .val(this.settings.fallback_emotion)
            .on('change', () => this.onSettingsChange());

        // Refresh emotions button
        $('#ew_refresh_emotions').on('click', () => this._refreshEmotionsUI());

        await this.checkReady();

        // Auto-load emotions after voices are ready
        this._refreshEmotionsUI();

        console.info('[Entity Whisper] Settings loaded');
    }

    async checkReady() {
        await Promise.allSettled([this.fetchTtsVoiceObjects()]);
    }

    async onRefreshClick() {
        return await this.checkReady();
    }

    //#################//
    //  TTS Interfaces //
    //#################//

    async getVoice(voiceName) {
        if (this.voices.length === 0) {
            this.voices = await this.fetchTtsVoiceObjects();
        }

        const match = this.voices.find(v => v.name === voiceName);
        if (!match) {
            throw `[Entity Whisper] Voice "${voiceName}" not found`;
        }
        return match;
    }

    async generateTts(text, voiceId) {
        return await this.fetchTtsGeneration(text, voiceId);
    }

    //###########//
    // API CALLS //
    //###########//

    /**
     * Fetch available voices from the GSVI backend.
     * GET /speakers → [{name, voice_id}]
     */
    async fetchTtsVoiceObjects() {
        try {
            const url = this._resolveUrl(`${this.settings.provider_endpoint}/speakers`);
            console.info(`[Entity Whisper] Fetching speakers from: ${url}`);
            const response = await fetch(url);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            this.voices = data;
            return data;
        } catch (error) {
            console.warn('[Entity Whisper] Failed to fetch speakers:', error?.message || error);
            return [];
        }
    }

    /**
     * Generate TTS audio via the GSVI ST compat endpoint.
     * POST / → audio blob
     */
    /**
     * Fetch available emotions for a character from the backend.
     * GET /character_emotions?character=xxx → [string]
     */
    async fetchEmotions(character) {
        if (!character) return [];
        try {
            // Try path-based endpoint first so it works through ST's /proxy/
            // relay (the proxy strips query params, so we use a path segment).
            const url = this._resolveUrl(
                `${this.settings.provider_endpoint}/character_emotions/${encodeURIComponent(character)}`,
            );
            console.info(`[Entity Whisper] Fetching emotions from: ${url}`);
            const response = await fetch(url);
            if (!response.ok) {
                // Path-based endpoint might not be supported; try query-param
                // version directly (won't work on HTTPS but acceptable degradation).
                console.info('[Entity Whisper] Path-based emotions endpoint not available, trying query-param fallback...');
                const fallbackUrl = `${this.settings.provider_endpoint}/character_emotions?character=${encodeURIComponent(character)}`;
                const fallbackResponse = await fetch(fallbackUrl);
                if (!fallbackResponse.ok) {
                    console.warn(`[Entity Whisper] Failed to fetch emotions: HTTP ${fallbackResponse.status}`);
                    return [];
                }
                const emotions = await fallbackResponse.json();
                this._availableEmotions = emotions;
                return emotions;
            }
            const emotions = await response.json();
            this._availableEmotions = emotions;
            return emotions;
        } catch (error) {
            console.warn('[Entity Whisper] Failed to fetch emotions:', error?.message || error);
            return [];
        }
    }

    /**
     * Refresh the emotions UI: fetch from backend → update dropdown + pills.
     */
    async _refreshEmotionsUI() {
        // Use the first voice as the character to query emotions
        const character = this.voices.length > 0 ? this.voices[0].voice_id : '';
        if (!character) {
            console.info('[Entity Whisper] No voices loaded, skipping emotions refresh');
            return;
        }

        const emotions = await this.fetchEmotions(character);
        const $dropdown = $('#ew_fallback_emotion');
        const $display = $('#ew_emotions_display');

        // Update fallback dropdown
        const savedFallback = this.settings.fallback_emotion || 'default';
        $dropdown.empty();
        if (emotions.length === 0) {
            $dropdown.append('<option value="default">default</option>');
        } else {
            for (const emo of emotions) {
                const selected = emo === savedFallback ? ' selected' : '';
                $dropdown.append(`<option value="${emo}"${selected}>${emo}</option>`);
            }
            // Ensure saved value is preserved if it exists
            if (!emotions.includes(savedFallback)) {
                $dropdown.val(emotions[0]);
                this.settings.fallback_emotion = emotions[0];
                saveTtsProviderSettings();
            }
        }

        // Update emotion pills display
        $display.empty();
        if (emotions.length === 0) {
            $display.append('<span class="ew-emotion-chip ew-emotion-chip--empty">未找到情感</span>');
        } else {
            for (const emo of emotions) {
                const isDefault = emo === 'default' ? ' ew-emotion-chip--default' : '';
                $display.append(`<span class="ew-emotion-chip${isDefault}">${emo}</span>`);
            }
        }

        console.info(`[Entity Whisper] Emotions loaded for "${character}": [${emotions.join(', ')}]`);
    }

    async fetchTtsGeneration(inputText, voiceId) {
        // Combine voiceId (character) + emotion
        // Priority: _currentTone (from <say tone>) > fallback_emotion setting > bare voiceId
        const emotion = this._currentTone || this.settings.fallback_emotion || 'default';
        const targetVoice = emotion && emotion !== 'default'
            ? `${voiceId}/${emotion}`
            : voiceId;

        console.info(`[Entity Whisper] Generating TTS: target=${targetVoice}, tone=${this._currentTone || 'none'}, fallback=${this.settings.fallback_emotion}, text="${inputText.substring(0, 30)}..."`);

        const params = {
            text: inputText,
            target_voice: targetVoice,
            use_st_adapter: true,
            text_lang: this.settings.text_lang,
            text_split_method: this.settings.text_split_method || 'cut5',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
            speed_factor: this.settings.speed ?? 1.0,
            top_k: this.settings.top_k ?? 15,
            top_p: this.settings.top_p ?? 1.0,
            temperature: this.settings.temperature ?? 1.0,
            repetition_penalty: this.settings.repetition_penalty ?? 1.35,
        };

        const response = await fetch(
            this._resolveUrl(`${this.settings.provider_endpoint}/`),
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            },
        );

        if (!response.ok) {
            toastr.error(response.statusText, '语音生成失败');
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        // ST's /proxy/ CORS relay does not forward Content-Type headers.
        // On mobile (HTTPS / secure context) requests go through /proxy/,
        // causing the audio blob to have an empty MIME type. ST's addAudioJob
        // then rejects it ("Expecting audio/*, got"). Fix: reconstruct the
        // Response with an explicit audio content type so the blob check passes.
        const mediaType = params.media_type || 'wav';
        const audioBuffer = await response.arrayBuffer();

        // Broadcast audio for other plugins (e.g. Singularity) to capture.
        // We dispatch on `document` so any listener can pick it up.
        try {
            const audioBlob = new Blob([audioBuffer], { type: `audio/${mediaType}` });
            document.dispatchEvent(new CustomEvent('entity-whisper-audio', {
                detail: { blob: audioBlob, text: inputText },
            }));
        } catch (e) {
            console.warn('[Entity Whisper] Failed to dispatch audio event:', e);
        }

        return new Response(audioBuffer, {
            status: 200,
            headers: { 'Content-Type': `audio/${mediaType}` },
        });
    }

    /**
     * Preview a TTS voice with a short sample.
     */
    async previewTtsVoice(voiceId) {
        const langCode = this.langKey2LangCode[this.settings.text_lang] || 'zh-CN';
        const previewText = getPreviewString(langCode);
        const response = await this.fetchTtsGeneration(previewText, voiceId);

        const audio = await response.blob();
        const url = URL.createObjectURL(audio);
        this.audioElement.src = url;
        this.audioElement.play();
        this.audioElement.onended = () => URL.revokeObjectURL(url);
    }

    // Interface not used
    async fetchTtsFromHistory(history_item_id) {
        return Promise.resolve(history_item_id);
    }
}
