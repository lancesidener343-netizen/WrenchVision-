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
- A step list for the repair. Every step carries one of three labels:
  - **verified** — confirmed from the machine's own evidence,
  - **inferred** — reasoned from what is visible,
  - **illustrative** — a diagram-level illustration, not a confirmed fact.
- A spoken walkthrough that reads the steps aloud on the device.
- A parts list page (every part needed, each identified and labeled).
- Follow-up updates: type extra symptoms, corrections, or
  confirmations and the manual updates on the same job.
- A schematic diagram in the diagram area, drawn from the factory
  component set and labeled illustrative, plus links to the factory
  owner's manual and Honda's free parts catalog for the true exploded
  diagrams (EU7000is only, so far).

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

- `index.html` — mobile-first single page: camera capture with
  file-upload fallback, photo preview, job description input with voice
  input, and the results area. The page footer shows the app version
  (v5), so a phone screenshot settles which build is running.
- `app.js` — frontend logic and the API client. It talks only to this
  app's own backend and never handles an API key. Photos are
  downscaled to 1280px on the long edge before sending.
- `server.js` — Node backend (no external dependencies). Serves the
  frontend and calls the Meta Model API, standard tier, on the server
  side only. It keeps the current job in memory and saved to
  `wrenchvision-job.json`, so a server restart does not wipe it.
  For a Honda EU7000is it also grounds generation in a compact
  factory reference from the 2023 owner's manual.
- `.devcontainer/devcontainer.json` — one-click GitHub Codespace
  setup (Node 24, port 3000 forwarded as https).
