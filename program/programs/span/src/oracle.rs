use crate::error::SpanError;
use anchor_lang::prelude::*;

pub const DOVES: Pubkey = pubkey!("DoVEsk76QybCEHQGzkvYPWLQu9gzNoZZZt3TPiL597e");
pub const SOL: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
pub const ASSETS: u8 = 3;
pub const BTC_FEED: Pubkey = pubkey!("hUqAT1KQ7eW1i6Csp9CXYtpPfSAvi835V7wKi5fRfmC");
pub const BTC_MINT: Pubkey = pubkey!("3NZ9JMVBmGAqocybic2c7LQCJScmgsAZ6vQqTDzcqmJh");
pub const ETH_FEED: Pubkey = pubkey!("AFZnHPzy4mvVCffrVwhewHbFc93uTHvDSFrVH7GtfXF1");
pub const ETH_MINT: Pubkey = pubkey!("7vfCXTUXx5WJV5JADk17DUJ4ksgau7utNKj4b963voxs");
pub fn mint_of(asset: u8) -> Result<Pubkey> {
    match asset { 0 => Ok(SOL), 1 => Ok(BTC_MINT), 2 => Ok(ETH_MINT), _ => err!(SpanError::InvalidValue) }
}
#[cfg(feature = "devnet")]
pub fn dev_feed_of(asset: u8) -> Pubkey {
    if asset == 0 { Pubkey::find_program_address(&[b"dev_feed"], &crate::ID).0 }
    else { Pubkey::find_program_address(&[b"dev_feed", &[asset]], &crate::ID).0 }
}
pub fn feed_of(config_feed: Pubkey, asset: u8) -> Result<Pubkey> {
    require!(asset < ASSETS, SpanError::InvalidValue);
    #[cfg(feature = "devnet")]
    { let _ = config_feed; Ok(dev_feed_of(asset)) }
    #[cfg(not(feature = "devnet"))]
    { match asset { 0 => Ok(config_feed), 1 => Ok(BTC_FEED), _ => Ok(ETH_FEED) } }
}
pub const DISC: [u8; 8] = [0x70, 0xf9, 0x8b, 0xd9, 0xd7, 0xd0, 0xf9, 0x36];

pub struct Price {
    pub price: u64,
    pub publish_ts: i64,
}

pub fn read(a: &AccountInfo<'_>, now: i64, age_limit: u16, asset: u8) -> Result<Price> {
    let mut owner_ok = *a.owner == DOVES;
    #[cfg(feature = "devnet")]
    {
        owner_ok |= *a.owner == crate::ID
            && a.key() == dev_feed_of(asset);
    }
    let _ = &mut owner_ok;
    require!(owner_ok, SpanError::FeedInvalid);
    let d = a.try_borrow_data()?;
    require!(
        d.len() == 394 && d[..8] == DISC && d[176] == 248,
        SpanError::FeedInvalid
    );
    require!(d[8..40] == mint_of(asset)?.to_bytes(), SpanError::FeedAssetMismatch);
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

pub fn peek(a: &AccountInfo<'_>, asset: u8) -> Result<Price> {
    let mut owner_ok = *a.owner == DOVES;
    #[cfg(feature = "devnet")]
    {
        owner_ok |= *a.owner == crate::ID
            && a.key() == dev_feed_of(asset);
    }
    let _ = &mut owner_ok;
    require!(owner_ok, SpanError::FeedInvalid);
    let d = a.try_borrow_data()?;
    require!(
        d.len() == 394 && d[..8] == DISC && d[176] == 248,
        SpanError::FeedInvalid
    );
    require!(d[8..40] == mint_of(asset)?.to_bytes(), SpanError::FeedAssetMismatch);
    let price = u64::from_le_bytes(d[168..176].try_into().map_err(|_| SpanError::FeedInvalid)?);
    let publish_ts =
        i64::from_le_bytes(d[177..185].try_into().map_err(|_| SpanError::FeedInvalid)?);
    require!(price > 0, SpanError::FeedInvalid);
    Ok(Price { price, publish_ts })
}
