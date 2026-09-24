//! Independent bounded state transition for an agent spending mandate.
//!
//! Authorization values passed here are assumed to have been authenticated by
//! the caller and bound to the transaction digest. This module validates that
//! boundary but intentionally does not perform signature verification.

use crate::{consensus_hash, Value};
use std::collections::{BTreeMap, BTreeSet};

pub const MAX_ACTIVE_MANDATES_PER_OWNER: usize = 64;
pub const MAX_GLOBAL_MANDATES: usize = 4_096;
pub const MAX_PRUNE_BATCH: usize = 64;
pub const MAX_PAYEES: usize = 64;
pub const MAX_LIFETIME: u64 = 1_000_000;
pub const MIN_FEE: u128 = 1_000;
const MAX_ATOMIC: u128 = 99_999_999_999_999_999_999_999_999_999_999;
const MAX_NONCE: u64 = 9_007_199_254_740_991;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Error(&'static str);
impl Error {
    pub const fn code(&self) -> &'static str {
        self.0
    }
}
impl std::fmt::Display for Error {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}
impl std::error::Error for Error {}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PreverifiedAuthorization {
    pub actor: String,
    pub digest: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Mandate {
    pub owner: String,
    pub agent: String,
    pub allowed_payees: Vec<String>,
    pub balance: u128,
    pub initial_escrow: u128,
    pub created_height: u64,
    pub expires_height: u64,
    pub max_fee: u128,
    pub max_per_transfer: u128,
    pub network_id: String,
    pub policy_hash: String,
    pub total_limit: u128,
    pub total_fee_limit: u128,
    pub total_fees: u128,
    pub total_spent: u128,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct State {
    pub balances: BTreeMap<String, u128>,
    pub nonces: BTreeMap<String, u64>,
    pub mandates: BTreeMap<String, Mandate>,
    pub burned: u128,
}

pub struct Create<'a> {
    pub owner: &'a str,
    pub agent: &'a str,
    pub mandate_id: &'a str,
    pub policy_hash: &'a str,
    pub allowed_payees: Vec<&'a str>,
    pub escrow: u128,
    pub max_fee: u128,
    pub max_per_transfer: u128,
    pub total_limit: u128,
    pub total_fee_limit: u128,
    pub network_id: &'a str,
    pub expires_height: u64,
    pub fee: u128,
    pub context: ExecutionContext<'a>,
    pub nonce: u64,
    pub authorization: PreverifiedAuthorization,
}
pub struct Transfer<'a> {
    pub mandate_id: &'a str,
    pub payee: &'a str,
    pub amount: u128,
    pub fee: u128,
    pub context: ExecutionContext<'a>,
    pub nonce: u64,
    pub authorization: PreverifiedAuthorization,
}
#[derive(Clone, Copy)]
pub enum CloseMode {
    Revoke,
    Expiry,
    Unknown,
}
pub struct Close<'a> {
    pub mandate_id: &'a str,
    pub mode: CloseMode,
    pub fee: u128,
    pub context: ExecutionContext<'a>,
    pub nonce: u64,
    pub authorization: PreverifiedAuthorization,
}
pub struct ExecutionContext<'a> {
    pub current_height: u64,
    pub fee_recipient: &'a str,
    pub network_id: &'a str,
}
pub struct PruneContext<'a> {
    pub current_height: u64,
    pub network_id: &'a str,
}

