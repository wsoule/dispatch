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
- **Runs:** live runs first, each with its log and a cancel button.
- **Overseer:** the Mac's current Overseer conversation, streaming as it writes,
  with cards to confirm its actions and allow its tool calls.
- **Review:** finished runs to merge or discard, and the merge queue.
- **Mac:** connection status, switching between paired Macs, pairing another,
  and forgetting one.
