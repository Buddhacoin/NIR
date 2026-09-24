use nir_consensus_codec::transfer_state::{
    apply_credit_transfer, apply_ordinary_transfer, apply_sponsored_transfer, parse_atomic,
    Account, CreditDelegation, CreditState, CreditTransfer, CreditUsage, SponsoredTransfer, State,
    Transfer, MAXIMUM_ATOMIC_DIGITS, MINIMUM_FEE, TRANSFER_CREDITS_PER_STAKE_UNIT,
    TRANSFER_CREDIT_EPOCH_BLOCKS, TRANSFER_CREDIT_STAKE_UNIT,
};
use nir_consensus_codec::{consensus_envelope_bytes, consensus_hash, consensus_value_bytes, Value};
use std::collections::BTreeMap;

#[derive(Clone, Debug)]
enum Json {
    Null,
    Bool(bool),
    Integer(i64),
    String(String),
    Array(Vec<Json>),
    Object(Vec<(String, Json)>),
}

struct Parser<'a> {
    bytes: &'a [u8],
    offset: usize,
}

impl<'a> Parser<'a> {
    fn new(input: &'a str) -> Self {
        Self {
            bytes: input.as_bytes(),
            offset: 0,
        }
    }

    fn parse(mut self) -> Result<Json, String> {
        let value = self.value()?;
        self.space();
        if self.offset != self.bytes.len() {
            return Err("trailing JSON data".into());
        }
        Ok(value)
    }

    fn space(&mut self) {
        while matches!(
            self.bytes.get(self.offset),
            Some(b' ' | b'\n' | b'\r' | b'\t')
        ) {
            self.offset += 1;
        }
    }

    fn take(&mut self, expected: u8) -> Result<(), String> {
        self.space();
        if self.bytes.get(self.offset) != Some(&expected) {
            return Err(format!("expected byte {expected:#x} at {}", self.offset));
        }
        self.offset += 1;
        Ok(())
    }

    fn literal(&mut self, literal: &[u8], value: Json) -> Result<Json, String> {
        if self.bytes.get(self.offset..self.offset + literal.len()) != Some(literal) {
            return Err(format!("invalid literal at {}", self.offset));
        }
        self.offset += literal.len();
        Ok(value)
    }

    fn value(&mut self) -> Result<Json, String> {
        self.space();
        match self.bytes.get(self.offset).copied() {
            Some(b'n') => self.literal(b"null", Json::Null),
            Some(b'f') => self.literal(b"false", Json::Bool(false)),
            Some(b't') => self.literal(b"true", Json::Bool(true)),
            Some(b'"') => self.string().map(Json::String),
            Some(b'[') => self.array(),
            Some(b'{') => self.object(),
            Some(b'-' | b'0'..=b'9') => self.integer(),
            _ => Err(format!("invalid JSON value at {}", self.offset)),
        }
    }

    fn integer(&mut self) -> Result<Json, String> {
        let start = self.offset;
        if self.bytes.get(self.offset) == Some(&b'-') {
            self.offset += 1;
        }
        if self.bytes.get(self.offset) == Some(&b'0') {
            self.offset += 1;
            if matches!(self.bytes.get(self.offset), Some(b'0'..=b'9')) {
                return Err("leading zero".into());
            }
        } else {
            let digits = self.offset;
            while matches!(self.bytes.get(self.offset), Some(b'0'..=b'9')) {
                self.offset += 1;
            }
            if digits == self.offset {
                return Err("integer requires digits".into());
            }
        }
        if matches!(self.bytes.get(self.offset), Some(b'.' | b'e' | b'E')) {
            return Err("non-integer JSON number".into());
        }
        let number = std::str::from_utf8(&self.bytes[start..self.offset])
            .map_err(|_| "invalid integer bytes")?
            .parse::<i64>()
            .map_err(|_| "invalid integer")?;
        Ok(Json::Integer(number))
    }