fn address(v: &str) -> bool {
    v.len() == 68
        && v.starts_with("nir1")
        && v[4..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn hash(v: &str) -> bool {
    v.len() == 64
        && v.bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
}
fn network(v: &str) -> bool {
    (3..=128).contains(&v.len())
        && v.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'))
}
fn auth(
    v: &PreverifiedAuthorization,
    actor: &str,
    digest: &str,
    role: &'static str,
) -> Result<(), Error> {
    if v.actor != actor || v.digest != digest {
        return Err(Error(role));
    }
    Ok(())
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn map(entries: Vec<(&str, Value)>) -> Value {
    Value::Map(
        entries
            .into_iter()
            .map(|(k, v)| (k.to_owned(), v))
            .collect(),
    )
}
fn string(v: impl ToString) -> Value {
    Value::String(v.to_string())
}
pub fn create_digest(tx: &Create<'_>, payees: &[String]) -> Result<String, Error> {
    let value = map(vec![
        ("agent", string(tx.agent)),
        (
            "allowedPayees",
            Value::Array(payees.iter().map(string).collect()),
        ),
        ("escrow", string(tx.escrow)),
        ("expiresHeight", Value::Integer(tx.expires_height as i64)),
        ("fee", string(tx.fee)),
        ("mandateId", string(tx.mandate_id)),
        ("maxFee", string(tx.max_fee)),
        ("maxPerTransfer", string(tx.max_per_transfer)),
        ("networkId", string(tx.network_id)),
        ("nonce", Value::Integer(tx.nonce as i64)),
        ("owner", string(tx.owner)),
        ("policyHash", string(tx.policy_hash)),
        ("totalFeeLimit", string(tx.total_fee_limit)),
        ("totalLimit", string(tx.total_limit)),
    ]);
    consensus_hash("AGENT_MANDATE_CREATE", &value)
        .map(|h| hex(&h))
        .map_err(|_| Error("agent mandate digest is invalid"))
}
pub fn transfer_digest(tx: &Transfer<'_>, network_id: &str) -> Result<String, Error> {
    let value = map(vec![
        ("amount", string(tx.amount)),
        ("fee", string(tx.fee)),
        ("mandateId", string(tx.mandate_id)),
        ("networkId", string(network_id)),
        ("nonce", Value::Integer(tx.nonce as i64)),
        ("payee", string(tx.payee)),
    ]);
    consensus_hash("AGENT_MANDATE_TRANSFER", &value)
        .map(|h| hex(&h))
        .map_err(|_| Error("agent mandate digest is invalid"))
}
pub fn close_digest(tx: &Close<'_>, network_id: &str) -> Result<String, Error> {
    let mode = match tx.mode {
        CloseMode::Revoke => "revoke",
        CloseMode::Expiry => "expiry",
        CloseMode::Unknown => return Err(Error("mandate close mode is invalid")),
    };
    let value = map(vec![
        ("fee", string(tx.fee)),
        ("mandateId", string(tx.mandate_id)),
        ("mode", string(mode)),
        ("networkId", string(network_id)),
        ("nonce", Value::Integer(tx.nonce as i64)),
    ]);
    consensus_hash("AGENT_MANDATE_CLOSE", &value)
        .map(|h| hex(&h))
        .map_err(|_| Error("agent mandate digest is invalid"))
}

fn validate_mandate(id: &str, m: &Mandate) -> Result<(), Error> {
    if !hash(id)
        || !address(&m.owner)
        || !address(&m.agent)
        || m.owner == m.agent
        || !hash(&m.policy_hash)
        || !network(&m.network_id)
    {
        return Err(Error("agent mandate state is invalid"));
    }
    if m.allowed_payees.is_empty()
        || m.allowed_payees.len() > MAX_PAYEES
        || m.allowed_payees.windows(2).any(|w| w[0] >= w[1])
        || m.allowed_payees
            .iter()
            .any(|p| !address(p) || p == &m.owner || p == &m.agent)
    {
        return Err(Error("agent mandate state is invalid"));
    }
    if m.max_fee < MIN_FEE
        || [
            m.balance,
            m.initial_escrow,
            m.max_fee,
            m.max_per_transfer,
            m.total_limit,
            m.total_fee_limit,
            m.total_fees,
            m.total_spent,
        ]
        .iter()
        .any(|v| *v > MAX_ATOMIC)
        || m.max_fee > m.total_fee_limit
        || m.max_per_transfer == 0
        || m.total_limit == 0
        || m.max_per_transfer > m.total_limit
        || m.total_spent > m.total_limit
        || m.total_fees > m.total_fee_limit
        || m.total_limit
            .checked_add(m.total_fee_limit)
            .filter(|v| *v <= m.initial_escrow)
            .is_none()
        || m.balance
            .checked_add(m.total_spent)
            .and_then(|v| v.checked_add(m.total_fees))
            != Some(m.initial_escrow)
        || m.expires_height <= m.created_height
        || m.expires_height > MAX_NONCE
        || m.expires_height - m.created_height > MAX_LIFETIME
    {
        return Err(Error("agent mandate state is invalid"));
    }
    Ok(())
}

fn validate_registry(state: &State, network_id: &str) -> Result<(), Error> {
    if state.mandates.len() > MAX_GLOBAL_MANDATES {
        return Err(Error("global agent mandate capacity exceeded"));
    }
    let mut owners: BTreeMap<&str, usize> = BTreeMap::new();
    for (id, m) in &state.mandates {
        validate_mandate(id, m)?;
        if m.network_id != network_id {
            return Err(Error("network id mismatch"));
        }
        let count = owners.get(m.owner.as_str()).copied().unwrap_or(0) + 1;
        if count > MAX_ACTIVE_MANDATES_PER_OWNER {
            return Err(Error("owner agent mandate capacity exceeded"));
        }
        owners.insert(&m.owner, count);
    }
    Ok(())
}
fn nonce(state: &State, actor: &str, supplied: u64, role: &'static str) -> Result<(), Error> {
    if supplied >= MAX_NONCE || state.nonces.get(actor).copied().unwrap_or(0) != supplied {
        return Err(Error(role));
    }
    Ok(())
}
fn add_delta(deltas: &mut BTreeMap<String, i128>, account: &str, delta: i128) -> Result<(), Error> {
    let next = deltas
        .get(account)
        .copied()
        .unwrap_or(0)
        .checked_add(delta)
        .ok_or(Error("account balance overflow"))?;
    deltas.insert(account.to_owned(), next);
    Ok(())
}
fn apply_deltas(state: &mut State, deltas: BTreeMap<String, i128>) -> Result<(), Error> {
    let mut next = Vec::new();
    for (account, delta) in deltas {
        let old = state.balances.get(&account).copied().unwrap_or(0);
        if old > MAX_ATOMIC {
            return Err(Error("account balance overflow"));
        }
        let value = if delta < 0 {
            old.checked_sub(delta.unsigned_abs())
        } else {
            old.checked_add(delta as u128)
        }
        .filter(|v| *v <= MAX_ATOMIC)
        .ok_or(Error("account balance overflow"))?;
        next.push((account, value));
    }
    for (account, value) in next {
        state.balances.insert(account, value);
    }
    Ok(())
}

pub fn create(state: &mut State, tx: Create<'_>) -> Result<(), Error> {
    if !address(tx.owner)
        || !address(tx.agent)
        || !address(tx.context.fee_recipient)
        || !network(tx.network_id)
        || !network(tx.context.network_id)
    {
        return Err(Error("agent mandate address is invalid"));
    }
    if tx.network_id != tx.context.network_id {
        return Err(Error("network id mismatch"));
    }
    if tx.owner == tx.agent {
        return Err(Error("agent must be independent from owner"));
    }
    if !hash(tx.mandate_id) || !hash(tx.policy_hash) {
        return Err(Error("agent mandate commitment is invalid"));
    }
    if state.mandates.contains_key(tx.mandate_id) {
        return Err(Error("agent mandate already exists"));
    }
    validate_registry(state, tx.context.network_id)?;
    if state.mandates.len() >= MAX_GLOBAL_MANDATES {
        return Err(Error("global agent mandate capacity reached"));
    }
    if state
        .mandates
        .values()
        .filter(|m| m.owner == tx.owner)
        .count()
        >= MAX_ACTIVE_MANDATES_PER_OWNER
    {
        return Err(Error("owner agent mandate capacity reached"));
    }
    nonce(state, tx.owner, tx.nonce, "owner nonce is unexpected")?;
    if tx.context.current_height > MAX_NONCE
        || tx.expires_height > MAX_NONCE
        || tx.expires_height <= tx.context.current_height
        || tx.expires_height - tx.context.current_height > MAX_LIFETIME
    {
        return Err(Error("agent mandate expiry is invalid"));
    }
    if tx.escrow == 0
        || tx.max_fee < MIN_FEE
        || tx.max_fee > tx.total_fee_limit
        || tx.max_per_transfer == 0
        || tx.total_limit == 0
        || tx.max_per_transfer > tx.total_limit
        || tx
            .total_limit
            .checked_add(tx.total_fee_limit)
            .filter(|v| *v <= tx.escrow)
            .is_none()
        || tx.escrow > MAX_ATOMIC
    {
        return Err(Error("agent mandate monetary limits are invalid"));
    }
    if tx.fee < MIN_FEE {
        return Err(Error("fee below minimum"));
    }
    if tx.fee > MAX_ATOMIC {
        return Err(Error("fee is out of range"));
    }
    if tx.allowed_payees.is_empty() || tx.allowed_payees.len() > MAX_PAYEES {
        return Err(Error("agent mandate payee capacity is invalid"));
    }
    let mut payees = tx
        .allowed_payees
        .iter()
        .copied()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if payees.iter().any(|p| !address(p)) {
        return Err(Error("allowed payee is invalid"));
    }
    payees.sort();
    if payees.iter().collect::<BTreeSet<_>>().len() != payees.len() {
        return Err(Error("agent mandate payees contain duplicates"));
    }
    if payees.iter().any(|p| p == tx.owner || p == tx.agent) {
        return Err(Error("agent mandate self-dealing payee is invalid"));
    }
    let digest = create_digest(&tx, &payees)?;
    auth(
        &tx.authorization,
        tx.owner,
        &digest,
        "owner preverified authorization is invalid",
    )?;
    let debit = tx
        .escrow
        .checked_add(tx.fee)
        .ok_or(Error("owner has insufficient balance"))?;
    if state.balances.get(tx.owner).copied().unwrap_or(0) < debit {
        return Err(Error("owner has insufficient balance"));
    }
    let mut next = state.clone();
    let mut deltas = BTreeMap::new();
    add_delta(&mut deltas, tx.owner, -(debit as i128))?;
    add_delta(&mut deltas, tx.context.fee_recipient, tx.fee as i128)?;
    apply_deltas(&mut next, deltas)?;
    next.nonces.insert(tx.owner.to_owned(), tx.nonce + 1);
    next.mandates.insert(
        tx.mandate_id.to_owned(),
        Mandate {
            owner: tx.owner.to_owned(),
            agent: tx.agent.to_owned(),
            allowed_payees: payees,
            balance: tx.escrow,
            initial_escrow: tx.escrow,
            created_height: tx.context.current_height,
            expires_height: tx.expires_height,
            max_fee: tx.max_fee,
            max_per_transfer: tx.max_per_transfer,
            network_id: tx.network_id.to_owned(),
            policy_hash: tx.policy_hash.to_owned(),
            total_limit: tx.total_limit,
            total_fee_limit: tx.total_fee_limit,
            total_fees: 0,
            total_spent: 0,
        },
    );
    *state = next;
    Ok(())
}

pub fn transfer(state: &mut State, tx: Transfer<'_>) -> Result<(), Error> {
    let current = state
        .mandates
        .get(tx.mandate_id)
        .cloned()
        .ok_or(Error("agent mandate is missing"))?;
    validate_mandate(tx.mandate_id, &current)?;
    validate_registry(state, tx.context.network_id)?;
    if current.network_id != tx.context.network_id {
        return Err(Error("network id mismatch"));
    }
    if tx.context.current_height < current.created_height {
        return Err(Error("current height precedes mandate creation"));
    }
    if tx.context.current_height > MAX_NONCE {
        return Err(Error("current height is invalid"));
    }
    if !address(tx.payee) || !address(tx.context.fee_recipient) {
        return Err(Error("agent mandate address is invalid"));
    }
    let digest = transfer_digest(&tx, &current.network_id)?;
    auth(
        &tx.authorization,
        &current.agent,
        &digest,
        "agent preverified authorization is invalid",
    )?;
    nonce(state, &current.agent, tx.nonce, "agent nonce is unexpected")?;
    if tx.context.current_height >= current.expires_height {
        return Err(Error("agent mandate expired"));
    }
    if !current.allowed_payees.iter().any(|p| p == tx.payee) {
        return Err(Error("payee is not allowed"));
    }
    let spent = current
        .total_spent
        .checked_add(tx.amount)
        .ok_or(Error("agent mandate spending limit exceeded"))?;
    if tx.amount == 0 || tx.amount > current.max_per_transfer || spent > current.total_limit {
        return Err(Error("agent mandate spending limit exceeded"));
    }
    if tx.fee < MIN_FEE {
        return Err(Error("fee below minimum"));
    }
    if tx.fee > current.max_fee {
        return Err(Error("fee exceeds agent mandate maximum"));
    }
    let fees = current
        .total_fees
        .checked_add(tx.fee)
        .ok_or(Error("agent mandate fee budget exceeded"))?;
    if fees > current.total_fee_limit {
        return Err(Error("agent mandate fee budget exceeded"));
    }
    let debit = tx
        .amount
        .checked_add(tx.fee)
        .ok_or(Error("agent mandate escrow is insufficient"))?;
    if current.balance < debit {
        return Err(Error("agent mandate escrow is insufficient"));
    }
    let mut next = state.clone();
    let mut deltas = BTreeMap::new();
    add_delta(&mut deltas, tx.payee, tx.amount as i128)?;
    add_delta(&mut deltas, tx.context.fee_recipient, tx.fee as i128)?;
    apply_deltas(&mut next, deltas)?;
    next.nonces.insert(current.agent.clone(), tx.nonce + 1);
    let mandate = next
        .mandates
        .get_mut(tx.mandate_id)
        .expect("cloned mandate exists");
    mandate.balance -= debit;
    mandate.total_spent = spent;
    mandate.total_fees = fees;
    *state = next;
    Ok(())
}

pub fn close(state: &mut State, tx: Close<'_>) -> Result<(), Error> {
    let current = state
        .mandates
        .get(tx.mandate_id)
        .cloned()
        .ok_or(Error("agent mandate is missing"))?;
    validate_mandate(tx.mandate_id, &current)?;
    validate_registry(state, tx.context.network_id)?;
    if current.network_id != tx.context.network_id {
        return Err(Error("network id mismatch"));
    }
    if tx.context.current_height < current.created_height {
        return Err(Error("current height precedes mandate creation"));
    }
    if tx.context.current_height > MAX_NONCE {
        return Err(Error("current height is invalid"));
    }
    if !address(tx.context.fee_recipient) {
        return Err(Error("agent mandate address is invalid"));
    }
    if matches!(tx.mode, CloseMode::Unknown) {
        return Err(Error("mandate close mode is invalid"));
    }
    let digest = close_digest(&tx, &current.network_id)?;
    auth(
        &tx.authorization,
        &current.owner,
        &digest,
        "owner preverified authorization is invalid",
    )?;
    nonce(state, &current.owner, tx.nonce, "owner nonce is unexpected")?;
    if matches!(tx.mode, CloseMode::Expiry) && tx.context.current_height < current.expires_height {
        return Err(Error("agent mandate has not expired"));
    }
    if tx.fee < MIN_FEE {
        return Err(Error("fee below minimum"));
    }
    if tx.fee > MAX_ATOMIC {
        return Err(Error("fee is out of range"));
    }
    if state
        .balances
        .get(&current.owner)
        .copied()
        .unwrap_or(0)
        .checked_add(current.balance)
        .ok_or(Error("account balance overflow"))?
        < tx.fee
    {
        return Err(Error("owner and escrow cannot cover close fee"));
    }
    let mut next = state.clone();
    let mut deltas = BTreeMap::new();
    add_delta(
        &mut deltas,
        &current.owner,
        current.balance as i128 - tx.fee as i128,
    )?;
    add_delta(&mut deltas, tx.context.fee_recipient, tx.fee as i128)?;
    apply_deltas(&mut next, deltas)?;
    next.nonces.insert(current.owner, tx.nonce + 1);
    next.mandates.remove(tx.mandate_id);
    *state = next;
    Ok(())
}

pub fn prune_expired(
    state: &mut State,
    context: PruneContext<'_>,
    limit: usize,
) -> Result<Vec<String>, Error> {
    if context.current_height > MAX_NONCE
        || !network(context.network_id)
        || limit == 0
        || limit > MAX_PRUNE_BATCH
    {
        return Err(Error("prune limit is invalid"));
    }
    validate_registry(state, context.network_id)?;
    let mut candidates = Vec::new();
    for (id, m) in &state.mandates {
        validate_mandate(id, m)?;
        if m.expires_height <= context.current_height {
            candidates.push((m.expires_height, id.clone(), m.owner.clone(), m.balance));
        }
    }
    candidates.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
    candidates.truncate(limit);
    let mut refunds: BTreeMap<String, u128> = BTreeMap::new();
    for (_, _, owner, balance) in &candidates {
        let value = refunds
            .get(owner)
            .copied()
            .unwrap_or(0)
            .checked_add(*balance)
            .ok_or(Error("account balance overflow"))?;
        refunds.insert(owner.clone(), value);
    }
    let mut next = state.clone();
    for (owner, refund) in refunds {
        let old = next.balances.get(&owner).copied().unwrap_or(0);
        let value = old
            .checked_add(refund)
            .filter(|v| *v <= MAX_ATOMIC)
            .ok_or(Error("account balance overflow"))?;
        next.balances.insert(owner, value);
    }
    let ids = candidates
        .into_iter()
        .map(|(_, id, _, _)| id)
        .collect::<Vec<_>>();
    for id in &ids {
        next.mandates.remove(id);
    }
    *state = next;
    Ok(ids)
}
