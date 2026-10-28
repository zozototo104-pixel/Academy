# Stamp fonts — where they live

The stamp fonts are NOT stored as `.ttf` files in this directory: the
deployment's push tooling cannot transfer binary files. Instead they are
embedded as base64 in `src/lib/stamp-fonts-data.ts` (Liberation Sans for
the SVG's `Arial`, Noto Naskh Arabic for Arabic stamp fields — both SIL
Open Font License 1.1, free to redistribute).

At runtime `ensureStampFonts()` in `src/lib/legacy-certificate-files.ts`
decodes them to a temp directory and points fontconfig there, so stamp
text renders even on servers with no system fonts (production previews
rendered every stamp field as tofu boxes when the renderer found no
usable font).
