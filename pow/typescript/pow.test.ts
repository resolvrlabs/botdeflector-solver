import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { solve, solveChallengeToken, type PowParams, type PowSolution } from "./pow.ts";

interface Vector {
    name: string;
    challengeToken?: string;
    params: PowParams;
    challenges: string[];
    expected: number[][];
}

const { vectors }: { vectors: Vector[] } = JSON.parse(
    readFileSync(new URL("../vectors.json", import.meta.url), "utf8"),
);

const production = { NODES_BITS: 14, EDGES_BITS: 16, CYCLE_LENGTH: 8, GRAPH_SEED: "seed" };

function edgeIndices(solved: PowSolution): number[][] {
    return solved.solution.map(solution => solution.edgeIndices);
}

function challengeToken(payload: object): string {
    return `e30.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

test("reproduces every vector exactly", () => {
    for (const vector of vectors) {
        const solved = solve(vector.challenges, vector.params);
        assert.deepEqual(edgeIndices(solved), vector.expected, vector.name);

        if (vector.challengeToken) {
            const fromToken = solveChallengeToken(vector.challengeToken);
            assert.deepEqual(fromToken.params, vector.params, `${vector.name}: GRAPH_SEED`);
            assert.deepEqual(edgeIndices(fromToken), vector.expected, vector.name);
        }
    }
});

test("refuses params outside 1–20 / 0–20 / 1–16, and a cycle longer than the graph", () => {
    const outOfRange = [
        { CYCLE_LENGTH: 0 },
        { CYCLE_LENGTH: 17 },
        { NODES_BITS: 0 },
        { NODES_BITS: 21 },
        { EDGES_BITS: -1 },
        { NODES_BITS: 2, CYCLE_LENGTH: 5 },
    ];

    for (const params of outOfRange) {
        assert.throws(
            () => solve(["ab"], { ...production, ...params }),
            /unsupported PoW complexity/,
            JSON.stringify(params),
        );
    }
});

test("refuses the challenges the Rust solver refuses", () => {
    assert.throws(() => solve([], production), /challenges must be a non-empty array/);

    for (const challenge of ["not hex", "abc", "0x12"]) {
        assert.throws(() => solve([challenge], production), /even-length hex string/, challenge);
    }
});

test("refuses a token that is not a challengeToken from pow/get", () => {
    const tokens = [
        "not a token",
        challengeToken({ challenges: ["ab"] }),
        challengeToken({ ico: "a.png", img: "b.webp", sessionId: "s", challengeType: "icon" }),
    ];

    for (const token of tokens) {
        assert.throws(
            () => solveChallengeToken(token),
            /not a challengeToken from pow\/get/,
            token,
        );
    }
});
