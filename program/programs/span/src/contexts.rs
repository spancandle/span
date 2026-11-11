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
    /// CHECK: canonical optional payout-band account, initialized only for a narrow band.
    #[account(mut, seeds = [b"band", ticket.key().as_ref()], bump)]
    pub band: UncheckedAccount<'info>,
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
pub struct SetMarker<'info> {
    pub buyer: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
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
        Clock::get()?.unix_timestamp <= crate::mark_deadline(candle)?,
        SpanError::MarkClosed
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
#[instruction(asset: u8)]
pub struct DevFeedInit<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout initialized by this instruction.
    #[account(init, payer = guard.authority, space = 394, seeds = [b"dev_feed".as_ref(), if asset == 0 { &[] } else { std::slice::from_ref(&asset) }], bump)]
    pub feed: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[cfg(feature = "devnet")]
#[event_cpi]
#[derive(Accounts)]
#[instruction(asset: u8)]
pub struct DevFeedWrite<'info> {
    pub guard: UpgradeGuard<'info>,
    /// CHECK: raw oracle layout, PDA and owner constrained.
    #[account(mut, seeds = [b"dev_feed".as_ref(), if asset == 0 { &[] } else { std::slice::from_ref(&asset) }], bump, owner = crate::ID)]
    pub feed: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64, premium: u64, strike_bps: u16, sale_until: i64)]
pub struct OpenRunning<'info> {
    pub gate: TicketGate<'info>,
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(init, payer = seller, space = running_ticket_space(&gate, id, sale_until)?, seeds = [b"ticket".as_ref(), id.to_le_bytes().as_ref()], bump)]
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
    #[account(init, payer = seller, space = 8 + Until::INIT_SPACE, seeds = [b"until", ticket.key().as_ref()], bump)]
    pub until: Box<Account<'info, Until>>,
    /// CHECK: canonical optional payout-band account, initialized only for a narrow band.
    #[account(mut, seeds = [b"band", ticket.key().as_ref()], bump)]
    pub band: UncheckedAccount<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BuyRunning<'info> {
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
    #[account(seeds = [b"until", ticket.key().as_ref()], bump = until.bump,
        constraint = until.ticket == ticket.key() @ SpanError::InvalidValue)]
    pub until: Box<Account<'info, Until>>,
    /// CHECK: oracle address, owner and bytes are checked in the instruction.
    pub feed: UncheckedAccount<'info>,
}


