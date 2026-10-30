//! Solver for the proof-of-work step (`inv`) of Queue-it's BotDeflector challenge.
//!
//! `pow/get` hands out a challenge token whose payload lists a few hex challenges and the graph
//! parameters. Edge `i` of the graph joins the two nodes taken from `SHA-256(i as u32 LE ‖ session
//! id)`. Each challenge picks a start node, and its answer is the edge indices of a simple cycle of
//! exactly `CYCLE_LENGTH` edges, searched depth-first from there.
//!
//! ```no_run
//! let challenge_token = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...";
//! let solved = botdeflector_pow::solve_challenge_token(challenge_token, &Default::default())?;
//! println!("{}", serde_json::to_string(&solved)?);
//! # Ok::<(), Box<dyn std::error::Error>>(())
//! ```
//!
//! The JSON is `{"solution": [...], "params": {...}}`: both go into the `pow/verify` body as they are.

use base64::alphabet;
use base64::engine::{DecodePaddingMode, Engine, GeneralPurpose, GeneralPurposeConfig};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fmt;
use std::time::{Duration, Instant};

/// Graph sizes beyond this are refused even when the caller raises [`Limits`].
pub const ABSOLUTE_MAX_BITS: u32 = 24;

const EDGES_BETWEEN_DEADLINE_CHECKS: usize = 65_536;
const STEPS_BETWEEN_DEADLINE_CHECKS: u64 = 4_096;

const BASE64URL: GeneralPurpose = GeneralPurpose::new(
    &alphabet::URL_SAFE,
    GeneralPurposeConfig::new().with_decode_padding_mode(DecodePaddingMode::Indifferent),
);

/// Graph parameters, named and defaulted like the widget's `pow.js`.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(default, rename_all = "SCREAMING_SNAKE_CASE")]
pub struct Params {
    pub nodes_bits: u32,
    pub edges_bits: u32,
    pub cycle_length: usize,
    /// The challenge's session id. `pow/get` leaves it out of `params`, but the graph depends on it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub graph_seed: Option<String>,
}

impl Default for Params {
    fn default() -> Self {
        Self {
            nodes_bits: 12,
            edges_bits: 13,
            cycle_length: 6,
            graph_seed: None,
        }
    }
}

/// The largest challenge the solver accepts. Production today is 14 / 16 / 8.
///
/// The defaults keep every solve under about a second and 100 MB. A sparse graph with a long cycle
/// makes the search exponential, so raise these only together with an [`Options::timeout`].
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Limits {
    pub max_nodes_bits: u32,
    pub max_edges_bits: u32,
    pub max_cycle_length: usize,
}

impl Default for Limits {
    fn default() -> Self {
        Self {
            max_nodes_bits: 20,
            max_edges_bits: 20,
            max_cycle_length: 16,
        }
    }
}

#[derive(Clone, Copy, Debug, Default)]
pub struct Options {
    pub limits: Limits,
    /// Give up with [`Error::Deadline`] once this much time has passed.
    pub timeout: Option<Duration>,
}

/// One challenge's answer, as `pow/verify` expects it.
#[derive(Clone, Debug, Deserialize, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Solution {
    pub challenge: String,
    pub edge_indices: Vec<u32>,
}

/// Everything `pow/verify` needs from the solver: `solution` and `params` go into its body as is.
#[derive(Clone, Debug, Serialize)]
pub struct PowSolution {
    #[serde(rename = "solution")]
    pub solutions: Vec<Solution>,
    pub params: Params,
    #[serde(skip)]
    pub elapsed: Duration,
}

/// The payload of a `pow/get` challenge token.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChallengeToken {
    pub challenges: Vec<String>,
    #[serde(default)]
    pub params: Params,
    pub session_id: String,
    pub exp: Option<u64>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Error {
    /// The parameters are malformed or outside the absolute bounds.
    InvalidParams(String),
    /// The parameters are valid but larger than the configured [`Limits`].
    Unsupported {
        nodes_bits: u32,
        edges_bits: u32,
        cycle_length: usize,
    },
    /// A challenge is not an even-length hex string.
    InvalidChallenge(String),
    /// The challenge token is not a JWT carrying a proof-of-work payload.
    InvalidToken(String),
    /// No cycle of the requested length exists anywhere in the graph.
    NoCycle { challenge_index: usize },
    /// [`Options::timeout`] passed before the solve finished.
    Deadline,
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Error::InvalidParams(message) => write!(formatter, "invalid params: {message}"),
            Error::Unsupported {
                nodes_bits,
                edges_bits,
                cycle_length,
            } => write!(
                formatter,
                "unsupported PoW complexity: NODES_BITS={nodes_bits}, EDGES_BITS={edges_bits}, \
                 CYCLE_LENGTH={cycle_length}"
            ),
            Error::InvalidChallenge(challenge) => write!(
                formatter,
                "challenge must be an even-length hex string: {challenge}"
            ),
            Error::InvalidToken(message) => write!(formatter, "invalid challenge token: {message}"),
            Error::NoCycle { challenge_index } => write!(
                formatter,
                "no cycle found for challenge #{}",
                challenge_index + 1
            ),
            Error::Deadline => write!(formatter, "pow deadline exceeded"),
        }
    }
}

