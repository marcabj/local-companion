# Local Companion

A floating macOS assistant for screenshots, live audio transcripts and quick answers. Responses run through your signed-in Codex CLI; NVIDIA Parakeet transcribes microphone and computer audio locally on Apple Silicon.

This is a source release of a local prototype. It is inspired by Cluely's interaction design and is independent of Cluely. It includes original mode instructions and no extracted Cluely binaries or assets.

## What it does

- **Screen → answer:** capture the current screen and ask about it in one action. Screen-only requests start a fresh model conversation so an earlier spoken question does not contaminate a new visual task.
- **Listen → latest question:** transcribe continuously, then answer the latest spoken question on demand. Listening continues while an answer generates.
- **Screen + transcript:** combine a fresh screenshot with the latest relevant speech.
- **Follow-ups:** continue a spoken or typed conversation, or start a new chat for fresh context.
- **Floating chat:** translucent panel, streamed Markdown and code, questions anchored near the top, screenshot previews and a jump-to-bottom button.
- **Model and mode pickers:** choose the Codex model, reasoning effort and advertised answer-speed tier; customize interview, coding, behavioral and other modes with background and reference files.
- **Local history:** save conversations, transcripts and notes; import text, PDF and DOCX context.
- **Privacy mode:** requests window capture exclusion and hides the Dock/Mission Control entry. Protection depends on macOS and the capture application; it is not a universal invisibility guarantee.

## Requirements

