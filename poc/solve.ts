import { randomBytes } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { solveChallengeToken } from "../pow/typescript/pow.ts";
import { solveIcons } from "./resolvr.ts";

export type HeaderList = [string, string][];

export type Fetch = (
    url: string,
    init: { method?: "GET" | "POST"; headers: HeaderList; body?: string },
) => Promise<Response>;

export interface SolveOptions {
    /** Resolvr API key. Without one, the flow stops at the Resolvr call. */
    apiKey?: string;
    /** Default https://api.resolvr.com */
    resolvrURL?: string;
    /** Sends the page and challenge host requests. Default: Node's fetch. */
    fetch?: Fetch;
    log?: (step: string, message: string) => void;
    /** The pause before the first challenge request, while the widget loads. */
    bootMs?: [number, number];
    /** The time from icon/get to icon/verify. Queue-it refuses icon/verify within 2.5 s. */
    iconWaitMs?: [number, number];
}

export interface FlowResult {
    /** The ChallengeFlowResult token. */
    token: string;
    /** The steps it certifies, e.g. "inv,icon". */
    solvedTypes: string;
}

interface Flow {
    send: Fetch;
    log: (step: string, message: string) => void;
    challengeOrigin: string;
    pageOrigin: string;
    fetchSite: "same-site" | "cross-site";
    flowToken: string;
    visitorID: string;
}

const DEFAULT_CHALLENGE_SCRIPT = "https://dual.challenge.queue-it.net/api.js";
const DEFAULT_BOOT_MS: [number, number] = [1200, 1900];
const DEFAULT_ICON_WAIT_MS: [number, number] = [2700, 3300];
const BROWSER_POW_SOLVE_MS: [number, number] = [150, 420];
const MIN_FLOW_TOKEN_LIFE_MS = 10_000;
const ICON_ATTEMPTS = 3;

/** Solves the challenge on a page that shows the widget: the page in, the flow result out. */
export async function solve(pageURL: string, options: SolveOptions = {}): Promise<FlowResult> {
    const send: Fetch =
        options.fetch ?? ((url, init) => fetch(url, { ...init, redirect: "manual" }));
    const log = options.log ?? (() => {});
    const page = new URL(pageURL);

    const pageResponse = await send(pageURL, { headers: PAGE_HEADERS });
    const html = await pageResponse.text();
    const pageSetting = (name: string) =>
        html.match(new RegExp(`\\b${name}\\s*:\\s*'([^']*)'`))?.[1];
    const flowToken = pageSetting("botDeflectorJwtToken");

    if (!flowToken) {
        throw new Error(
            `the page has no botDeflectorJwtToken (it answered ${pageResponse.status})`,
        );
    }

    const challengeScript = pageSetting("botDeflectorSource") ?? DEFAULT_CHALLENGE_SCRIPT;
    const challengeHost = new URL(challengeScript, page).host;
    log("page", `flow token read, challenge host ${challengeHost}`);

    const { challengeFlow, exp: expiresAt } = jwtPayload<{
        challengeFlow: { type: string }[];
        exp: number;
    }>(flowToken);

    if (expiresAt * 1000 - Date.now() < MIN_FLOW_TOKEN_LIFE_MS) {
        throw new Error(`the flow token expires in under ${MIN_FLOW_TOKEN_LIFE_MS / 1000} s`);
    }

    const sameSite = lastTwoLabels(page.hostname) === lastTwoLabels(challengeHost);
    const flow: Flow = {
        send,
        log,
        challengeOrigin: `https://${challengeHost}`,
        pageOrigin: page.origin,
        fetchSite: sameSite ? "same-site" : "cross-site",
        flowToken,
        visitorID: randomVisitorID(),
    };

    await sleep(randomBetween(options.bootMs ?? DEFAULT_BOOT_MS));

    const stepTokens: string[] = [];

    for (const { type } of challengeFlow) {
        if (type === "inv") {
            stepTokens.push(await powStep(flow));
        } else if (type === "icon") {
            stepTokens.push(await iconStep(flow, options));
        } else {
            throw new Error(`unsupported step "${type}"`);
        }
    }

    return verifyFlow(flow, stepTokens);
}

