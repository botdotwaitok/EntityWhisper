/**
 * Entity Whisper TTS — SillyTavern Third-Party Extension
 *
 * Registers a custom TTS provider that connects to a GPT-SoVITS backend
 * with emotion-aware reference audio selection.
 */

import { registerTtsProvider } from '../../tts/index.js';
import { EntityWhisperProvider } from './modules/tts-provider.js';

// Register the provider — ST will add it to the TTS dropdown
registerTtsProvider('Entity Whisper', EntityWhisperProvider);

console.info('[Entity Whisper] TTS provider registered.');
