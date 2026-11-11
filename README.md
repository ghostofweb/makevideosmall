# Make Video Small

A Windows app that makes videos and pictures smaller. Add a file, and the app tries three sizes on it, shows what each one looks like next to the original, and suggests one. Everything runs on your own PC; nothing is uploaded.

![Make Video Small](./screenshot.png)

## What it does

**Videos**

- **Three choices, measured on your video.** Best quality, Balanced and Smallest each show the size the file will become, how much smaller that is, how it will look and how long it takes. One is marked as suggested.
- **See it before you commit.** A frame of the original and the same frame at the chosen size sit side by side, with a divider you can drag.
- **Cut the start or end** to keep only part of a video.
- **Join several videos into one.** Tick them in the order they should play.
- **Black bars are removed automatically** when a video has them.
- **A queue** that works through your files one after another. You can reorder, pause, resume and cancel, and it is remembered if the app closes.
- **Uses your graphics card when it can** (NVIDIA, AMD or Intel), which is several times faster. One setting switches to the smallest possible files instead.
- **Advanced controls** behind one switch: exact encoder (H.264, HEVC, AV1), quality, bitrate or target file size, two-pass, resolution, frame rate, crop, 10-bit, HDR, each audio and subtitle track, filters, and your own saved presets.

**Pictures**

- **Make smaller** as WebP, JPEG, AVIF or PNG.
- **Fit a size limit**, for upload forms that reject large files.
- **Crop** by dragging a box, free or to a fixed shape.
- **Remove the background** so only the subject is left.
- **Make bigger** four times with AI (needs a graphics card).

Originals are never changed or overwritten. Camera details and GPS location are never copied into picture results.

## Install

1. Open the [Releases page](https://github.com/ghostofweb/makevideosmall/releases).
2. Download the latest `MakeVideoSmall-x.y.z-setup.exe`.
3. Run it. It installs for you only and does not ask for an administrator.

Windows 10 or 11, 64-bit. To update, download and run the newer installer; your settings, presets and queue are kept.

## How it is built

The whole app is Rust. There is no web view and no JavaScript.

| Part | What |
|---|---|
| Window | [Slint](https://slint.dev), drawn by its software renderer (`app/`) |
| Engine | A plain Rust library (`core/`): reading files, building ffmpeg commands, the queue, presets, analysis, picture tools |
| Media engine | [ffmpeg](https://ffmpeg.org) and ffprobe, run as separate programs |
| AI | [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) for enlarging; a U²-Net model through ONNX Runtime for background removal |

The engine owns everything that matters (the queue, presets, settings) and knows nothing about how the window is drawn. The window shows what the engine reports and passes on what people ask for.

```
app/                 the window
  ui/                what it looks like (.slint): theme, video, queue, pictures, main window
  src/
    main.rs          start-up, drag and drop, closing
    video.rs         the list of videos and the editor (simple and advanced)
    queue_ui.rs      the queue pane and what happens when it finishes
    pictures.rs      the picture tools
    settings_ui.rs   the Settings sheet
    fmt.rs           words, numbers and crop-box maths (unit-tested)
core/                the engine
  src/
    service.rs       the front door: one method per thing a person can ask for
    ffmpeg/          locate, probe, capabilities, command builder, progress parser, process runner
    queue.rs         ordering, pause/resume/cancel, persistence
    analysis.rs      black bars, noise, size estimates, the three choices and the suggestion
    image.rs         compress, fit a size, crop, enlarge
    background.rs    background removal
    presets.rs       built-in and saved presets, the simple choices
  tests/             runs real encodes through ffmpeg and checks the results
engine/              bundled tools and AI models
installer/           the Windows installer script (NSIS)
scripts/             fetch ffmpeg, build the installer
```

### Why Slint

Earlier versions drew the window with a web view (first Electron, then Tauri with WebView2). A web view costs several hundred megabytes of memory before the app does anything. Measured on the same PC, with the same engine underneath:

| | Electron (v2) | Tauri + WebView2 | Slint (now) |
|---|---|---|---|
| Memory with an empty window | 460–500 MB | about 480 MB | 53 MB |
| Memory with three videos loaded and one checked | | | 71 MB |
| Start to window | 2.8–3.9 s | 1.3–1.9 s | 0.1–0.35 s |
| Installer (without ffmpeg) | 166 MB | 63 MB | 66 MB |

Most of the installer is the two AI models, which is why it did not shrink further. The time to check a video is set by ffmpeg, not by the window, so that did not change either.

## Development

You need [Rust](https://rustup.rs) and the Microsoft C++ Build Tools ("Desktop development with C++"), and ffmpeg.

```powershell
git clone https://github.com/ghostofweb/makevideosmall.git
cd makevideosmall
powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1   # downloads ffmpeg + ffprobe into engine\ (not stored in git)
cargo run -p make-video-small
```

If you skip the fetch script, the app uses an ffmpeg found on your `PATH`.

| Command | What it does |
|---|---|
| `cargo run -p make-video-small` | Run the app |
| `cargo test --workspace` | Unit tests, plus tests that run real encodes through ffmpeg and check the results |
| `cargo build --release -p make-video-small` | The optimised program (`target\release\make-video-small.exe`) |
| `powershell -ExecutionPolicy Bypass -File scripts\package.ps1` | Build, then make the installer in `dist\` |

The real-encode tests are timing-sensitive (pause, cancel, restart). Run them on an otherwise idle PC.

`scripts\package.ps1` needs [NSIS](https://nsis.sourceforge.io) (`winget install NSIS.NSIS`) to make an installer; without it, it makes a zip of the program folder instead. The installer carries whatever is in `engine\`, so run the fetch script first if it should include its own ffmpeg.

### Checking the built program

The program can press its own buttons, for checks that need the real window. Set `MVS_AUTO` to a list of steps and `MVS_SNAPSHOT` to a file for pictures of the window; the steps are listed in `app/src/main.rs`. `MVS_DATA_DIR` points the app at a different settings folder so that a check never touches your own queue.

## Licences

The app's own code is under the licence in `license.txt`. It bundles and runs third-party software under their own licences: ffmpeg (GPL build), Real-ESRGAN ncnn Vulkan (MIT), ONNX Runtime (MIT), the U²-Net model from [rembg](https://github.com/danielgatis/rembg) (MIT; model weights Apache-2.0) and Slint (used under its royalty-free licence for desktop apps; see [slint.dev](https://slint.dev)).