async function powStep(flow: Flow): Promise<string> {
    const requestedAt = Date.now();
    const challengeResponse = await flow.send(`${flow.challengeOrigin}/pow/get`, {
        headers: apiHeaders(flow, ["x-tt-flow-token", flow.flowToken]),
    });
    const { challengeToken } = await readJSON(challengeResponse, "pow/get");

    const solveStartedAt = performance.now();
    const { solution, params } = solveChallengeToken(challengeToken);
    const solveMs = Math.round(performance.now() - solveStartedAt);
    flow.log("pow", `solved locally in ${solveMs} ms (${solution.length} challenges)`);

    const reportedSolveMs = randomBetween(BROWSER_POW_SOLVE_MS);
    await sleep(Math.max(0, requestedAt + reportedSolveMs - Date.now()));

    const verifyResponse = await flow.send(`${flow.challengeOrigin}/pow/verify`, {
        method: "POST",
        headers: apiHeaders(flow),
        body: JSON.stringify({
            solution,
            params,
            solution_fingerprint: flow.visitorID,
            time: (reportedSolveMs / 1000).toFixed(3),
            challengeToken,
            challengeFlowToken: flow.flowToken,
        }),
    });
    const { token: stepToken } = await readJSON(verifyResponse, "pow/verify");
    flow.log("pow", "pow/verify accepted");
    return stepToken;
}

async function iconStep(flow: Flow, options: SolveOptions): Promise<string> {
    for (let attempt = 1; attempt <= ICON_ATTEMPTS; attempt++) {
        const challengeResponse = await flow.send(`${flow.challengeOrigin}/icon/get`, {
            headers: apiHeaders(flow, ["x-tt-flow-token", flow.flowToken]),
        });
        const shownAt = Date.now();
        const { challengeToken } = await readJSON(challengeResponse, "icon/get");

        const iconChallenge = jwtPayload<{ lib: string; ico: string; img: string }>(challengeToken);
        const imagePaths = [
            `/icons/${iconChallenge.lib}/ico/${iconChallenge.ico}`,
            `/icons/${iconChallenge.lib}/bgnd/${iconChallenge.img}`,
        ];
        const [icons, background] = await Promise.all(
            imagePaths.map(async path => {
                const imageResponse = await flow.send(`${flow.challengeOrigin}${path}`, {
                    headers: imageHeaders(flow),
                });

                if (imageResponse.status !== 200) {
                    throw new Error(`${path} answered ${imageResponse.status}`);
                }

                return new Uint8Array(await imageResponse.arrayBuffer());
            }),
        );

        const resolvrStartedAt = performance.now();
        const task = await solveIcons(
            { icons, background },
            { apiKey: options.apiKey, baseURL: options.resolvrURL },
        );
        const roundTripMs = Math.round(performance.now() - resolvrStartedAt);

        if (!task.success || !task.data) {
            const reason = [task.error, task.message].filter(Boolean).join(": ");
            flow.log("icon", `Resolvr: ${reason}, trying a fresh challenge`);
            continue;
        }

        const { points } = task.data;
        const solvedIn = task.timing
            ? `solved it in ${task.timing.execution_ms} ms (${roundTripMs} ms round trip)`
            : `answered in ${roundTripMs} ms`;
        flow.log("icon", `Resolvr ${solvedIn}: ${JSON.stringify(points)}`);

        const verifyAt = shownAt + randomBetween(options.iconWaitMs ?? DEFAULT_ICON_WAIT_MS);
        const waitMs = Math.max(0, verifyAt - Date.now());
        const waitSeconds = (waitMs / 1000).toFixed(1);
        flow.log(
            "icon",
            `waiting ${waitSeconds} s: icon/verify is refused within 2.5 s of icon/get`,
        );
        await sleep(waitMs);

        const answeredAfterMs = Date.now() - shownAt;
        const verifyResponse = await flow.send(`${flow.challengeOrigin}/icon/verify`, {
            method: "POST",
            headers: apiHeaders(flow),
            body: JSON.stringify({
                solution: points,
                solution_fingerprint: flow.visitorID,
                time: answeredAfterMs,
                challengeToken,
                challengeFlowToken: flow.flowToken,
            }),
        });

        if (verifyResponse.status === 200) {
            flow.log("icon", `icon/verify accepted after ${answeredAfterMs} ms`);
            return (await readJSON(verifyResponse, "icon/verify")).token;
        }

        const refusal = (await verifyResponse.text()).slice(0, 100);
        flow.log(
            "icon",
            `icon/verify answered ${verifyResponse.status} ${refusal}, trying a fresh challenge`,
        );
    }

    throw new Error(`the icon step failed ${ICON_ATTEMPTS} times`);
}

async function verifyFlow(flow: Flow, stepTokens: string[]): Promise<FlowResult> {
    const response = await flow.send(`${flow.challengeOrigin}/verify-flow`, {
        headers: verifyFlowHeaders(flow, stepTokens),
    });
    const { ChallengeFlowResult: flowResultToken } = await readJSON(response, "verify-flow");
    const { solvedTypes } = jwtPayload<{ solvedTypes: string }>(flowResultToken);
    flow.log("verify-flow", `flow result for ${solvedTypes}`);
    return { token: flowResultToken, solvedTypes };
}

