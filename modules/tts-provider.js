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
        fallback_emotion: 'default',
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
                <span class="ew-settings__subtitle">GPT-SoVITS TTS Provider</span>
            </div>

            <label for="ew_provider_endpoint">Provider Endpoint:</label>
            <input id="ew_provider_endpoint" type="text" class="text_pole"
                   maxlength="250" value="${currentSettings.provider_endpoint}"
                   placeholder="http://localhost:9881" />

            <label for="ew_text_lang">Text Language:</label>
            <select id="ew_text_lang" class="text_pole">
                <option value="zh" ${currentSettings.text_lang === 'zh' ? 'selected' : ''}>中文 (Chinese)</option>
                <option value="en" ${currentSettings.text_lang === 'en' ? 'selected' : ''}>English</option>
                <option value="ja" ${currentSettings.text_lang === 'ja' ? 'selected' : ''}>日本語 (Japanese)</option>
                <option value="ko" ${currentSettings.text_lang === 'ko' ? 'selected' : ''}>한국어 (Korean)</option>
            </select>

            <div class="ew-settings__divider"></div>

            <label for="ew_fallback_emotion">Fallback Emotion:</label>
            <div class="ew-settings__row">
                <select id="ew_fallback_emotion" class="text_pole">
                    <option value="default">default</option>
                </select>
                <div id="ew_refresh_emotions" class="menu_button menu_button_icon" title="Refresh emotions from backend">
                    <i class="ph-bold ph-arrows-clockwise"></i>
                </div>
            </div>
            <small class="ew-settings__hint">Used when no &lt;say tone&gt; tag is present in the AI output.</small>

            <label>Available Emotions:</label>
            <div id="ew_emotions_display" class="ew-emotions-grid">
                <span class="ew-emotion-chip ew-emotion-chip--empty">Click refresh to load</span>
            </div>
        </div>
        `;

        return html;
    }

    onSettingsChange() {
        this.settings.provider_endpoint = $('#ew_provider_endpoint').val();
        this.settings.text_lang = $('#ew_text_lang').val();
        this.settings.fallback_emotion = $('#ew_fallback_emotion').val();

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
            const response = await fetch(`${this.settings.provider_endpoint}/speakers`);

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}: ${await response.text()}`);
            }

            const data = await response.json();
            this.voices = data;
            return data;
        } catch (error) {
            console.warn('[Entity Whisper] Failed to fetch speakers:', error);
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
            const response = await fetch(
                `${this.settings.provider_endpoint}/character_emotions?character=${encodeURIComponent(character)}`,
            );
            if (!response.ok) {
                console.warn(`[Entity Whisper] Failed to fetch emotions: HTTP ${response.status}`);
                return [];
            }
            const emotions = await response.json();
            this._availableEmotions = emotions;
            return emotions;
        } catch (error) {
            console.warn('[Entity Whisper] Failed to fetch emotions:', error);
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
            $display.append('<span class="ew-emotion-chip ew-emotion-chip--empty">No emotions found</span>');
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
            text_split_method: 'cut5',
            batch_size: 1,
            media_type: 'wav',
            streaming_mode: false,
        };

        const response = await fetch(
            `${this.settings.provider_endpoint}/`,
            {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
            },
        );

        if (!response.ok) {
            toastr.error(response.statusText, 'TTS Generation Failed');
            throw new Error(`HTTP ${response.status}: ${await response.text()}`);
        }

        return response;
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