impl std::error::Error for Error {}

/// Solves every challenge on the graph `params` describe.
pub fn solve(
    challenges: &[String],
    params: &Params,
    options: &Options,
) -> Result<PowSolution, Error> {
    if challenges.is_empty() {
        return Err(Error::InvalidParams(
            "challenges must be a non-empty array".to_owned(),
        ));
    }

    let started = Instant::now();
    let deadline = options.timeout.map(|timeout| started + timeout);
    validate_params(params)?;
    let limits = &options.limits;

    if params.nodes_bits > limits.max_nodes_bits
        || params.edges_bits > limits.max_edges_bits
        || params.cycle_length > limits.max_cycle_length
    {
        return Err(Error::Unsupported {
            nodes_bits: params.nodes_bits,
            edges_bits: params.edges_bits,
            cycle_length: params.cycle_length,
        });
    }

    let node_count = 1usize << params.nodes_bits;
    let start_nodes = challenges
        .iter()
        .map(|challenge| challenge_start_node(challenge, node_count))
        .collect::<Result<Vec<_>, _>>()?;
    let graph = Graph::build(params, deadline)?;
    let mut solutions = Vec::with_capacity(challenges.len());

    for (challenge_index, (challenge, start_node)) in challenges.iter().zip(start_nodes).enumerate()
    {
        let edge_indices = graph
            .find_cycle(params.cycle_length, start_node, deadline)?
            .ok_or(Error::NoCycle { challenge_index })?;

        solutions.push(Solution {
            challenge: challenge.clone(),
            edge_indices,
        });
    }

    Ok(PowSolution {
        solutions,
        params: params.clone(),
        elapsed: started.elapsed(),
    })
}

/// Solves the `challengeToken` from `pow/get`, seeding the graph with its session id.
pub fn solve_challenge_token(token: &str, options: &Options) -> Result<PowSolution, Error> {
    let payload = decode_challenge_token(token)?;
    let params = Params {
        graph_seed: Some(payload.session_id),
        ..payload.params
    };
    solve(&payload.challenges, &params, options)
}

/// Reads the payload of a `pow/get` challenge token. Its signature is Queue-it's and is not checked.
pub fn decode_challenge_token(token: &str) -> Result<ChallengeToken, Error> {
    let parts: Vec<&str> = token.trim().split('.').collect();

    if parts.len() != 3 {
        return Err(Error::InvalidToken(
            "expected three dot-separated parts".to_owned(),
        ));
    }

    let payload_bytes = BASE64URL
        .decode(parts[1])
        .map_err(|error| Error::InvalidToken(format!("payload is not base64url: {error}")))?;
    let payload: serde_json::Value = serde_json::from_slice(&payload_bytes)
        .map_err(|error| Error::InvalidToken(format!("payload: {error}")))?;
    let challenge_type = payload
        .get("challengeType")
        .and_then(|challenge_type| challenge_type.as_str());

    if let Some(challenge_type) = challenge_type.filter(|challenge_type| *challenge_type != "inv") {
        return Err(Error::InvalidToken(format!(
            "challengeType is \"{challenge_type}\", not \"inv\": pass the challengeToken from pow/get"
        )));
    }

    serde_json::from_value(payload)
        .map_err(|error| Error::InvalidToken(format!("payload: {error}")))
}

/// Checks that `edge_indices` is a simple cycle of exactly `CYCLE_LENGTH` edges in the graph,
/// walked in order. Use it to check a port's answers.
pub fn verify(params: &Params, edge_indices: &[u32]) -> bool {
    if validate_params(params).is_err() || edge_indices.len() != params.cycle_length {
        return false;
    }

    let node_count = 1usize << params.nodes_bits;
    let edge_count = 1u64 << params.edges_bits;

    if edge_indices
        .iter()
        .any(|&edge_index| u64::from(edge_index) >= edge_count)
    {
        return false;
    }

    let seed = params.graph_seed.as_deref();
    let endpoints: Vec<(u32, u32)> = edge_indices
        .iter()
        .map(|&edge_index| edge_endpoints(edge_index, node_count, seed))
        .collect();
    let (first_edge_start, first_edge_end) = endpoints[0];

    [first_edge_start, first_edge_end].into_iter().any(|start| {
        let mut current = start;
        let mut visited = Vec::with_capacity(endpoints.len());

        for &(one_end, other_end) in &endpoints {
            if visited.contains(&current) {
                return false;
            }

            visited.push(current);

            current = if one_end == current {
                other_end
            } else if other_end == current {
                one_end
            } else {
                return false;
            };
        }

        current == start
    })
}

