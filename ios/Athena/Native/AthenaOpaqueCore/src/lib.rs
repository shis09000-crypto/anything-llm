#![allow(non_snake_case)]

use argon2::{Algorithm, Argon2, ParamsBuilder, Version};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD as BASE64, Engine as _};
use generic_array::{ArrayLength, GenericArray};
use opaque_ke::ciphersuite::CipherSuite;
use opaque_ke::errors::InternalError;
use opaque_ke::ksf::Ksf;
use opaque_ke::rand::rngs::OsRng;
use opaque_ke::{
    ClientLogin, ClientLoginFinishParameters, ClientRegistration,
    ClientRegistrationFinishParameters, CredentialResponse, Identifiers,
    RegistrationResponse,
};
use serde::{Deserialize, Serialize};
use std::ffi::{CStr, CString};
use std::os::raw::c_char;
use std::ptr;
use zeroize::Zeroize;

struct AthenaCipherSuite;

impl CipherSuite for AthenaCipherSuite {
    type OprfCs = opaque_ke::Ristretto255;
    type KeyExchange = opaque_ke::TripleDh<opaque_ke::Ristretto255, sha2::Sha512>;
    type Ksf = AthenaKsf;
}

#[derive(Default)]
struct AthenaKsf {
    argon: Argon2<'static>,
}

impl Ksf for AthenaKsf {
    fn hash<L: ArrayLength<u8>>(
        &self,
        input: GenericArray<u8, L>,
    ) -> Result<GenericArray<u8, L>, InternalError> {
        let mut output = GenericArray::default();
        self.argon
            .hash_password_into(
                &input,
                &[0; argon2::RECOMMENDED_SALT_LEN],
                &mut output,
            )
            .map_err(|_| InternalError::KsfError)?;
        Ok(output)
    }
}

fn memory_constrained_ksf() -> Result<AthenaKsf, String> {
    let mut builder = ParamsBuilder::default();
    builder.t_cost(3);
    builder.m_cost(1 << 16);
    builder.p_cost(4);
    let params = builder
        .build()
        .map_err(|_| "Invalid OPAQUE key stretching parameters.".to_string())?;
    Ok(AthenaKsf {
        argon: Argon2::new(Algorithm::Argon2id, Version::V0x13, params),
    })
}

