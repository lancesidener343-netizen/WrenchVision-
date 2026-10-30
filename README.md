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
  component set and labeled illustrative, plus links to the factory
  owner's manual and Honda's free parts catalog for the true exploded
  diagrams (EU7000is only, so far).
- A photo-anchored diagram (v12): after Generate, sam-3.1 locates
  each callout part in the user's actual photo, and the diagram area
  shows that photo with numbered gold markers on the located parts.
  A part SAM cannot see gets no marker, and when no part is located
  the diagram falls back to the schematic — never a guessed region
  presented as a part. Markers are detections, not verified part
  positions. A page reload has no photo in memory, so it renders the
  schematic; a follow-up keeps the photo markers only when the
  callout list is unchanged.
- (v13 fix): SAM prompts are simplified from full callout phrases to
  short nouns ("Display screen module" -> "screen", "Volume control
  potentiometer" -> "knob"), because SAM is weak with complicated
  phrases and strong with short ones. Marker numbers still match the
  original callout order; duplicate nouns are sent once, first
  callout wins.

## Demo machines

- **Main demo:** Honda EU7000is generator (live walkthrough).
- **Fallback demo case:** Cat 45 pump.

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
and start the server the same way as above.

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
  (v11), so a phone screenshot settles which build is running. On
  load, the page restores the job saved during this server run
  (GET /api/job), so leaving the app and coming back mid-job shows
  the manual instead of an empty form; starting the server is a
  clean slate — the saved job is wiped on startup.
- `app.js` — frontend logic and the API client. It talks only to this
  app's own backend and never handles an API key. Photos are
  downscaled to 1280px on the long edge before sending.
- `server.js` — Node backend (no external dependencies). Serves the
  frontend and calls the Meta Model API, standard tier, on the server
  side only. It keeps the current job in memory and saved to
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
- `.devcontainer/devcontainer.json` — one-click GitHub Codespace
  setup (Node 24, port 3000 forwarded as https).
