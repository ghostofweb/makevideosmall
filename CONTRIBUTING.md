# Contributing to Make Video Small

Thank you for your interest in improving Make Video Small. To maintain the quality and stability of this project, please follow these guidelines.

## Reporting Bugs
* **Check for existing issues:** Before opening a new issue, please search the issue tracker to see if the bug has already been reported.
* **Be specific:** Include your Windows version, your GPU model (NVIDIA/AMD), and the specific video format you were trying to compress.
* **Provide logs:** For a failed video, open the job's menu in the Queue, choose "Show log", and paste what "Copy log" gives you.

## Development Workflow
1. Fork the repository and create your branch from `main`.
2. Install Node.js 20+, Rust and the Microsoft C++ Build Tools (see the README).
3. Add tests for what you change, and run `npm run lint`, `npm test` and `npm run test:rust`.
4. Ensure the app builds locally using `npm run build` before submitting a Pull Request.

## Pull Request Guidelines
* Adhere to the existing coding style (TypeScript for the interface, Rust for the core).
* Provide a clear description of the changes or the specific bug being fixed.
* Update the documentation if you are adding new features or changing existing functionality.

All contributions are subject to review by the project maintainer.