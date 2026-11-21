# Third-party notices

XLETH is licensed under **AGPL-3.0-or-later** (see [LICENSE](LICENSE)). It includes, links to, or ships
alongside the third-party components below, each under its own license. Nothing here changes the license of
those components. The full audit behind this file is `docs/LICENSE_AUDIT.md`.

**JUCE and the "or later" wording.** The XLETH binaries (`XlethEngine.exe`, `xleth_native.node`,
`xleth-editor-host.exe`, `xleth-plugin-scanner.exe`) include JUCE 8.0.6 under **AGPL-3.0**. JUCE's source
headers offer the AGPLv3 without an "or later" option, so those combined binaries are distributed under
AGPL-3.0. XLETH's own source code remains available under AGPL-3.0-or-later.

Source code for XLETH: https://github.com/composition-cassidy/Xleth

---

## 1. Compiled into or linked with the XLETH binaries

| Component | Version | License | Copyright / upstream |
|---|---|---|---|
| JUCE | 8.0.6 | AGPL-3.0 (dual-licensed with the commercial JUCE 8 licence; used here under the AGPLv3) | Raw Material Software Limited, https://github.com/juce-framework/JUCE |
| FFmpeg libraries (`avcodec`, `avformat`, `avutil`, `swscale`, `swresample`, `avdevice`, `avfilter`), via vcpkg | FFmpeg 8.x (libavcodec 62), vcpkg baseline `4497409a47f19db373a410a0efb84eca4747adbf` | LGPL-2.1-or-later (built without `--enable-gpl` or `--enable-nonfree`) | FFmpeg developers, https://ffmpeg.org |
| Rubber Band Library | 4.0.0 | GPL-2.0-or-later (used here under the GPL; a commercial licence also exists) | Particular Programs Ltd, https://github.com/breakfastquay/rubberband |
| WORLD vocoder | 1.0.1 | Modified BSD (3-clause) | Copyright (c) 2010 M. Morise, https://github.com/mmorise/World |
| xxHash | 0.8.2 | BSD-2-Clause | Copyright (c) 2012-2021 Yann Collet, https://github.com/Cyan4973/xxHash |
| nlohmann/json | 3.11.x | MIT | Copyright (c) 2013-2022 Niels Lohmann, https://github.com/nlohmann/json |
| stb_image_write | 1.16 | Public domain (or MIT) | Sean Barrett, https://github.com/nothings/stb |
| node-addon-api | 8.x | MIT | Node.js contributors, https://github.com/nodejs/node-addon-api |
| `pkgconf` runtime DLL (vcpkg build tool) | 7 | ISC | pkgconf contributors |
| Microsoft Visual C++ runtime (`vcruntime140*`, `msvcp140*`) | VS 2022 | Microsoft redistributable terms | Microsoft Corporation |

### Code bundled inside JUCE (compiled in on Windows)

| Component | License |
|---|---|
| FLAC | BSD-3-Clause |
| Ogg Vorbis | BSD-3-Clause |
| zlib | zlib |
| libpng | zlib |
| libjpeg (IJG) | Independent JPEG Group License |
| HarfBuzz | Old MIT |
| SheenBidi | Apache-2.0 |
| CHOC / QuickJS | ISC / MIT |
| VST3 SDK | Steinberg VST3 License **or** GPL-3.0 (the GPL-3.0 option is used) |
| Box2D | zlib |

## 2. Shipped as separate programs and runtimes

| Component | Version | License | Notes |
|---|---|---|---|
| FFmpeg command-line tools `ffmpeg.exe`, `ffprobe.exe` (gyan.dev "full" static build) | 2026-04-26, git `4867d251ad` | **GPL-3.0** (`--enable-gpl --enable-version3`; includes libx264, libx265 and other libraries) | Run as separate processes. License text and build configuration ship in `resources/ffmpeg/` (`LICENSE`, `README.txt`). Corresponding source: https://github.com/FFmpeg/FFmpeg/commit/4867d251ad and the component sources listed on https://www.gyan.dev/ffmpeg/builds/. |
| Node.js (`node.exe`) | 24.11.1 | MIT, plus its bundled third-party licenses | https://nodejs.org |
| Electron (application shell, Chromium, V8) | 41.x | MIT; Chromium and bundled libraries under BSD, MIT, LGPL and others | The full list ships with the app as `LICENSES.chromium.html` and `LICENSE.electron.txt`. |
| Python (python-build-standalone) | 3.12.14, build 20260901 | PSF-2.0, plus bundled OpenSSL 3 (Apache-2.0), libffi (MIT), SQLite (public domain), expat (MIT) and others | Shipped as the separation sidecar runtime; its `LICENSE.txt` ships beside it. |

