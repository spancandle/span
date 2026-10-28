use crate::{error::SpanError, state::VAULT_CAP};
use anchor_lang::prelude::*;

pub fn add_time(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b).ok_or_else(|| error!(SpanError::Overflow))
}

pub fn payout(p0: u64, high: u64, low: u64, strike_bps: u16) -> Result<u64> {
    require!(p0 > 0 && high >= low, SpanError::InvalidValue);
    let width = u128::from(high.checked_sub(low).ok_or(SpanError::Overflow)?);
    let numerator = width
        .checked_mul(1_000_000_000)
        .ok_or(SpanError::Overflow)?;
    let raw = numerator
        .checked_div(u128::from(p0))
        .ok_or(SpanError::Overflow)?;
    let strike = u128::from(strike_bps).checked_mul(100_000).ok_or(SpanError::Overflow)?;
    Ok(raw.saturating_sub(strike).min(u128::from(VAULT_CAP)) as u64)
}

pub fn extends(price: u64, high: u64, low: u64, p0: u64, step: u16) -> Result<Option<bool>> {
    let scaled = u128::from(price)
        .checked_mul(10_000)
        .ok_or(SpanError::Overflow)?;
    let stride = u128::from(p0)
        .checked_mul(u128::from(step))
        .ok_or(SpanError::Overflow)?;
    let high_limit = u128::from(high)
        .checked_mul(10_000)
        .and_then(|v| v.checked_add(stride))
        .ok_or(SpanError::Overflow)?;
    let low_scaled = u128::from(low)
        .checked_mul(10_000)
        .ok_or(SpanError::Overflow)?;
    let low_limit = scaled.checked_add(stride).ok_or(SpanError::Overflow)?;
    if scaled >= high_limit {
        Ok(Some(true))
    } else if low_limit <= low_scaled {
        Ok(Some(false))
    } else {
        Ok(None)
    }
}
