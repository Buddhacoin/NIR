//! Dependency-free compatibility implementation of NIR consensus bytes v1.
//!
//! This crate deliberately implements only the language-neutral data model,
//! domain-separated envelope and SHA3-256 digest exercised by the normative
//! vectors. It is not a node, signer, JSON parser, or consensus engine.

use std::collections::HashSet;
use std::fmt;
use unicode_normalization::UnicodeNormalization;

pub const ENCODING_VERSION: u16 = 1;
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

const PREFIX: &[u8] = b"NIR-CONSENSUS";
const MAX_DEPTH: usize = 64;
const MAX_CONTAINER_ENTRIES: usize = 100_000;
const MAX_STRING_BYTES: usize = 16 * 1024 * 1024;
const MAX_ENCODED_BYTES: usize = 64 * 1024 * 1024;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
    Null,
    Bool(bool),
    Integer(i64),
    String(String),
    Array(Vec<Value>),
    Map(Vec<(String, Value)>),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(&'static str);

impl Error {
    pub const fn message(&self) -> &'static str {
        self.0
    }
}

impl fmt::Display for Error {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for Error {}

fn append(output: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Error> {
    let next = output
        .len()
        .checked_add(bytes.len())
        .ok_or(Error("encoded value is too large"))?;
    if next > MAX_ENCODED_BYTES {
        return Err(Error("encoded value is too large"));
    }
    output.extend_from_slice(bytes);
    Ok(())
}

fn append_string(output: &mut Vec<u8>, value: &str) -> Result<(), Error> {
    if value.len() > MAX_STRING_BYTES {
        return Err(Error("string is too large"));
    }
    append(output, &[0x04])?;
    append(output, &(value.len() as u32).to_be_bytes())?;
    append(output, value.as_bytes())
}

fn encode(value: &Value, output: &mut Vec<u8>, depth: usize) -> Result<(), Error> {
    if depth > MAX_DEPTH {
        return Err(Error("value nesting is too deep"));
    }
    match value {
        Value::Null => append(output, &[0x00]),
        Value::Bool(false) => append(output, &[0x01]),
        Value::Bool(true) => append(output, &[0x02]),
        Value::Integer(integer) => {
            if !(-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(integer) {
                return Err(Error("integer is outside the interoperable range"));
            }
            append(output, &[0x03])?;
            append(output, &integer.to_be_bytes())
        }
        Value::String(string) => append_string(output, string),
        Value::Array(values) => {
            if values.len() > MAX_CONTAINER_ENTRIES {
                return Err(Error("array has too many entries"));
            }
            append(output, &[0x05])?;
            append(output, &(values.len() as u32).to_be_bytes())?;
            for entry in values {
                encode(entry, output, depth + 1)?;
            }
            Ok(())
        }
        Value::Map(entries) => {
            if entries.len() > MAX_CONTAINER_ENTRIES {
                return Err(Error("map has too many entries"));
            }
            let mut ordered: Vec<_> = entries.iter().collect();
            ordered.sort_by(|left, right| left.0.as_bytes().cmp(right.0.as_bytes()));
            let mut keys = HashSet::with_capacity(ordered.len());
            for (key, _) in &ordered {
                if !key.nfc().eq(key.chars()) {
                    return Err(Error("map contains an ambiguous non-NFC key"));
                }
                if !keys.insert(key.as_str()) {
                    return Err(Error("map contains a duplicate key"));
                }
            }
            append(output, &[0x06])?;
            append(output, &(ordered.len() as u32).to_be_bytes())?;
            for (key, entry) in ordered {
                append_string(output, key)?;
                encode(entry, output, depth + 1)?;
            }
            Ok(())
        }
    }
}

pub fn consensus_value_bytes(value: &Value) -> Result<Vec<u8>, Error> {
    let mut output = Vec::new();
    encode(value, &mut output, 0)?;
    Ok(output)
}

fn valid_domain(domain: &str) -> bool {
    (1..=40).contains(&domain.len())
        && domain.bytes().all(|byte| {
            byte.is_ascii_uppercase() || byte.is_ascii_digit() || byte == b'_' || byte == b'-'
        })
}

pub fn consensus_envelope_bytes(domain: &str, value: &Value) -> Result<Vec<u8>, Error> {
    if !valid_domain(domain) {
        return Err(Error("invalid cryptographic domain"));
    }
    let value_bytes = consensus_value_bytes(value)?;
    let mut output = Vec::with_capacity(PREFIX.len() + 4 + domain.len() + value_bytes.len());
    output.extend_from_slice(PREFIX);
    output.push(0x00);
    output.extend_from_slice(&ENCODING_VERSION.to_be_bytes());
    output.push(domain.len() as u8);
    output.extend_from_slice(domain.as_bytes());
    output.extend_from_slice(&value_bytes);
    Ok(output)
}

pub fn consensus_hash(domain: &str, value: &Value) -> Result<[u8; 32], Error> {
    Ok(sha3_256(&consensus_envelope_bytes(domain, value)?))
}

const ROUND_CONSTANTS: [u64; 24] = [
    0x0000_0000_0000_0001,
    0x0000_0000_0000_8082,
    0x8000_0000_0000_808a,
    0x8000_0000_8000_8000,
    0x0000_0000_0000_808b,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8009,
    0x0000_0000_0000_008a,
    0x0000_0000_0000_0088,
    0x0000_0000_8000_8009,
    0x0000_0000_8000_000a,
    0x0000_0000_8000_808b,
    0x8000_0000_0000_008b,
    0x8000_0000_0000_8089,
    0x8000_0000_0000_8003,
    0x8000_0000_0000_8002,
    0x8000_0000_0000_0080,
    0x0000_0000_0000_800a,
    0x8000_0000_8000_000a,
    0x8000_0000_8000_8081,
    0x8000_0000_0000_8080,
    0x0000_0000_8000_0001,
    0x8000_0000_8000_8008,
];

const ROTATION: [u32; 25] = [
    0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14,
];

fn keccak_f(state: &mut [u64; 25]) {
    for round_constant in ROUND_CONSTANTS {
        let mut columns = [0_u64; 5];
        for x in 0..5 {
            columns[x] = state[x] ^ state[x + 5] ^ state[x + 10] ^ state[x + 15] ^ state[x + 20];
        }
        let mut theta = [0_u64; 5];
        for x in 0..5 {
            theta[x] = columns[(x + 4) % 5] ^ columns[(x + 1) % 5].rotate_left(1);
        }
        for y in 0..5 {
            for x in 0..5 {
                state[x + 5 * y] ^= theta[x];
            }
        }

        let mut rho_pi = [0_u64; 25];
        for y in 0..5 {
            for x in 0..5 {
                rho_pi[y + 5 * ((2 * x + 3 * y) % 5)] =
                    state[x + 5 * y].rotate_left(ROTATION[x + 5 * y]);
            }
        }

        for y in 0..5 {
            for x in 0..5 {
                state[x + 5 * y] = rho_pi[x + 5 * y]
                    ^ ((!rho_pi[(x + 1) % 5 + 5 * y]) & rho_pi[(x + 2) % 5 + 5 * y]);
            }
        }
        state[0] ^= round_constant;
    }
}

/// SHA3-256 as specified for consensus hashing. Kept private to the crate's
/// compatibility surface except through `consensus_hash`.
fn sha3_256(input: &[u8]) -> [u8; 32] {
    const RATE: usize = 136;
    let mut state = [0_u64; 25];
    let (blocks, remainder) = input.as_chunks::<RATE>();
    for block in blocks {
        for (lane, bytes) in block.as_chunks::<8>().0.iter().enumerate() {
            state[lane] ^= u64::from_le_bytes(*bytes);
        }
        keccak_f(&mut state);
    }

    let mut final_block = [0_u8; RATE];
    final_block[..remainder.len()].copy_from_slice(remainder);
    final_block[remainder.len()] = 0x06;
    final_block[RATE - 1] |= 0x80;
    for (lane, bytes) in final_block.as_chunks::<8>().0.iter().enumerate() {
        state[lane] ^= u64::from_le_bytes(*bytes);
    }
    keccak_f(&mut state);

    let mut output = [0_u8; 32];
    for (lane, target) in output.as_chunks_mut::<8>().0.iter_mut().enumerate() {
        target.copy_from_slice(&state[lane].to_le_bytes());
    }
    output
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_invalid_domains_and_duplicate_keys() {
        assert!(consensus_envelope_bytes("bad", &Value::Null).is_err());
        let duplicate = Value::Map(vec![
            ("key".into(), Value::Null),
            ("key".into(), Value::Bool(true)),
        ]);
        assert!(consensus_value_bytes(&duplicate).is_err());
        let unicode_key = Value::Map(vec![("é".into(), Value::Null)]);
        assert!(consensus_value_bytes(&unicode_key).is_ok());
        let non_nfc_key = Value::Map(vec![("e\u{301}".into(), Value::Null)]);
        assert!(consensus_value_bytes(&non_nfc_key).is_err());
    }

    #[test]
    fn sha3_known_answer_empty_input() {
        assert_eq!(
            sha3_256(b""),
            [
                0xa7, 0xff, 0xc6, 0xf8, 0xbf, 0x1e, 0xd7, 0x66, 0x51, 0xc1, 0x47, 0x56, 0xa0, 0x61,
                0xd6, 0x62, 0xf5, 0x80, 0xff, 0x4d, 0xe4, 0x3b, 0x49, 0xfa, 0x82, 0xd8, 0x0a, 0x4b,
                0x80, 0xf8, 0x43, 0x4a,
            ]
        );
    }
}