pub fn running_ticket_space(gate: &TicketGate, id: u64, until: i64) -> Result<usize> {
    require_eq!(id, gate.config.next_ticket_id, SpanError::IdMismatch);
    let cutoff = gate.candle.t0.checked_sub(i64::from(gate.candle.buy_cutoff)).ok_or(SpanError::Overflow)?;
    require!(until > cutoff && until <= crate::math::add_time(gate.candle.t0, crate::math::window(gate.candle.t0)?.1)?, SpanError::InvalidValue);
    require!(Clock::get()?.unix_timestamp < until, SpanError::BuyClosed);
    Ok(8 + Ticket::INIT_SPACE)
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseUntil<'info> {
    #[account(mut, close = seller, seeds = [b"until", until.ticket.as_ref()], bump = until.bump)]
    pub until: Box<Account<'info, Until>>,
    /// CHECK: bound to the stored rent recipient.
    #[account(mut, address = until.seller @ SpanError::ReceiverMismatch)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: address is bound; owner and data determine whether seller authority is needed.
    #[account(address = until.ticket @ SpanError::InvalidValue)]
    pub ticket: UncheckedAccount<'info>,
    pub closer: Signer<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct ListResale<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(init_if_needed, payer = holder, space = 8 + Resale::INIT_SPACE,
        seeds = [b"resale", ticket.key().as_ref()], bump)]
    pub resale: Box<Account<'info, Resale>>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BuyResale<'info> {
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, close = holder, seeds = [b"resale", ticket.key().as_ref()], bump = resale.bump,
        constraint = resale.ticket == ticket.key() @ SpanError::InvalidValue)]
    pub resale: Box<Account<'info, Resale>>,
    /// CHECK: stored offer owner receives payment and account rent.
    #[account(mut, address = resale.holder @ SpanError::ReceiverMismatch)]
    pub holder: UncheckedAccount<'info>,
    #[account(mut, dup, constraint = holder_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = holder_usdc.owner == resale.holder @ SpanError::WrongOwner)]
    pub holder_usdc: Box<Account<'info, UsdcAccount>>,
    pub buyer: Signer<'info>,
    #[account(mut, constraint = buyer_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = buyer_source.owner == buyer.key() @ SpanError::WrongOwner)]
    pub buyer_source: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: address and oracle layout are validated by the instruction.
    pub feed: UncheckedAccount<'info>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(mut)]
    pub span_hold: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut, dup)]
    pub holder_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseResale<'info> {
    #[account(mut, close = holder, seeds = [b"resale", resale.ticket.as_ref()], bump = resale.bump)]
    pub resale: Box<Account<'info, Resale>>,
    /// CHECK: bound to the stored rent recipient.
    #[account(mut, address = resale.holder @ SpanError::ReceiverMismatch)]
    pub holder: UncheckedAccount<'info>,
    /// CHECK: bound address; owner and data select the authority check.
    #[account(address = resale.ticket @ SpanError::InvalidValue)]
    pub ticket: UncheckedAccount<'info>,
    pub closer: Signer<'info>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct PlaceBid<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(init, payer = bidder, space = 8 + Bid::INIT_SPACE,
        seeds = [b"bid", ticket.key().as_ref(), bidder.key().as_ref()], bump)]
    pub bid: Box<Account<'info, Bid>>,
    #[account(init, payer = bidder, seeds = [b"bid_usdc", bid.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = bid)]
    pub bid_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = bidder_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = bidder_source.owner == bidder.key() @ SpanError::WrongOwner)]
    pub bidder_source: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BidSpanGate<'info> {
    #[account(mut)]
    pub bidder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = config.span_mint.is_some() @ SpanError::SpanNotSet)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"bid", bid.ticket.as_ref(), bid.bidder.as_ref()], bump = bid.bump,
        constraint = bid.bidder == bidder.key() @ SpanError::NotBidder,
        constraint = bid.span_amount == 0 @ SpanError::AlreadyLoaded)]
    pub bid: Box<Account<'info, Bid>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct BidSpan<'info> {
    pub gate: BidSpanGate<'info>,
    #[account(init, payer = gate.bidder, seeds = [b"bid_span", gate.bid.key().as_ref()], bump,
        token::mint = span_mint, token::authority = gate.bid, token::token_program = span_token_program)]
    pub bid_span: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(address = gate.config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Box<InterfaceAccount<'info, SpanMint>>,
    #[account(mut, constraint = span_source.mint == span_mint.key() @ SpanError::WrongMint,
        constraint = span_source.owner == gate.bidder.key() @ SpanError::WrongOwner)]
    pub span_source: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(address = gate.config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct AcceptBid<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, close = bidder, seeds = [b"bid", ticket.key().as_ref(), bid.bidder.as_ref()], bump = bid.bump,
        constraint = bid.ticket == ticket.key() @ SpanError::InvalidValue)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: the stored bidder receives refunds and rent.
    #[account(mut, address = bid.bidder @ SpanError::ReceiverMismatch)]
    pub bidder: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"bid_usdc", bid.key().as_ref()], bump = bid.usdc_bump,
        constraint = bid_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = bid_usdc.owner == bid.key() @ SpanError::WrongOwner)]
    pub bid_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = bidder_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = bidder_usdc.owner == bid.bidder @ SpanError::WrongOwner)]
    pub bidder_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, dup, constraint = holder_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = holder_usdc.owner == holder.key() @ SpanError::WrongOwner)]
    pub holder_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: feed address and data are checked in the handler.
    pub feed: UncheckedAccount<'info>,
    /// CHECK: the canonical offer must have no data.
    #[account(seeds = [b"resale", ticket.key().as_ref()], bump)]
    pub resale: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
    /// CHECK: checked, closed and optionally initialized again in the handler.
    #[account(mut)]
    pub span_hold: Option<UncheckedAccount<'info>>,
    #[account(mut, dup)]
    pub holder_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut, seeds = [b"bid_span", bid.key().as_ref()], bump = bid.span_bump)]
    pub bid_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct CloseBid<'info> {
    pub closer: Signer<'info>,
    #[account(mut, close = bidder, seeds = [b"bid", bid.ticket.as_ref(), bid.bidder.as_ref()], bump = bid.bump)]
    pub bid: Box<Account<'info, Bid>>,
    /// CHECK: bound to the bidder who receives every refund.
    #[account(mut, address = bid.bidder @ SpanError::ReceiverMismatch)]
    pub bidder: UncheckedAccount<'info>,
    /// CHECK: bound address; owner and data select the live-ticket authorization.
    #[account(address = bid.ticket @ SpanError::InvalidValue)]
    pub ticket: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"bid_usdc", bid.key().as_ref()], bump = bid.usdc_bump,
        constraint = bid_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = bid_usdc.owner == bid.key() @ SpanError::WrongOwner)]
    pub bid_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = bidder_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = bidder_usdc.owner == bid.bidder @ SpanError::WrongOwner)]
    pub bidder_usdc: Box<Account<'info, UsdcAccount>>,
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, seeds = [b"bid_span", bid.key().as_ref()], bump = bid.span_bump)]
    pub bid_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut)]
    pub bidder_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(t0: i64, strike_bps: u16)]
