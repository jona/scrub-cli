# Native download dependencies

Before running YouTube downloads, retrying failed downloads, or building an image,
check the latest stable yt-dlp release against official upstream metadata and
install it. Verify the version of the executable that Scrub will actually use.

- Run `npm run update:ytdlp:image` to refresh the image's hash-locked yt-dlp
  requirement from PyPI. `npm run build:image` performs this check automatically.
  Run it explicitly before raw Docker builds.
- For a local Homebrew installation, run `brew update` and `brew upgrade yt-dlp`,
  then compare `yt-dlp --version` with upstream. Homebrew can lag upstream; in
  that case use the following command and verify that its executable takes
  precedence on PATH:

  ```sh
  uv tool install --upgrade 'yt-dlp[default]' --default-index https://pypi.org/simple
  ```

  For a pip installation, upgrade `yt-dlp[default]` using its owning Python
  environment and verify that binary. Do not overwrite Homebrew-managed files.

- A running container retains the version it was built with. Rebuild its image
  with the current release before retrying downloads on an outdated image.
  Preserve completed videos and their artifacts when retrying failures.
- Keep dependency installation and release checks in operator/build tooling.
  The shared core and per-video pipeline functions must remain environment agnostic.
