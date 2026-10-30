use serde::Deserialize;
use serde_json::Value;
use std::io::Write;
use std::process::{Command, Output, Stdio};

#[derive(Deserialize)]
struct Vectors {
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Vector {
    challenge_token: Option<String>,
    params: Value,
    challenges: Vec<String>,
    expected: Vec<Vec<u32>>,
}

fn captured_vector() -> (String, Vector) {
    let path = concat!(env!("CARGO_MANIFEST_DIR"), "/../vectors.json");
    let text = std::fs::read_to_string(path).expect("pow/vectors.json");
    let vector = serde_json::from_str::<Vectors>(&text)
        .unwrap()
        .vectors
        .into_iter()
        .find(|vector| vector.challenge_token.is_some())
        .expect("a vector with a challengeToken");

    (vector.challenge_token.clone().unwrap(), vector)
}

fn run(arguments: &[&str], stdin: &str) -> Output {
    let mut child = Command::new(env!("CARGO_BIN_EXE_botdeflector-pow"))
        .args(arguments)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the botdeflector-pow binary starts");

    child
        .stdin
        .take()
        .unwrap()
        .write_all(stdin.as_bytes())
        .unwrap();
    child.wait_with_output().unwrap()
}

fn solved(output: &Output) -> Value {
    assert!(
        output.status.success(),
        "exit {:?}: {}",
        output.status.code(),
        String::from_utf8_lossy(&output.stderr)
    );

    serde_json::from_slice(&output.stdout).expect("stdout is JSON")
}

fn edge_indices(printed: &Value) -> Vec<Vec<u32>> {
    printed["solution"]
        .as_array()
        .expect("solution is an array")
        .iter()
        .map(|solution| serde_json::from_value(solution["edgeIndices"].clone()).unwrap())
        .collect()
}

#[test]
fn solves_a_token_given_as_argument() {
    let (token, vector) = captured_vector();
    let printed = solved(&run(&[&token], ""));

    assert_eq!(edge_indices(&printed), vector.expected);
    assert_eq!(printed["params"], vector.params, "params carry GRAPH_SEED");
    assert!(printed["elapsedMs"].as_f64().unwrap() > 0.0);
}

#[test]
fn reads_a_token_or_json_from_stdin() {
    let (token, vector) = captured_vector();
    let challenges_input =
        serde_json::json!({ "challenges": vector.challenges, "params": vector.params });

    assert_eq!(
        edge_indices(&solved(&run(&[], &format!("{token}\n")))),
        vector.expected
    );
    assert_eq!(edge_indices(&solved(&run(&["-"], &token))), vector.expected);
    assert_eq!(
        edge_indices(&solved(&run(&["--pretty"], &challenges_input.to_string()))),
        vector.expected
    );
}

#[test]
fn exit_codes_match_the_usage_text() {
    let exit_code = |arguments: &[&str], stdin: &str| run(arguments, stdin).status.code();
    let oversized =
        r#"{"challenges":["ab"],"params":{"NODES_BITS":24,"EDGES_BITS":24,"CYCLE_LENGTH":8}}"#;
    let fewer_edges_than_nodes = r#"{"challenges":["ab"],"params":{"NODES_BITS":12,"EDGES_BITS":4,"CYCLE_LENGTH":8,"GRAPH_SEED":"sparse"}}"#;

    assert_eq!(exit_code(&["--help"], ""), Some(0));
    assert_eq!(exit_code(&[], ""), Some(1), "no input");
    assert_eq!(exit_code(&["--bogus"], ""), Some(1), "unknown option");
    assert_eq!(
        exit_code(&["--timeout-ms"], ""),
        Some(1),
        "option without a value"
    );
    assert_eq!(exit_code(&["a.b.c", "d.e.f"], ""), Some(1), "two tokens");
    assert_eq!(exit_code(&["not-a-token"], ""), Some(2), "invalid token");
    assert_eq!(exit_code(&[], oversized), Some(3), "above the limits");
    assert_eq!(exit_code(&[], fewer_edges_than_nodes), Some(4), "no cycle");
}

#[test]
fn errors_go_to_stderr_and_version_to_stdout() {
    let failed = run(&["not-a-token"], "");
    let version = run(&["--version"], "");

    assert!(failed.stdout.is_empty());
    assert!(String::from_utf8_lossy(&failed.stderr)
        .starts_with("botdeflector-pow: invalid challenge token"));
    assert_eq!(
        String::from_utf8_lossy(&version.stdout).trim(),
        format!("botdeflector-pow {}", env!("CARGO_PKG_VERSION"))
    );
}