    fn string(&mut self) -> Result<String, String> {
        self.take(b'"')?;
        let mut output = String::new();
        let mut segment = self.offset;
        loop {
            let byte = *self.bytes.get(self.offset).ok_or("unterminated string")?;
            match byte {
                b'"' => {
                    output.push_str(
                        std::str::from_utf8(&self.bytes[segment..self.offset])
                            .map_err(|_| "invalid UTF-8")?,
                    );
                    self.offset += 1;
                    return Ok(output);
                }
                b'\\' => {
                    output.push_str(
                        std::str::from_utf8(&self.bytes[segment..self.offset])
                            .map_err(|_| "invalid UTF-8")?,
                    );
                    self.offset += 1;
                    let escaped = *self.bytes.get(self.offset).ok_or("unterminated escape")?;
                    self.offset += 1;
                    match escaped {
                        b'"' => output.push('"'),
                        b'\\' => output.push('\\'),
                        b'/' => output.push('/'),
                        b'b' => output.push('\u{0008}'),
                        b'f' => output.push('\u{000c}'),
                        b'n' => output.push('\n'),
                        b'r' => output.push('\r'),
                        b't' => output.push('\t'),
                        b'u' => output.push(self.unicode_escape()?),
                        _ => return Err("invalid escape".into()),
                    }
                    segment = self.offset;
                }
                0x00..=0x1f => return Err("control byte in string".into()),
                _ => self.offset += 1,
            }
        }
    }

    fn unicode_escape(&mut self) -> Result<char, String> {
        let first = self.hex_quad()?;
        let scalar = if (0xd800..=0xdbff).contains(&first) {
            if self.bytes.get(self.offset..self.offset + 2) != Some(b"\\u") {
                return Err("unpaired high surrogate".into());
            }
            self.offset += 2;
            let second = self.hex_quad()?;
            if !(0xdc00..=0xdfff).contains(&second) {
                return Err("unpaired high surrogate".into());
            }
            0x10000 + (((first - 0xd800) as u32) << 10) + (second - 0xdc00) as u32
        } else if (0xdc00..=0xdfff).contains(&first) {
            return Err("unpaired low surrogate".into());
        } else {
            first as u32
        };
        char::from_u32(scalar).ok_or_else(|| "invalid Unicode scalar".into())
    }

    fn hex_quad(&mut self) -> Result<u16, String> {
        let end = self.offset.checked_add(4).ok_or("escape overflow")?;
        let text = std::str::from_utf8(self.bytes.get(self.offset..end).ok_or("short escape")?)
            .map_err(|_| "invalid escape")?;
        self.offset = end;
        u16::from_str_radix(text, 16).map_err(|_| "invalid hex escape".into())
    }

    fn array(&mut self) -> Result<Json, String> {
        self.take(b'[')?;
        let mut values = Vec::new();
        self.space();
        if self.bytes.get(self.offset) == Some(&b']') {
            self.offset += 1;
            return Ok(Json::Array(values));
        }
        loop {
            values.push(self.value()?);
            self.space();
            match self.bytes.get(self.offset) {
                Some(b',') => self.offset += 1,
                Some(b']') => {
                    self.offset += 1;
                    return Ok(Json::Array(values));
                }
                _ => return Err("invalid array separator".into()),
            }
        }
    }

    fn object(&mut self) -> Result<Json, String> {
        self.take(b'{')?;
        let mut values = Vec::new();
        self.space();
        if self.bytes.get(self.offset) == Some(&b'}') {
            self.offset += 1;
            return Ok(Json::Object(values));
        }
        loop {
            let key = self.string()?;
            self.take(b':')?;
            let value = self.value()?;
            if values.iter().any(|(existing, _)| existing == &key) {
                return Err("duplicate JSON key".into());
            }
            values.push((key, value));
            self.space();
            match self.bytes.get(self.offset) {
                Some(b',') => self.offset += 1,
                Some(b'}') => {
                    self.offset += 1;
                    return Ok(Json::Object(values));
                }
                _ => return Err("invalid object separator".into()),
            }
        }
    }
}

fn object(value: &Json) -> &[(String, Json)] {
    match value {
        Json::Object(value) => value,
        _ => panic!("expected object"),
    }
}

fn member<'a>(value: &'a [(String, Json)], key: &str) -> &'a Json {
    value
        .iter()
        .find_map(|(name, value)| (name == key).then_some(value))
        .unwrap_or_else(|| panic!("missing field {key}"))
}

fn optional_member<'a>(value: &'a [(String, Json)], key: &str) -> Option<&'a Json> {
    value
        .iter()
        .find_map(|(name, value)| (name == key).then_some(value))
}

