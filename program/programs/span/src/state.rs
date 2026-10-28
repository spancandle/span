use anchor_lang::prelude::*;

pub const VAULT_CAP: u64 = 40_000_000;

pub const PREMIUM_MIN: u64 = 100_000;
pub const PREMIUM_MAX: u64 = 39_000_000;
pub const STRIKE_MAX_BPS: u16 = 500;
pub const STRIKE_STEP_BPS: u16 = 25;

#[account]
#[derive(InitSpace)]
pub struct Config {
    pub admin: Pubkey,
    pub usdc_mint: Pubkey,
    pub feed: Pubkey,
    pub read_window: u16,
    pub age_limit: u16,
    pub buy_cutoff: u16,
    pub span_mint: Option<Pubkey>,
    pub span_token_program: Option<Pubkey>,
    pub burn_per_mark: u64,
    pub next_ticket_id: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, Default, InitSpace)]
pub struct PriceRead {
    pub price: u64,
    pub publish_ts: i64,
}

#[account]
#[derive(InitSpace)]
pub struct Candle {
    pub t0: i64,
    pub read_window: u16,
    pub age_limit: u16,
    pub buy_cutoff: u16,
    pub reads: [PriceRead; 13],
    pub read_high: u64,
    pub read_low: u64,
    pub bump: u8,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq, InitSpace)]
pub enum TicketState {
    Open,
    Sold,
}

#[account]
#[derive(InitSpace)]
pub struct Ticket {
    pub id: u64,
    pub t0: i64,
    pub seller: Pubkey,
    pub buyer: Option<Pubkey>,
    pub premium: u64,
    pub strike_bps: u16,
    pub state: TicketState,
    pub span_loaded: u64,
    pub step_bps: u16,
    pub marker: Pubkey,
    pub tail_high: u64,
    pub tail_low: u64,
    pub marks: u32,
    pub burned: u64,
    pub bump: u8,
    pub vault_bump: u8,
    pub span_bump: u8,
}

impl Ticket {
    pub fn high_low(&self, candle: &Candle) -> (u64, u64) {
        let high = candle.read_high.max(self.tail_high);
        let low = if self.tail_low == 0 {
            candle.read_low
        } else {
            candle.read_low.min(self.tail_low)
        };
        (high, low)
    }
}