pub struct PlaceRequest<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(init, payer = requester, space = 8 + Request::INIT_SPACE,
        seeds = [b"request".as_ref(), t0.to_le_bytes().as_ref(), strike_bps.to_le_bytes().as_ref(), requester.key().as_ref()], bump)]
    pub request: Box<Account<'info, Request>>,
    #[account(init, payer = requester, seeds = [b"request_usdc", request.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = request)]
    pub request_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = requester_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = requester_source.owner == requester.key() @ SpanError::WrongOwner)]
    pub requester_source: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct RequestSpanGate<'info> {
    #[account(mut)]
    pub requester: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump,
        constraint = config.span_mint.is_some() @ SpanError::SpanNotSet)]
    pub config: Box<Account<'info, Config>>,
    #[account(mut, seeds = [b"request", &request.t0.to_le_bytes(), &request.strike_bps.to_le_bytes(), request.requester.as_ref()], bump = request.bump,
        constraint = request.requester == requester.key() @ SpanError::NotRequester,
        constraint = request.span_amount == 0 @ SpanError::AlreadyLoaded)]
    pub request: Box<Account<'info, Request>>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct RequestSpan<'info> {
    pub gate: RequestSpanGate<'info>,
    #[account(init, payer = gate.requester, seeds = [b"request_span", gate.request.key().as_ref()], bump,
        token::mint = span_mint, token::authority = gate.request, token::token_program = span_token_program)]
    pub request_span: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(address = gate.config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Box<InterfaceAccount<'info, SpanMint>>,
    #[account(mut, constraint = span_source.mint == span_mint.key() @ SpanError::WrongMint,
        constraint = span_source.owner == gate.requester.key() @ SpanError::WrongOwner)]
    pub span_source: Box<InterfaceAccount<'info, SpanAccount>>,
    #[account(address = gate.config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Interface<'info, TokenInterface>,
    pub system_program: Program<'info, System>,
}

