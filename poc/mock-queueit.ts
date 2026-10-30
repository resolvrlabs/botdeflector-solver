import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { isDeepStrictEqual } from "node:util";
import type { Point } from "./resolvr.ts";
import type { Fetch, HeaderList } from "./solve.ts";

export interface MockOptions {
    /** icon/verify is refused sooner than this after icon/get. Default 2500. */
    minWaitMs?: number;
    /** Decline the first n icon answers. */
    declineFirst?: number;
}

const CHALLENGE_HOST = "dual.challenge.queue-it.net";
const FLOW_TOKEN_LIFE_SECONDS = 120;
const NEAR_ACCEPTED_PX = 12;

export const fixture = {
    page: readFixture("page.html").toString("utf8"),
    icons: readFixture("icon.png"),
    background: readFixture("bg.webp"),
    pow: readFixtureJSON("pow.json"),
    icon: readFixtureJSON("icon.json"),
    flow: readFixtureJSON("flow.json"),
};

/** True when every click lands within 12 px of the click Queue-it accepted. */
export function nearAccepted(solution: Point[]): boolean {
    const accepted: Point[] = fixture.icon.accepted.solution;

    return (
        Array.isArray(solution) &&
        solution.length === accepted.length &&
        solution.every(
            (point, index) =>
                Math.hypot(point.x - accepted[index].x, point.y - accepted[index].y) <=
                NEAR_ACCEPTED_PX,
        )
    );
}

/**
 * Starts a local page and challenge host that replay the challenge captured in poc/fixture. Pass
 * its `fetch` to the client: it records every request in `sent`, and the host checks each one as
 * Queue-it does, from the tokens and the PoW answer to the wait before icon/verify and the clicks.
 */
export async function startMockQueueIt(options: MockOptions = {}) {
    const { pow, icon, flow } = fixture;
    const minWaitMs = options.minWaitMs ?? 2500;
    const declineFirst = options.declineFirst ?? 0;

    const [tokenHeader, , tokenSignature] = flow.flowToken.split(".");
    const expiresAt = Math.floor(Date.now() / 1000) + FLOW_TOKEN_LIFE_SECONDS;
    const freshPayload = Buffer.from(JSON.stringify({ ...flow.flowPayload, exp: expiresAt }));
    const flowToken = `${tokenHeader}.${freshPayload.toString("base64url")}.${tokenSignature}`;
    const stepTokens = `${pow.response.token},${icon.response.token}`;
    const state = { visitorID: "", iconGets: 0, iconShownAt: 0, iconVerifies: 0 };

    const server = createServer(async (request, response) => {
        const [, host, ...path] = new URL(request.url ?? "/", "http://mock").pathname.split("/");
        const route = `${request.method} /${path.join("/")}`;
        const header = (name: string) => String(request.headers[name] ?? "");
        const answer = (value: unknown) =>
            response
                .writeHead(200, { "content-type": "application/json" })
                .end(JSON.stringify(value));
        const refuse = (reason: string) => response.writeHead(400).end(reason);

        if (host !== CHALLENGE_HOST) {
            if (route !== "GET /softblock/") {
                return response.writeHead(404).end();
            }

            return response.writeHead(200).end(fixture.page.replace(flow.flowToken, flowToken));
        }

        const body = request.method === "POST" ? await readJSONObject(request) : {};

        if (!body) {
            return refuse("the body is not a JSON object");
        }

        switch (route) {
            case "GET /pow/get":
                if (header("x-tt-flow-token") !== flowToken) {
                    return refuse("bad flow token");
                }

                return answer({ challengeToken: pow.challengeToken });

            case "POST /pow/verify":
                if (body.challengeToken !== pow.challengeToken) {
                    return refuse("bad challenge token");
                }

                if (body.challengeFlowToken !== flowToken) {
                    return refuse("bad flow token");
                }

                if (!body.solution_fingerprint) {
                    return refuse("no visitor ID");
                }

                if (!/^\d+\.\d{3}$/.test(body.time)) {
                    return refuse("bad time");
                }

                if (!isDeepStrictEqual(body.solution, pow.accepted.solution)) {
                    return refuse("wrong solution");
                }

                if (!isDeepStrictEqual(body.params, pow.accepted.params)) {
                    return refuse("wrong params");
                }

                state.visitorID = body.solution_fingerprint;
                return answer(pow.response);

            case "GET /icon/get":
                if (header("x-tt-flow-token") !== flowToken) {
                    return refuse("bad flow token");
                }

                state.iconGets++;
                state.iconShownAt = Date.now();
                return answer({ challengeToken: icon.challengeToken });

            case `GET /icons/${icon.payload.lib}/ico/${icon.payload.ico}`:
                return response.writeHead(200).end(fixture.icons);

            case `GET /icons/${icon.payload.lib}/bgnd/${icon.payload.img}`:
                return response.writeHead(200).end(fixture.background);

            case "POST /icon/verify":
                state.iconVerifies++;

                if (body.challengeToken !== icon.challengeToken) {
                    return refuse("bad challenge token");
                }

                if (body.challengeFlowToken !== flowToken) {
                    return refuse("bad flow token");
                }

                if (body.solution_fingerprint !== state.visitorID) {
                    return refuse("visitor ID changed");
                }

                if (Date.now() - state.iconShownAt < minWaitMs) {
                    return refuse("answered too soon");
                }

                if (!Number.isInteger(body.time)) {
                    return refuse("bad time");
                }

                if (state.iconVerifies <= declineFirst || !nearAccepted(body.solution)) {
                    return refuse("wrong answer");
                }

                return answer(icon.response);

            case "GET /verify-flow":
                if (header("x-tt-ch-flow-token") !== flowToken) {
                    return refuse("bad flow token");
                }

                if (header("x-tt-client-fingerprint") !== state.visitorID) {
                    return refuse("visitor ID changed");
                }

                if (header("x-tt-solution-tokens") !== stepTokens) {
                    return refuse("missing step tokens");
                }

                return answer(flow.verifyFlow);
        }

        response.writeHead(404).end();
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const mockOrigin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const sent: { method: string; url: string; headers: HeaderList }[] = [];

    const fetchThroughMock: Fetch = (url, init) => {
        sent.push({ method: init.method ?? "GET", url, headers: init.headers });
        const { host, pathname, search } = new URL(url);
        return globalThis.fetch(`${mockOrigin}/${host}${pathname}${search}`, init);
    };

    return {
        pageURL: flow.pageUrl as string,
        fetch: fetchThroughMock,
        sent,
        state,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close(error => (error ? reject(error) : resolve())),
            ),
    };
}

function readFixture(name: string): Buffer {
    return readFileSync(new URL(`fixture/${name}`, import.meta.url));
}

function readFixtureJSON(name: string) {
    return JSON.parse(readFixture(name).toString("utf8"));
}

async function readJSONObject(request: IncomingMessage): Promise<Record<string, any> | undefined> {
    const chunks: Buffer[] = [];

    for await (const chunk of request) {
        chunks.push(chunk);
    }

    try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        return typeof body === "object" && body !== null ? body : undefined;
    } catch {
        return undefined;
    }
}
