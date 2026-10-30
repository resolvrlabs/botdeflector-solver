import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { fixture, startMockQueueIt, type MockOptions } from "../mock-queueit.ts";
import { solve } from "../solve.ts";
import { startMockResolvr, TEST_API_KEY, type MockResolvrOptions } from "./mock-resolvr.ts";

interface RunOptions {
    queueit?: MockOptions;
    resolvr?: MockResolvrOptions;
    withoutKey?: boolean;
}

interface CapturedRequest {
    method: string;
    url: string;
    headers: { name: string; value: string }[];
}

const CLI_PATH = fileURLToPath(new URL("../cli.ts", import.meta.url));

// Node's fetch sets accept-encoding and content-length itself; the captured cookie was the browser's.
const NOT_SET_BY_THE_CLIENT = ["cookie", "accept-encoding", "content-length"];
const PER_FLOW_HEADERS = [
    "x-tt-flow-token",
    "x-tt-ch-flow-token",
    "x-tt-solution-tokens",
    "x-tt-client-fingerprint",
];

const expectedTask = {
    type: "botdeflector_image",
    params: {
        icons: fixture.icons.toString("base64"),
        background: fixture.background.toString("base64"),
    },
};

async function run(options: RunOptions = {}) {
    const queueit = await startMockQueueIt({ minWaitMs: 200, ...options.queueit });
    const resolvr = await startMockResolvr(options.resolvr);

    try {
        const result = await solve(queueit.pageURL, {
            fetch: queueit.fetch,
            apiKey: options.withoutKey ? undefined : TEST_API_KEY,
            resolvrURL: resolvr.url,
            bootMs: [0, 0],
            iconWaitMs: [220, 260],
        });
        return { result, queueit, resolvr };
    } catch (error) {
        return { error: error as Error, queueit, resolvr };
    } finally {
        await queueit.close();
        await resolvr.close();
    }
}

function perFlowValuesMasked([name, value]: [string, string]): [string, string] {
    return [name, PER_FLOW_HEADERS.includes(name) ? "(per flow)" : value];
}

test("solves the captured challenge, from the page to the flow result", async () => {
    const { result } = await run();

    assert.deepEqual(result, {
        token: fixture.flow.verifyFlow.ChallengeFlowResult,
        solvedTypes: "inv,icon",
    });
});

test("sends the widget's requests in its order, with its headers in their order", async () => {
    const { queueit } = await run();
    const captured: CapturedRequest[] = fixture.flow.requests;
    const capturedWithoutPreflights = captured.filter(request => request.method !== "OPTIONS");

    assert.equal(queueit.sent.length, capturedWithoutPreflights.length);

    for (const [index, sent] of queueit.sent.entries()) {
        const expected = capturedWithoutPreflights[index];
        const expectedHeaders = expected.headers
            .filter(header => !NOT_SET_BY_THE_CLIENT.includes(header.name))
            .map(header => perFlowValuesMasked([header.name, header.value]));

        assert.equal(`${sent.method} ${sent.url}`, `${expected.method} ${expected.url}`);
        assert.deepEqual(sent.headers.map(perFlowValuesMasked), expectedHeaders, expected.url);
    }
});

test("sends Resolvr the two images as served, and nothing else", async () => {
    const { resolvr } = await run();

    assert.deepEqual(resolvr.tasks, [expectedTask]);
});

test("reads the result from one poll, without sleeping first", async () => {
    const { result, resolvr } = await run();

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(resolvr.polls.length, 1);
});

test("polls again, at once, while the task is still running", async () => {
    const { result, resolvr } = await run({ resolvr: { runningFirst: true } });

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(resolvr.polls.length, 2);
    assert.ok(resolvr.polls[1] - resolvr.polls[0] < 200, "the second poll waited");
});

test("gets a fresh icon challenge when Resolvr has no confident answer", async () => {
    const { result, queueit, resolvr } = await run({ resolvr: { unsolvedFirst: 1 } });

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(queueit.state.iconGets, 2);
    assert.equal(resolvr.tasks.length, 2);
});

test("sends the same images again when the recognizer had no time for them", async () => {
    const { result, queueit, resolvr } = await run({ resolvr: { busyFirst: 1 } });

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(queueit.state.iconGets, 1);
    assert.deepEqual(resolvr.tasks, [expectedTask, expectedTask]);
});

test("submits again after a pause when the concurrency limit refuses the task", async () => {
    const { result, queueit, resolvr } = await run({ resolvr: { limitedFirst: 1 } });

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(queueit.state.iconGets, 1);
    assert.deepEqual(resolvr.tasks, [expectedTask, expectedTask]);
});

test("gets a fresh icon challenge when icon/verify declines the answer", async () => {
    const { result, queueit } = await run({ queueit: { declineFirst: 1 } });

    assert.equal(result?.solvedTypes, "inv,icon");
    assert.equal(queueit.state.iconGets, 2);
});

test("without an API key, the flow runs up to the Resolvr call and stops there", async () => {
    const { error, queueit } = await run({ withoutKey: true });

    assert.match(String(error?.message), /^Resolvr answered 401 ERROR_UNAUTHORIZED/);
    assert.ok(queueit.state.visitorID, "pow/verify accepted the answer");
    assert.equal(queueit.state.iconVerifies, 0);
});

test("npm run demo without RESOLVR_API_KEY says how to get one", async () => {
    const resolvr = await startMockResolvr();
    const { RESOLVR_API_KEY, ...environment } = process.env;

    try {
        const demo = await promisify(execFile)(process.execPath, [CLI_PATH, "--demo"], {
            env: { ...environment, RESOLVR_BASE_URL: resolvr.url },
        }).then(
            () => assert.fail("the demo succeeded without an API key"),
            (error: { code: number; stderr: string }) => error,
        );

        assert.equal(demo.code, 1);
        assert.match(demo.stderr, /pow\/verify accepted/);
        assert.match(demo.stderr, /Set RESOLVR_API_KEY: get a key at https:\/\/resolvr\.com/);
    } finally {
        await resolvr.close();
    }
});
