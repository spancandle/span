use crate::{error::SpanError, state::{VAULT_CAP, BANDS, BAND_DEFAULT}};
use anchor_lang::prelude::*;

pub fn add_time(a: i64, b: i64) -> Result<i64> {
    a.checked_add(b).ok_or_else(|| error!(SpanError::Overflow))
}

pub fn payout(p0: u64, high: u64, low: u64, strike_bps: u16, band_bps: u16) -> Result<u64> {
    require!(p0 > 0 && high >= low, SpanError::InvalidValue);
    require!(BANDS.contains(&band_bps), SpanError::InvalidBand);
    let width = u128::from(high.checked_sub(low).ok_or(SpanError::Overflow)?);
    let numerator = width
        .checked_mul(1_000_000_000)
        .ok_or(SpanError::Overflow)?;
    let raw = numerator
        .checked_div(u128::from(p0))
        .ok_or(SpanError::Overflow)?;
    let strike = u128::from(strike_bps).checked_mul(100_000).ok_or(SpanError::Overflow)?;
    let net = raw.saturating_sub(strike);
    Ok(net.checked_mul(u128::from(BAND_DEFAULT / band_bps)).ok_or(SpanError::Overflow)?.min(u128::from(VAULT_CAP)) as u64)
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

/// Asset, duration in seconds and final scheduled reading encoded by a start.
pub fn window(t0: i64) -> Result<(u8, i64, u8)> {
    let second = t0.rem_euclid(60);
    require!(second < 6, SpanError::InvalidValue);
    let secs = if second < 3 { 3600 } else { 1800 };
    Ok(((second % 3) as u8, secs, (secs / 300) as u8))
}
