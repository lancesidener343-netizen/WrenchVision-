# WrenchVision

A mobile web app that turns a phone photo of a machine into an
exploded-view repair manual with a spoken step-by-step walkthrough.

## What it does

**Inputs**

- A photo of the machine — taken with the phone camera or uploaded from
  the photo library.
- A description of the job — typed, or spoken into the phone's microphone.

**Outputs**

- The identified machine.
- An exploded-view diagram area with numbered callouts naming the parts.
- A Problem section up top (the reported problem + the most likely
  cause), with the step list below it as the solution. Every step
  carries one of three labels:
  - **verified** — confirmed from the machine's own evidence,
  - **inferred** — reasoned from what is visible,
  - **illustrative** — a diagram-level illustration, not a confirmed fact.
  For a Honda EU7000is, steps the factory manual covers are built
  from the manual and labeled verified; steps it does not cover stay
  inferred, never dressed up as book text.
- A troubleshooting section: for the reported problem, the likely
  causes in order with the check that confirms or rules out each
  one, each labeled the same way.
- A parts list page (every part needed, each identified and labeled,
  with the real manufacturer part number whenever it is verified —
  never guessed).
- A New job button that clears the form and the saved job mid-run,
  so the next job starts from a clean slate without restarting the
  server.
- An offline queue: a job that cannot reach the server is held on
  the phone and sent when the network is back, instead of being lost.
- A spoken walkthrough that reads the steps aloud on the device.
- Follow-up updates: type extra symptoms, corrections, or
  confirmations and the manual updates on the same job.
- A schematic diagram in the diagram area, drawn from the factory
  component set and labeled illustrative, plus a link to the factory
  owner's manual whenever one is verified for the machine, and Honda's
  free parts catalog for the true exploded diagrams (EU7000is only).
- A photo-anchored diagram (v12): after Generate, sam-3.1 locates
  each callout part in the user's actual photo, and the diagram area
  shows that photo with numbered gold markers on the located parts.
  A part SAM cannot see gets no marker, and when no part is located
  the diagram falls back to the schematic — never a guessed region
  presented as a part. Markers are detections, not verified part
  positions. A page reload restores the job's photo with its markers
  (v28); a follow-up keeps the photo with the rebuilt manual.
