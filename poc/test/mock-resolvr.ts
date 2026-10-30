import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fixture } from "../mock-queueit.ts";

export const TEST_API_KEY = "test-key";

export interface MockResolvrOptions {
    /** Refuse the first n submissions with 429 ERROR_CONCURRENCY_LIMIT. */
    limitedFirst?: number;
    /** Fail the first n tasks with ERROR_RECOGNITION_BUSY. */
    busyFirst?: number;
    /** Fail the next n tasks with ERROR_RECOGNITION_UNSOLVED. */
    unsolvedFirst?: number;
    /** Answer the first poll with the task still processing. */
    runningFirst?: boolean;
}

interface Refusal {
    error: string;
    message: string;
}

const MAX_BODY_BYTES = 32_768;

/**
 * Starts a local stand-in for Resolvr's botdeflector_image task, as docs/icon-api.md describes it:
 * a submission is checked and answered 202, the result comes from polling, and every solved task
 * gets the clicks Queue-it accepted.
 */
export async function startMockResolvr(options: MockResolvrOptions = {}) {
    const { limitedFirst = 0, busyFirst = 0, unsolvedFirst = 0, runningFirst = false } = options;
    const tasks: { type: string; params: Record<string, string> }[] = [];
    const polls: number[] = [];
    const results = new Map<string, object>();
    const timing = { queued_ms: 1, proxy_verify_ms: 0, execution_ms: 1, total_ms: 2 };

    const server = createServer(async (request, response) => {
        const url = request.url ?? "";
        const send = (status: number, body: object) =>
            response
                .writeHead(status, { "content-type": "application/json" })
                .end(JSON.stringify(body));

        if (request.headers.authorization !== `Bearer ${TEST_API_KEY}`) {
            return send(401, {
                error: "ERROR_UNAUTHORIZED",
                message: "Invalid or missing API key",
            });
        }

        if (request.method === "GET" && url.startsWith("/v1/task/")) {
            const taskID = url.slice("/v1/task/".length);
            const result = results.get(taskID);

            if (!result) {
                return send(404, { error: "ERROR_TASK_NOT_FOUND", message: "Unknown" });
            }

            polls.push(Date.now());

            if (runningFirst && polls.length === 1) {
                return send(200, { task_id: taskID, status: "processing" });
            }

            return send(200, result);
        }

        if (request.method !== "POST" || url !== "/v1/task") {
            return send(404, { error: "ERROR" });
        }

        const chunks: Buffer[] = [];

        for await (const chunk of request) {
            chunks.push(chunk);
        }

        const rawBody = Buffer.concat(chunks);
        let task;

        try {
            task = JSON.parse(rawBody.toString("utf8"));
        } catch {
            return send(400, { error: "ERROR_INVALID_INPUT", message: "The body is not JSON" });
        }

        tasks.push(task);

        if (tasks.length <= limitedFirst) {
            return send(429, {
                error: "ERROR_CONCURRENCY_LIMIT",
                message: "Too many in-flight tasks",
            });
        }

        const refusal = validate(rawBody, task);

        if (refusal) {
            return send(400, refusal);
        }

        const taskID = `task-${tasks.length}`;
        const acceptedCount = tasks.length - limitedFirst;
        const failed = (error: string, message: string) => ({
            task_id: taskID,
            status: "failed",
            success: false,
            error,
            message,
            timing,
        });

        if (acceptedCount <= busyFirst) {
            results.set(
                taskID,
                failed("ERROR_RECOGNITION_BUSY", "No time left for this challenge"),
            );
        } else if (acceptedCount <= busyFirst + unsolvedFirst) {
            results.set(
                taskID,
                failed("ERROR_RECOGNITION_UNSOLVED", "No confident answer for this challenge"),
            );
        } else {
            results.set(taskID, {
                task_id: taskID,
                status: "completed",
                success: true,
                data: { points: fixture.icon.accepted.solution },
                timing,
            });
        }

        send(202, { task_id: taskID, status: "queued" });
    });

    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));

    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        tasks,
        polls,
        close: () =>
            new Promise<void>((resolve, reject) =>
                server.close(error => (error ? reject(error) : resolve())),
            ),
    };
}

function validate(rawBody: Buffer, task: Record<string, unknown>): Refusal | undefined {
    const invalid = (message: string) => ({ error: "ERROR_INVALID_INPUT", message });

    if (rawBody.length > MAX_BODY_BYTES) {
        return invalid("Request body exceeds 32 KB");
    }

    if (task.type !== "botdeflector_image") {
        return { error: "ERROR_UNSUPPORTED_TYPE", message: `Unknown task type ${task.type}` };
    }

    if ("user_agent" in task) {
        return invalid("user_agent is not accepted for botdeflector_image tasks");
    }

    if ("egress" in task || "egress_client" in task) {
        return invalid("Egress mode does not apply to botdeflector_image tasks");
    }

    const params = (task.params ?? {}) as Record<string, unknown>;
    const images = [
        { name: "icons", format: "a PNG", hasFormat: isPNG },
        { name: "background", format: "a WebP", hasFormat: isWebP },
    ];

    for (const { name, format, hasFormat } of images) {
        const value = params[name];

        if (typeof value !== "string" || !value) {
            return invalid(`params.${name} is required`);
        }

        const base64 = value.replace(/^data:image\/\w+;base64,/, "");

        if (!/^[A-Za-z0-9+/_-]+={0,2}$/.test(base64)) {
            return invalid(`params.${name} must be base64`);
        }

        if (!hasFormat(Buffer.from(base64, "base64"))) {
            return invalid(`params.${name} must be ${format} image`);
        }
    }

    return undefined;
}

function isPNG(image: Buffer): boolean {
    return image.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
}

function isWebP(image: Buffer): boolean {
    return (
        image.subarray(0, 4).toString("latin1") === "RIFF" &&
        image.subarray(8, 12).toString("latin1") === "WEBP"
    );
}
