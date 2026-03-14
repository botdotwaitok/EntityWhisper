/**
 * Entity Whisper TTS Provider
 *
 * Connects to a GPT-SoVITS backend (via the ST Compat layer injected by
 * gptsovits_panel.py). Phase 1: basic skeleton — endpoint + language.
 *
 * API contract (matches _ST_COMPAT_TEMPLATE in gptsovits_panel.py):
 *   GET  /speakers       → [{name, voice_id}]
 *   POST /               → audio blob (wav)
 */

import { saveTtsProviderSettings } from '../../tts/index.js';
import { getPreviewString } from '../../tts/index.js';

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
     * Phase 1: pass text through unchanged.
     * Phase 2 will add <say tone="..."> parsing here.
     * @param {string} text
     * @returns {string}
     */
    processText(text) {
        return text;
    }

    langKey2LangCode = {
        'zh': 'zh-CN',
        'en': 'en-US',
        'ja': 'ja-JP',
        'ko': 'ko-KR',
    };

    defaultSettings = {
        provider_endpoint: 'http://localhost:9881',
        text_lang: 'zh',
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
        </div>
        `;

        return html;
    }

    onSettingsChange() {
        this.settings.provider_endpoint = $('#ew_provider_endpoint').val();
        this.settings.text_lang = $('#ew_text_lang').val();

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

        await this.checkReady();
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
    async fetchTtsGeneration(inputText, voiceId) {
        console.info(`[Entity Whisper] Generating TTS: voice=${voiceId}, text="${inputText.substring(0, 30)}..."`);

        const params = {
            text: inputText,
            target_voice: voiceId,
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
