//! Deterministic monetary transition for an ordinary NIR transfer.
//!
//! Signature, network, transaction schema, block and treasury-vesting checks
//! are deliberately outside this narrow compatibility layer.

use std::collections::BTreeMap;
use std::fmt;

use crate::{consensus_hash, Value};

pub const MINIMUM_FEE: u128 = 1_000;
pub const MAXIMUM_ATOMIC_DIGITS: usize = 32;
pub const MAXIMUM_SAFE_NONCE: u64 = 9_007_199_254_740_991;
pub const MAXIMUM_ATOMIC_VALUE: u128 = 99_999_999_999_999_999_999_999_999_999_999;
pub const TRANSFER_CREDIT_STAKE_UNIT: u128 = 10_000_000_000;
pub const TRANSFER_CREDITS_PER_STAKE_UNIT: u128 = 10;
pub const TRANSFER_CREDIT_EPOCH_BLOCKS: u64 = 720;
pub const MAXIMUM_MULTISIG_MEMBERS: usize = 16;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Account {
    pub balance: u128,
    pub nonce: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub accounts: BTreeMap<String, Account>,
    pub burned: u128,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transfer<'a> {
    pub sender: &'a str,
    pub recipient: &'a str,
    pub fee_recipient: &'a str,
    pub amount: &'a str,
    pub fee: &'a str,
    pub nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Transition {
    pub amount: u128,
    pub fee: u128,
    pub next_nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SponsoredTransfer<'a> {
    pub sender: &'a str,
    pub recipient: &'a str,
    pub fee_payer: &'a str,
    pub fee_recipient: &'a str,
    pub amount: &'a str,
    pub fee: &'a str,
    pub nonce: u64,
    pub fee_payer_nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct SponsoredTransition {
    pub amount: u128,
    pub fee: u128,
    pub next_nonce: u64,
    pub next_fee_payer_nonce: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditUsage {
    pub epoch: u64,
    pub spent: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditDelegation {
    pub owner: String,
    pub delegate: String,
    pub limit: u64,
    pub epoch: u64,
    pub spent: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditState {
    pub monetary: State,
    pub credit_stakes: BTreeMap<String, u128>,
    pub credit_usage: BTreeMap<String, CreditUsage>,
    pub credit_delegations: BTreeMap<String, CreditDelegation>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CreditTransfer<'a> {
    pub sender: &'a str,
    pub recipient: &'a str,
    pub credit_owner: Option<&'a str>,
    pub fee_payer: Option<&'a str>,
    pub fee_payer_nonce: Option<u64>,
    pub amount: &'a str,
    pub fee: &'a str,
    pub nonce: u64,
    pub height: u64,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CreditTransition {
    pub amount: u128,
    pub epoch: u64,
    pub next_nonce: u64,
    pub next_fee_payer_nonce: Option<u64>,
    pub owner: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct MultisigTransfer<'a> {
    pub sender: &'a str,
    pub recipient: &'a str,
    pub fee_recipient: &'a str,
    pub amount: &'a str,
    pub fee: &'a str,
    pub nonce: u64,
    pub member_public_keys: Vec<&'a str>,
    pub threshold: usize,
    pub verified_signers: Vec<&'a str>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct TransferError(&'static str);

impl TransferError {
    pub const fn code(self) -> &'static str {
        self.0
    }
}

impl fmt::Display for TransferError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.0)
    }
}

impl std::error::Error for TransferError {}

pub fn parse_atomic(value: &str) -> Result<u128, TransferError> {
    if value.is_empty()
        || value.len() > MAXIMUM_ATOMIC_DIGITS
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(TransferError("invalid atomic decimal"));
    }
    value
        .parse::<u128>()
        .ok()
        .filter(|value| *value <= MAXIMUM_ATOMIC_VALUE)
        .ok_or(TransferError("invalid atomic decimal"))
}

fn valid_address(value: &str) -> bool {
    value.len() == 68
        && value.starts_with("nir1")
        && value[4..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn balance(state: &State, address: &str) -> Result<u128, TransferError> {
    let value = state
        .accounts
        .get(address)
        .map(|account| account.balance)
        .unwrap_or(0);
    if value > MAXIMUM_ATOMIC_VALUE {
        return Err(TransferError("balance overflow"));
    }
    Ok(value)
}

fn apply_delta(value: u128, delta: i128) -> Result<u128, TransferError> {
    let updated = if delta < 0 {
        value
            .checked_sub(delta.unsigned_abs())
            .ok_or(TransferError("insufficient balance"))?
    } else {
        value
            .checked_add(delta as u128)
            .ok_or(TransferError("balance overflow"))?
    };
    if updated > MAXIMUM_ATOMIC_VALUE {
        return Err(TransferError("balance overflow"));
    }
    Ok(updated)
}

pub fn apply_ordinary_transfer(
    state: &mut State,
    transfer: Transfer<'_>,
) -> Result<Transition, TransferError> {
    if !valid_address(transfer.sender)
        || !valid_address(transfer.recipient)
        || !valid_address(transfer.fee_recipient)
    {
        return Err(TransferError("invalid address"));
    }
    let amount = parse_atomic(transfer.amount)?;
    let fee = parse_atomic(transfer.fee)?;
    if amount == 0 {
        return Err(TransferError("amount must be positive"));
    }
    if fee < MINIMUM_FEE {
        return Err(TransferError("fee below minimum"));
    }
    if transfer.nonce >= MAXIMUM_SAFE_NONCE {
        return Err(TransferError("nonce cannot advance"));
    }
    let expected_nonce = state
        .accounts
        .get(transfer.sender)
        .map(|account| account.nonce)
        .unwrap_or(0);
    if transfer.nonce != expected_nonce {
        return Err(TransferError("unexpected nonce"));
    }

    let debit = amount
        .checked_add(fee)
        .ok_or(TransferError("balance overflow"))?;
    let debit = i128::try_from(debit).map_err(|_| TransferError("balance overflow"))?;
    let amount_delta = i128::try_from(amount).map_err(|_| TransferError("balance overflow"))?;
    let fee_delta = i128::try_from(fee).map_err(|_| TransferError("balance overflow"))?;
    let mut deltas = BTreeMap::<&str, i128>::new();
    for (address, delta) in [
        (transfer.sender, -debit),
        (transfer.recipient, amount_delta),
        (transfer.fee_recipient, fee_delta),
    ] {
        let combined = deltas
            .get(address)
            .copied()
            .unwrap_or(0)
            .checked_add(delta)
            .ok_or(TransferError("balance overflow"))?;
        deltas.insert(address, combined);
    }
    if deltas
        .values()
        .try_fold(0_i128, |total, delta| total.checked_add(*delta))
        != Some(0)
    {
        return Err(TransferError("conservation failure"));
    }

    let before = deltas.keys().try_fold(0_u128, |total, address| {
        total
            .checked_add(balance(state, address)?)
            .ok_or(TransferError("balance overflow"))
    })?;
    let mut updated = BTreeMap::new();
    for (address, delta) in &deltas {
        updated.insert(*address, apply_delta(balance(state, address)?, *delta)?);
    }
    let after = updated
        .values()
        .try_fold(0_u128, |total, value| total.checked_add(*value))
        .ok_or(TransferError("balance overflow"))?;
    if before != after {
        return Err(TransferError("conservation failure"));
    }

    for (address, next_balance) in updated {
        state
            .accounts
            .entry(address.to_owned())
            .or_insert(Account {
                balance: 0,
                nonce: 0,
            })
            .balance = next_balance;
    }
    state
        .accounts
        .entry(transfer.sender.to_owned())
        .or_insert(Account {
            balance: 0,
            nonce: 0,
        })
        .nonce = transfer.nonce + 1;
    Ok(Transition {
        amount,
        fee,
        next_nonce: transfer.nonce + 1,
    })
}

pub fn apply_sponsored_transfer(
    state: &mut State,
    transfer: SponsoredTransfer<'_>,
) -> Result<SponsoredTransition, TransferError> {
    if !valid_address(transfer.sender)
        || !valid_address(transfer.recipient)
        || !valid_address(transfer.fee_payer)
        || !valid_address(transfer.fee_recipient)
    {
        return Err(TransferError("invalid address"));
    }
    if transfer.fee_payer == transfer.sender {
        return Err(TransferError("fee payer must be distinct"));
    }
    let amount = parse_atomic(transfer.amount)?;
    let fee = parse_atomic(transfer.fee)?;
    if amount == 0 {
        return Err(TransferError("amount must be positive"));
    }
    if fee < MINIMUM_FEE {
        return Err(TransferError("fee below minimum"));
    }
    if transfer.nonce >= MAXIMUM_SAFE_NONCE {
        return Err(TransferError("nonce cannot advance"));
    }
    if transfer.fee_payer_nonce >= MAXIMUM_SAFE_NONCE {
        return Err(TransferError("fee payer nonce cannot advance"));
    }
    let expected_nonce = state
        .accounts
        .get(transfer.sender)
        .map(|account| account.nonce)
        .unwrap_or(0);
    if transfer.nonce != expected_nonce {
        return Err(TransferError("unexpected nonce"));
    }
    let expected_fee_payer_nonce = state
        .accounts
        .get(transfer.fee_payer)
        .map(|account| account.nonce)
        .unwrap_or(0);
    if transfer.fee_payer_nonce != expected_fee_payer_nonce {
        return Err(TransferError("unexpected fee payer nonce"));
    }
    if balance(state, transfer.sender)? < amount {
        return Err(TransferError("sender insufficient balance"));
    }
    if balance(state, transfer.fee_payer)? < fee {
        return Err(TransferError("fee payer insufficient balance"));
    }

    let amount_delta = i128::try_from(amount).map_err(|_| TransferError("balance overflow"))?;
    let fee_delta = i128::try_from(fee).map_err(|_| TransferError("balance overflow"))?;
    let mut deltas = BTreeMap::<&str, i128>::new();
    for (address, delta) in [
        (transfer.sender, -amount_delta),
        (transfer.recipient, amount_delta),
        (transfer.fee_payer, -fee_delta),
        (transfer.fee_recipient, fee_delta),
    ] {
        let combined = deltas
            .get(address)
            .copied()
            .unwrap_or(0)
            .checked_add(delta)
            .ok_or(TransferError("balance overflow"))?;
        deltas.insert(address, combined);
    }
    if deltas
        .values()
        .try_fold(0_i128, |total, delta| total.checked_add(*delta))
        != Some(0)
    {
        return Err(TransferError("conservation failure"));
    }

    let before = deltas.keys().try_fold(0_u128, |total, address| {
        total
            .checked_add(balance(state, address)?)
            .ok_or(TransferError("balance overflow"))
    })?;
    let mut updated = BTreeMap::new();
    for (address, delta) in &deltas {
        updated.insert(*address, apply_delta(balance(state, address)?, *delta)?);
    }
    let after = updated
        .values()
        .try_fold(0_u128, |total, value| total.checked_add(*value))
        .ok_or(TransferError("balance overflow"))?;
    if before != after {
        return Err(TransferError("conservation failure"));
    }

    for (address, next_balance) in updated {
        state
            .accounts
            .entry(address.to_owned())
            .or_insert(Account {
                balance: 0,
                nonce: 0,
            })
            .balance = next_balance;
    }
    state
        .accounts
        .entry(transfer.sender.to_owned())
        .or_insert(Account {
            balance: 0,
            nonce: 0,
        })
        .nonce = transfer.nonce + 1;
    state
        .accounts
        .entry(transfer.fee_payer.to_owned())
        .or_insert(Account {
            balance: 0,
            nonce: 0,
        })
        .nonce = transfer.fee_payer_nonce + 1;
    Ok(SponsoredTransition {
        amount,
        fee,
        next_nonce: transfer.nonce + 1,
        next_fee_payer_nonce: transfer.fee_payer_nonce + 1,
    })
}

pub fn transfer_credit_allowance(stake: u128) -> Result<u128, TransferError> {
    if stake > MAXIMUM_ATOMIC_VALUE {
        return Err(TransferError("credit stake overflow"));
    }
    stake
        .checked_mul(TRANSFER_CREDITS_PER_STAKE_UNIT)
        .map(|value| value / TRANSFER_CREDIT_STAKE_UNIT)
        .ok_or(TransferError("credit allowance overflow"))
}

pub fn transfer_credit_epoch(height: u64) -> Result<u64, TransferError> {
    if height > MAXIMUM_SAFE_NONCE {
        return Err(TransferError("credit height invalid"));
    }
    Ok(if height == 0 {
        0
    } else {
        (height - 1) / TRANSFER_CREDIT_EPOCH_BLOCKS
    })
}

pub fn apply_credit_transfer(
    state: &mut CreditState,
    transfer: CreditTransfer<'_>,
) -> Result<CreditTransition, TransferError> {
    if !valid_address(transfer.sender) || !valid_address(transfer.recipient) {
        return Err(TransferError("invalid address"));
    }
    let sponsored = transfer.fee_payer.is_some() || transfer.fee_payer_nonce.is_some();
    if sponsored && (transfer.fee_payer.is_none() || transfer.fee_payer_nonce.is_none()) {
        return Err(TransferError("sponsored credit fields incomplete"));
    }
    if sponsored && transfer.credit_owner.is_some() {
        return Err(TransferError("sponsored credit cannot be delegated"));
    }
    let fee_payer = transfer.fee_payer;
    if fee_payer == Some(transfer.sender) {
        return Err(TransferError("fee payer must be distinct"));
    }
    let owner = fee_payer
        .or(transfer.credit_owner)
        .unwrap_or(transfer.sender);
    if !valid_address(owner) {
        return Err(TransferError("invalid address"));
    }
    let delegated = !sponsored && owner != transfer.sender;
    if transfer.credit_owner.is_some() && !delegated {
        return Err(TransferError("delegated owner must be distinct"));
    }
    let amount = parse_atomic(transfer.amount)?;
    let fee = parse_atomic(transfer.fee)?;
    if amount == 0 {
        return Err(TransferError("amount must be positive"));
    }
    if fee != 0 {
        return Err(TransferError("credit fee must be zero"));
    }
    if transfer.nonce >= MAXIMUM_SAFE_NONCE {
        return Err(TransferError("nonce cannot advance"));
    }
    let epoch = transfer_credit_epoch(transfer.height)?;
    let expected_nonce = state
        .monetary
        .accounts
        .get(transfer.sender)
        .map(|account| account.nonce)
        .unwrap_or(0);
    if transfer.nonce != expected_nonce {
        return Err(TransferError("unexpected nonce"));
    }
    if let (Some(fee_payer), Some(fee_payer_nonce)) = (fee_payer, transfer.fee_payer_nonce) {
        if fee_payer_nonce >= MAXIMUM_SAFE_NONCE {
            return Err(TransferError("fee payer nonce cannot advance"));
        }
        let expected_fee_payer_nonce = state
            .monetary
            .accounts
            .get(fee_payer)
            .map(|account| account.nonce)
            .unwrap_or(0);
        if fee_payer_nonce != expected_fee_payer_nonce {
            return Err(TransferError("unexpected fee payer nonce"));
        }
    }
    if balance(&state.monetary, transfer.sender)? < amount {
        return Err(TransferError("sender insufficient balance"));
    }

    let stake = state.credit_stakes.get(owner).copied().unwrap_or(0);
    let allowance = transfer_credit_allowance(stake)?;
    let spent = state
        .credit_usage
        .get(owner)
        .filter(|usage| usage.epoch == epoch)
        .map(|usage| usage.spent)
        .unwrap_or(0);
    if allowance <= u128::from(spent) {
        return Err(TransferError("credit quota exhausted"));
    }
    let next_usage = CreditUsage {
        epoch,
        spent: spent
            .checked_add(1)
            .ok_or(TransferError("credit usage overflow"))?,
    };

    let mut next_delegation = None;
    if delegated {
        let key = format!("{owner}:{}", transfer.sender);
        let delegation = state
            .credit_delegations
            .get(&key)
            .ok_or(TransferError("delegation missing"))?;
        let delegation_spent = if delegation.epoch == epoch {
            delegation.spent
        } else {
            0
        };
        if delegation_spent >= delegation.limit {
            return Err(TransferError("delegation exhausted"));
        }
        let mut updated = delegation.clone();
        updated.epoch = epoch;
        updated.spent = delegation_spent
            .checked_add(1)
            .ok_or(TransferError("delegation usage overflow"))?;
        next_delegation = Some((key, updated));
    }

    let amount_delta = i128::try_from(amount).map_err(|_| TransferError("balance overflow"))?;
    let mut deltas = BTreeMap::<&str, i128>::new();
    for (address, delta) in [
        (transfer.sender, -amount_delta),
        (transfer.recipient, amount_delta),
    ] {
        let combined = deltas
            .get(address)
            .copied()
            .unwrap_or(0)
            .checked_add(delta)
            .ok_or(TransferError("balance overflow"))?;
        deltas.insert(address, combined);
    }
    let before = deltas.keys().try_fold(0_u128, |total, address| {
        total
            .checked_add(balance(&state.monetary, address)?)
            .ok_or(TransferError("balance overflow"))
    })?;
    let mut updated_balances = BTreeMap::new();
    for (address, delta) in &deltas {
        updated_balances.insert(
            *address,
            apply_delta(balance(&state.monetary, address)?, *delta)?,
        );
    }
    let after = updated_balances
        .values()
        .try_fold(0_u128, |total, value| total.checked_add(*value))
        .ok_or(TransferError("balance overflow"))?;
    if before != after
        || deltas
            .values()
            .try_fold(0_i128, |total, delta| total.checked_add(*delta))
            != Some(0)
    {
        return Err(TransferError("conservation failure"));
    }

    for (address, next_balance) in updated_balances {
        state
            .monetary
            .accounts
            .entry(address.to_owned())
            .or_insert(Account {
                balance: 0,
                nonce: 0,
            })
            .balance = next_balance;
    }
    state
        .monetary
        .accounts
        .entry(transfer.sender.to_owned())
        .or_insert(Account {
            balance: 0,
            nonce: 0,
        })
        .nonce = transfer.nonce + 1;
    if let (Some(fee_payer), Some(fee_payer_nonce)) = (fee_payer, transfer.fee_payer_nonce) {
        state
            .monetary
            .accounts
            .entry(fee_payer.to_owned())
            .or_insert(Account {
                balance: 0,
                nonce: 0,
            })
            .nonce = fee_payer_nonce + 1;
    }
    state.credit_usage.insert(owner.to_owned(), next_usage);
    if let Some((key, delegation)) = next_delegation {
        state.credit_delegations.insert(key, delegation);
    }
    Ok(CreditTransition {
        amount,
        epoch,
        next_nonce: transfer.nonce + 1,
        next_fee_payer_nonce: transfer.fee_payer_nonce.map(|nonce| nonce + 1),
        owner: owner.to_owned(),
    })
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

pub fn multisig_state_address(
    member_public_keys: &[&str],
    threshold: usize,
) -> Result<String, TransferError> {
    if member_public_keys.len() < 2
        || member_public_keys.len() > MAXIMUM_MULTISIG_MEMBERS
        || threshold < 2
        || threshold > member_public_keys.len()
        || member_public_keys
            .iter()
            .any(|key| key.encode_utf16().count() > 4_000)
    {
        return Err(TransferError("invalid descriptor"));
    }
    let mut members = member_public_keys.to_vec();
    members.sort_unstable();
    if members.windows(2).any(|pair| pair[0] == pair[1]) {
        return Err(TransferError("invalid descriptor"));
    }
    let descriptor = Value::Map(vec![
        (
            "algorithm".to_owned(),
            Value::String("ml-dsa-65".to_owned()),
        ),
        (
            "memberPublicKeys".to_owned(),
            Value::Array(
                members
                    .into_iter()
                    .map(|member| Value::String(member.to_owned()))
                    .collect(),
            ),
        ),
        (
            "threshold".to_owned(),
            Value::Integer(
                i64::try_from(threshold).map_err(|_| TransferError("invalid descriptor"))?,
            ),
        ),
    ]);
    let digest = consensus_hash("MULTISIG_ADDRESS", &descriptor)
        .map_err(|_| TransferError("invalid descriptor"))?;
    Ok(format!("nir1{}", hex(&digest)))
}

pub fn apply_multisig_transfer(
    state: &mut State,
    transfer: MultisigTransfer<'_>,
) -> Result<Transition, TransferError> {
    let expected_address =
        multisig_state_address(&transfer.member_public_keys, transfer.threshold)?;
    if expected_address != transfer.sender {
        return Err(TransferError("descriptor address mismatch"));
    }
    if transfer.verified_signers.len() > transfer.member_public_keys.len() {
        return Err(TransferError("invalid signer collection"));
    }
    let allowed = transfer
        .member_public_keys
        .iter()
        .copied()
        .collect::<std::collections::BTreeSet<_>>();
    let mut signers = std::collections::BTreeSet::new();
    for signer in &transfer.verified_signers {
        if !allowed.contains(signer) {
            return Err(TransferError("unknown signer"));
        }
        if !signers.insert(*signer) {
            return Err(TransferError("duplicate signer"));
        }
    }
    if signers.len() < transfer.threshold {
        return Err(TransferError("threshold not reached"));
    }
    apply_ordinary_transfer(
        state,
        Transfer {
            sender: transfer.sender,
            recipient: transfer.recipient,
            fee_recipient: transfer.fee_recipient,
            amount: transfer.amount,
            fee: transfer.fee,
            nonce: transfer.nonce,
        },
    )
}