### Python packages in the separation sidecar runtime

| Package | Version | License |
|---|---|---|
| onnxruntime (CPU) | 1.30.0 | MIT (with third-party notices) |
| numpy (bundles OpenBLAS) | 2.5.3 | BSD-3-Clause AND 0BSD AND MIT AND Zlib AND CC0-1.0 |
| soxr (python-soxr, libsoxr, PFFFT) | 1.1.0 | LGPL-2.1-or-later |
| soundfile | 0.14.0 | BSD-3-Clause |
| libsndfile (`libsndfile_x64.dll`, with libFLAC, libmp3lame, mpg123, Opus, Ogg, Vorbis) | bundled with soundfile | LGPL-2.1-or-later (component notices in `soundfile`'s `licensing/license_notes.md`) |
| PyYAML | 6.0.3 | MIT |
| fastapi | 0.141.1 | MIT |
| starlette | 1.6.0 | BSD-3-Clause |
| uvicorn | 0.53.0 | BSD-3-Clause |
| h11 | 0.16.0 | MIT |
| click | 8.5.0 | BSD-3-Clause |
| anyio | 4.15.1 | MIT |
| idna | 3.20 | BSD-3-Clause |
| pydantic / pydantic_core | 2.13.5 / 2.46.5 | MIT |
| annotated_types, annotated_doc, typing_inspection | 0.8.0 / 0.0.5 / 0.4.4 | MIT |
| cffi / pycparser | 2.1.1 / 3.0 | MIT-0 / BSD-3-Clause |
| flatbuffers | 25.12.19 | Apache-2.0 |
| protobuf | 7.36.2 | BSD-3-Clause |
| packaging | 26.3 | Apache-2.0 OR BSD-2-Clause |
| typing_extensions | 4.16.0 | PSF-2.0 |

**LGPL source and replacement.** `soxr` and `libsndfile` are used as separate, replaceable libraries (a
Python extension module and a DLL). Their license texts ship in the runtime's `*.dist-info/licenses/` and
`_soundfile_data/COPYING`. Sources: https://sourceforge.net/projects/soxr/, https://github.com/dofuuz/python-soxr,
https://github.com/libsndfile/libsndfile.

### Separation sidecar code and graphs

- `xleth_separation/vendor/{attend,bs_roformer,mel_band_roformer}.py`: MIT, from
  https://github.com/ZFTurbo/Music-Source-Separation-Training (pinned commits), descended from
  https://github.com/lucidrains/BS-RoFormer (MIT). Provenance and the single import edit are in
  `tools/separation_sidecar/xleth_separation/vendor/VENDOR-NOTICE.md`.
- `xleth_separation/graphs/*.onnx`: graph structure only, generated from the MIT code above. They contain no
  checkpoint weights.

## 3. JavaScript packages in the app bundle (production dependencies of `ui/`)

Direct dependencies: `react` 18.3.1 (MIT), `react-dom` 18.3.1 (MIT), `zustand` 5.0.12 (MIT),
`@xyflow/react` 12.10.2 (MIT), `archiver` 7.0.1 (MIT), and the three font packages in section 4. All 102
packages in the production dependency tree are under these licenses:

| License | Examples |
|---|---|
| MIT | @xyflow/system, archiver-utils, compress-commons, crc32-stream, zip-stream, tar-stream, readable-stream, streamx, async, lodash, classcat, use-sync-external-store, zustand 4.5.7, string-width, wrap-ansi, strip-ansi, cross-spawn |
| ISC | d3-color, d3-dispatch, d3-drag, d3-interpolate, d3-selection, d3-timer, d3-transition, d3-zoom, glob, graceful-fs, inherits, lru-cache, signal-exit, which |
| BSD-3-Clause | d3-ease |
| Apache-2.0 | crc-32, readdir-glob, bare-events, bare-fs, bare-os, bare-path, bare-stream, bare-url |
| BlueOak-1.0.0 | isexe, jackspeak, minimatch, minipass, package-json-from-dist, path-scurry |

`@phosphor-icons/core` 2.1.1 (MIT, https://github.com/phosphor-icons/core) is used at build time and its icon
shapes are embedded in the UI bundle.

## 4. Fonts (SIL Open Font License 1.1)

Font files ship as separate data files, each with its license text.

| Font | Copyright | Files |
|---|---|---|
| **Barlow** (brand font; Light 300, Regular 400, Medium 500, SemiBold 600, Bold 700) | Copyright 2017 The Barlow Project Authors (https://github.com/jpt/barlow) | `ui/assets/fonts/Barlow/*.ttf`, license text in `ui/assets/fonts/Barlow/OFL.txt` |
| Inter | Copyright (c) The Inter Project Authors (https://github.com/rsms/inter) | `@fontsource/inter` |
| Noto Sans | Copyright (c) The Noto Project Authors (https://github.com/notofonts/latin-greek-cyrillic) | `@fontsource/noto-sans` |
| IBM Plex Mono | Copyright (c) IBM Corp. (https://github.com/IBM/plex) | `@fontsource/ibm-plex-mono` |

Barlow was taken from https://github.com/google/fonts (`ofl/barlow/`, commit
`c30b221beb0c1da59d563feb91ec8656a1fa972a`). The commercial typeface previously used (Neuzeit Grotesk) is
no longer part of the repository or any build.

## 5. Ported and derived code

- **FLP importer** (`ui/electron-main/flp-import.js`): ported from **FLP-to-Video**
  (https://github.com/composition-cassidy/FLP-to-Video, `source/flp2json.py`) by Krasen (composition-cassidy),
  who is also the author of XLETH, and is contributed to XLETH under AGPL-3.0-or-later. The parsing approach is
  based on **PyFLP** (https://github.com/demberto/PyFLP, **GPL-3.0**, Copyright (c) demberto and PyFLP
  contributors). GPL-3.0 code may be combined with AGPL-3.0 under section 13 of the GPLv3.
- **Metronome click samples** (`engine/src/audio/MetronomeSamples.cpp`): original work by Krasen, licensed under
  the project license (AGPL-3.0-or-later).

## 6. Optional models downloaded by the user (not distributed with XLETH)

These weights are **not** in the repository, the installer or any build. The separation sidecar downloads each
one onto the user's own machine from the author's repository, pinned to a commit and a SHA-256, after the user
accepts the notice shown in the app. Each one remains under its own license.

| Model | Source | License | Notes |
|---|---|---|---|
| Fast: MDX-Net "Kim Vocal 2" (`Kim_Vocal_2.onnx`) | https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx | MIT, credit required: "MDX-Net 'Kim Vocal 2', model by KimberleyJSN, distributed by Ultimate Vocal Remover (MIT)." | Credit is shown in the app. |
| Balanced: Mel-Band RoFormer "deux" (`becruily_deux.ckpt`) | https://huggingface.co/becruily/mel-band-roformer-deux (commit `2da74427d682a3df47a774378fc24d7a1a0cdaad`) | **CC BY-NC 4.0**, **non-commercial use only**, credit becruily | The in-app notice states non-commercial use only. Use the Fast model for commercial work, or get permission from the author. |
| Best: BS-Roformer FT1 (`bs_roformer_ft1_anvuew_sdr_12.55.ckpt`) | https://huggingface.co/anvuew/BS-RoFormer (commit `24988f47270cb3529b62c4f3bbb8234f4586de9b`) | GPL-3.0, as declared by the author's Hugging Face metadata | No further grant statement from the author. The in-app notice quotes the license. |

## 7. Not included

- The ASIO SDK is not part of the build (`XLETH_ASIO` is off by default).
- Plugin hosting in this release covers VST3 only. The repository carries FST's VST2 headers (section 8), but no build file or source file includes them, so no VST2 code is compiled into any XLETH binary.

## 8. Vendored in the repository, not currently built

| Component | Location | License | Notes |
|---|---|---|---|
| FST (Free Studio Technology), v0.115.0, reverse-engineered VST2 headers | `third_party/fst/` (`fst/aeffect.h`, `fst/aeffectx.h`, `fst/fst.h`; `LICENSE`, `README.md`, `VERSION`, `PATCHES.md`) | **GPL-3.0-or-later** (file headers: "version 3 of the License, or (at your option) any later version"; `LICENSE` is the GPLv3 text). Copyright (C) 2019 IOhannes m zmölnig, IEM. Upstream: https://git.iem.at/zmoelnig/FST | Prepared for VST2 plugin hosting. At this commit nothing in the build or source includes it. One local change, recorded in `third_party/fst/PATCHES.md`: the four `#warning` directives in `fst.h` are wrapped in `#if !defined(_MSC_VER)` because MSVC rejects them. If compiled in, it is combined into an AGPL-3.0-or-later work under section 13 of the GPLv3 and section 13 of the AGPLv3. |
| FST compatibility shim | `third_party/fst-compat/pluginterfaces/vst2.x/aeffect.h`, `aeffectx.h` | Part of XLETH (AGPL-3.0-or-later); contains no VST2 definitions | Forwards JUCE's `<pluginterfaces/vst2.x/aeffect.h>` include to FST and defines `FST_DONT_DEPRECATE_UNKNOWN` for MSVC. Not included by any build file at this commit. |

`vendor/ffmpeg/` (docs, presets, `LICENSE`, `README.txt`) and `vendor/node/node.exe` are the shipped tools already listed in section 2.
