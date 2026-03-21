/**
 * Entity Whisper TTS — SillyTavern Third-Party Extension
 *
 * Registers a custom TTS provider that connects to a GPT-SoVITS backend
 * with emotion-aware reference audio selection.
 *
 * Also initializes the inline TTS playback system that parses <say tone>
 * tags and renders per-sentence audio controls in chat messages.
 */

import { extension_settings } from '../../../extensions.js';
import { registerTtsProvider } from '../../tts/index.js';
import { EntityWhisperProvider } from './modules/tts-provider.js';
import { initInlineTts } from './modules/inline-tts.js';

// Register the provider — ST will add it to the TTS dropdown
registerTtsProvider('Entity Whisper', EntityWhisperProvider);

// Initialize inline TTS — provides a settings getter so the inline module
// can read the current provider endpoint/language/voice configuration.
initInlineTts(() => {
    return extension_settings?.tts?.['Entity Whisper'] ?? null;
});

console.info('[Entity Whisper] TTS provider registered, inline TTS active.');
