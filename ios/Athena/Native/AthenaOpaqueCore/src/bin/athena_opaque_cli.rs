use std::env;
use std::io::{self, Read};

fn main() {
    let operation = env::args().nth(1).unwrap_or_default();
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap();

    let output = match operation.as_str() {
        "start-registration" => AthenaOpaqueCore::start_registration_json(input.trim_end()),
        "finish-registration" => AthenaOpaqueCore::finish_registration_json(&input),
        "start-login" => AthenaOpaqueCore::start_login_json(input.trim_end()),
        "finish-login" => AthenaOpaqueCore::finish_login_json(&input),
        _ => {
            eprintln!("unsupported operation");
            std::process::exit(64);
        }
    };
    println!("{output}");
}