#[event_cpi]
#[derive(Accounts)]
pub struct FillRequestHeld<'info> {
    #[account(mut)]
    pub holder: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(mut, seeds = [b"ticket", &ticket.id.to_le_bytes()], bump = ticket.bump,
        constraint = ticket.t0 == candle.t0 @ SpanError::InvalidValue)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(mut, close = requester, seeds = [b"request", &request.t0.to_le_bytes(), &request.strike_bps.to_le_bytes(), request.requester.as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, Request>>,
    /// CHECK: the stored requester receives refunds and rent.
    #[account(mut, address = request.requester @ SpanError::ReceiverMismatch)]
    pub requester: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"request_usdc", request.key().as_ref()], bump = request.usdc_bump,
        constraint = request_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = request_usdc.owner == request.key() @ SpanError::WrongOwner)]
    pub request_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = requester_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = requester_usdc.owner == request.requester @ SpanError::WrongOwner)]
    pub requester_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, dup, constraint = holder_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = holder_usdc.owner == holder.key() @ SpanError::WrongOwner)]
    pub holder_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    /// CHECK: feed address and data are checked in the handler.
    pub feed: UncheckedAccount<'info>,
    /// CHECK: the canonical offer must have no data.
    #[account(seeds = [b"resale", ticket.key().as_ref()], bump)]
    pub resale: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
    /// CHECK: checked, closed and optionally initialized again in the handler.
    #[account(mut)]
    pub span_hold: Option<UncheckedAccount<'info>>,
    #[account(mut, dup)]
    pub holder_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut, seeds = [b"request_span", request.key().as_ref()], bump = request.span_bump)]
    pub request_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
}


#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct FillRequestOpen<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump,
        constraint = candle.t0 == request.t0 @ SpanError::RequestMismatch)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(init, payer = seller, space = request_ticket_space(&config, id)?, seeds = [b"ticket".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(init, payer = seller, seeds = [b"vault", ticket.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = ticket)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = seller_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = seller_source.owner == seller.key() @ SpanError::WrongOwner)]
    pub seller_source: Box<Account<'info, UsdcAccount>>,
    #[account(mut, close = requester, seeds = [b"request", &request.t0.to_le_bytes(), &request.strike_bps.to_le_bytes(), request.requester.as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, Request>>,
    /// CHECK: the request binds the refund recipient.
    #[account(mut, address = request.requester @ SpanError::ReceiverMismatch)]
    pub requester: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"request_usdc", request.key().as_ref()], bump = request.usdc_bump,
        constraint = request_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = request_usdc.owner == request.key() @ SpanError::WrongOwner)]
    pub request_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, dup, constraint = requester_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = requester_usdc.owner == request.requester @ SpanError::WrongOwner)]
    pub requester_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
    /// CHECK: address and initialization are checked in the handler.
    #[account(mut)]
    pub span_hold: Option<UncheckedAccount<'info>>,
    #[account(mut, seeds = [b"request_span", request.key().as_ref()], bump = request.span_bump)]
    pub request_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
}

