/**
 * The proof-of-work step of Queue-it's BotDeflector challenge, solved with Node's standard library.
 * From https://github.com/resolvrlabs/botdeflector-solver (MIT License).
 */
import { hash } from "node:crypto";

export interface PowParams {
    NODES_BITS?: number;
    EDGES_BITS?: number;
    CYCLE_LENGTH?: number;
    /** The challenge token's sessionId. */
    GRAPH_SEED?: string;
}

/** `solution` and `params` go into the pow/verify body unchanged. */
export interface PowSolution {
    solution: { challenge: string; edgeIndices: number[] }[];
    params: PowParams;
}

interface Graph {
    nodeCount: number;
    neighborOffsets: Uint32Array;
    neighbors: Uint32Array;
    neighborEdges: Uint32Array;
}

const DEFAULT_NODES_BITS = 12;
const DEFAULT_EDGES_BITS = 13;
const DEFAULT_CYCLE_LENGTH = 6;

const MAX_NODES_BITS = 20;
const MAX_EDGES_BITS = 20;
const MAX_CYCLE_LENGTH = 16;

const EVEN_LENGTH_HEX = /^(?:[0-9a-f]{2})*$/i;

/** Solves the challengeToken from pow/get, seeding the graph with its sessionId. */
export function solveChallengeToken(challengeToken: string): PowSolution {
    const encodedPayload = challengeToken.split(".")[1] ?? "";
    let payload;

    try {
        payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
    } catch (error) {
        throw new Error("not a challengeToken from pow/get", { cause: error });
    }

    if (!Array.isArray(payload?.challenges) || typeof payload.sessionId !== "string") {
        throw new Error("not a challengeToken from pow/get");
    }

    return solve(payload.challenges, { ...payload.params, GRAPH_SEED: payload.sessionId });
}

/** Solves every challenge on the graph `params` describe. */
export function solve(challenges: string[], params: PowParams): PowSolution {
    const nodesBits = params.NODES_BITS ?? DEFAULT_NODES_BITS;
    const edgesBits = params.EDGES_BITS ?? DEFAULT_EDGES_BITS;
    const cycleLength = params.CYCLE_LENGTH ?? DEFAULT_CYCLE_LENGTH;

    if (challenges.length === 0) {
        throw new Error("challenges must be a non-empty array");
    }

    if (
        !isIntegerBetween(nodesBits, 1, MAX_NODES_BITS) ||
        !isIntegerBetween(edgesBits, 0, MAX_EDGES_BITS) ||
        !isIntegerBetween(cycleLength, 1, Math.min(MAX_CYCLE_LENGTH, 2 ** nodesBits))
    ) {
        throw new Error(`unsupported PoW complexity: ${nodesBits} / ${edgesBits} / ${cycleLength}`);
    }

    const malformedChallenge = challenges.find(challenge => !EVEN_LENGTH_HEX.test(challenge));

    if (malformedChallenge !== undefined) {
        throw new Error(`challenge must be an even-length hex string: ${malformedChallenge}`);
    }

    const graph = buildGraph(nodesBits, edgesBits, Buffer.from(params.GRAPH_SEED ?? "", "utf8"));

    const solution = challenges.map(challenge => {
        const challengeDigest = sha256(Buffer.from(challenge, "hex"));
        const startNode = nodeFromDigest(challengeDigest, 0, graph.nodeCount);
        const edgeIndices = findCycle(graph, cycleLength, startNode);

        if (!edgeIndices) {
            throw new Error(`no cycle found for challenge ${challenge}`);
        }

        return { challenge, edgeIndices };
    });

    return { solution, params };
}

function buildGraph(nodesBits: number, edgesBits: number, seed: Buffer): Graph {
    const nodeCount = 2 ** nodesBits;
    const edgeCount = 2 ** edgesBits;
    const firstNodes = new Uint32Array(edgeCount);
    const secondNodes = new Uint32Array(edgeCount);
    const degrees = new Uint32Array(nodeCount);
    const hashInput = Buffer.alloc(4 + seed.length);
    seed.copy(hashInput, 4);

    for (let edge = 0; edge < edgeCount; edge++) {
        hashInput.writeUInt32LE(edge, 0);
        const digest = sha256(hashInput);
        firstNodes[edge] = nodeFromDigest(digest, 0, nodeCount);
        secondNodes[edge] = nodeFromDigest(digest, 8, nodeCount);
        degrees[firstNodes[edge]]++;
        degrees[secondNodes[edge]]++;
    }

    const neighborOffsets = new Uint32Array(nodeCount + 1);

    for (let node = 0; node < nodeCount; node++) {
        neighborOffsets[node + 1] = neighborOffsets[node] + degrees[node];
    }

    const neighbors = new Uint32Array(2 * edgeCount);
    const neighborEdges = new Uint32Array(2 * edgeCount);
    const nextFreePositions = neighborOffsets.slice(0, nodeCount);

    // The answer depends on this order: each edge joins its first node's list, then its second's.
    for (let edge = 0; edge < edgeCount; edge++) {
        const firstNode = firstNodes[edge];
        const secondNode = secondNodes[edge];
        neighbors[nextFreePositions[firstNode]] = secondNode;
        neighborEdges[nextFreePositions[firstNode]++] = edge;
        neighbors[nextFreePositions[secondNode]] = firstNode;
        neighborEdges[nextFreePositions[secondNode]++] = edge;
    }

    return { nodeCount, neighborOffsets, neighbors, neighborEdges };
}

function findCycle(graph: Graph, cycleLength: number, startNode: number): number[] | null {
    const { nodeCount, neighborOffsets, neighbors, neighborEdges } = graph;
    const onPath = new Uint8Array(nodeCount);
    const pathNodes = new Uint32Array(cycleLength);
    const pathEdges = new Uint32Array(cycleLength);
    const nextPositions = new Uint32Array(cycleLength);

    for (let offset = 0; offset < nodeCount; offset++) {
        const root = (startNode + offset) % nodeCount;
        let depth = 0;
        onPath[root] = 1;
        pathNodes[0] = root;
        nextPositions[0] = neighborOffsets[root];

        while (depth >= 0) {
            const node = pathNodes[depth];
            const position = nextPositions[depth];

            if (position >= neighborOffsets[node + 1]) {
                onPath[node] = 0;
                depth--;
                continue;
            }

            nextPositions[depth]++;
            const neighbor = neighbors[position];
            const edge = neighborEdges[position];

            if (depth > 0 && neighbor === pathNodes[depth - 1]) {
                continue;
            }

            if (onPath[neighbor]) {
                if (neighbor === root && depth + 1 === cycleLength) {
                    return [...pathEdges.subarray(1, depth + 1), edge];
                }
            } else if (depth + 1 < cycleLength) {
                depth++;
                onPath[neighbor] = 1;
                pathNodes[depth] = neighbor;
                pathEdges[depth] = edge;
                nextPositions[depth] = neighborOffsets[neighbor];
            }
        }
    }

    return null;
}

function sha256(data: Buffer): Buffer {
    return hash("sha256", data, "buffer");
}

// nodeCount is a power of two, so this equals the little-endian u64 at `offset` mod nodeCount.
function nodeFromDigest(digest: Buffer, offset: number, nodeCount: number): number {
    return digest.readUInt32LE(offset) & (nodeCount - 1);
}

function isIntegerBetween(value: number, min: number, max: number): boolean {
    return Number.isInteger(value) && value >= min && value <= max;
}
