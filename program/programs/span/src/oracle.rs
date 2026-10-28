use crate::error::SpanError;
use anchor_lang::prelude::*;

pub const DOVES: Pubkey = pubkey!("DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e");
pub const SOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const DISC: [u8; 8] = [0x70, 0xf9, 0x8b, 0xd9, 0xd7, 0xd0, 0xf9, 0x36];

pub struct Price {
    pub price: u64,
    pub publish_ts: i64,
}

pub fn read(a: &AccountInfo<'_>, now: i64, age_limit: u16) -> Result<Price> {
    let mut owner_ok = *a.owner == DOVES;
    #[cfg(feature = "devnet")]
    {
        owner_ok |= *a.owner == crate::ID
            && a.key() == Pubkey::find_program_address(&[b"dev_feed"], &crate::ID).0;
    }
    let _ = &mut owner_ok;
    require!(owner_ok, SpanError::FeedInvalid);
    let d = a.try_borrow_data()?;
    require!(
        d.len() == 394 && d[..8] == DISC && d[176] == 248,
        SpanError::FeedInvalid
    );
    require!(d[8..40] == SOL.to_bytes(), SpanError::FeedAssetMismatch);
    let price = u64::from_le_bytes(d[168..176].try_into().map_err(|_| SpanError::FeedInvalid)?);
    let publish_ts =
        i64::from_le_bytes(d[177..185].try_into().map_err(|_| SpanError::FeedInvalid)?);
    require!(price > 0, SpanError::FeedInvalid);
    require!(
        i128::from(now) - i128::from(publish_ts) <= i128::from(age_limit),
        SpanError::FeedStale
    );
    Ok(Price { price, publish_ts })
}
