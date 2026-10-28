use crate::{error::SpanError, state::*};
use anchor_lang::prelude::*;
use anchor_spl::{
    token::{Mint as UsdcMint, Token, TokenAccount as UsdcAccount},
    token_interface::{Mint as SpanMint, TokenAccount as SpanAccount, TokenInterface},
};

#[derive(Accounts)]
pub struct UpgradeGuard<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(constraint = deployment.programdata_address()? == Some(program_data.key()) @ SpanError::NotUpgradeAuthority)]
    pub deployment: Program<'info, crate::program::Span>,
    #[account(constraint = program_data.upgrade_authority_address == Some(authority.key()) @ SpanError::NotUpgradeAuthority)]
    pub program_data: Box<Account<'info, ProgramData>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Init<'info> {
    pub guard: UpgradeGuard<'info>,
    #[account(init, payer = guard.authority, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: raw mint layout is checked in the instruction.
    pub usdc_mint: UncheckedAccount<'info>,
    /// CHECK: oracle owner and bytes are checked in the instruction.
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetSpan<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ SpanError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: token mint layout and authority extensions checked in the instruction.
    pub span_mint: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetFeed<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ SpanError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
    /// CHECK: oracle owner and bytes checked in the instruction.
    pub feed: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct SetParams<'info> {
    pub admin: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump, has_one = admin @ SpanError::NotAdmin)]
    pub config: Box<Account<'info, Config>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(t0: i64)]