- (v13 fix): SAM prompts are simplified from full callout phrases to
  short nouns ("Display screen module" -> "screen", "Volume control
  potentiometer" -> "knob"), because SAM is weak with complicated
  phrases and strong with short ones. Marker numbers still match the
  original callout order; duplicate nouns are sent once, first
  callout wins.
- Look (v15, v18): black titanium + gold theme, the real logo art
  (eye + drip wordmark) in the header, and a gold wrench mark on
  every clickable button.
- Diagram upgrades (v16, v17): part-name label chips on the photo,
  leader lines from marker to label, tap-to-zoom with captions, and
  SAM mask outlines that trace real part edges where a valid mask
  exists (otherwise an honest gold box). Labels stay clamped inside
  the photo.
- Live camera eye viewfinder (v18–v21, secure contexts only): on
  https, a Live camera button opens the camera framed by the eye —
  since v21, the logo eye artwork itself, with a transparent center,
  so the camera shows straight through the middle. Take photo feeds
  the same path as the file picker. On plain http the button does
  not appear and the file-picker camera path is unchanged.
- Low-memory photo fix (v19): the file-picker path decodes via
  createImageBitmap straight to a ≤1280px canvas and releases the
  bitmap at once, instead of holding the full file in memory at the
  camera→browser handoff.
- Factory-manual search (v22): after the app identifies the
  machine, it looks for that exact model's factory owner's manual
  from an official source, reads it, and grounds the steps in it —
  specs the book covers are labeled verified, everything else stays
  inferred, and the app links the official book (link only, never
  copied). A book is only used when its fetched text names the
  identified model and reads as a manual; anything else falls back
  to today's behavior (all inferred, no link), so a failed search
  never breaks the manual. The Honda EU7000is keeps its built-in
  reference.
- Badge integrity (v23): a "verified" badge now requires a verified
  factory reference behind it — the factory-manual link or reference
  slices from a verified book. When no book verifies for a job, the
  server rewrites any verified labels to inferred, on the first
  manual and on every follow-up, so a badge can never outrun its
  source. Jobs with a verified book (and the Honda EU7000is built-in
  reference) are unchanged. Candidate proposals are also steered
  (v23) toward the manufacturer's site first, then ManualsLib,
  Manuals.plus, the Internet Archive Manuals Library, iFixit, and
  ManualsOnline — steering only; every candidate is still verified
  by fetch.
- Step completion (v24): steps the user says are done — in a
  follow-up ("completed all 7 steps", "step 8 corrected the
  issue") or by tapping a step's Mark done control — carry a
  distinct ✓ Done marker that is separate from the
  verified/inferred badge: a done step on a no-book job stays
  inferred, a done step on a verified job stays verified.
  Completion never changes a badge, and a badge never implies
  completion. Done state persists in the saved job, restores on
  load, and clears on New Job. The follow-up response states
  which steps it newly marked done, so a mis-marking is visible
  and tappable to correct.
- Cosmetics (v25): the WrenchVision eye mark sits as a fixed,
  centered page background (faded to 0.16 opacity) that stays put
  while the cards scroll over it; cards are translucent so the
  logo shows through them as they move, while the machine photo,
  diagram area, buttons, and inputs stay fully opaque and text
  stays readable. The camera caption under the photo ("Photo of
  your machine — gold markers…") is removed, the broken
  voice-input ("Speak it") button is removed (the spoken
  walkthrough is untouched), and the photo section gains a
  clearly labeled "Upload a photo" button — the same file-picker
  attach path as the camera button, but without the camera
  capture hint, so the chooser offers existing photos when a
  picture can't be taken.
- Cosmetics (v26): the cards get more see-through (card and speak-bar
  backgrounds from 0.70 down to 0.50 alpha) so the fixed eye shows
  through them clearly while scrolling; the eye layer itself is
  unchanged, and the photo, diagram area, buttons, and inputs stay
  fully opaque with text still readable.

## Demo machines

- **Main demo:** Honda EU7000is generator (live walkthrough).
- **Fallback demo case:** Cat 45 pump.
- **Also proven in testing:** Hicall C100 Pro live sound card,
  identified from the photo alone, with photo-anchored diagrams,
  follow-up updates, parts list, and spoken walkthrough.

## Run it locally

```sh
cd ~/workspace/wrenchvision-app
node server.js
```

Then open http://localhost:3000 on the phone or computer.

To run it over https instead — which the phone camera and microphone
need, since both stay silent on a plain http:// address — open this
repo in a GitHub Codespace: the forwarded port 3000 comes up as https
and the camera and mic work. In the Codespace terminal, set the key
and start the server the same way as above. On https, a Live camera
button also appears, framing the camera view with the eye (see
above).

Live-camera frame file: the overlay loads `eye-frame.png` from the
app directory (the logo eye with a transparent center). If it is not
in your copy, place it alongside `server.js` — without it the overlay
still works, just without the frame.

To enable live manual generation, set the Meta Model API key as an
environment variable before starting the server:

```sh
META_API_KEY=your-key-here node server.js
```

The key is never stored in this repo, never sent to the browser, and
never shown in the app. Without a key, the app reports clearly that the
key is not configured instead of showing a manual.

## Files

- `index.html` — mobile-first single page: one Open camera button
  (the phone's camera, via the file picker), photo preview, job
  description input with voice input, and the results area. The page footer shows the app version
  (v28), so a phone screenshot settles which build is running. On
  load, the page restores the job saved during this server run
  (GET /api/job), so leaving the app and coming back mid-job shows
  the manual instead of an empty form; starting the server is a
  clean slate — the saved job is wiped on startup.
- `app.js` — frontend logic and the API client. It talks only to this
  app's own backend and never handles an API key. Photos are
  downscaled to 1280px on the long edge before sending.
- `server.js` — Node backend (no external dependencies). Serves the
  frontend and calls Meta's models on the server side only: Muse Spark 1.3 (standard tier) for Generate-Scan-Fix manual generation, and SAM 3.1 for photo diagrams. It keeps the current job in memory and saved to
  `wrenchvision-job.json`, so leaving the app and coming back
  mid-job restores it; a server start wipes the saved job (clean
  slate), and GET /api/job returns the current run's job for the
  page-load restore.
  For a Honda EU7000is it also grounds generation in a compact
  factory reference from the 2023 owner's manual, and that
  reference is the truth for specs and for every step it covers.
  v11 shapes the manual problem/solution, adds verified part
  numbers, a troubleshooting section, a New job button, and the
  offline queue; Generate waits for the photo and retries once on
  empty model output, and errors render as errors, not steps.
  v12–v13 add SAM photo diagrams; v16–v17 add the diagram upgrades
  (labels, leader lines, zoom, mask outlines); v21 serves the
  live-camera frame image; v22 adds factory-manual search +
  grounding (verified book or fallback to inferred); v23 adds
  badge-integrity enforcement (verified labels require a verified
  factory reference, else they become inferred); v24 adds
  step-completion (done) markers, separate from badges; v25 adds
  the fixed centered logo background + translucent cards, removes
  the camera caption and the Speak-it button, and adds the
  Upload-a-photo button; v26 makes the cards more see-through
  (0.70 down to 0.50 alpha) so the fixed eye shows through better;
  v27 replaces the eye-only background with the full logo (eye +
  wrench + wordmark), white background removed to transparency, in
  a portrait contain box so nothing is cut off; v28 keeps the job's
  photo with the job, so a reload restores the picture (with its
  markers) instead of falling back to the boxed schematic — jobs
  that never had a photo still render the schematic as before.
- `diagram-upgrades.js` / `diagram-upgrades.css` — client-only
  plug-in for the diagram upgrades (labels, leader lines,
  tap-to-zoom, SAM mask outlines). No loop logic lives here.
- `eye-frame.png` — the live-camera frame image (logo eye, center
  transparent), loaded by the overlay on secure contexts. See the
  run-it-locally note above if it is missing from your copy.
- `.devcontainer/devcontainer.json` — one-click GitHub Codespace
  setup (Node 24, port 3000 forwarded as https).