// Chrome 155 on macOS, in Chrome's order (poc/fixture/flow.json). Node's fetch adds accept-encoding.
const USER_AGENT =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36";
const SEC_CH_UA = '"Google Chrome";v="155", "Chromium";v="155", "Not(A:Brand";v="24"';
const ACCEPT_LANGUAGE = "en-US,en;q=0.9";

const PAGE_HEADERS: HeaderList = [
    ["sec-ch-ua", SEC_CH_UA],
    ["sec-ch-ua-mobile", "?0"],
    ["sec-ch-ua-platform", '"macOS"'],
    ["upgrade-insecure-requests", "1"],
    ["user-agent", USER_AGENT],
    [
        "accept",
        "text/html,application/xhtml+xml,application/xml;q=0.9,image/jxl,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7",
    ],
    ["sec-fetch-site", "none"],
    ["sec-fetch-mode", "navigate"],
    ["sec-fetch-user", "?1"],
    ["sec-fetch-dest", "document"],
    ["accept-language", ACCEPT_LANGUAGE],
    ["priority", "u=0, i"],
];

function apiHeaders(flow: Flow, ...extra: HeaderList): HeaderList {
    return [
        ["sec-ch-ua-platform", '"macOS"'],
        ["user-agent", USER_AGENT],
        ["sec-ch-ua", SEC_CH_UA],
        ["content-type", "application/json"],
        ...extra,
        ["sec-ch-ua-mobile", "?0"],
        ["accept", "*/*"],
        ["origin", flow.pageOrigin],
        ["sec-fetch-site", flow.fetchSite],
        ["sec-fetch-mode", "cors"],
        ["sec-fetch-dest", "empty"],
        ["referer", `${flow.pageOrigin}/`],
        ["accept-language", ACCEPT_LANGUAGE],
        ["priority", "u=1, i"],
    ];
}

function imageHeaders(flow: Flow): HeaderList {
    return [
        ["sec-ch-ua-platform", '"macOS"'],
        ["user-agent", USER_AGENT],
        ["sec-ch-ua", SEC_CH_UA],
        ["sec-ch-ua-mobile", "?0"],
        ["accept", "image/jxl,image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8"],
        ["sec-fetch-site", flow.fetchSite],
        ["sec-fetch-mode", "no-cors"],
        ["sec-fetch-dest", "image"],
        ["referer", `${flow.pageOrigin}/`],
        ["accept-language", ACCEPT_LANGUAGE],
        ["priority", "u=1, i"],
    ];
}

function verifyFlowHeaders(flow: Flow, stepTokens: string[]): HeaderList {
    return [
        ["sec-ch-ua-platform", '"macOS"'],
        ["x-tt-ch-flow-token", flow.flowToken],
        ["sec-ch-ua", SEC_CH_UA],
        ["sec-ch-ua-mobile", "?0"],
        ["x-tt-client-fingerprint", flow.visitorID],
        ["user-agent", USER_AGENT],
        ["x-tt-solution-tokens", stepTokens.join(",")],
        ["content-type", "application/json"],
        ["accept", "*/*"],
        ["origin", flow.pageOrigin],
        ["sec-fetch-site", flow.fetchSite],
        ["sec-fetch-mode", "cors"],
        ["sec-fetch-dest", "empty"],
        ["referer", `${flow.pageOrigin}/`],
        ["accept-language", ACCEPT_LANGUAGE],
        ["priority", "u=1, i"],
    ];
}

// The widget's visitor IDs are 32 hex characters with a 2 at position 15.
function randomVisitorID(): string {
    const hex = randomBytes(16).toString("hex");
    return `${hex.slice(0, 15)}2${hex.slice(16)}`;
}

function jwtPayload<T>(token: string): T {
    try {
        return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    } catch (error) {
        throw new Error(`not a JWT: ${token.slice(0, 20)}…`, { cause: error });
    }
}

async function readJSON(response: Response, request: string): Promise<Record<string, string>> {
    const text = await response.text();

    if (response.status !== 200) {
        throw new Error(`${request} answered ${response.status}: ${text.slice(0, 200)}`);
    }

    try {
        return JSON.parse(text);
    } catch (error) {
        throw new Error(`${request} answered 200 with a body that is not JSON`, { cause: error });
    }
}

function lastTwoLabels(hostname: string): string {
    return hostname.split(".").slice(-2).join(".");
}

function randomBetween([min, max]: [number, number]): number {
    return min + Math.floor(Math.random() * (max - min + 1));
}
