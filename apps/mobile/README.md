# Dispatch for iPhone

Answer agents, watch runs and merge work from your phone, through the hosted
relay. No VPN, and no Dispatch token on the phone. The design is in
`docs/specs/2026-11-06-remote-access-design.md`.

## Run it

You need Xcode for a device or simulator build.

```sh
pnpm install
pnpm --filter "@dispatch/mobile^..." run build   # @dispatch/client and @dispatch/remote
cd apps/mobile
pnpm ios                                         # expo run:ios
```

To check the app bundles without Xcode (CI runs this on every PR that touches
the app or a package it uses):

```sh
moon run mobile:build                            # expo export for iOS into dist/
```

The colours come from the desktop's tokens. After changing
`packages/ui/src/styles/tokens.css`, regenerate them (a test fails until you
do):

```sh
moon run mobile:theme
```

Then pair: on the Mac open Dispatch › Settings › Devices and choose **Show
code** under iPhone (or run `dispatch phone pair` in your project), and scan the
code from the app. A phone can pair with several Macs and switch between them in
the Mac tab. Until the hosted relay is up, run one locally and point the daemon
at it:

```sh
bun run apps/remote-relay/src/main.ts                # listens on :8080
DISPATCH_REMOTE_RELAY=ws://<your-mac's-ip>:8080 dispatchd
```

## What it does

- **Needs you:** tool approvals, scope requests, questions, and the Overseer's
  proposed actions. The tab's badge counts them.
- **Runs:** the tasks ready to start, each with Start, then live runs, each with
  its log and a cancel button. **New** writes a task: the first line is its
  title, and Save and start runs it straight away.
- **Overseer:** the Mac's current Overseer conversation, streaming as it writes,
  with cards to confirm its actions and allow its tool calls.
- **Review:** finished runs to merge or discard, and the merge queue.
- **Mac:** connection status, switching between paired Macs, pairing another,
  and forgetting one.

## Send a page from Safari

Until the app has its own share extension, an iOS Shortcut can send a page into
a new task. Make a shortcut that shows in the share sheet, takes Safari web
pages, and opens this URL, with each value URL-encoded:

```text
dispatch-remote://task/new?title=<page title>&url=<page URL>
```

`text=<anything>` works too. The link only fills in the New task screen. Nothing
is saved or started until you tap.
