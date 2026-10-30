use botdeflector_pow::{solve, solve_challenge_token, verify, Options, Params, PowSolution};
use serde::Deserialize;

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    name: String,
    challenge_token: Option<String>,
    params: Params,
    challenges: Vec<String>,
    expected: Vec<Vec<u32>>,
}

fn vectors() -> Vec<Vector> {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors.json");
    let text = std::fs::read_to_string(path).expect("pow/vectors.json");
    serde_json::from_str::<Vectors>(&text).unwrap().vectors
}

fn edge_indices(solved: PowSolution) -> Vec<Vec<u32>> {
    solved
        .solutions
        .into_iter()
        .map(|solution| solution.edge_indices)
        .collect()
}

#[test]
fn reproduces_every_vector_exactly() {
    for vector in vectors() {
        let solved = solve(&vector.challenges, &vector.params, &Options::default()).unwrap();
        let found = edge_indices(solved);

        assert_eq!(found, vector.expected, "vector {}", vector.name);
    }
}

#[test]
fn every_expected_answer_is_a_valid_cycle() {
    for vector in vectors() {
        for cycle in &vector.expected {
            assert!(
                verify(&vector.params, cycle),
                "vector {} cycle {:?}",
                vector.name,
                cycle
            );
        }
    }
}

#[test]
fn solves_the_captured_challenge_token() {
    for vector in vectors() {
        let Some(token) = vector.challenge_token else {
            continue;
        };

        let solved = solve_challenge_token(&token, &Options::default()).unwrap();

        assert_eq!(
            solved.params, vector.params,
            "GRAPH_SEED comes from the token's sessionId"
        );

        let found = edge_indices(solved);

        assert_eq!(found, vector.expected, "vector {}", vector.name);
    }
}