pub struct OpenCandle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init_if_needed, payer = payer, space = 8 + Candle::INIT_SPACE, seeds = [b"candle".as_ref(), t0.to_le_bytes().as_ref()], bump)]
    pub candle: Box<Account<'info, Candle>>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct TicketGate<'info> {
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct OpenTicket<'info> {
    pub gate: TicketGate<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(init, payer = seller, space = new_ticket_space(&gate, id)?, seeds = [b"ticket".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(address = gate.config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    #[account(init, payer = seller, seeds = [b"vault", ticket.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = ticket, token::token_program = token_program)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = seller_source.mint == gate.config.usdc_mint @ SpanError::WrongMint,
        constraint = seller_source.owner == seller.key() @ SpanError::WrongOwner)]
    pub seller_source: Box<Account<'info, UsdcAccount>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

pub fn new_ticket_space(gate: &TicketGate, id: u64) -> Result<usize> {
    require_eq!(id, gate.config.next_ticket_id, SpanError::IdMismatch);
    require!(
        Clock::get()?.unix_timestamp
            < gate
                .candle
                .t0
                .checked_sub(i64::from(gate.candle.buy_cutoff))
                .ok_or(SpanError::Overflow)?,
        SpanError::BuyClosed
    );
    Ok(8 + Ticket::INIT_SPACE)
}

#[event_cpi]
#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, close = seller, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    #[account(mut, seeds = [b"vault", ticket.key().as_ref()], bump = ticket.vault_bump,
        constraint = vault.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = vault.owner == ticket.key() @ SpanError::WrongOwner)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = seller_destination.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = seller_destination.owner == ticket.seller @ SpanError::WrongOwner)]
    pub seller_destination: Box<Account<'info, UsdcAccount>>,
    pub token_program: Program<'info, Token>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Buy<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    pub buyer: Signer<'info>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    #[account(mut, seeds = [b"vault", ticket.key().as_ref()], bump = ticket.vault_bump,
        constraint = vault.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = vault.owner == ticket.key() @ SpanError::WrongOwner)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = buyer_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = buyer_source.owner == buyer.key() @ SpanError::WrongOwner)]
    pub buyer_source: Box<Account<'info, UsdcAccount>>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct LoadGate<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue,
        constraint = load_allowed(&config, &candle, &ticket, &buyer)?)]
    pub ticket: Box<Account<'info, Ticket>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct LoadSpan<'info> {
    pub gate: LoadGate<'info>,
    #[account(init, payer = gate.buyer, seeds = [b"span", gate.ticket.key().as_ref()], bump,
        token::mint = span_mint, token::authority = gate.ticket, token::token_program = span_token_program)]
    pub span_hold: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(constraint = Some(span_mint.key()) == gate.config.span_mint @ SpanError::WrongMint)]
    pub span_mint: Box<InterfaceAccount<'info, SpanMint>>,
    #[account(mut, constraint = span_source.mint == span_mint.key() @ SpanError::WrongMint,
        constraint = span_source.owner == gate.buyer.key() @ SpanError::WrongOwner)]
    pub span_source: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(constraint = Some(span_token_program.key()) == gate.config.span_token_program @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

pub fn load_allowed(
    config: &Config,
    candle: &Candle,
    ticket: &Ticket,
    buyer: &Signer,
) -> Result<bool> {
    require!(ticket.state == TicketState::Sold, SpanError::NotSold);
    require!(ticket.buyer == Some(buyer.key()), SpanError::NotBuyer);
    require!(
        Clock::get()?.unix_timestamp
            < candle
                .t0
                .checked_sub(i64::from(candle.buy_cutoff))
                .ok_or(SpanError::Overflow)?,
        SpanError::BuyClosed
    );
    require!(config.span_mint.is_some(), SpanError::SpanNotSet);
    require!(ticket.span_loaded == 0, SpanError::AlreadyLoaded);
    Ok(true)
}

#[event_cpi]
#[derive(Accounts)]
pub struct ReadPrice<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    /// CHECK: checked against configured feed, owner and byte layout.
    pub feed: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct MarkGate<'info> {
    pub marker: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue,
        constraint = ticket.state == TicketState::Sold @ SpanError::NotSold,
        constraint = ticket.span_loaded > 0 @ SpanError::NotLoaded,
        constraint = ticket.marker == marker.key() @ SpanError::NotMarker)]
    pub ticket: Box<Account<'info, Ticket>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Mark<'info> {
    pub gate: MarkGate<'info>,
    /// CHECK: checked against configured feed, owner and byte layout.
    pub feed: UncheckedAccount<'info>,
    #[account(mut, address = gate.config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Box<InterfaceAccount<'info, SpanMint>>,
    #[account(mut, seeds = [b"span", gate.ticket.key().as_ref()], bump = gate.ticket.span_bump,
        constraint = span_hold.mint == span_mint.key() @ SpanError::WrongMint,
        constraint = span_hold.owner == gate.ticket.key() @ SpanError::WrongOwner)]
    pub span_hold: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(address = gate.config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Interface<'info, TokenInterface>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct Settle<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, close = seller, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    /// CHECK: address is checked against ticket seller; receives rent only.
    #[account(mut)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: address is checked against ticket buyer; receives rent only.
    #[account(mut)]
    pub buyer: Option<UncheckedAccount<'info>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    #[account(mut, seeds = [b"vault", ticket.key().as_ref()], bump = ticket.vault_bump,
        constraint = vault.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = vault.owner == ticket.key() @ SpanError::WrongOwner)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, dup)]
    pub seller_usdc: Option<Box<Account<'info, UsdcAccount>>>,
    #[account(mut, dup)]
    pub buyer_usdc: Option<Box<Account<'info, UsdcAccount>>>,
    pub token_program: Program<'info, Token>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(mut)]
    pub span_hold: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut, dup)]
    pub buyer_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
}

#[cfg(feature = "devnet")]
#[event_cpi]
#[derive(Accounts)]
pub struct DevFeedInit<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout initialized by this instruction.
    #[account(init, payer = guard.authority, space = 394, seeds = [b"dev_feed"], bump)]
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "devnet")]
#[event_cpi]
#[derive(Accounts)]
pub struct DevFeedWrite<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout, PDA and owner constrained.
    #[account(mut, seeds = [b"dev_feed"], bump, owner = crate::ID)]
    pub feed: UncheckedAccount<'info>,
}