- Apple Silicon Mac with macOS 15 or newer.
- Node.js 22.12 or newer, npm and Python 3.12.
- Xcode Command Line Tools (`xcode-select --install`).
- [Codex CLI](https://developers.openai.com/codex/cli), installed and signed in with `codex login`.
- Internet access for Codex answers and the first Parakeet model download.

## Build and run

```sh
git clone https://github.com/marcabj/local-companion.git
cd local-companion
npm ci
python3.12 -m venv .venv
.venv/bin/python -m pip install -r requirements.lock
node scripts/signing.cjs --setup
npm test
npm run test:native
npm run build
open "$HOME/Applications/Local Companion.app"
```

The build compiles the Swift capture helper, packages the arm64 Electron app and installs it in `~/Applications/Local Companion.app`. Quit an existing Local Companion before rebuilding. The app uses the checkout's `.venv` and transcription scripts, so keep the checkout in place after building. `npm start` runs the development Electron app after the helper has been built; macOS can treat that as a different application for permissions.

The first Listen can take longer while Parakeet downloads `mlx-community/parakeet-tdt-0.6b-v3` into your Hugging Face cache. The model stays warm until the app quits.

### Permissions and signing

Allow microphone access when requested. Enable Local Companion in **System Settings → Privacy & Security → Screen & System Audio Recording** for screenshots and computer audio. Follow any macOS request to reopen the app. Listen uses Core Audio process taps for computer playback, with a separate AVFoundation microphone session; it does not start a screen-video stream. macOS recording indicators can still appear.

The one-time signing setup creates a personal certificate in a dedicated local keychain. Preserve `~/Library/Application Support/Local Companion Signing/` between builds: changing that identity can require renewing permissions. The build fails if that identity is missing rather than silently replacing it. Keys and generated signing state are not part of this repository. This personal build is not notarized for general binary distribution.

## Controls

| Action | Default shortcut |
| --- | --- |
| Answer latest spoken question, transcript only | Control–Option–Enter |
| Capture screen and answer | Control–Option–' |
| Capture screen + latest transcript and answer | Control–Option–`\` |
| Listen / Pause | Control–Option–L |
| New chat | Control–Option–N |
| Show / hide panel | Control–Option–Space |
| Focus question input | Control–Option–P |
| Move panel | Command–Arrow |
| Scroll answer | Control–Option–Shift–Up / Down |

Screen shortcuts use physical key positions. On Canadian–CSA, the screen-only and combined keys are **è** and **à**. Shortcuts are editable in Advanced settings and may conflict with other applications.

- Start **Listen** once. Blank Enter in the composer or Control–Option–Enter answers the latest spoken question without taking a screenshot.
- Click **Screen** or its shortcut to solve the visible task. You can type a specific instruction first. A screenshot temporarily hides the panel to keep it out of the captured image.
- Choose **… → Screen + transcript** or the combined shortcut to use both sources.
- Click the square **Stop** button in the composer to interrupt thinking or generation. Click **Pause** to stop audio capture separately.
- Open **Model** for model, effort and speed. Faster service tiers can consume more of your Codex allowance; the menu uses descriptions advertised by the provider.
- Open **Mode** to select or edit instructions, background and reference files.
- Hover or focus **Viewed screen** for the image preview. Copy appears after the response finishes; Retry is in the small response menu.
- **…** contains Transcript, History, Notes, Settings and New interview. The eye/incognito button toggles Privacy mode while leaving the panel visible.

## Data and account usage

Parakeet transcription runs on your Mac. Asking for an answer sends the composed question and applicable transcript, screenshots, mode instructions and reference text to your configured Codex provider. Smart research optionally enables web search. Model inference is not local. With ChatGPT sign-in, answers use the account's allowance; an API-key configuration follows its provider's billing.

The app starts its own `codex app-server --listen stdio://` process and uses existing Codex authentication. The Codex desktop app does not need to be open. `COMPANION_CODEX` can point to a specific CLI executable. The companion disables configured development MCP servers for its own threads and enables web search only when Smart research is on.

Application data lives in `~/Library/Application Support/Local Companion/`:

- `history.json`: messages, transcripts, notes, settings, mode/reference text, image previews and Codex thread IDs.
- `images/`: attached image files.
- `audio-temp/`: temporary WAV segments, normally removed after transcription.
- `workspace/`: working directory for the companion's Codex process.

Codex also retains its normal local conversation state. There is no automatic history retention limit; an abrupt exit can leave temporary audio files. The repository ignores runtime state, recordings, screenshots, credentials, virtual environments and build outputs.

## Development and tests

```sh
npm test                # Offline JS tests; macOS signing test uses the setup identity
npm run test:native     # Swift PCM/capture-buffer tests; macOS only
```

The tests cover request isolation, transcript flushing, cancellation transport, renderer behavior, audio readiness and persistent signing identity. They do not call models. CI runs the portable tests on Linux, where the macOS signing test is skipped.

Live checks are separate and consume account usage:

```sh
node tests/screen-context-smoke.cjs /absolute/path/to/invert-binary-tree.png
node tests/live-capture-check.cjs 'expected speech' Computer
```

`tests/codex-smoke.cjs` also checks real image input, continuation and cancellation; it expects a test image at `.build/test-screen.png` containing the number 42. Live checks and their generated evidence are not included in `npm test`.

The source is organized as follows:

- `src/main.cjs`: Electron lifecycle, shortcuts, capture and request routing.
- `src/codex.cjs`: Codex app-server transport and interruption.
- `src/audio.cjs` and `scripts/transcribe.py`: audio segmentation and local ASR worker.
- `native/Capture.swift`: microphone capture, Core Audio taps and PCM conversion.
- `src/prompts.cjs` and `src/interview-mode-prompts.json`: request context and editable modes.
- `src/renderer.js`, `src/index.html`, `src/styles.css`: floating interface.
- `scripts/build.cjs`, `scripts/signing.cjs`: personal local build and stable signing.

## Limits

Transcription is emitted in utterance segments, not partial words. Audio channels are labeled Me/Computer, not verified speaker identities; speaker playback may be picked up by both. Headphones reduce duplicate pickup. Echo cancellation, diarization and automatic answering are not implemented.

Live answers use up to 24,000 recent transcript characters; recaps and notes use up to 160,000. Reference files are limited to 20 MB input, 100,000 extracted characters per file and 200,000 per mode. Scanned PDFs need OCR. Full conversation histories, model context limits and provider behavior can affect answers.

This prototype has no cloud sync, calendar integration, account/billing system, automatic updater or notarized installer. Privacy mode uses standard Electron/macOS window controls and cannot hide the process from system tools. See [Electron's capture-exclusion limitations](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows).

## Acknowledgements and license

[REA](https://github.com/morluto/rea) helped inspect interaction patterns during development. It is not embedded in the app. The public runtime uses independently written application code and mode instructions. Transcription uses [Parakeet MLX](https://github.com/senstella/parakeet-mlx) and the [Parakeet model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); their own terms apply. Electron, Geist, marked and DOMPurify are installed as dependencies with their respective licenses.

Local Companion source is licensed under [ISC](LICENSE).
