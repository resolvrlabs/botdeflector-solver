import assert from "node:assert/strict";
import { test } from "node:test";
import { fixture, nearAccepted } from "../mock-queueit.ts";
import { solveIcons } from "../resolvr.ts";

const apiKey = process.env.RESOLVR_API_KEY;

test(
    "Resolvr answers the captured challenge within 12 px of the accepted clicks",
    { skip: !apiKey && "set RESOLVR_API_KEY" },
    async context => {
        const task = await solveIcons(
            { icons: fixture.icons, background: fixture.background },
            { apiKey, baseURL: process.env.RESOLVR_BASE_URL },
        );

        assert.ok(task.success, `${task.error}: ${task.message}`);

        const { points } = task.data!;
        context.diagnostic(`${JSON.stringify(points)}, solved in ${task.timing?.execution_ms} ms`);

        assert.ok(
            nearAccepted(points),
            `accepted: ${JSON.stringify(fixture.icon.accepted.solution)}`,
        );
    },
);
