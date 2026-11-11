# Make Video Small

Make your videos and pictures smaller, on your own PC.

Add a video and the app tries three sizes on it. You see how big each one will be, how it will look next to the original, and which one it suggests. Pick one and you're done. Nothing is uploaded, there is no account, and it is free.

![Make Video Small](./screenshot.png)

## Download

**[Download the latest version for Windows](https://github.com/ghostofweb/makevideosmall/releases/latest)**: get `MakeVideoSmall-3.0.0-setup.exe` and run it.

- Windows 10 or 11, 64-bit.
- It installs for you only and does not ask for an administrator password.
- Everything it needs is inside, including ffmpeg. Nothing else to install.

Windows may show "Windows protected your PC" the first time, because the app is new and not signed by a company. Click **More info**, then **Run anyway**.

## What it does

### Videos

- **Three sizes, measured on your video.** Best quality, Balanced and Smallest each show the size your file will become, how much smaller that is, how it will look, and how long it takes. One is marked as suggested.
- **See before you choose.** A frame of your video and the same frame at the chosen size sit side by side. Drag the line between them to compare.
- **Cut** the start or end off a video.
- **Join** several videos into one. Tick them in the order they should play.
- **Black bars are removed** by themselves when a video has them.
- **A queue.** Add a whole folder and leave it. Pause, reorder or cancel whenever you like. It is remembered if you close the app, and it can turn the PC off when it is done.
- **Fast on a graphics card.** NVIDIA, AMD and Intel graphics are used when your PC has them. One setting switches to the processor instead, for the smallest possible files.
- **Every control, if you want it.** Turn on **Advanced** to choose the exact format, quality, file size, resolution, sound tracks, subtitles and filters yourself, and save your own presets.

### Pictures

- **Make smaller**, as WebP, JPEG, AVIF or PNG.
- **Fit a size**, for upload forms that reject big files.
- **Crop**, free or to a fixed shape.
- **Remove the background**, keeping only the person or object.
- **Make bigger**, four times, with AI filling in the detail (needs a graphics card).

Your originals are never changed. Camera details and GPS location are never copied into the results.

## How to use it

1. **Add a video.** Drag it onto the window, or click **Add videos**. The app tries the three sizes on short pieces of it; this takes about a minute.
2. **Pick a size.** Look at the numbers and the picture, and click the one you want. The suggested one is a good choice if you are not sure.
3. **Add it to the queue** and click **Start**. The smaller copy appears next to the original, with `_small` at the end of its name.

For pictures, switch to **Pictures** at the top, add them, pick a tool on the right, and click the big button.

## Questions

**Is it really free?**
Yes. It is open source under the MIT licence. No account, no trial, no paid version, and nothing that reports back.

**Does anything get uploaded?**
No. Everything happens on your PC. It works with the internet switched off.

**Will my video look worse?**
That depends on the size you pick, and you see it before you start. Each choice tells you in plain words how close it is to the original.

**Where do the finished files go?**
Next to the original by default. In **Settings** you can choose one folder for everything, or change what is added to the name.

**Is there a Mac or Linux version?**
Not yet.

**I had version 2. What changed?**
Version 3 was rewritten from scratch. It opens in a fraction of a second, uses a ninth of the memory, and adds cutting, joining, cropping and background removal. You can remove version 2 from **Settings > Apps > Installed apps**.

## Rewritten in Rust

Version 2 was built with Electron and Python: a web browser and a Python runtime inside the app. Version 3 is one Rust program, with its window drawn by [Slint](https://slint.dev). Measured on the same laptop:

| | Version 2 | Version 3 |
|---|---|---|
| Memory with an empty window | about 480 MB | 53 MB |
| Time to open | 2.8 – 3.9 s | 0.12 – 0.35 s |

Rust runs everything you click on and wait for: reading your files, working out the right settings, the queue, pausing and cancelling. The encoding itself is done by [ffmpeg](https://ffmpeg.org), which is the best tool there is for that job.

## For developers

You need [Rust](https://rustup.rs) and the Microsoft C++ Build Tools ("Desktop development with C++"), and ffmpeg on your `PATH` or in `engine\`.

```powershell
git clone https://github.com/ghostofweb/makevideosmall.git
cd makevideosmall
cargo run -p make-video-small
```

| Command | What it does |
|---|---|
| `cargo run -p make-video-small` | Run the app |
| `cargo test --workspace` | Unit tests, plus tests that run real encodes through ffmpeg and check the results |
| `cargo build --release -p make-video-small` | The optimised program, in `target\release\` |
| `powershell -ExecutionPolicy Bypass -File scripts\package.ps1` | Build, then make the installer in `dist\` |
| `powershell -ExecutionPolicy Bypass -File scripts\fetch-ffmpeg.ps1` | Put ffmpeg in `engine\` so the installer includes it |

The real-encode tests pause, cancel and restart encodes against the clock, so run them on an otherwise idle PC. Making the installer needs [NSIS](https://nsis.sourceforge.io) (`winget install NSIS.NSIS`); without it the script makes a zip instead.

```
app/        the window: Slint interface (ui/) and the Rust behind it (src/)
core/       the engine: ffmpeg commands, queue, presets, analysis, picture tools
            core/src/service.rs is the front door; core/tests/ runs real encodes
engine/     bundled tools and AI models
installer/  the Windows installer script
scripts/    fetch ffmpeg, build the installer
```

The engine knows nothing about the window, and the window knows nothing about ffmpeg. Every ffmpeg command comes from one pure function, `plan()` in `core/src/ffmpeg/command.rs`, which is tested without running ffmpeg.

The built program can drive itself for automated checks: set `MVS_AUTO` to a list of steps and `MVS_SNAPSHOT` to a file for pictures of the window (the steps are listed in `app/src/main.rs`). `MVS_DATA_DIR` points it at a different settings folder so a check never touches your own queue.

Contributions are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).

## Licences

Make Video Small is under the MIT licence (`license.txt`). It includes other software under its own licence:

- [ffmpeg](https://ffmpeg.org), GPL v3 build from [gyan.dev](https://www.gyan.dev/ffmpeg/builds/)
- [Real-ESRGAN ncnn Vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan), MIT
- [ONNX Runtime](https://github.com/microsoft/onnxruntime), MIT
- the U²-Net model from [rembg](https://github.com/danielgatis/rembg), MIT, weights Apache-2.0
- [Slint](https://slint.dev), under its royalty-free licence for desktop apps

The full list ships with the app in `engine\THIRD-PARTY.txt`.

Made by [Sahiljeet Singh Kalsi](https://ghostofweb.vercel.app/).