fn validate_params(params: &Params) -> Result<(), Error> {
    if params.nodes_bits == 0 || params.nodes_bits > ABSOLUTE_MAX_BITS {
        return Err(Error::InvalidParams(format!(
            "NODES_BITS must be between 1 and {ABSOLUTE_MAX_BITS}"
        )));
    }

    if params.edges_bits > ABSOLUTE_MAX_BITS {
        return Err(Error::InvalidParams(format!(
            "EDGES_BITS must not exceed {ABSOLUTE_MAX_BITS}"
        )));
    }

    let node_count = 1usize << params.nodes_bits;

    if params.cycle_length == 0 || params.cycle_length > node_count {
        return Err(Error::InvalidParams(format!(
            "CYCLE_LENGTH must be between 1 and {node_count}"
        )));
    }

    Ok(())
}

fn edge_endpoints(edge_index: u32, node_count: usize, graph_seed: Option<&str>) -> (u32, u32) {
    let mut hasher = Sha256::new();
    hasher.update(edge_index.to_le_bytes());
    hasher.update(graph_seed.unwrap_or_default());
    let digest = hasher.finalize();

    (
        node_from_digest(&digest, 0, node_count) as u32,
        node_from_digest(&digest, 8, node_count) as u32,
    )
}

fn challenge_start_node(challenge: &str, node_count: usize) -> Result<usize, Error> {
    let challenge_bytes =
        hex::decode(challenge).map_err(|_| Error::InvalidChallenge(challenge.to_owned()))?;
    let digest = Sha256::digest(&challenge_bytes);
    Ok(node_from_digest(&digest, 0, node_count))
}

fn node_from_digest(digest: &[u8], offset: usize, node_count: usize) -> usize {
    let value = u64::from_le_bytes(digest[offset..offset + 8].try_into().unwrap());
    (value % node_count as u64) as usize
}

fn past(deadline: Option<Instant>) -> bool {
    deadline.is_some_and(|deadline| Instant::now() >= deadline)
}

struct Graph {
    node_count: usize,
    neighbor_offsets: Vec<usize>,
    neighbors: Vec<u32>,
    neighbor_edges: Vec<u32>,
}

impl Graph {
    fn build(params: &Params, deadline: Option<Instant>) -> Result<Self, Error> {
        let node_count = 1usize << params.nodes_bits;
        let edge_count = 1usize << params.edges_bits;
        let seed = params.graph_seed.as_deref();
        let mut endpoints = Vec::with_capacity(edge_count);
        let mut degrees = vec![0usize; node_count];

        for edge_index in 0..edge_count {
            if edge_index.is_multiple_of(EDGES_BETWEEN_DEADLINE_CHECKS) && past(deadline) {
                return Err(Error::Deadline);
            }

            let (first_node, second_node) = edge_endpoints(edge_index as u32, node_count, seed);
            endpoints.push((first_node, second_node));
            degrees[first_node as usize] += 1;
            degrees[second_node as usize] += 1;
        }

        let mut neighbor_offsets = vec![0usize; node_count + 1];

        for node in 0..node_count {
            neighbor_offsets[node + 1] = neighbor_offsets[node] + degrees[node];
        }

        let mut neighbors = vec![0u32; 2 * edge_count];
        let mut neighbor_edges = vec![0u32; 2 * edge_count];
        let mut next_free_positions = neighbor_offsets[..node_count].to_vec();

        // The answer depends on this order: each edge joins its first node's list, then its second's.
        for (edge_index, &(first_node, second_node)) in endpoints.iter().enumerate() {
            for (node, neighbor) in [(first_node, second_node), (second_node, first_node)] {
                let position = next_free_positions[node as usize];
                neighbors[position] = neighbor;
                neighbor_edges[position] = edge_index as u32;
                next_free_positions[node as usize] += 1;
            }
        }

        Ok(Graph {
            node_count,
            neighbor_offsets,
            neighbors,
            neighbor_edges,
        })
    }

