# Instructions for AI agents

This repository shows how to solve Queue-it's BotDeflector challenge. The proof-of-work is solved locally with the open-source solver, and the icon step is solved with the Resolvr API. If you have been asked to add BotDeflector support to a codebase, follow the instructions in this file.

## 1. Read the documentation

| File | What to take from it |
| --- | --- |
| [README.md](README.md) | The four steps of a flow |
| [poc/solve.ts](poc/solve.ts) | The reference client. Reproduce its requests exactly: the endpoints, the header names and their order, the body fields and their types, and the waiting times. |
| [pow/README.md](pow/README.md) | The proof-of-work solver: how to build and call it, the algorithm, and the test vectors |
| [docs/icon-api.md](docs/icon-api.md) | The Resolvr API: the request, the response, polling, and errors |

If the repository has not been cloned, fetch these files from `https://raw.githubusercontent.com/resolvrlabs/botdeflector-solver/main/<path>`.

## 2. Integrate the solver

1. Find the place where the codebase loads the page that displays the widget, or where it obtains the flow token (`botDeflectorJwtToken`). Use the existing HTTP client, proxies and cookies of the codebase, and ask before replacing any of them.
2. Choose the proof-of-work solver according to the language of the codebase:
   - In Rust, use the library: `cargo add botdeflector-pow --git https://github.com/resolvrlabs/botdeflector-solver`.
   - In TypeScript or JavaScript, copy `pow/typescript/pow.ts`.
   - In any other language, build the Rust executable (`cd pow/rust && cargo build --release`) and run it with the `challengeToken` from `pow/get`. The executable prints the `solution` and `params` for `pow/verify` in about 4 ms per call, including the start of the process. Port the algorithm only if the user asks for a port.
3. For the icon step, send both images to `POST https://api.resolvr.com/v1/task` and read the result from `GET /v1/task/{task_id}`, as described in docs/icon-api.md. The result request waits on the server for up to 5 seconds, so give it a read timeout of 10 seconds or more, and never pause between requests. Read the API key from the `RESOLVR_API_KEY` environment variable, and never hardcode, log or commit it.
4. Follow the rules below. The reference client in poc/solve.ts follows all of them.
   - Every request of a flow carries the same visitor ID and the same set of headers.
   - The challenge host is taken from the `botDeflectorSource` value of the page.
   - A flow starts only if the flow token remains valid for more than 10 seconds. The flow token is valid for 120 seconds.
   - `icon/verify` is sent 2.7 to 3.3 seconds after `icon/get`, and never sooner than 2.5 seconds. The request to Resolvr takes place within this waiting period.
   - After `ERROR_RECOGNITION_UNSOLVED` or a rejected `icon/verify`, the client requests a new challenge from `icon/get`, and it gives up after three attempts. After `ERROR_RECOGNITION_BUSY`, `ERROR_INTERNAL`, HTTP status 429 or HTTP status 503, the client sends the same images again. Every failed task is refunded.
   - The `data.points` returned by Resolvr are sent to `icon/verify` unchanged, as its `solution`.

If the codebase already solves the proof-of-work, implement only the icon step.

## 3. Verify the integration

Write the following tests and run them before any live traffic:

1. **Proof-of-work:** Every vector in `pow/vectors.json` is reproduced exactly, including the vector that is solved from its `challengeToken`.
2. **Icons:** When `poc/fixture/icon.png` and `poc/fixture/bg.webp` are sent to the API, the returned points lie within 12 pixels of `accepted.solution` in `poc/fixture/icon.json`. This test requires `RESOLVR_API_KEY` and is skipped without it.
3. **Complete flow, offline:** Replay the challenge captured in `poc/fixture`. The file `flow.json` lists every request that the browser sent, in order and with its headers, and the files `pow.json`, `icon.json` and `flow.json` contain the responses that Queue-it gave. Replace the HTTP layer of the client with a stub that returns these responses. Then check that the client sends the same requests in the same order with the same header names, sends the proof-of-work answer in `pow.json` (`accepted.solution`), uses one visitor ID throughout, and sends `icon/verify` no sooner than 2.5 seconds after `icon/get`. Without `RESOLVR_API_KEY`, answer the icon step with `accepted.solution` from `icon.json`. In a TypeScript or JavaScript codebase, use `startMockQueueIt()` from `poc/mock-queueit.ts` instead, as `poc/test/solve.test.ts` does. Pass its `fetch` function as the transport of the client; the stand-in then checks every request and rejects incorrect ones. `npm run demo` runs the reference client through the same replay.

## Working on this repository

- `npm test` runs the offline tests, `npm run check` checks the types and the formatting, `cd pow/rust && cargo test` tests the Rust solver, and `RESOLVR_API_KEY=... npm run test:live` calls the live API.
- The Rust and TypeScript solvers must continue to give identical answers.
- `poc/fixture` and `pow/vectors.json` contain real captured values. Do not change or regenerate them.