fn string(value: &Json) -> &str {
    match value {
        Json::String(value) => value,
        _ => panic!("expected string"),
    }
}

fn integer(value: &Json) -> i64 {
    match value {
        Json::Integer(value) => *value,
        _ => panic!("expected integer"),
    }
}

fn into_codec(value: &Json) -> Value {
    match value {
        Json::Null => Value::Null,
        Json::Bool(value) => Value::Bool(*value),
        Json::Integer(value) => Value::Integer(*value),
        Json::String(value) => Value::String(value.clone()),
        Json::Array(values) => Value::Array(values.iter().map(into_codec).collect()),
        Json::Object(values) => Value::Map(
            values
                .iter()
                .map(|(key, value)| (key.clone(), into_codec(value)))
                .collect(),
        ),
    }
}

fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut output = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        output.push(DIGITS[(byte >> 4) as usize] as char);
        output.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    output
}

#[test]
fn reproduces_normative_consensus_vectors() {
    let source = include_str!("../../../tests/vectors/consensus-codec-v1.json");
    let document = Parser::new(source)
        .parse()
        .expect("normative vectors must be strict JSON");
    let root = object(&document);
    assert_eq!(
        string(member(root, "format")),
        "nir-consensus-codec-vectors-v1"
    );
    let vectors = match member(root, "vectors") {
        Json::Array(values) => values,
        _ => panic!("vectors must be an array"),
    };
    assert!(!vectors.is_empty());

    for vector in vectors {
        let fields = object(vector);
        let name = string(member(fields, "name"));
        let domain = string(member(fields, "domain"));
        let value = into_codec(member(fields, "value"));
        assert_eq!(
            hex(&consensus_value_bytes(&value).expect("value bytes")),
            string(member(fields, "valueHex")),
            "value vector {name}"
        );
        assert_eq!(
            hex(&consensus_envelope_bytes(domain, &value).expect("envelope bytes")),
            string(member(fields, "envelopeHex")),
            "envelope vector {name}"
        );
        assert_eq!(
            hex(&consensus_hash(domain, &value).expect("hash")),
            string(member(fields, "hash")),
            "hash vector {name}"
        );
    }
}

fn transfer_state(value: &Json) -> State {
    let fields = object(value);
    let mut accounts = BTreeMap::<String, Account>::new();
    for (address, balance) in object(member(fields, "balances")) {
        accounts.insert(
            address.clone(),
            Account {
                balance: parse_atomic(string(balance)).expect("vector balance"),
                nonce: 0,
            },
        );
    }
    for (address, nonce) in object(member(fields, "nonces")) {
        accounts
            .entry(address.clone())
            .or_insert(Account {
                balance: 0,
                nonce: 0,
            })
            .nonce = u64::try_from(integer(nonce)).expect("vector nonce");
    }
    State {
        accounts,
        burned: parse_atomic(string(member(fields, "burned"))).expect("vector burned"),
    }
}

fn transfer_input(value: &Json) -> Transfer<'_> {
    let fields = object(value);
    Transfer {
        sender: string(member(fields, "sender")),
        recipient: string(member(fields, "recipient")),
        fee_recipient: string(member(fields, "feeRecipient")),
        amount: string(member(fields, "amount")),
        fee: string(member(fields, "fee")),
        nonce: u64::try_from(integer(member(fields, "nonce"))).expect("vector nonce"),
    }
}

fn sponsored_transfer_input(value: &Json) -> SponsoredTransfer<'_> {
    let fields = object(value);
    SponsoredTransfer {
        sender: string(member(fields, "sender")),
        recipient: string(member(fields, "recipient")),
        fee_payer: string(member(fields, "feePayer")),
        fee_recipient: string(member(fields, "feeRecipient")),
        amount: string(member(fields, "amount")),
        fee: string(member(fields, "fee")),
        nonce: u64::try_from(integer(member(fields, "nonce"))).expect("vector nonce"),
        fee_payer_nonce: u64::try_from(integer(member(fields, "feePayerNonce")))
            .expect("vector fee payer nonce"),
    }
}

