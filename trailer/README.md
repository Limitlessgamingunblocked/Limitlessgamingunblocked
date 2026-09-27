# Haunted Camcorder — trailer

A 64-second motion-design trailer built entirely from the game itself.

1. **capture.js** drives `haunted-camcorder.html` in headless Chromium and records
   in-engine shots frame by frame (`cap/<shot>/NNNN.jpg`).
2. **compose.html** is the edit: VHS compositing, kinetic type, case file, end card,
   plus a soundtrack synthesized with the Web Audio API (`renderAudio()`).
3. **render.js** renders every frame of `compose.html` and muxes it with the
   soundtrack into an MP4 via ffmpeg.

```sh
node capture.js cap                     # ~30 min in software GL
node render.js cap haunted-camcorder-trailer.mp4
```

Fonts (in `fonts/`): Anton, Special Elite, Cormorant Garamond, IBM Plex Mono —
all under the SIL Open Font License.
