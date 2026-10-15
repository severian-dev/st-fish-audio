// Fish Audio TTS, SillyTavern extension entry.
// Adds a Fish Audio provider to SillyTavern's built-in TTS extension. The
// provider needs the st-fish-audio-plugin server plugin for synthesis.

import { registerTtsProvider } from '../../tts/index.js';
import { PROVIDER_NAME } from './lib.js';
import { FishAudioTtsProvider } from './provider.js';

try {
    registerTtsProvider(PROVIDER_NAME, FishAudioTtsProvider);
    // SillyTavern builds the provider dropdown before third-party extensions
    // load, so a saved selection of this provider shows nothing selected.
    const { extensionSettings } = SillyTavern.getContext();
    if (extensionSettings.tts?.currentProvider === PROVIDER_NAME) {
        $('#tts_provider').val(PROVIDER_NAME);
    }
} catch (error) {
    console.error('[Fish Audio TTS] could not register the TTS provider:', error);
}