fn credit_state(value: &Json) -> CreditState {
    let fields = object(value);
    let credit_stakes = object(member(fields, "creditStakes"))
        .iter()
        .map(|(address, stake)| {
            (
                address.clone(),
                parse_atomic(string(stake)).expect("vector credit stake"),
            )
        })
        .collect();
    let credit_usage = object(member(fields, "creditUsage"))
        .iter()
        .map(|(address, usage)| {
            let usage = object(usage);
            (
                address.clone(),
                CreditUsage {
                    epoch: u64::try_from(integer(member(usage, "epoch"))).expect("usage epoch"),
                    spent: u64::try_from(integer(member(usage, "spent"))).expect("usage spent"),
                },
            )
        })
        .collect();
    let credit_delegations = object(member(fields, "creditDelegations"))
        .iter()
        .map(|(key, delegation)| {
            let delegation = object(delegation);
            (
                key.clone(),
                CreditDelegation {
                    owner: string(member(delegation, "owner")).to_owned(),
                    delegate: string(member(delegation, "delegate")).to_owned(),
                    limit: u64::try_from(integer(member(delegation, "limit")))
                        .expect("delegation limit"),
                    epoch: u64::try_from(integer(member(delegation, "epoch")))
                        .expect("delegation epoch"),
                    spent: u64::try_from(integer(member(delegation, "spent")))
                        .expect("delegation spent"),
                },
            )
        })
        .collect();
    CreditState {
        monetary: transfer_state(value),
        credit_stakes,
        credit_usage,
        credit_delegations,
    }
}

fn credit_transfer_input(value: &Json) -> CreditTransfer<'_> {
    let fields = object(value);
    CreditTransfer {
        sender: string(member(fields, "sender")),
        recipient: string(member(fields, "recipient")),
        credit_owner: optional_member(fields, "creditOwner").map(string),
        fee_payer: optional_member(fields, "feePayer").map(string),
        fee_payer_nonce: optional_member(fields, "feePayerNonce")
            .map(integer)
            .map(|value| u64::try_from(value).expect("vector fee payer nonce")),
        amount: string(member(fields, "amount")),
        fee: string(member(fields, "fee")),
        nonce: u64::try_from(integer(member(fields, "nonce"))).expect("vector nonce"),
        height: u64::try_from(integer(member(fields, "height"))).expect("vector height"),
    }
}

#[test]
fn reproduces_normative_transfer_state_vectors_atomically() {
    let source = include_str!("../../../tests/vectors/transfer-state-v1.json");
    let document = Parser::new(source)
        .parse()
        .expect("transfer vectors must be strict JSON");
    let root = object(&document);
    assert_eq!(
        string(member(root, "format")),
        "nir-transfer-state-vectors-v1"
    );
    assert_eq!(
        parse_atomic(string(member(root, "minimumFee"))).expect("minimum fee"),
        MINIMUM_FEE
    );
    assert_eq!(
        usize::try_from(integer(member(root, "maximumAtomicDigits"))).expect("maximum digits"),
        MAXIMUM_ATOMIC_DIGITS
    );
    let vectors = match member(root, "vectors") {
        Json::Array(values) => values,
        _ => panic!("vectors must be an array"),
    };

    for vector in vectors {
        let fields = object(vector);
        let name = string(member(fields, "name"));
        let mut state = transfer_state(member(fields, "state"));
        let before = state.clone();
        let result =
            apply_ordinary_transfer(&mut state, transfer_input(member(fields, "transaction")));
        if let Some(error) = optional_member(fields, "error") {
            assert_eq!(
                result.expect_err("negative vector must fail").code(),
                string(error),
                "error vector {name}"
            );
            assert_eq!(state, before, "negative vector {name} must be atomic");
        } else {
            result.unwrap_or_else(|error| panic!("success vector {name}: {error}"));
            let expected = transfer_state(member(fields, "expected"));
            assert_eq!(state, expected, "state vector {name}");
            let before_total: u128 = before
                .accounts
                .values()
                .map(|account| account.balance)
                .sum();
            let after_total: u128 = state.accounts.values().map(|account| account.balance).sum();
            assert_eq!(after_total, before_total, "conservation vector {name}");
            assert_eq!(state.burned, before.burned, "burn vector {name}");
        }
    }
}

