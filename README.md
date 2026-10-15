# Fish Audio TTS

[Fish Audio](https://fish.audio) voices in SillyTavern's built-in TTS. Narration modes, the voice map, `/speak` and
the narrate buttons work as usual. Adds a voice browser with free sample playback, several voices in one message,
emotion cues, dialogue-only reading, infobox skipping, and an audio cache so repeated lines cost nothing.

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

## What gets read

Everything below happens before any text reaches Fish, so skipped text costs nothing.

- **Reasoning is never read.** `<think>`, `<thinking>` and `<reasoning>` blocks are dropped, in case a model writes them
  inline and SillyTavern doesn't parse them out.
- **Skip infoboxes and markup.** On by default. Drops code blocks, markdown tables, HTML blocks (`<div>`, `<details>`,
  `<table>` and the like) and HTML comments, plus any tags you list (default: `infobox, status, stats`). Drama 3's
  voice tags are kept.
- **Read narration.** On by default. Off reads only dialogue: quoted text and `Name:` lines. On a typical roleplay
  reply that cuts the text sent, and the cost, to a fraction.
- **Mute a speaker.** Pick "Muted" in the Speakers list, or set the character to "disabled" in the voice map.
- **Preview last message** shows what will be read, in which voice, how many bytes, and the rough cost.

Use these instead of SillyTavern's "Skip `<tagged>` blocks" and "Only narrate quotes". Those run first and break
Drama 3's tags and speaker voices. The settings panel warns when they're on.

## Several voices in one message

Lines that start with a known name use that character's voice:

```
The door opened slowly.
Alice: "Who goes there?"
Old Tom: "Just me."
She stepped back.
```

Alice and Old Tom get their own voices, the narration keeps the message's voice. Pick "Muted" for a name to skip
their lines. Names come from the voice map
(characters in the chat) and from the **Speakers** list, which is where NPCs go. Each line stands alone: a line without
a known name goes back to the message's voice. "Note:" or "Time:" lines are left alone unless you add those names.

S2 models and Drama 3 voice the whole message in one request. S1 gets one clip per speaker turn.

**Preview last message** shows how the latest message splits, without generating anything.

Turn off SillyTavern's "Only narrate quotes" and "Different voices for quotes" for this to work. Both strip or split
the lines before the extension sees them.

## Voice cues

S2 models and Drama 3 read delivery cues in square brackets: `[whispering]`, `[laughing]`, `[sighing]`, or free-form
ones like `[tense, quiet voice]`. S1 only knows a fixed set of tags. The extension rewrites cues for the selected model
and drops the ones it can't read.

- **Use cues.** On by default. Off removes them before speaking.
- **Ask the chat model to write cues.** Adds a short instruction to the prompt while TTS is on with this provider.
- **Hide cues in the chat.** Adds a display-only regex script, "Fish Audio TTS: hide voice cues". Messages keep the
  cues, TTS still reads them, you just don't see them. Untick to remove the script.

## Audio cache

The plugin keeps generated audio on the SillyTavern server, per user. A line spoken again with the same voice and
settings replays from disk instead of costing credit. Up to 200 MB per user, oldest first. Turn it off or clear it in
the settings.

## Models

| Model | Cost | Notes |
| --- | --- | --- |
| S2.1 Pro Free | Free until Nov 30, 2026 | Default. No uptime guarantee, and Fish may use requests to improve its models. |
| S2.1 Pro | $15 per 1M bytes of text | |
| S2 Pro | $15 per 1M bytes of text | |
| S1 | $15 per 1M bytes of text | Deprecated. Fish retires it Dec 31, 2026 and bills it as S2.1 Pro after. |
| Drama 3 | About $10 per 1M bytes of text | Most expressive. Not on Fish's pricing page, measured in October 2026. |

Paid models use API credit, which is separate from fish.audio app credit. fish.audio's Plus and Pro plans are for the
web app and don't fund the API. Top up API credit at [fish.audio/app/developers](https://fish.audio/app/developers).
The settings panel shows your balance.

Rough cost of one reply, read in full: 2,000 tokens of English is about 8 KB of text, so about $0.08 on Drama 3 and
$0.12 on S2.1 Pro. Dialogue only is usually a third of that or less. Fish bills by UTF-8 bytes, so Chinese, Japanese
and Korean text costs about 3x per character.

## Drama 3

Drama 3 follows directions much more closely than S2.1 Pro. In testing with the same voice, `[whispering]` and
`<whisper>…</whisper>` produced a real whisper on Drama 3 and no change on S2.1 Pro.

- Directions written like notes to an actor: `[slow, dangerously quiet]`, `[voice breaking]`.
- Tags that change only the words inside: `<whisper>`, `<emphasis>`, `<soft>`, `<fast>`, `<slow>`, `<stress>`,
  `<forceful>`. On other models they become the nearest cue or plain words.
- **Smooth playback.** Drama 3 generates at about real time or slower, so one long streamed clip can stutter. With this
  on (default), the text goes out as sentence chunks that all generate at once: the first short sentence starts
  playing in about 2 seconds, and the rest have a head start by the time they play.

## Settings

| Setting | Default | Notes |
| --- | --- | --- |
| Model | S2.1 Pro Free | See above. |
| Latency | Balanced | Balanced and Low start audio sooner than Normal. |
| Speed | 1 | 0.5 to 2. |
| Temperature | 0.7 | Higher is more varied. |
| Top P | 0.7 | |
| Even out loudness | on | S2 models only. |
| Smooth playback for Drama 3 | on | |
| Read narration | on | Off reads only dialogue. |
| Skip infoboxes and markup | on | |
| Also skip these tags | `infobox, status, stats` | |
| Reuse audio | on | Needs plugin 0.2.0 or newer. |
| Several voices per message | on | |
| Use cues | on | |
| Ask the chat model to write cues | off | Drama 3 gets its own instruction with directions and word tags. |

## How it works

- The extension adds a provider to SillyTavern's TTS with `registerTtsProvider`.
- Each line goes to the plugin, which checks it and calls Fish's documented `POST /v1/tts`. The plugin answers with a
  job id as soon as Fish accepts, then streams the MP3 as Fish produces it. Playback starts on the first chunk.
- Only models on a fixed list are sent. Fish bills a missing or unknown model as S2.1 Pro.
- At most 5 requests at once per key, Fish's base limit. Busy answers are retried.
- Speaker lines are found in `processText`, before SillyTavern collapses line breaks, and turned into Fish's
  `<|speaker:N|>` turns with one voice per speaker.
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
