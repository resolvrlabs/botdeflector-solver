# Proof-of-work solver

The first step of a BotDeflector flow (`inv`) is a proof-of-work that requires finding a cycle in a graph. The computation is deterministic and involves no secret, so a client can perform it locally. This directory contains two implementations, which produce identical answers:

| Implementation | Path | Time per production token | Requirements |
| --- | --- | --- | --- |
| Rust library and command-line executable | [`rust/`](rust) | About 2 ms | Rust 1.88 or later, for building |
| TypeScript module | [`typescript/pow.ts`](typescript/pow.ts) | About 28 ms | Node.js 24, no dependencies |

Both implementations accept the `challengeToken` from `pow/get` and return the `solution` and `params` fields of the `pow/verify` request body.

## Rust

The following commands build the executable and pass a token to it:

```bash
cd pow/rust
cargo build --release
./target/release/botdeflector-pow "$CHALLENGE_TOKEN"
```

The executable prints the answer as JSON:

```json
{
  "elapsedMs": 2.716,
  "params": {
    "CYCLE_LENGTH": 8,
    "EDGES_BITS": 16,
    "GRAPH_SEED": "f1e1f665-d3be-4396-a669-4e57de25078b",
    "NODES_BITS": 14
  },
  "solution": [
    {
      "challenge": "2fa7283a…",
      "edgeIndices": [258, 3392, 23682, 15789, 36604, 7855, 23985, 373]
    }
  ]
}
```

The `solution` array contains one entry for each challenge in the token, usually three. The executable can also read the token, or a JSON document of the form `{"challenges": [...], "params": {...}}`, from standard input. The executable accepts two options: `--timeout-ms N` sets the time limit in milliseconds (5000 by default), and `--pretty` formats the output. The exit code is 0 if the challenge was solved, 1 for incorrect usage, 2 for invalid input, 3 if the parameters exceed the size limits, and 4 if no cycle was found or the time limit expired.

The following command installs the executable without cloning the repository:

```bash
cargo install --git https://github.com/resolvrlabs/botdeflector-solver botdeflector-pow
```

The solver can also be used as a library:

```bash
cargo add botdeflector-pow --git https://github.com/resolvrlabs/botdeflector-solver
```

```rust
let solved = botdeflector_pow::solve_challenge_token(&challenge_token, &Default::default())?;
let body = serde_json::to_value(&solved)?; // {"solution": [...], "params": {...}}
```

## TypeScript

```ts
import { solveChallengeToken } from "./pow.ts";

const { solution, params } = solveChallengeToken(challengeToken);
```

The module depends only on `node:crypto` and can be copied into another project. The reference client in [`poc/solve.ts`](../poc/solve.ts) uses this module to solve the proof-of-work.

## The algorithm

The payload of the challenge token, which is the middle segment of the JSON Web Token encoded in base64url, has the following form:

```json
{
  "challenges": ["2fa7283a…", "bdb76401…", "a49ed48d…"],
  "params": { "NODES_BITS": 14, "EDGES_BITS": 16, "CYCLE_LENGTH": 8 },
  "sessionId": "f1e1f665-d3be-4396-a669-4e57de25078b"
}
```

`GRAPH_SEED` is the `sessionId`. The token does not include `GRAPH_SEED` in `params`, but the graph depends on it, and the client must return it to `pow/verify` as part of `params`. Missing parameters default to 12, 13 and 6, respectively.

```
N = 2^NODES_BITS, E = 2^EDGES_BITS, L = CYCLE_LENGTH, seed = utf8(sessionId)

graph:
  for i in 0 .. E-1:
      h = sha256( u32_le(i) ++ seed )
      u = u64_le(h[0..8])  mod N
      v = u64_le(h[8..16]) mod N
      adjacency[u].append((v, i))
      adjacency[v].append((u, i))           # u's side first, then v's

for each challenge:
  start = u64_le( sha256( hex_decode(challenge) )[0..8] ) mod N
  for root in start, start+1, … (mod N):
      depth-first search from root, walking each adjacency list in order:
        - skip the neighbour you came from
        - skip neighbours already on the current path
        - go deeper only while depth + 1 < L
        - reaching root again at depth + 1 == L closes the cycle
      the first cycle found is the answer: its edge indices, in walk order
```

The answer must be the first cycle that this search finds. The following implementation errors lead to a different cycle:

| Error | Correct implementation |
| --- | --- |
| Hashing the hexadecimal string of the challenge | Hash the bytes that the hexadecimal string encodes |
| Using big-endian integers | Use little-endian integers for the 32-bit edge index and for both 64-bit reads |
| Building the adjacency lists in a different order | Build them in edge-index order, with the entry of `u` before the entry of `v` |
| Omitting `GRAPH_SEED` from `params` | Set `GRAPH_SEED` to the `sessionId` before solving, and send it back |

In JavaScript, the expression `u64_le(h[0..8]) mod N` does not require BigInt. Because N is a power of two, the result equals the low bits of the first four bytes.

## Test vectors

The file [`vectors.json`](vectors.json) contains two test vectors. The vector `live-accepted-2026-10-28` is a challenge whose answer Queue-it accepted, and the vector `reference-pow-js` matches the output of the widget's own solver. An implementation is correct if it reproduces both vectors exactly:

```bash
cd pow/rust && cargo test                 # Rust
node --test pow/typescript/pow.test.ts    # TypeScript
```

## Limits

Production challenges use the parameters 14, 16 and 8. Both solvers reject a `NODES_BITS` value outside the range 1 to 20, an `EDGES_BITS` value outside the range 0 to 20, and a `CYCLE_LENGTH` value outside the range 1 to 16 or greater than the number of nodes, because the search becomes exponential on a sparse graph with a long cycle. The Rust solver also stops when its time limit expires. Both solvers reject an empty list of challenges and any challenge that is not a hexadecimal string of even length.