    // The answer is the first cycle in pow.js's order: roots from start_node up, neighbors in order.
    fn find_cycle(
        &self,
        cycle_length: usize,
        start_node: usize,
        deadline: Option<Instant>,
    ) -> Result<Option<Vec<u32>>, Error> {
        struct PathStep {
            node: usize,
            next_position: usize,
        }

        let mut on_path = vec![false; self.node_count];
        let mut path: Vec<PathStep> = Vec::with_capacity(cycle_length);
        let mut path_edges: Vec<u32> = Vec::with_capacity(cycle_length);
        let mut steps: u64 = 0;

        for offset in 0..self.node_count {
            let root = (start_node + offset) % self.node_count;
            on_path[root] = true;
            path.push(PathStep {
                node: root,
                next_position: self.neighbor_offsets[root],
            });

            while !path.is_empty() {
                steps += 1;

                if steps.is_multiple_of(STEPS_BETWEEN_DEADLINE_CHECKS) && past(deadline) {
                    return Err(Error::Deadline);
                }

                let depth = path.len() - 1;
                let node = path[depth].node;
                let position = path[depth].next_position;

                if position >= self.neighbor_offsets[node + 1] {
                    on_path[node] = false;
                    path.pop();
                    path_edges.pop();
                    continue;
                }

                path[depth].next_position += 1;
                let neighbor = self.neighbors[position] as usize;
                let edge = self.neighbor_edges[position];

                if depth > 0 && neighbor == path[depth - 1].node {
                    continue;
                }

                if on_path[neighbor] {
                    if neighbor == root && depth + 1 == cycle_length {
                        path_edges.push(edge);
                        return Ok(Some(path_edges));
                    }
                } else if depth + 1 < cycle_length {
                    on_path[neighbor] = true;
                    path.push(PathStep {
                        node: neighbor,
                        next_position: self.neighbor_offsets[neighbor],
                    });
                    path_edges.push(edge);
                }
            }
        }

        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn production_params(graph_seed: &str) -> Params {
        Params {
            nodes_bits: 14,
            edges_bits: 16,
            cycle_length: 8,
            graph_seed: Some(graph_seed.to_owned()),
        }
    }

    #[test]
    fn missing_json_params_take_the_pow_js_defaults() {
        let params: Params = serde_json::from_str("{}").unwrap();

        assert_eq!(params, Params::default());
    }

    #[test]
    fn rejects_invalid_challenge_hex() {
        let challenges = ["not hex".to_owned()];
        let error =
            solve(&challenges, &production_params("seed"), &Options::default()).unwrap_err();

        assert_eq!(error, Error::InvalidChallenge("not hex".to_owned()));
    }

    #[test]
    fn rejects_complexity_above_the_limits() {
        let params = Params {
            nodes_bits: 22,
            edges_bits: 24,
            cycle_length: 8,
            graph_seed: None,
        };
        let error = solve(&["00".to_owned()], &params, &Options::default()).unwrap_err();

        assert!(matches!(error, Error::Unsupported { nodes_bits: 22, .. }));
    }

    #[test]
    fn sparse_graph_with_long_cycle_hits_the_deadline() {
        let params = Params {
            nodes_bits: 20,
            edges_bits: 20,
            cycle_length: 16,
            graph_seed: Some("deadline".to_owned()),
        };
        let options = Options {
            timeout: Some(Duration::from_millis(50)),
            ..Options::default()
        };
        let started = Instant::now();
        let result = solve(&["ab".to_owned()], &params, &options);

        assert_eq!(result.unwrap_err(), Error::Deadline);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn reports_when_no_cycle_exists() {
        let fewer_edges_than_nodes = Params {
            nodes_bits: 12,
            edges_bits: 4,
            cycle_length: 8,
            graph_seed: Some("sparse".to_owned()),
        };
        let error = solve(
            &["ab".to_owned()],
            &fewer_edges_than_nodes,
            &Options::default(),
        )
        .unwrap_err();

        assert_eq!(error, Error::NoCycle { challenge_index: 0 });
    }

    #[test]
    fn verify_rejects_broken_cycles() {
        let params = production_params("683beef1-0c5e-4285-a833-09a38a6331d0");
        let cycle = vec![508, 11633, 7726, 40537, 47673, 22262, 30977, 9115];
        let mut reordered = cycle.clone();
        reordered.swap(2, 5);

        assert!(verify(&params, &cycle));
        assert!(!verify(&params, &reordered));
        assert!(!verify(&params, &cycle[..7]));
        assert!(!verify(&production_params("another-session"), &cycle));
        assert!(!verify(&params, &[u32::MAX; 8]));
    }

    #[test]
    fn rejects_tokens_for_other_steps() {
        let icon_payloads = [
            r#"{"challenges":["ab"],"sessionId":"s","challengeType":"icon"}"#,
            r#"{"ico":"a.png","img":"b.webp","sessionId":"s","challengeType":"icon"}"#,
        ];

        for payload in icon_payloads {
            let token = format!("e30.{}.signature", BASE64URL.encode(payload));

            assert!(matches!(
                decode_challenge_token(&token),
                Err(Error::InvalidToken(message)) if message.contains("pow/get")
            ));
        }

        assert!(matches!(
            decode_challenge_token("nope"),
            Err(Error::InvalidToken(_))
        ));
    }
}
