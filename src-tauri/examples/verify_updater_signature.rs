use base64::Engine;
use minisign_verify::{PublicKey, Signature};
use serde_json::Value;
use std::path::Path;

fn main() -> Result<(), String> {
    let arguments = std::env::args().skip(1).collect::<Vec<_>>();
    let [config_path, installer_path, signature_path] = arguments.as_slice() else {
        return Err(
            "Usage: verify_updater_signature <tauri.conf.json> <installer> <signature>".into(),
        );
    };
    let config: Value = serde_json::from_str(
        &std::fs::read_to_string(config_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let encoded_public_key = config
        .pointer("/plugins/updater/pubkey")
        .and_then(Value::as_str)
        .ok_or_else(|| "Tauri updater public key is missing".to_string())?;
    let decoded_public_key = base64::engine::general_purpose::STANDARD
        .decode(encoded_public_key)
        .map_err(|error| error.to_string())?;
    let public_key_text =
        std::str::from_utf8(&decoded_public_key).map_err(|error| error.to_string())?;
    let public_key = PublicKey::decode(public_key_text).map_err(|error| error.to_string())?;
    let encoded_signature =
        std::fs::read_to_string(Path::new(signature_path)).map_err(|error| error.to_string())?;
    let decoded_signature = base64::engine::general_purpose::STANDARD
        .decode(encoded_signature.trim())
        .map_err(|error| error.to_string())?;
    let signature_text =
        std::str::from_utf8(&decoded_signature).map_err(|error| error.to_string())?;
    let signature = Signature::decode(signature_text).map_err(|error| error.to_string())?;
    let installer = std::fs::read(installer_path).map_err(|error| error.to_string())?;
    public_key
        .verify(&installer, &signature, false)
        .map_err(|error| error.to_string())?;
    println!("Verified updater signature for {installer_path}.");
    Ok(())
}
