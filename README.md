# Local Companion

A floating macOS assistant for screenshots, live audio transcripts and quick answers. Responses run through your signed-in Codex CLI or Claude Code CLI; NVIDIA Parakeet transcribes microphone and computer audio locally on Apple Silicon.

This is a source release of a local prototype. It is inspired by Cluely's interaction design and is independent of Cluely. It includes original mode instructions and no extracted Cluely binaries or assets.

## What it does

- **Continuous chat:** typed messages, screenshots and speech share one conversation until New chat. Mode instructions configure it separately from your messages.
- **Screen → queue → Send:** collect multiple screenshots or attach PNG/JPEG files, remove any individually, then send with optional text. Capture alone does not request an answer.
- **Listen → Send:** transcribe continuously and submit new speech on demand. Listening continues while an answer generates.
- **Quick Assist:** explicitly capture and send a fresh screenshot with queued images, new speech and your message.
- **Floating chat:** translucent panel, streamed Markdown and code, questions anchored near the top, screenshot previews and a jump-to-bottom button.
- **Answer provider:** switch between Codex and Claude Code from the toolbar or Settings. Each provider keeps its own model settings and session; switching carries the chat's earlier messages and images to the newly selected provider. Requests never fall back silently to the other provider.
- **Model and mode pickers:** choose the provider's model, reasoning effort and advertised answer-speed tier; customize interview, coding, behavioral and other modes with background and reference files.
- **Local history:** save conversations, transcripts and notes; import text, PDF and DOCX context.
- **Privacy mode:** requests window capture exclusion and hides the Dock/Mission Control entry. Protection depends on macOS and the capture application; it is not a universal invisibility guarantee.

## Requirements

