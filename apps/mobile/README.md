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

Then on the Mac, in your project:

```sh
dispatch phone pair
```

and scan the code from the app. Until the hosted relay is up, run one locally
and point the daemon at it:

```sh
bun run apps/remote-relay/src/main.ts                # listens on :8080
DISPATCH_REMOTE_RELAY=ws://<your-mac's-ip>:8080 dispatchd
```

## What it does

- **Needs you:** tool approvals, scope requests and questions from runs.
- **Runs:** live runs first, each with its log and a cancel button.
- **Review:** finished runs to merge or discard, and the merge queue.
- **Mac:** connection status, and forgetting the Mac on this phone.
