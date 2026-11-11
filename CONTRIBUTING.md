# Contributing to Make Video Small

Thank you for your interest in improving Make Video Small. To maintain the quality and stability of this project, please follow these guidelines.

## Reporting Bugs
* **Check for existing issues:** Before opening a new issue, please search the issue tracker to see if the bug has already been reported.
* **Be specific:** Include your Windows version, your GPU model (NVIDIA/AMD/Intel), and the specific video format you were trying to compress.
* **Provide logs:** For a failed video, choose "Log" on it in the Queue, then "Copy log", and paste the result.

## Development Workflow
1. Fork the repository and create your branch from `main`.
2. Install Rust and the Microsoft C++ Build Tools, and have ffmpeg on your PATH (see the README).
3. Add tests for what you change, and run `cargo test --workspace`.
4. Ensure the app builds and starts with `cargo run -p make-video-small` before submitting a Pull Request.

## Pull Request Guidelines
* Keep the engine (`core/`) free of anything about how the window is drawn, and keep the window (`app/`) free of ffmpeg details.
* The default view must stay usable without reading anything twice; detail belongs behind the Advanced switch.
* Provide a clear description of the changes or the specific bug being fixed.
* Update the documentation if you are adding new features or changing existing functionality.

All contributions are subject to review by the project maintainer.