#[test]
fn reproduces_normative_sponsored_transfer_vectors_atomically() {
    let source = include_str!("../../../tests/vectors/sponsored-transfer-state-v1.json");
    let document = Parser::new(source)
        .parse()
        .expect("sponsored transfer vectors must be strict JSON");
    let root = object(&document);
    assert_eq!(
        string(member(root, "format")),
        "nir-sponsored-transfer-state-vectors-v1"
    );
    assert_eq!(
        parse_atomic(string(member(root, "minimumFee"))).expect("minimum fee"),
        MINIMUM_FEE
    );
    assert_eq!(
        usize::try_from(integer(member(root, "maximumAtomicDigits"))).expect("maximum digits"),
        MAXIMUM_ATOMIC_DIGITS
    );
    let vectors = match member(root, "vectors") {
        Json::Array(values) => values,
        _ => panic!("vectors must be an array"),
    };

    for vector in vectors {
        let fields = object(vector);
        let name = string(member(fields, "name"));
        let mut state = transfer_state(member(fields, "state"));
        let before = state.clone();
        let result = apply_sponsored_transfer(
            &mut state,
            sponsored_transfer_input(member(fields, "transaction")),
        );
        if let Some(error) = optional_member(fields, "error") {
            assert_eq!(
                result.expect_err("negative vector must fail").code(),
                string(error),
                "error vector {name}"
            );
            assert_eq!(state, before, "negative vector {name} must be atomic");
        } else {
            result.unwrap_or_else(|error| panic!("success vector {name}: {error}"));
            let expected = transfer_state(member(fields, "expected"));
            assert_eq!(state, expected, "state vector {name}");
            let before_total: u128 = before
                .accounts
                .values()
                .map(|account| account.balance)
                .sum();
            let after_total: u128 = state.accounts.values().map(|account| account.balance).sum();
            assert_eq!(after_total, before_total, "conservation vector {name}");
            assert_eq!(state.burned, before.burned, "burn vector {name}");
        }
    }
}

#[test]
fn reproduces_normative_credit_transfer_vectors_atomically() {
    let source = include_str!("../../../tests/vectors/credit-transfer-state-v1.json");
    let document = Parser::new(source)
        .parse()
        .expect("credit transfer vectors must be strict JSON");
    let root = object(&document);
    assert_eq!(
        string(member(root, "format")),
        "nir-credit-transfer-state-vectors-v1"
    );
    assert_eq!(
        parse_atomic(string(member(root, "stakeUnit"))).expect("stake unit"),
        TRANSFER_CREDIT_STAKE_UNIT
    );
    assert_eq!(
        u128::try_from(integer(member(root, "creditsPerStakeUnit"))).expect("credits per unit"),
        TRANSFER_CREDITS_PER_STAKE_UNIT
    );
    assert_eq!(
        u64::try_from(integer(member(root, "epochBlocks"))).expect("epoch blocks"),
        TRANSFER_CREDIT_EPOCH_BLOCKS
    );
    let vectors = match member(root, "vectors") {
        Json::Array(values) => values,
        _ => panic!("vectors must be an array"),
    };

    for vector in vectors {
        let fields = object(vector);
        let name = string(member(fields, "name"));
        let mut state = credit_state(member(fields, "state"));
        let before = state.clone();
        let result = apply_credit_transfer(
            &mut state,
            credit_transfer_input(member(fields, "transaction")),
        );
        if let Some(error) = optional_member(fields, "error") {
            assert_eq!(
                result.expect_err("negative vector must fail").code(),
                string(error),
                "error vector {name}"
            );
            assert_eq!(state, before, "negative vector {name} must be atomic");
        } else {
            result.unwrap_or_else(|error| panic!("success vector {name}: {error}"));
            let expected = credit_state(member(fields, "expected"));
            assert_eq!(state, expected, "state vector {name}");
            let before_total: u128 = before
                .monetary
                .accounts
                .values()
                .map(|account| account.balance)
                .sum();
            let after_total: u128 = state
                .monetary
                .accounts
                .values()
                .map(|account| account.balance)
                .sum();
            assert_eq!(after_total, before_total, "conservation vector {name}");
            assert_eq!(
                state.monetary.burned, before.monetary.burned,
                "burn vector {name}"
            );
        }
    }
}
