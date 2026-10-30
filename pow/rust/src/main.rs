use botdeflector_pow::{solve, solve_challenge_token, Error, Options, Params};
use serde::Deserialize;
use std::io::Read;
use std::process::ExitCode;
use std::time::Duration;

const USAGE: &str = "usage: botdeflector-pow [--timeout-ms N] [--pretty] [<challengeToken>]

Solves the proof-of-work step of Queue-it's BotDeflector challenge.
Pass the challengeToken from pow/get as the argument, or pipe either the token or
{\"challenges\": [...], \"params\": {...}} on stdin.

Exit codes: 0 solved, 1 usage, 2 invalid input, 3 complexity above the limits, 4 no cycle or timed out";

const DEFAULT_TIMEOUT_MS: u64 = 5_000;

#[derive(Deserialize)]
struct ChallengesInput {
    challenges: Vec<String>,
    #[serde(default)]
    params: Params,
}

fn main() -> ExitCode {
    let mut timeout_ms = DEFAULT_TIMEOUT_MS;
    let mut pretty = false;
    let mut token_argument: Option<String> = None;
    let mut arguments = std::env::args().skip(1);

    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "-h" | "--help" => {
                println!("{USAGE}");
                return ExitCode::SUCCESS;
            }
            "-V" | "--version" => {
                println!("botdeflector-pow {}", env!("CARGO_PKG_VERSION"));
                return ExitCode::SUCCESS;
            }
            "--pretty" => pretty = true,
            "--timeout-ms" => match arguments.next().and_then(|value| value.parse().ok()) {
                Some(value) => timeout_ms = value,
                None => return usage("--timeout-ms needs a number"),
            },
            flag if flag.starts_with('-') && flag != "-" => {
                return usage(&format!("unknown option {flag}"))
            }
            _ if token_argument.is_some() => return usage("more than one challenge token given"),
            token => token_argument = Some(token.to_owned()),
        }
    }

    let input = match token_argument.filter(|token| token != "-") {
        Some(token) => token,
        None => {
            let mut stdin = String::new();

            if let Err(error) = std::io::stdin().read_to_string(&mut stdin) {
                return usage(&format!("stdin could not be read: {error}"));
            }

            if stdin.trim().is_empty() {
                return usage("no challenge token given");
            }

            stdin
        }
    };

    let input = input.trim();
    let options = Options {
        timeout: Some(Duration::from_millis(timeout_ms)),
        ..Options::default()
    };

    let result = if input.starts_with('{') {
        match serde_json::from_str::<ChallengesInput>(input) {
            Ok(challenges_input) => solve(
                &challenges_input.challenges,
                &challenges_input.params,
                &options,
            ),
            Err(error) => Err(Error::InvalidParams(format!("stdin JSON: {error}"))),
        }
    } else {
        solve_challenge_token(input, &options)
    };

    let solved = match result {
        Ok(solved) => solved,
        Err(error) => {
            eprintln!("botdeflector-pow: {error}");

            return ExitCode::from(match error {
                Error::InvalidParams(_) | Error::InvalidChallenge(_) | Error::InvalidToken(_) => 2,
                Error::Unsupported { .. } => 3,
                Error::NoCycle { .. } | Error::Deadline => 4,
            });
        }
    };

    let elapsed_ms = (solved.elapsed.as_secs_f64() * 1_000_000.0).round() / 1_000.0;
    let mut output = serde_json::to_value(&solved).expect("a solution serializes to JSON");
    output["elapsedMs"] = serde_json::json!(elapsed_ms);

    let text = if pretty {
        serde_json::to_string_pretty(&output)
    } else {
        serde_json::to_string(&output)
    };

    println!("{}", text.expect("a JSON value serializes"));
    ExitCode::SUCCESS
}

fn usage(message: &str) -> ExitCode {
    eprintln!("botdeflector-pow: {message}\n\n{USAGE}");
    ExitCode::from(1)
}
