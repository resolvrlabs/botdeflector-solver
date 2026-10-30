# Proof of concept

This directory contains a TypeScript client that completes a BotDeflector flow from beginning to end. The client takes the address of a page that displays the widget and returns the flow result token. The client solves the proof-of-work locally with [`pow/typescript`](../pow/typescript/pow.ts) and obtains the positions of the icons from the [Resolvr API](../docs/icon-api.md). The client requires Node.js 24 and has no other dependencies.

```bash
export RESOLVR_API_KEY=...    # API key for the icon step, from https://resolvr.com/?ref=github
npm run demo                  # replays the captured challenge against a local challenge host
npm run poc -- "<page url>"   # solves the challenge on a page that displays the widget
```

| File | Content |
| --- | --- |
| [`solve.ts`](solve.ts) | The flow, with one function for each step |
| [`resolvr.ts`](resolvr.ts) | The request to the Resolvr API |
| [`cli.ts`](cli.ts) | The command-line interface behind `npm run poc` and `npm run demo` |
| [`mock-queueit.ts`](mock-queueit.ts) | The local page and challenge host of the demonstration, which replay `fixture/` and check every answer |
| [`fixture/`](fixture) | A challenge captured from a browser session: the page, the proof-of-work and icon challenges, the answers that Queue-it accepted, and every request with its headers |
| [`test/`](test) | The tests. `npm test` replays the fixture against `mock-queueit.ts` and a local substitute for the Resolvr API, and `npm run test:live` sends the captured images to the Resolvr API. |

The proof of concept processes one flow at a time, makes one attempt per flow token and stops at the first error. A production client would use its own HTTP stack and session handling, and would add concurrency and retries across flows.
