# Bundled stamp fonts

These fonts ship with the app so legacy-certificate stamp text renders on
servers with no system fonts (production previews rendered every stamp field
as tofu boxes when the renderer found no usable font). `ensureStampFonts()`
in `src/lib/legacy-certificate-files.ts` points fontconfig at this directory
before the first stamp render.

- `LiberationSans-*` — the SVG asks for `Arial`; fontconfig maps Arial to
  Liberation Sans (metric-compatible). SIL Open Font License 1.1.
- `NotoNaskhArabic-*` — the SVG asks for `Noto Naskh Arabic` for Arabic
  stamp fields. SIL Open Font License 1.1.

Both families are free to redistribute under the OFL.
