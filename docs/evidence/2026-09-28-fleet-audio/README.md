# Fleet audio route qualification

The deployed gateway retained an OpenRouter music configuration but lacked its audio adapter. `ComposeMusic` therefore forwarded to the provider's nonexistent `/audio/generations` URL and returned 404. The adapter is restored from the previously reviewed source and follow-up fixes, using the installed undici fetch/dispatcher pair. It maps the fleet audio endpoint to streamed provider chat audio and validates the completed WAV artifact.

Hear now runs as a managed CPU service on the media Spark, reached through the fleet gateway. Its interpretation credential explicitly targets the fleet gateway instead of inheriting the owner gateway's different credential. Optional interpretation still uses the existing Gemini route; measured DSP stays local. The old Mac route is not an active member or automatic fallback.

Two additional Hear contract failures were reproduced and repaired:

- A normal 10.4 MB stereo track was rejected as 3,965,572 estimated text tokens against the old 1,048,576 allowance. The CPU recipe now admits the existing bounded request envelope with a 33,554,432 allowance. This is transport admission metadata, not an LLM context claim; byte and analysis-duration limits are unchanged.
- An omitted start with duration/end previously returned 400. It now means a window starting at zero, preserving finite/nonnegative validation, empty/reversed-window rejection and duration clamping.

Custom speech and voice design were disabled, and transcription and YuE remained suspended from earlier operations. They are callable again. Verification uses the installed Runtime tools with generic operator fixtures through the normal fleet relay; no entity release or lasting entity configuration was changed. A brief graceful presence pause allowed the gateway restart; both previous enabled states were restored.

## Live verification

| Path                              | Result                                                                                 |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| ComposeMusic, default music alias | WAV returned, 44.1 kHz stereo                                                          |
| ACE-Step XL Turbo and XL SFT      | Both returned 15-second, 48 kHz stereo WAVs                                            |
| MiniMax Music3                    | Returned 14.99-second, 44.1 kHz stereo WAV                                             |
| YuE2                              | Returned 15-second, 48 kHz stereo WAV                                                  |
| SynthesizeSpeech                  | Custom, clone and design modes returned valid WAVs                                     |
| TranscribeAudio                   | Exact expected sentence returned                                                       |
| HearAudio, silence                | Correctly abstained                                                                    |
| HearAudio, speech                 | Local measurements and optional interpretation succeeded                               |
| HearAudio, full generated track   | Accepted 10.4 MB input and analyzed the requested first 10 seconds with interpretation |

The Lyria duration is a prompt request, not an exact trim: this check requested 10 seconds and received 59.01 seconds. Local-model checks were bounded route/artifact smoke tests, not a music-quality comparison. Detailed durations and artifact hashes are in [checks.json](checks.json).

Validation: 22 audio-provider tests, 8 audio-generation gateway tests, policy-helper checks, the Hear recipe check, and 47 real Hear boundary tests passed. Runtime deployment preserved the installed gateway's unrelated changes by applying only the audio adapter integration.
