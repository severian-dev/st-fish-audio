# Fish Audio TTS

[Fish Audio](https://fish.audio) voices in SillyTavern's built-in TTS. Narration modes, the voice map, `/speak` and
the narrate buttons work as usual. Adds a voice browser with free sample playback.

Two parts: this extension and a small [server plugin](https://github.com/severian-dev/st-fish-audio-plugin). Fish's
speech API does not accept calls from a browser, so the plugin makes them from the SillyTavern server. Your API key
stays there too.

Tested on SillyTavern 1.19.0.

## Install

1. **Server plugin.** In your SillyTavern folder:

   ```
   node plugins.js install https://github.com/severian-dev/st-fish-audio-plugin
   ```

   Set `enableServerPlugins: true` in `config.yaml`, then restart SillyTavern.
2. **Extension.** Extensions > Install extension > paste this repo's git URL.
3. Extensions > TTS. Pick **Fish Audio (Extension)** as the provider and tick Enabled.
4. Paste your API key from [fish.audio/app/developers](https://fish.audio/app/developers) and hit Save.

## Voices

- **Browse voices** searches Fish's public library by name, language and popularity. Samples are free to play. Save
  the ones you like.
- Or paste a voice ID or a fish.audio voice link and hit Add.
- Your own Fish voices show up automatically.
- Saved voices appear in the voice map. Pick one per character.

## Models

| Model | Cost | Notes |
| --- | --- | --- |
| S2.1 Pro Free | Free until Nov 30, 2026 | Default. No uptime guarantee, and Fish may use requests to improve its models. |
| S2.1 Pro | $15 per 1M bytes of text | |
| S2 Pro | $15 per 1M bytes of text | |
| S1 | $15 per 1M bytes of text | Deprecated. Fish retires it Dec 31, 2026 and bills it as S2.1 Pro after. |
| Drama 3 | Paid | |

Paid models use API credit, which is separate from fish.audio app credit. The settings panel shows your balance.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Model | S2.1 Pro Free | See above. |
| Latency | Balanced | Balanced and Low start audio sooner than Normal. |
| Speed | 1 | 0.5 to 2. |
| Temperature | 0.7 | Higher is more varied. |
| Top P | 0.7 | |
| Even out loudness | on | S2 models only. |

## How it works

- The extension adds a provider to SillyTavern's TTS with `registerTtsProvider`.
- Each line goes to the plugin, which checks it and calls Fish's documented `POST /v1/tts`. The plugin answers with a
  job id as soon as Fish accepts, then streams the MP3 as Fish produces it. Playback starts on the first chunk.
- Only models on a fixed list are sent. Fish bills a missing or unknown model as S2.1 Pro.
- At most 5 requests at once per key, Fish's base limit. Busy answers are retried.
- The key lives in SillyTavern's secrets store as `api_key_fish_audio`.

## Fish's rules

This extension sends your chat text to Fish as is. Read [Fish's terms](https://fish.audio/terms/) before you use it.

- Sexually explicit text is not allowed. Fish detects it automatically and can close accounts.
- Clone only voices you have consent to use.
- Free accounts are for personal, non-commercial use.
- Don't share or sell API keys. Everyone brings their own.

## Troubleshooting

- **Server plugin not found.** The plugin isn't installed, `enableServerPlugins` is off, or SillyTavern wasn't
  restarted.
- **Not enough Fish API credit.** A paid model on an account without API credit. Switch to S2.1 Pro Free or add credit.
- **`ttsProviders[provider] is not a constructor` in the console at startup.** Harmless. SillyTavern loads the saved
  provider before third-party extensions register. The extension fixes the selection right after.

## License

MIT
