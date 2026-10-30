import { startMockQueueIt } from "./mock-queueit.ts";
import { ResolvrError } from "./resolvr.ts";
import { solve } from "./solve.ts";

const SIGN_UP_URL = "https://resolvr.com/?ref=github";

const USAGE = `usage: npm run poc -- <page url>   solve the challenge on a page that shows the widget
       npm run demo                the same, on a local replay of poc/fixture

RESOLVR_API_KEY   your Resolvr API key, from ${SIGN_UP_URL}
RESOLVR_BASE_URL  replaces https://api.resolvr.com`;

const [pageURL] = process.argv.slice(2);

if (!pageURL) {
    console.error(USAGE);
    process.exit(1);
}

const mock = pageURL === "--demo" ? await startMockQueueIt() : undefined;

if (mock) {
    console.error("demo: dual.challenge.queue-it.net, replayed locally from poc/fixture\n");
}

const startedAt = Date.now();

try {
    const result = await solve(mock?.pageURL ?? pageURL, {
        fetch: mock?.fetch,
        apiKey: process.env.RESOLVR_API_KEY,
        resolvrURL: process.env.RESOLVR_BASE_URL,
        log: (step, message) => {
            const seconds = ((Date.now() - startedAt) / 1000).toFixed(2).padStart(6);
            console.error(`${seconds}s  ${step.padEnd(11)} ${message}`);
        },
    });
    console.log(`\nflow result for ${result.solvedTypes}:\n${result.token}`);
} catch (error) {
    console.error(`\n${(error as Error).message}`);

    if (error instanceof ResolvrError && error.status === 401) {
        const problem = process.env.RESOLVR_API_KEY
            ? "RESOLVR_API_KEY was refused"
            : "Set RESOLVR_API_KEY";
        console.error(`${problem}: get a key at ${SIGN_UP_URL}`);
    }

    process.exitCode = 1;
} finally {
    await mock?.close();
}