#[event_cpi]
#[derive(Accounts)]
#[instruction(id: u64)]
pub struct FillRequestRunning<'info> {
    #[account(mut)]
    pub seller: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Box<Account<'info, Config>>,
    #[account(seeds = [b"candle", &candle.t0.to_le_bytes()], bump = candle.bump,
        constraint = candle.t0 == request.t0 @ SpanError::RequestMismatch)]
    pub candle: Box<Account<'info, Candle>>,
    #[account(init, payer = seller, space = request_ticket_space(&config, id)?, seeds = [b"ticket".as_ref(), id.to_le_bytes().as_ref()], bump)]
    pub ticket: Box<Account<'info, Ticket>>,
    #[account(init, payer = seller, seeds = [b"vault", ticket.key().as_ref()], bump,
        token::mint = usdc_mint, token::authority = ticket)]
    pub vault: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = seller_source.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = seller_source.owner == seller.key() @ SpanError::WrongOwner)]
    pub seller_source: Box<Account<'info, UsdcAccount>>,
    #[account(mut, close = requester, seeds = [b"request", &request.t0.to_le_bytes(), &request.strike_bps.to_le_bytes(), request.requester.as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, Request>>,
    /// CHECK: the request binds the refund recipient.
    #[account(mut, address = request.requester @ SpanError::ReceiverMismatch)]
    pub requester: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"request_usdc", request.key().as_ref()], bump = request.usdc_bump,
        constraint = request_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = request_usdc.owner == request.key() @ SpanError::WrongOwner)]
    pub request_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, dup, constraint = requester_usdc.mint == config.usdc_mint @ SpanError::WrongMint,
        constraint = requester_usdc.owner == request.requester @ SpanError::WrongOwner)]
    pub requester_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(address = config.usdc_mint @ SpanError::WrongMint)]
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: the handler validates the configured asset feed.
    pub feed: UncheckedAccount<'info>,
    #[account(address = config.span_mint.ok_or(SpanError::SpanNotSet)? @ SpanError::WrongMint)]
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    #[account(address = config.span_token_program.ok_or(SpanError::SpanNotSet)? @ SpanError::UnsupportedTokenProgram)]
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
    /// CHECK: address and initialization are checked in the handler.
    #[account(mut)]
    pub span_hold: Option<UncheckedAccount<'info>>,
    #[account(mut, seeds = [b"request_span", request.key().as_ref()], bump = request.span_bump)]
    pub request_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
}
#[event_cpi]
#[derive(Accounts)]
pub struct CloseRequest<'info> {
    pub closer: Signer<'info>,
    #[account(mut, close = requester, seeds = [b"request", &request.t0.to_le_bytes(), &request.strike_bps.to_le_bytes(), request.requester.as_ref()], bump = request.bump)]
    pub request: Box<Account<'info, Request>>,
    /// CHECK: bound to the requester who receives every refund.
    #[account(mut, address = request.requester @ SpanError::ReceiverMismatch)]
    pub requester: UncheckedAccount<'info>,
    #[account(mut, seeds = [b"request_usdc", request.key().as_ref()], bump = request.usdc_bump,
        constraint = request_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = request_usdc.owner == request.key() @ SpanError::WrongOwner)]
    pub request_usdc: Box<Account<'info, UsdcAccount>>,
    #[account(mut, constraint = requester_usdc.mint == usdc_mint.key() @ SpanError::WrongMint,
        constraint = requester_usdc.owner == request.requester @ SpanError::WrongOwner)]
    pub requester_usdc: Box<Account<'info, UsdcAccount>>,
    pub usdc_mint: Box<Account<'info, UsdcMint>>,
    pub token_program: Program<'info, Token>,
    #[account(mut, seeds = [b"request_span", request.key().as_ref()], bump = request.span_bump)]
    pub request_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    #[account(mut)]
    pub requester_span: Option<Box<InterfaceAccount<'info, SpanAccount>>>,
    pub span_mint: Option<Box<InterfaceAccount<'info, SpanMint>>>,
    pub span_token_program: Option<Interface<'info, TokenInterface>>,
}

pub fn request_ticket_space(config: &Config, id: u64) -> Result<usize> {
    require_eq!(id, config.next_ticket_id, SpanError::IdMismatch);
    Ok(8 + Ticket::INIT_SPACE)
}


#[event_cpi]
#[derive(Accounts)]
pub struct CloseBand<'info> {
    #[account(mut, close = seller, seeds = [b"band", band.ticket.as_ref()], bump = band.bump)]
    pub band: Box<Account<'info, Band>>,
    /// CHECK: bound to the original seller's rent destination.
    #[account(mut, address = band.seller @ SpanError::ReceiverMismatch)]
    pub seller: UncheckedAccount<'info>,
    /// CHECK: the bound ticket must have no data before its Band can close.
    #[account(address = band.ticket @ SpanError::InvalidBand)]
    pub ticket: UncheckedAccount<'info>,
    pub closer: Signer<'info>,
}
