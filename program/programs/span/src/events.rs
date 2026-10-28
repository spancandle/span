use anchor_lang::prelude::*;

#[event]
pub struct Initialized {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub feed: Pubkey,
    pub read_window: u16,
    pub age_limit: u16,
    pub buy_cutoff: u16,
}
#[event]
pub struct SpanSet {
    pub span_mint: Pubkey,
    pub span_token_program: Pubkey,
    pub burn_per_mark: u64,
}
#[event]
pub struct FeedSet {
    pub old_feed: Pubkey,
    pub new_feed: Pubkey,
}
#[event]
pub struct ParamsSet {
    pub read_window: u16,
    pub age_limit: u16,
    pub buy_cutoff: u16,
}
#[event]
pub struct CandleOpened {
    pub candle: Pubkey,
    pub t0: i64,
    pub read_window: u16,
    pub age_limit: u16,
    pub buy_cutoff: u16,
}
#[event]
pub struct TicketOpened {
    pub ticket: Pubkey,
    pub id: u64,
    pub t0: i64,
    pub seller: Pubkey,
    pub premium: u64,
    pub strike_bps: u16,
    pub deposit: u64,
}
#[event]
pub struct Withdrawn {
    pub ticket: Pubkey,
    pub id: u64,
    pub t0: i64,
    pub seller: Pubkey,
    pub returned: u64,
}
#[event]
pub struct Bought {
    pub ticket: Pubkey,
    pub id: u64,
    pub t0: i64,
    pub buyer: Pubkey,
    pub premium: u64,
}
#[event]
pub struct SpanLoaded {
    pub ticket: Pubkey,
    pub id: u64,
    pub buyer: Pubkey,
    pub amount: u64,
    pub step_bps: u16,
    pub marker: Pubkey,
}
#[event]
pub struct Read {
    pub candle: Pubkey,
    pub t0: i64,
    pub j: u8,
    pub price: u64,
    pub publish_ts: i64,
    pub slot: u64,
    pub read_high: u64,
    pub read_low: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum Side {
    High,
    Low,
}
#[event]
pub struct Marked {
    pub ticket: Pubkey,
    pub id: u64,
    pub t0: i64,
    pub side: Side,
    pub price: u64,
    pub publish_ts: i64,
    pub slot: u64,
    pub tail_high: u64,
    pub tail_low: u64,
    pub marks: u32,
    pub burned: u64,
    pub burn: u64,
    pub span_left: u64,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub enum Outcome {
    Paid,
    Void,
    Unsold,
}
#[event]
pub struct Settled {
    pub ticket: Pubkey,
    pub id: u64,
    pub t0: i64,
    pub outcome: Outcome,
    pub seller: Pubkey,
    pub buyer: Option<Pubkey>,
    pub premium: u64,
    pub strike_bps: u16,
    pub p0: u64,
    pub read_high: u64,
    pub read_low: u64,
    pub tail_high: u64,
    pub tail_low: u64,
    pub high: u64,
    pub low: u64,
    pub payout: u64,
    pub to_buyer: u64,
    pub to_seller: u64,
    pub span_returned: u64,
    pub burned: u64,
    pub marks: u32,
    pub reads: u16,
}
#[cfg(feature = "devnet")]
#[event]
pub struct DevFeedUpdated {
    pub price: u64,
    pub publish_ts: i64,
}
