//! Deterministic monetary transition for an ordinary NIR transfer.
//!
//! Signature, network, transaction schema, block and treasury-vesting checks
//! are deliberately outside this narrow compatibility layer.

use std::collections::BTreeMap;
use std::fmt;

pub const MINIMUM_FEE: u128 = 1_000;
pub const MAXIMUM_ATOMIC_DIGITS: usize = 32;
pub const MAXIMUM_SAFE_NONCE: u64 = 9_007_199_254_740_991;
pub const MAXIMUM_ATOMIC_VALUE: u128 = 99_999_999_999_999_999_999_999_999_999_999;

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
