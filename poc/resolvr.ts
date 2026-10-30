import { setTimeout as sleep } from "node:timers/promises";

export interface Point {
    x: number;
    y: number;
}

export interface Task {
    task_id: string;
    status: "queued" | "processing" | "completed" | "failed";
    /** Set once the task has finished: true only on "completed". */
    success?: boolean;
    /** The clicks in the strip's order, in background pixels: the `solution` of icon/verify. */
    data?: { points: Point[] };
    error?: string;
    message?: string;
    timing?: { queued_ms: number; proxy_verify_ms: number; execution_ms: number; total_ms: number };
}

export interface ResolvrOptions {
    apiKey?: string;
    /** Default https://api.resolvr.com */
    baseURL?: string;
    /** How many times the same images are sent again. Default 2. */
    retries?: number;
    /** The pause before submitting again after a 429 or 503. Default 500. */
    retryAfterMs?: number;
}

/** A request the Resolvr API refused, with its HTTP status and the API's error code. */
export class ResolvrError extends Error {
    readonly status: number;
    readonly code: string | undefined;

    constructor(status: number, code?: string, detail?: string) {
        const reason = [code, detail].filter(Boolean).join(": ");
        super(reason ? `Resolvr answered ${status} ${reason}` : `Resolvr answered ${status}`);
        this.name = "ResolvrError";
        this.status = status;
        this.code = code;
    }
}

const DEFAULT_BASE_URL = "https://api.resolvr.com";
const DEFAULT_RETRIES = 2;
const DEFAULT_RETRY_AFTER_MS = 500;

// A poll is held open for up to 5 s while the task finishes.
const REQUEST_TIMEOUT_MS = 15_000;

const SUBMISSION_REFUSED_FOR_NOW = [429, 503];
const TASK_ERRORS_WORTH_THE_SAME_IMAGES = ["ERROR_RECOGNITION_BUSY", "ERROR_INTERNAL"];

/**
 * Submits a botdeflector_image task and waits for its result. A submission refused with 429 or 503,
 * and a task that failed with ERROR_RECOGNITION_BUSY or ERROR_INTERNAL, are sent again, up to
 * `retries` times. Any other failed task comes back with its `error`: on ERROR_RECOGNITION_UNSOLVED
 * the same images get the same answer, so get a fresh challenge. A refused request throws a
 * ResolvrError.
 */
export async function solveIcons(
    images: { icons: Uint8Array; background: Uint8Array },
    options: ResolvrOptions = {},
): Promise<Task> {
    const baseURL = options.baseURL ?? DEFAULT_BASE_URL;
    const retries = options.retries ?? DEFAULT_RETRIES;
    const headers: Record<string, string> = { "content-type": "application/json" };

    if (options.apiKey) {
        headers.authorization = `Bearer ${options.apiKey}`;
    }

    const request = async (path: string, init: RequestInit = {}): Promise<Task> => {
        const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
        const response = await fetch(`${baseURL}${path}`, { ...init, headers, signal });
        const body = await response.json().catch(() => undefined);

        if (!response.ok) {
            throw new ResolvrError(response.status, body?.error, body?.message);
        }

        if (body === undefined) {
            throw new Error(`Resolvr answered ${response.status} with a body that is not JSON`);
        }

        return body;
    };

    const submission = JSON.stringify({
        type: "botdeflector_image",
        params: {
            icons: Buffer.from(images.icons).toString("base64"),
            background: Buffer.from(images.background).toString("base64"),
        },
    });

    for (let attempt = 0; ; attempt++) {
        let task: Task;

        try {
            task = await request("/v1/task", { method: "POST", body: submission });
        } catch (error) {
            const refusedForNow =
                error instanceof ResolvrError && SUBMISSION_REFUSED_FOR_NOW.includes(error.status);

            if (!refusedForNow || attempt >= retries) {
                throw error;
            }

            await sleep(options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS);
            continue;
        }

        while (task.status === "queued" || task.status === "processing") {
            task = await request(`/v1/task/${task.task_id}`);
        }

        const worthTheSameImages =
            !task.success && TASK_ERRORS_WORTH_THE_SAME_IMAGES.includes(task.error ?? "");

        if (!worthTheSameImages || attempt >= retries) {
            return task;
        }
    }
}