- Apple Silicon Mac with macOS 15 or newer.
- Node.js 22.12 or newer, npm and Python 3.12.
- Xcode Command Line Tools (`xcode-select --install`).
- At least one answer provider:
  - [Codex CLI](https://developers.openai.com/codex/cli), installed and signed in with `codex login`; or
  - [Claude Code](https://code.claude.com/docs/en/quickstart), installed and signed in with `claude auth login`.
- Internet access for answers and the first Parakeet model download.

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

The first Listen can take longer while Parakeet downloads `mlx-community/parakeet-tdt-0.6b-v3` into your Hugging Face cache. The model stays warm during short pauses. After 45 paused minutes with all transcription finished, its worker exits to release memory. Listen automatically reloads it from cache.

### Permissions and signing

Allow microphone access when requested. Enable Local Companion in **System Settings → Privacy & Security → Screen & System Audio Recording** for screenshots and computer audio. Follow any macOS request to reopen the app. Listen uses Core Audio process taps for computer playback, with a separate AVFoundation microphone session; it does not start a screen-video stream. macOS recording indicators can still appear.

The one-time signing setup creates a personal certificate in a dedicated local keychain. Preserve `~/Library/Application Support/Local Companion Signing/` between builds: changing that identity can require renewing permissions. The build fails if that identity is missing rather than silently replacing it. Keys and generated signing state are not part of this repository. This personal build is not notarized for general binary distribution.

## Controls

| Action | Default shortcut |
| --- | --- |
| Send new speech, preserving draft and queued images | Control–Option–Enter |
| Queue a screenshot | Control–Option–' |
| Quick Assist: capture screen and send | Control–Option–`\` |
| Listen / Pause | Control–Option–L |
| New chat | Control–Option–N |
| Show / hide panel | Control–Option–Space |
| Focus question input | Control–Option–P |
| Move panel | Command–Arrow |
| Scroll answer | Control–Option–Shift–Up / Down |

Screen shortcuts use physical key positions. On Canadian–CSA, the screen-only and combined keys are **è** and **à**. Shortcuts are editable in Advanced settings and may conflict with other applications.

- Start **Listen** once. Enter sends your message, queued images and new speech. Control–Option–Enter sends only new speech, preserving the draft and queued images.
- Click **Screen** to queue a screenshot without submitting. Capture several views, add any text, then Send. The paperclip accepts multiple image files. Capturing temporarily hides the panel.
- Choose **… → Quick Assist · screen + voice** or the combined shortcut to capture and send immediately. Automatic screen capture for typed messages is optional and initially off.
- Click the square **Stop** button in the composer to interrupt thinking or generation. Click **Pause** to stop audio capture separately.
- Click **Codex / Claude** beside Model to choose the answer provider. Wait for an active answer to finish before switching. Each completed answer shows which provider wrote it.
- Open **Model** for model, effort and speed. Faster service tiers can consume more of your Codex allowance; the menu uses descriptions advertised by the provider. Claude offers the Sonnet, Opus and Haiku aliases at Standard speed; your account determines which can answer.
- Open **Mode** to select or edit instructions, background and reference files.
- Hover or focus each image label for its preview. Copy appears after the response finishes; Retry is in the small response menu.
- **…** contains Transcript, History, Notes, Settings and New chat. The eye/incognito button toggles Privacy mode while leaving the panel visible.


New chat / Command–N leaves an already fresh chat in place, preserving its draft and queued images.

## Data and account usage

Parakeet transcription runs on your Mac. Asking for an answer sends the composed question and applicable transcript, screenshots, mode instructions and reference text to the selected answer provider. Switching providers sends earlier messages and images that provider has not yet seen with the next request. Mode instructions and references configure the conversation initially and when changed; ordinary messages do not repeat them. Smart research optionally enables web search. Model inference is not local. With ChatGPT sign-in, answers use the account's allowance; an API-key configuration follows its provider's billing.

The app starts its own `codex app-server --listen stdio://` process and uses existing Codex authentication. The Codex desktop app does not need to be open. `COMPANION_CODEX` can point to a specific CLI executable. The companion disables configured development MCP servers for its own threads and enables web search only when Smart research is on.

For Claude, choose **Settings → Answer provider → Claude**, click **Sign in to Claude…**, finish the login in Terminal, then click **Reconnect Claude**. The app runs `claude -p` with streaming JSON input and output and resumes its own Claude session on follow-up turns. It uses your normal Claude Code authentication; an API key set in the environment takes precedence and uses API billing, which the connection status shows. `COMPANION_CLAUDE` can point to a specific executable. Mode instructions go in the system prompt. Normal answers run without tools; Smart research enables only WebSearch and WebFetch. Configured MCP servers and settings are excluded. Claude Code limits piped input to 10 MB, so an oversized request reports an error and keeps unsent inputs. Check Anthropic's terms before using subscription login with third-party tools.

Application data lives in `~/Library/Application Support/Local Companion/`:

- `history.json`: messages, transcripts, notes, settings, mode/reference text, image previews and separate Codex/Claude session IDs.
- `images/`: attached image files.
- `audio-temp/`: temporary WAV segments, normally removed after transcription.
- `workspace/`: working directory for the companion's Codex and Claude processes.

Each CLI also retains its normal local conversation state. There is no automatic history retention limit; an abrupt exit can leave temporary audio files. The repository ignores runtime state, recordings, screenshots, credentials, virtual environments and build outputs.

## Development and tests

```sh
npm test                # Offline JS tests; macOS signing test uses the setup identity
npm run test:native     # Swift PCM/capture-buffer tests; macOS only
```

The tests cover chat continuity, multiple-image queues, incremental speech, worker idle unloading and reloading, transcript flushing, cancellation transport, renderer behavior, audio readiness, Claude streaming/sign-in/cancellation handling, provider routing and persistent signing identity. They do not call models; Claude tests use a local fixture in place of the CLI. CI runs the portable tests on Linux, where the macOS signing test is skipped.

Live checks are separate and consume account usage:

```sh
node tests/provider-smoke.cjs claude # or codex; expects .build/test-screen.png containing 42
node tests/chat-flow-smoke.cjs # expects .build/test-screen.png containing 42
node tests/screen-context-smoke.cjs /absolute/path/to/invert-binary-tree.png
node tests/live-capture-check.cjs 'expected speech' Computer
```

`tests/codex-smoke.cjs` also checks real image input, continuation and cancellation; it expects a test image at `.build/test-screen.png` containing the number 42. `tests/provider-smoke.cjs` checks a cross-provider history handoff, image input, continuation and Stop against the named provider. Live checks and their generated evidence are not included in `npm test`.

`node tests/audio-idle-smoke.cjs /absolute/path/to/speech.wav` verifies real local Parakeet unload/reload using a shortened test timeout and a known mono 16 kHz WAV, without Codex calls.

The source is organized as follows:

- `src/main.cjs`: Electron lifecycle, shortcuts, capture and request routing.
- `src/providers.cjs`: provider selection, event routing and cross-provider history handoff.
- `src/codex.cjs`: Codex app-server transport and interruption.
- `src/claude.cjs`: Claude Code CLI streaming transport, session resume and interruption.
- `src/audio.cjs` and `scripts/transcribe.py`: audio segmentation and local ASR worker.
- `native/Capture.swift`: microphone capture, Core Audio taps and PCM conversion.
- `src/prompts.cjs` and `src/interview-mode-prompts.json`: request context and editable modes.
- `src/renderer.js`, `src/index.html`, `src/styles.css`: floating interface.
- `scripts/build.cjs`, `scripts/signing.cjs`: personal local build and stable signing.

## Limits

Transcription is emitted in utterance segments, not partial words. Audio channels are labeled Me/Computer, not verified speaker identities; speaker playback may be picked up by both. Headphones reduce duplicate pickup. Echo cancellation, diarization and automatic answering are not implemented.

Live answers use up to 24,000 new transcript characters; recaps and notes use up to 160,000. Reference files are limited to 20 MB input, 100,000 extracted characters per file and 200,000 per mode. Scanned PDFs need OCR. Full conversation histories, model context limits and provider behavior can affect answers.

This prototype has no cloud sync, calendar integration, account/billing system, automatic updater or notarized installer. Privacy mode uses standard Electron/macOS window controls and cannot hide the process from system tools. See [Electron's capture-exclusion limitations](https://www.electronjs.org/docs/latest/api/browser-window#winsetcontentprotectionenable-macos-windows).

## Acknowledgements and license

[REA](https://github.com/morluto/rea) helped inspect interaction patterns during development. It is not embedded in the app. The public runtime uses independently written application code and mode instructions. Transcription uses [Parakeet MLX](https://github.com/senstella/parakeet-mlx) and the [Parakeet model](https://huggingface.co/mlx-community/parakeet-tdt-0.6b-v3); their own terms apply. Electron, Geist, marked and DOMPurify are installed as dependencies with their respective licenses.

Local Companion source is licensed under [ISC](LICENSE).

Local input diagnostics are kept in `~/Library/Application Support/Local Companion/diagnostics/input.jsonl` and `input.previous.jsonl`, capped at 1 MiB each. They record window focus/enabled state, operation flags, renderer health replies, and native/DOM input counts every five seconds. They do not record key values, message text, screenshots, or audio. If interaction stops, keep the app open so the failed state can be inspected before restarting.