#[derive(Serialize)]
struct Envelope<T: Serialize> {
    ok: bool,
    value: Option<T>,
    error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationStart {
    client_registration_state: String,
    registration_request: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationFinishInput {
    password: String,
    client_registration_state: String,
    registration_response: String,
    client_identifier: String,
    server_identifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegistrationFinish {
    registration_record: String,
    server_static_public_key: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginStart {
    client_login_state: String,
    start_login_request: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinishInput {
    password: String,
    client_login_state: String,
    login_response: String,
    client_identifier: String,
    server_identifier: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinish {
    finish_login_request: String,
    server_static_public_key: String,
}

fn encode_envelope<T: Serialize>(result: Result<T, String>) -> *mut c_char {
    CString::new(encode_envelope_json(result))
        .map(CString::into_raw)
        .unwrap_or(ptr::null_mut())
}

fn encode_envelope_json<T: Serialize>(result: Result<T, String>) -> String {
    let envelope = match result {
        Ok(value) => Envelope {
            ok: true,
            value: Some(value),
            error: None,
        },
        Err(error) => Envelope::<T> {
            ok: false,
            value: None,
            error: Some(error),
        },
    };
    serde_json::to_string(&envelope).unwrap_or_else(|_| {
        "{\"ok\":false,\"value\":null,\"error\":\"OPAQUE serialization failed.\"}"
            .to_string()
    })
}

unsafe fn string_from_ptr(value: *const c_char) -> Result<String, String> {
    if value.is_null() {
        return Err("OPAQUE input was missing.".to_string());
    }
    CStr::from_ptr(value)
        .to_str()
        .map(str::to_owned)
        .map_err(|_| "OPAQUE input was not valid UTF-8.".to_string())
}

fn identifiers<'a>(client: &'a str, server: &'a str) -> Identifiers<'a> {
    Identifiers {
        client: Some(client.as_bytes()),
        server: Some(server.as_bytes()),
    }
}

fn decode(value: &str, name: &str) -> Result<Vec<u8>, String> {
    BASE64
        .decode(value)
        .map_err(|_| format!("Invalid {name}."))
}

fn start_registration(mut password: String) -> Result<RegistrationStart, String> {
    let result = ClientRegistration::<AthenaCipherSuite>::start(
        &mut OsRng,
        password.as_bytes(),
    )
    .map_err(|_| "Unable to start OPAQUE registration.".to_string())?;
    password.zeroize();
    Ok(RegistrationStart {
        client_registration_state: BASE64.encode(result.state.serialize()),
        registration_request: BASE64.encode(result.message.serialize()),
    })
}

fn finish_registration(
    mut input: RegistrationFinishInput,
) -> Result<RegistrationFinish, String> {
    let state = ClientRegistration::<AthenaCipherSuite>::deserialize(&decode(
        &input.client_registration_state,
        "client registration state",
    )?)
    .map_err(|_| "Invalid OPAQUE registration state.".to_string())?;
    let response = RegistrationResponse::deserialize(&decode(
        &input.registration_response,
        "registration response",
    )?)
    .map_err(|_| "Invalid OPAQUE registration response.".to_string())?;
    let ksf = memory_constrained_ksf()?;
    let params = ClientRegistrationFinishParameters::new(
        identifiers(&input.client_identifier, &input.server_identifier),
        Some(&ksf),
    );
    let result = state
        .finish(&mut OsRng, input.password.as_bytes(), response, params)
        .map_err(|_| "OPAQUE registration verification failed.".to_string())?;
    input.password.zeroize();
    Ok(RegistrationFinish {
        registration_record: BASE64.encode(result.message.serialize()),
        server_static_public_key: BASE64.encode(result.server_s_pk.serialize()),
    })
}

fn start_login(mut password: String) -> Result<LoginStart, String> {
    let result = ClientLogin::<AthenaCipherSuite>::start(
        &mut OsRng,
        password.as_bytes(),
    )
    .map_err(|_| "Unable to start OPAQUE login.".to_string())?;
    password.zeroize();
    Ok(LoginStart {
        client_login_state: BASE64.encode(result.state.serialize()),
        start_login_request: BASE64.encode(result.message.serialize()),
    })
}

fn finish_login(mut input: LoginFinishInput) -> Result<LoginFinish, String> {
    let state = ClientLogin::<AthenaCipherSuite>::deserialize(&decode(
        &input.client_login_state,
        "client login state",
    )?)
    .map_err(|_| "Invalid OPAQUE login state.".to_string())?;
    let response = CredentialResponse::deserialize(&decode(
        &input.login_response,
        "login response",
    )?)
    .map_err(|_| "Invalid OPAQUE login response.".to_string())?;
    let ksf = memory_constrained_ksf()?;
    let params = ClientLoginFinishParameters::new(
        None,
        identifiers(&input.client_identifier, &input.server_identifier),
        Some(&ksf),
    );
    let result = state
        .finish(&mut OsRng, input.password.as_bytes(), response, params)
        .map_err(|_| "OPAQUE login verification failed.".to_string())?;
    input.password.zeroize();
    Ok(LoginFinish {
        finish_login_request: BASE64.encode(result.message.serialize()),
        server_static_public_key: BASE64.encode(result.server_s_pk.serialize()),
    })
}

pub fn start_registration_json(password: &str) -> String {
    encode_envelope_json(start_registration(password.to_string()))
}

pub fn finish_registration_json(input: &str) -> String {
    encode_envelope_json(
        serde_json::from_str::<RegistrationFinishInput>(input)
            .map_err(|_| "Invalid OPAQUE registration input.".to_string())
            .and_then(finish_registration),
    )
}

pub fn start_login_json(password: &str) -> String {
    encode_envelope_json(start_login(password.to_string()))
}

pub fn finish_login_json(input: &str) -> String {
    encode_envelope_json(
        serde_json::from_str::<LoginFinishInput>(input)
            .map_err(|_| "Invalid OPAQUE login input.".to_string())
            .and_then(finish_login),
    )
}

#[no_mangle]
pub unsafe extern "C" fn athena_opaque_start_registration(
    password: *const c_char,
) -> *mut c_char {
    encode_envelope(string_from_ptr(password).and_then(start_registration))
}

#[no_mangle]
pub unsafe extern "C" fn athena_opaque_finish_registration(
    json: *const c_char,
) -> *mut c_char {
    let result = string_from_ptr(json)
        .and_then(|value| {
            serde_json::from_str::<RegistrationFinishInput>(&value)
                .map_err(|_| "Invalid OPAQUE registration input.".to_string())
        })
        .and_then(finish_registration);
    encode_envelope(result)
}

#[no_mangle]
pub unsafe extern "C" fn athena_opaque_start_login(
    password: *const c_char,
) -> *mut c_char {
    encode_envelope(string_from_ptr(password).and_then(start_login))
}

#[no_mangle]
pub unsafe extern "C" fn athena_opaque_finish_login(
    json: *const c_char,
) -> *mut c_char {
    let result = string_from_ptr(json)
        .and_then(|value| {
            serde_json::from_str::<LoginFinishInput>(&value)
                .map_err(|_| "Invalid OPAQUE login input.".to_string())
        })
        .and_then(finish_login);
    encode_envelope(result)
}

#[no_mangle]
pub unsafe extern "C" fn athena_opaque_string_free(value: *mut c_char) {
    if !value.is_null() {
        let _ = CString::from_raw(value);
    }
}
