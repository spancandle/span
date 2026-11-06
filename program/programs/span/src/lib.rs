use anchor_lang::prelude::*;
use anchor_spl::{token, token_interface};

pub mod contexts;
pub mod error;
pub mod events;
pub mod math;
pub mod mint;
pub mod oracle;
pub mod state;

use contexts::*;
use contexts::BidSpan;
use error::SpanError;
use events::*;
use state::*;

declare_id!("ED2a4EqgPCKRiAV1rF4pK3r44w8xzhU8h9VLYGTXNEMd");

#[cfg(not(feature = "no-entrypoint"))]
solana_security_txt::security_txt! {
    name: "span",
    project_url: "https://span.press",
    contacts: "email:contact@span.press",
    policy: "https://github.com/spancandle/span/blob/main/SECURITY.md",
    preferred_languages: "en",
    source_code: "https://github.com/spancandle/span"
}

fn params_valid(w: u16, a: u16, c: u16) -> Result<()> {
    require!(
        (2..=60).contains(&w) && (2..=120).contains(&a) && (1..=600).contains(&c),
        SpanError::InvalidValue
    );
    Ok(())
}

fn sale_open(candle: &Candle) -> Result<()> {
    require!(
        Clock::get()?.unix_timestamp
            < candle
                .t0
                .checked_sub(i64::from(candle.buy_cutoff))
                .ok_or(SpanError::Overflow)?,
        SpanError::BuyClosed
    );
    Ok(())
}

fn mark_deadline(candle: &Candle) -> Result<i64> {
    math::add_time(math::add_time(candle.t0, math::window(candle.t0)?.1)?, i64::from(candle.age_limit))
}

#[program]
pub mod span {
    use super::*;

    pub fn init(
        ctx: Context<Init>,
        admin: Pubkey,
        read_window: u16,
        age_limit: u16,
        buy_cutoff: u16,
    ) -> Result<()> {
        params_valid(read_window, age_limit, buy_cutoff)?;
        let a = ctx.accounts.usdc_mint.to_account_info();
        let d = a.try_borrow_data()?;
        require!(
            *a.owner == token::ID && d.len() == 82 && d[44] == 6 && d[45] == 1,
            SpanError::UsdcMintInvalid
        );
        drop(d);
        oracle::read(
            &ctx.accounts.feed.to_account_info(),
            Clock::get()?.unix_timestamp,
            age_limit,
            0,
        )?;
        ctx.accounts.config.set_inner(Config {
            admin,
            usdc_mint: a.key(),
            feed: ctx.accounts.feed.key(),
            read_window,
            age_limit,
            buy_cutoff,
            span_mint: None,
            span_token_program: None,
            burn_per_mark: 0,
            next_ticket_id: 0,
            bump: ctx.bumps.config,
        });
        emit_cpi!(Initialized {
            admin,
            usdc_mint: a.key(),
            feed: ctx.accounts.feed.key(),
            read_window,
            age_limit,
            buy_cutoff
        });
        Ok(())
    }

    pub fn set_span(ctx: Context<SetSpan>, burn_per_mark: u64) -> Result<()> {
        require!(
            ctx.accounts.config.span_mint.is_none(),
            SpanError::SpanAlreadySet
        );
        require!(burn_per_mark > 0, SpanError::InvalidValue);
        let a = ctx.accounts.span_mint.to_account_info();
        mint::validate(&a)?;
        let d = a.try_borrow_data()?;
        token_interface::Mint::try_deserialize(&mut &d[..])?;
        drop(d);
        let c = &mut ctx.accounts.config;
        c.span_mint = Some(a.key());
        c.span_token_program = Some(*a.owner);
        c.burn_per_mark = burn_per_mark;
        emit_cpi!(SpanSet {
            span_mint: a.key(),
            span_token_program: *a.owner,
            burn_per_mark
        });
        Ok(())
    }

    pub fn set_feed(ctx: Context<SetFeed>) -> Result<()> {
        oracle::read(
            &ctx.accounts.feed.to_account_info(),
            Clock::get()?.unix_timestamp,
            ctx.accounts.config.age_limit,
            0,
        )?;
        let old_feed = ctx.accounts.config.feed;
        let new_feed = ctx.accounts.feed.key();
        ctx.accounts.config.feed = new_feed;
        emit_cpi!(FeedSet { old_feed, new_feed });
        Ok(())
    }

    pub fn set_params(
        ctx: Context<SetParams>,
        read_window: u16,
        age_limit: u16,
        buy_cutoff: u16,
    ) -> Result<()> {
        params_valid(read_window, age_limit, buy_cutoff)?;
        let c = &mut ctx.accounts.config;
        c.read_window = read_window;
        c.age_limit = age_limit;
        c.buy_cutoff = buy_cutoff;
        emit_cpi!(ParamsSet {
            read_window,
            age_limit,
            buy_cutoff
        });
        Ok(())
    }

    pub fn open_candle(ctx: Context<OpenCandle>, t0: i64) -> Result<()> {
        if ctx.accounts.candle.t0 != 0 {
            return Ok(());
        }
        math::window(t0)?;
        require!(
            Clock::get()?.unix_timestamp
                < t0.checked_sub(i64::from(ctx.accounts.config.buy_cutoff))
                    .ok_or(SpanError::Overflow)?,
            SpanError::BuyClosed
        );
        let c = &ctx.accounts.config;
        let candle = &mut ctx.accounts.candle;
        candle.set_inner(Candle {
            t0,
            read_window: c.read_window,
            age_limit: c.age_limit,
            buy_cutoff: c.buy_cutoff,
            reads: [PriceRead::default(); 13],
            read_high: 0,
            read_low: 0,
            bump: ctx.bumps.candle,
        });
        emit_cpi!(CandleOpened {
            candle: candle.key(),
            t0,
            read_window: c.read_window,
            age_limit: c.age_limit,
            buy_cutoff: c.buy_cutoff
        });
        Ok(())
    }

    pub fn list_resale(ctx: Context<ListResale>, ask: u64, until: i64) -> Result<()> {
        let t = &ctx.accounts.ticket;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.buyer == Some(ctx.accounts.holder.key()), SpanError::NotBuyer);
        require!((PREMIUM_MIN..=PREMIUM_MAX).contains(&ask), SpanError::InvalidValue);
        require!(Clock::get()?.unix_timestamp < until && until <= math::add_time(ctx.accounts.candle.t0, math::window(ctx.accounts.candle.t0)?.1)?, SpanError::InvalidValue);
        ctx.accounts.resale.set_inner(Resale {
            ticket: t.key(), holder: ctx.accounts.holder.key(), ask, until, bump: ctx.bumps.resale,
        });
        emit_cpi!(ResaleListed { ticket: t.key(), id: t.id, t0: t.t0, holder: ctx.accounts.holder.key(), ask, until });
        Ok(())
    }

    pub fn buy_resale(ctx: Context<BuyResale>, max_pay: u64) -> Result<()> {
        let t = &ctx.accounts.ticket;
        let c = &ctx.accounts.candle;
        let offer = &ctx.accounts.resale;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.buyer == Some(offer.holder), SpanError::NotHolder);
        require_keys_neq!(ctx.accounts.buyer.key(), offer.holder, SpanError::InvalidValue);
        require!(c.reads[0].price > 0, SpanError::NoOpen);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= offer.until, SpanError::BuyClosed);
        let asset = math::window(c.t0)?.0;
        require_keys_eq!(ctx.accounts.feed.key(), oracle::feed_of(ctx.accounts.config.feed, asset)?, SpanError::FeedNotConfig);
        // A vacant read can still absorb the observation already on chain.
        let elapsed = clock.unix_timestamp.checked_sub(c.t0).ok_or(SpanError::Overflow)?;
        let j = elapsed / 300;
        if (0..=i64::from(math::window(c.t0)?.2)).contains(&j) {
            let boundary = math::add_time(c.t0, j * 300)?;
            require!(c.reads[j as usize].price > 0 || clock.unix_timestamp > math::add_time(boundary, i64::from(c.read_window) + i64::from(c.age_limit))?, SpanError::ReadPending);
        }
        let price = oracle::peek(&ctx.accounts.feed.to_account_info(), asset)?;
        for k in 1..=usize::from(math::window(c.t0)?.2) {
            let boundary = math::add_time(c.t0, k as i64 * 300)?;
            require!(c.reads[k].price > 0 || price.publish_ts < boundary || price.publish_ts > math::add_time(boundary, i64::from(c.read_window))? || i128::from(clock.unix_timestamp) - i128::from(price.publish_ts) > i128::from(c.age_limit), SpanError::ReadPending);
        }
        let (high, low) = t.high_low(c);
        let recorded = math::payout(c.reads[0].price, high, low, t.strike_bps)?;
        require!(recorded < VAULT_CAP, SpanError::CapReached);
        let paid = recorded.checked_add(offer.ask).ok_or(SpanError::Overflow)?;
        require!(paid <= max_pay, SpanError::PriceAboveMax);
        let before = ctx.accounts.holder_usdc.amount;
        token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.buyer_source.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.holder_usdc.to_account_info(), authority: ctx.accounts.buyer.to_account_info(),
        }), paid, 6)?;
        ctx.accounts.holder_usdc.reload()?;
        require!(ctx.accounts.holder_usdc.amount.checked_sub(before) == Some(paid), SpanError::DepositMismatch);
        let mut span_returned = 0;
        if t.span_loaded > 0 {
            let mint = ctx.accounts.span_mint.as_ref().ok_or(SpanError::MissingAccount)?;
            let hold = ctx.accounts.span_hold.as_ref().ok_or(SpanError::MissingAccount)?;
            let program = ctx.accounts.span_token_program.as_ref().ok_or(SpanError::MissingAccount)?;
            let (expected, _) = Pubkey::find_program_address(&[b"span", t.key().as_ref()], &crate::ID);
            require_keys_eq!(hold.key(), expected, SpanError::WrongOwner);
            require_keys_eq!(hold.mint, mint.key(), SpanError::WrongMint);
            require_keys_eq!(hold.owner, t.key(), SpanError::WrongOwner);
            require_keys_eq!(*hold.to_account_info().owner, program.key(), SpanError::UnsupportedTokenProgram);
            require_keys_eq!(*mint.to_account_info().owner, program.key(), SpanError::UnsupportedTokenProgram);
            let id_bytes = t.id.to_le_bytes();
            let bump = [t.bump];
            let seeds: &[&[u8]] = &[b"ticket", &id_bytes, &bump];
            span_returned = hold.amount;
            if span_returned > 0 {
                let destination = ctx.accounts.holder_span.as_ref().ok_or(SpanError::MissingAccount)?;
                require_keys_eq!(destination.mint, mint.key(), SpanError::WrongMint);
                require_keys_eq!(destination.owner, offer.holder, SpanError::WrongOwner);
                require_keys_eq!(*destination.to_account_info().owner, program.key(), SpanError::UnsupportedTokenProgram);
                token_interface::transfer_checked(CpiContext::new_with_signer(program.key(), token_interface::TransferChecked {
                    from: hold.to_account_info(), mint: mint.to_account_info(), to: destination.to_account_info(), authority: t.to_account_info(),
                }, &[seeds]), span_returned, mint.decimals)?;
            }
            token_interface::close_account(CpiContext::new_with_signer(program.key(), token_interface::CloseAccount {
                account: hold.to_account_info(), destination: ctx.accounts.holder.to_account_info(), authority: t.to_account_info(),
            }, &[seeds]))?;
        }
        let reads = c.reads.iter().enumerate().fold(0u16, |bits, (j, r)| if r.price > 0 { bits | (1u16 << j) } else { bits });
        let t = &mut ctx.accounts.ticket;
        t.buyer = Some(ctx.accounts.buyer.key());
        t.span_loaded = 0;
        t.step_bps = 0;
        t.marker = Pubkey::default();
        t.span_bump = 0;
        emit_cpi!(Resold {
            ticket: t.key(), id: t.id, t0: t.t0, from: offer.holder, to: ctx.accounts.buyer.key(),
            ask: offer.ask, recorded, paid, high, low, tail_high: t.tail_high, tail_low: t.tail_low,
            reads, marks: t.marks, burned: t.burned, span_returned, slot: clock.slot,
        });
        Ok(())
    }

    pub fn close_resale(ctx: Context<CloseResale>) -> Result<()> {
        if ctx.accounts.ticket.owner == &crate::ID && !ctx.accounts.ticket.data_is_empty() {
            require_keys_eq!(ctx.accounts.closer.key(), ctx.accounts.resale.holder, SpanError::NotHolder);
        }
        emit_cpi!(ResaleClosed { ticket: ctx.accounts.resale.ticket, resale: ctx.accounts.resale.key(), holder: ctx.accounts.resale.holder, closer: ctx.accounts.closer.key() });
        Ok(())
    }

    pub fn place_bid(ctx: Context<PlaceBid>, ask: u64, cap: u64, until: i64) -> Result<()> {
        let t = &ctx.accounts.ticket;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.buyer != Some(ctx.accounts.bidder.key()), SpanError::InvalidValue);
        require!((PREMIUM_MIN..=PREMIUM_MAX).contains(&ask), SpanError::InvalidValue);
        require!(ask <= cap && cap <= VAULT_CAP.checked_add(PREMIUM_MAX).ok_or(SpanError::Overflow)?, SpanError::InvalidValue);
        require!(Clock::get()?.unix_timestamp < until && until <= math::add_time(t.t0, math::window(t.t0)?.1)?, SpanError::InvalidValue);
        let before = ctx.accounts.bid_usdc.amount;
        token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.bidder_source.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.bid_usdc.to_account_info(), authority: ctx.accounts.bidder.to_account_info(),
        }), cap, 6)?;
        ctx.accounts.bid_usdc.reload()?;
        require!(ctx.accounts.bid_usdc.amount.checked_sub(before) == Some(cap), SpanError::DepositMismatch);
        ctx.accounts.bid.set_inner(Bid { ticket: t.key(), bidder: ctx.accounts.bidder.key(), ask, cap, until,
            span_amount: 0, step_bps: 0, marker: Pubkey::default(), bump: ctx.bumps.bid,
            usdc_bump: ctx.bumps.bid_usdc, span_bump: 0 });
        emit_cpi!(BidPlaced { ticket: t.key(), id: t.id, t0: t.t0, bid: ctx.accounts.bid.key(), bidder: ctx.accounts.bidder.key(), ask, cap, until });
        Ok(())
    }

    pub fn bid_span(ctx: Context<BidSpan>, amount: u64, step_bps: u16, marker: Pubkey) -> Result<()> {
        require!(ctx.accounts.gate.config.span_mint.is_some(), SpanError::SpanNotSet);
        require!(ctx.accounts.gate.bid.span_amount == 0, SpanError::AlreadyLoaded);
        require!([2, 5, 10, 25].contains(&step_bps), SpanError::StepNotAllowed);
        require!(amount >= ctx.accounts.gate.config.burn_per_mark, SpanError::InvalidValue);
        let before = ctx.accounts.bid_span.amount;
        token_interface::transfer_checked(CpiContext::new(ctx.accounts.span_token_program.key(), token_interface::TransferChecked {
            from: ctx.accounts.span_source.to_account_info(), mint: ctx.accounts.span_mint.to_account_info(),
            to: ctx.accounts.bid_span.to_account_info(), authority: ctx.accounts.gate.bidder.to_account_info(),
        }), amount, ctx.accounts.span_mint.decimals)?;
        ctx.accounts.bid_span.reload()?;
        require!(ctx.accounts.bid_span.amount.checked_sub(before) == Some(amount), SpanError::DepositMismatch);
        let reserve = Rent::get()?.minimum_balance(ctx.accounts.bid_span.to_account_info().data_len());
        anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), anchor_lang::system_program::Transfer {
            from: ctx.accounts.gate.bidder.to_account_info(), to: ctx.accounts.gate.bid.to_account_info(),
        }), reserve)?;
        let b = &mut ctx.accounts.gate.bid;
        b.span_amount = amount; b.step_bps = step_bps; b.marker = marker; b.span_bump = ctx.bumps.bid_span;
        emit_cpi!(events::BidSpan { bid: b.key(), amount, step_bps, marker });
        Ok(())
    }

    pub fn accept_bid(ctx: Context<AcceptBid>) -> Result<()> {
        let t = &ctx.accounts.ticket;
        let c = &ctx.accounts.candle;
        let bid = &ctx.accounts.bid;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.buyer == Some(ctx.accounts.holder.key()), SpanError::NotHolder);
        require_keys_neq!(bid.bidder, ctx.accounts.holder.key(), SpanError::InvalidValue);
        require!(ctx.accounts.resale.data_is_empty(), SpanError::ResaleOpen);
        require!(c.reads[0].price > 0, SpanError::NoOpen);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= bid.until, SpanError::BuyClosed);
        let asset = math::window(c.t0)?.0;
        require_keys_eq!(ctx.accounts.feed.key(), oracle::feed_of(ctx.accounts.config.feed, asset)?, SpanError::FeedNotConfig);
        let elapsed = clock.unix_timestamp.checked_sub(c.t0).ok_or(SpanError::Overflow)?;
        let j = elapsed / 300;
        if (0..=i64::from(math::window(c.t0)?.2)).contains(&j) {
            let boundary = math::add_time(c.t0, j * 300)?;
            require!(c.reads[j as usize].price > 0 || clock.unix_timestamp > math::add_time(boundary, i64::from(c.read_window) + i64::from(c.age_limit))?, SpanError::ReadPending);
        }
        let price = oracle::peek(&ctx.accounts.feed.to_account_info(), asset)?;
        for k in 1..=usize::from(math::window(c.t0)?.2) {
            let boundary = math::add_time(c.t0, k as i64 * 300)?;
            require!(c.reads[k].price > 0 || price.publish_ts < boundary || price.publish_ts > math::add_time(boundary, i64::from(c.read_window))? || i128::from(clock.unix_timestamp) - i128::from(price.publish_ts) > i128::from(c.age_limit), SpanError::ReadPending);
        }
        let (high, low) = t.high_low(c);
        let recorded = math::payout(c.reads[0].price, high, low, t.strike_bps)?;
        require!(recorded < VAULT_CAP, SpanError::CapReached);
        let paid = recorded.checked_add(bid.ask).ok_or(SpanError::Overflow)?;
        require!(paid <= bid.cap, SpanError::PriceAboveMax);
        let balance = ctx.accounts.bid_usdc.amount;
        require!(balance >= bid.cap, SpanError::DepositMismatch);
        let refund = bid.cap.checked_sub(paid).ok_or(SpanError::Overflow)?;
        let extra = balance.checked_sub(bid.cap).ok_or(SpanError::Overflow)?;
        let ticket_key = t.key();
        let bid_bump = [bid.bump];
        let bid_seeds: &[&[u8]] = &[b"bid", ticket_key.as_ref(), bid.bidder.as_ref(), &bid_bump];
        let before = ctx.accounts.holder_usdc.amount;
        token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.bid_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.holder_usdc.to_account_info(), authority: bid.to_account_info(),
        }, &[bid_seeds]), paid, 6)?;
        ctx.accounts.holder_usdc.reload()?;
        require!(ctx.accounts.holder_usdc.amount.checked_sub(before) == Some(paid), SpanError::DepositMismatch);
        token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.bid_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.bidder_usdc.to_account_info(), authority: bid.to_account_info(),
        }, &[bid_seeds]), balance.checked_sub(paid).ok_or(SpanError::Overflow)?, 6)?;
        token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::CloseAccount {
            account: ctx.accounts.bid_usdc.to_account_info(), destination: ctx.accounts.bidder.to_account_info(), authority: bid.to_account_info(),
        }, &[bid_seeds]))?;
        let mut span_returned = 0u64;
        let mut span_loaded = 0u64;
        let mut span_bump = 0u8;
        let mut reimbursement = 0u64;
        if t.span_loaded > 0 || bid.span_amount > 0 {
            let mint = ctx.accounts.span_mint.as_ref().ok_or(SpanError::MissingAccount)?;
            let program = ctx.accounts.span_token_program.as_ref().ok_or(SpanError::MissingAccount)?;
            let hold = ctx.accounts.span_hold.as_ref().ok_or(SpanError::MissingAccount)?;
            let (expected, bump) = Pubkey::find_program_address(&[b"span", ticket_key.as_ref()], &crate::ID);
            require_keys_eq!(hold.key(), expected, SpanError::WrongOwner);
            require_keys_eq!(*mint.to_account_info().owner, program.key(), SpanError::UnsupportedTokenProgram);
            if t.span_loaded > 0 {
                span_returned = bid_token_balance(&hold.to_account_info(), mint.key(), ticket_key, program.key())?;
                let id_bytes = t.id.to_le_bytes(); let ticket_bump = [t.bump];
                let ticket_seeds: &[&[u8]] = &[b"ticket", &id_bytes, &ticket_bump];
                if span_returned > 0 {
                    let destination = ctx.accounts.holder_span.as_ref().ok_or(SpanError::MissingAccount)?;
                    bid_token_balance(&destination.to_account_info(), mint.key(), ctx.accounts.holder.key(), program.key())?;
                    token_interface::transfer_checked(CpiContext::new_with_signer(program.key(), token_interface::TransferChecked {
                        from: hold.to_account_info(), mint: mint.to_account_info(), to: destination.to_account_info(), authority: t.to_account_info(),
                    }, &[ticket_seeds]), span_returned, mint.decimals)?;
                }
                token_interface::close_account(CpiContext::new_with_signer(program.key(), token_interface::CloseAccount {
                    account: hold.to_account_info(), destination: ctx.accounts.holder.to_account_info(), authority: t.to_account_info(),
                }, &[ticket_seeds]))?;
            }
            if bid.span_amount > 0 {
                let escrow = ctx.accounts.bid_span.as_ref().ok_or(SpanError::MissingAccount)?;
                span_loaded = bid_token_balance(&escrow.to_account_info(), mint.key(), bid.key(), program.key())?;
                require_keys_eq!(*hold.owner, anchor_lang::system_program::ID, SpanError::InvalidValue);
                require!(hold.data_is_empty(), SpanError::InvalidValue);
                let size = escrow.to_account_info().data_len();
                let rent = Rent::get()?;
                let minimum = rent.minimum_balance(size);
                let cost = minimum.saturating_sub(hold.lamports());
                let hold_bump = [bump];
                let hold_seeds: &[&[u8]] = &[b"span", ticket_key.as_ref(), &hold_bump];
                if hold.lamports() == 0 {
                    anchor_lang::system_program::create_account(CpiContext::new_with_signer(ctx.accounts.system_program.key(), anchor_lang::system_program::CreateAccount {
                        from: ctx.accounts.holder.to_account_info(), to: hold.to_account_info(),
                    }, &[hold_seeds]), minimum, size as u64, &program.key())?;
                } else {
                    if cost > 0 {
                        anchor_lang::system_program::transfer(CpiContext::new(ctx.accounts.system_program.key(), anchor_lang::system_program::Transfer {
                            from: ctx.accounts.holder.to_account_info(), to: hold.to_account_info(),
                        }), cost)?;
                    }
                    anchor_lang::system_program::allocate(CpiContext::new_with_signer(ctx.accounts.system_program.key(), anchor_lang::system_program::Allocate { account_to_allocate: hold.to_account_info() }, &[hold_seeds]), size as u64)?;
                    anchor_lang::system_program::assign(CpiContext::new_with_signer(ctx.accounts.system_program.key(), anchor_lang::system_program::Assign { account_to_assign: hold.to_account_info() }, &[hold_seeds]), &program.key())?;
                }
                token_interface::initialize_account3(CpiContext::new(program.key(), token_interface::InitializeAccount3 {
                    account: hold.to_account_info(), mint: mint.to_account_info(), authority: t.to_account_info(),
                }))?;
                let remaining = bid.to_account_info().lamports().checked_sub(cost).ok_or(SpanError::InvalidValue)?;
                require!(remaining >= rent.minimum_balance(8 + Bid::INIT_SPACE), SpanError::InvalidValue);
                reimbursement = cost;
                token_interface::transfer_checked(CpiContext::new_with_signer(program.key(), token_interface::TransferChecked {
                    from: escrow.to_account_info(), mint: mint.to_account_info(), to: hold.to_account_info(), authority: bid.to_account_info(),
                }, &[bid_seeds]), span_loaded, mint.decimals)?;
                token_interface::close_account(CpiContext::new_with_signer(program.key(), token_interface::CloseAccount {
                    account: escrow.to_account_info(), destination: ctx.accounts.bidder.to_account_info(), authority: bid.to_account_info(),
                }, &[bid_seeds]))?;
                span_bump = bump;
            }
        }
        let reads = c.reads.iter().enumerate().fold(0u16, |bits, (j, r)| if r.price > 0 { bits | (1u16 << j) } else { bits });
        let t = &mut ctx.accounts.ticket;
        t.buyer = Some(bid.bidder); t.span_loaded = span_loaded; t.span_bump = span_bump;
        t.step_bps = if bid.span_amount > 0 { bid.step_bps } else { 0 };
        t.marker = if bid.span_amount > 0 { bid.marker } else { Pubkey::default() };
        emit_cpi!(BidAccepted { ticket: t.key(), id: t.id, t0: t.t0, bid: bid.key(), from: ctx.accounts.holder.key(), to: bid.bidder,
            ask: bid.ask, cap: bid.cap, recorded, paid, refund, extra, high, low, tail_high: t.tail_high, tail_low: t.tail_low,
            reads, marks: t.marks, burned: t.burned, span_returned, span_loaded, step_bps: t.step_bps, marker: t.marker, slot: clock.slot });
        // Apply the balanced native refund after the last CPI; neither side is partially synchronized into a CPI.
        if reimbursement > 0 {
            let remaining = bid.to_account_info().lamports().checked_sub(reimbursement).ok_or(SpanError::InvalidValue)?;
            let holder_lamports = ctx.accounts.holder.lamports().checked_add(reimbursement).ok_or(SpanError::Overflow)?;
            **bid.to_account_info().try_borrow_mut_lamports()? = remaining;
            **ctx.accounts.holder.to_account_info().try_borrow_mut_lamports()? = holder_lamports;
        }
        Ok(())
    }

    pub fn close_bid(ctx: Context<CloseBid>) -> Result<()> {
        let bid = &ctx.accounts.bid;
        if ctx.accounts.ticket.owner == &crate::ID && !ctx.accounts.ticket.data_is_empty() && Clock::get()?.unix_timestamp <= bid.until {
            require_keys_eq!(ctx.accounts.closer.key(), bid.bidder, SpanError::NotBidder);
        }
        let ticket = bid.ticket; let bidder = bid.bidder; let bump = [bid.bump];
        let seeds: &[&[u8]] = &[b"bid", ticket.as_ref(), bidder.as_ref(), &bump];
        let usdc = ctx.accounts.bid_usdc.amount;
        token::transfer_checked(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.bid_usdc.to_account_info(), mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.bidder_usdc.to_account_info(), authority: bid.to_account_info(),
        }, &[seeds]), usdc, ctx.accounts.usdc_mint.decimals)?;
        token::close_account(CpiContext::new_with_signer(ctx.accounts.token_program.key(), token::CloseAccount {
            account: ctx.accounts.bid_usdc.to_account_info(), destination: ctx.accounts.bidder.to_account_info(), authority: bid.to_account_info(),
        }, &[seeds]))?;
        let mut span = 0;
        if bid.span_amount > 0 {
            let escrow = ctx.accounts.bid_span.as_ref().ok_or(SpanError::MissingAccount)?;
            let mint = ctx.accounts.span_mint.as_ref().ok_or(SpanError::MissingAccount)?;
            let program = ctx.accounts.span_token_program.as_ref().ok_or(SpanError::MissingAccount)?;
            let destination = ctx.accounts.bidder_span.as_ref().ok_or(SpanError::MissingAccount)?;
            require_keys_eq!(*mint.to_account_info().owner, program.key(), SpanError::UnsupportedTokenProgram);
            span = bid_token_balance(&escrow.to_account_info(), mint.key(), bid.key(), program.key())?;
            bid_token_balance(&destination.to_account_info(), mint.key(), bidder, program.key())?;
            token_interface::transfer_checked(CpiContext::new_with_signer(program.key(), token_interface::TransferChecked {
                from: escrow.to_account_info(), mint: mint.to_account_info(), to: destination.to_account_info(), authority: bid.to_account_info(),
            }, &[seeds]), span, mint.decimals)?;
            token_interface::close_account(CpiContext::new_with_signer(program.key(), token_interface::CloseAccount {
                account: escrow.to_account_info(), destination: ctx.accounts.bidder.to_account_info(), authority: bid.to_account_info(),
            }, &[seeds]))?;
        }
        emit_cpi!(BidClosed { ticket, bid: bid.key(), bidder, closer: ctx.accounts.closer.key(), usdc, span });
        Ok(())
    }

    pub fn open_running(ctx: Context<OpenRunning>, id: u64, premium: u64, strike_bps: u16, until: i64) -> Result<()> {
        require!(
            (PREMIUM_MIN..=PREMIUM_MAX).contains(&premium)
                && strike_bps <= STRIKE_MAX_BPS && strike_bps % STRIKE_STEP_BPS == 0,
            SpanError::InvalidValue
        );
        let deposit = VAULT_CAP.checked_sub(premium).ok_or(SpanError::Overflow)?;
        let t = &mut ctx.accounts.ticket;
        t.set_inner(Ticket {
            id,
            t0: ctx.accounts.gate.candle.t0,
            seller: ctx.accounts.seller.key(),
            buyer: None,
            premium,
            strike_bps,
            state: TicketState::Open,
            span_loaded: 0,
            step_bps: 0,
            marker: Pubkey::default(),
            tail_high: 0,
            tail_low: 0,
            marks: 0,
            burned: 0,
            bump: ctx.bumps.ticket,
            vault_bump: ctx.bumps.vault,
            span_bump: 0,
        });
        let before = ctx.accounts.vault.amount;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::TransferChecked {
                    from: ctx.accounts.seller_source.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            deposit,
            6,
        )?;
        ctx.accounts.vault.reload()?;
        require!(
            ctx.accounts.vault.amount.checked_sub(before) == Some(deposit),
            SpanError::DepositMismatch
        );
        ctx.accounts.gate.config.next_ticket_id = id.checked_add(1).ok_or(SpanError::Overflow)?;
        ctx.accounts.until.set_inner(Until {
            ticket: t.key(), seller: t.seller, until, bump: ctx.bumps.until,
        });
        emit_cpi!(TicketOpened {
            ticket: t.key(),
            id,
            t0: t.t0,
            seller: t.seller,
            premium,
            strike_bps,
            deposit
        });
        emit_cpi!(UntilSet { ticket: t.key(), id, t0: t.t0, until });
        Ok(())
    }

    pub fn buy_running(ctx: Context<BuyRunning>, max_pay: u64) -> Result<()> {
        let c = &ctx.accounts.candle;
        let t = &ctx.accounts.ticket;
        require!(t.state == TicketState::Open, SpanError::NotOpen);
        require!(c.reads[0].price > 0, SpanError::NoOpen);
        let clock = Clock::get()?;
        require!(clock.unix_timestamp <= ctx.accounts.until.until, SpanError::BuyClosed);
        let asset = math::window(c.t0)?.0;
        require_keys_eq!(ctx.accounts.feed.key(), oracle::feed_of(ctx.accounts.config.feed, asset)?, SpanError::FeedNotConfig);
        let price = oracle::read(&ctx.accounts.feed.to_account_info(), clock.unix_timestamp, c.age_limit, asset)?;
        require!(price.publish_ts > c.t0 && price.publish_ts <= math::add_time(c.t0, math::window(c.t0)?.1)?, SpanError::OutsideCandle);
        let (high, low) = t.high_low(c);
        let recorded = math::payout(c.reads[0].price, high.max(price.price), low.min(price.price), t.strike_bps)?;
        require!(recorded < VAULT_CAP, SpanError::CapReached);
        let paid = recorded.checked_add(t.premium).ok_or(SpanError::Overflow)?;
        require!(paid <= max_pay, SpanError::PriceAboveMax);
        let before = ctx.accounts.vault.amount;
        token::transfer_checked(CpiContext::new(ctx.accounts.token_program.key(), token::TransferChecked {
            from: ctx.accounts.buyer_source.to_account_info(),
            mint: ctx.accounts.usdc_mint.to_account_info(),
            to: ctx.accounts.vault.to_account_info(),
            authority: ctx.accounts.buyer.to_account_info(),
        }), paid, 6)?;
        ctx.accounts.vault.reload()?;
        require!(ctx.accounts.vault.amount.checked_sub(before) == Some(paid), SpanError::DepositMismatch);
        require!(ctx.accounts.vault.amount >= VAULT_CAP, SpanError::DepositMismatch);
        let t = &mut ctx.accounts.ticket;
        if price.price > high { t.tail_high = price.price; }
        if price.price < low { t.tail_low = price.price; }
        t.buyer = Some(ctx.accounts.buyer.key());
        t.state = TicketState::Sold;
        emit_cpi!(BoughtRunning {
            ticket: t.key(), id: t.id, t0: t.t0, buyer: ctx.accounts.buyer.key(), premium: t.premium,
            recorded, paid, price: price.price, publish_ts: price.publish_ts,
            tail_high: t.tail_high, tail_low: t.tail_low, slot: clock.slot,
        });
        Ok(())
    }

    pub fn close_until(ctx: Context<CloseUntil>) -> Result<()> {
        if ctx.accounts.ticket.owner == &crate::ID && !ctx.accounts.ticket.data_is_empty() {
            require_keys_eq!(ctx.accounts.closer.key(), ctx.accounts.until.seller, SpanError::NotSeller);
        }
        emit_cpi!(UntilClosed { ticket: ctx.accounts.until.ticket, until: ctx.accounts.until.key(), closer: ctx.accounts.closer.key() });
        Ok(())
    }

    pub fn open_ticket(ctx: Context<OpenTicket>, id: u64, premium: u64, strike_bps: u16) -> Result<()> {
        require!(
            (PREMIUM_MIN..=PREMIUM_MAX).contains(&premium)
                && strike_bps <= STRIKE_MAX_BPS && strike_bps % STRIKE_STEP_BPS == 0,
            SpanError::InvalidValue
        );
        let deposit = VAULT_CAP.checked_sub(premium).ok_or(SpanError::Overflow)?;
        let t = &mut ctx.accounts.ticket;
        t.set_inner(Ticket {
            id,
            t0: ctx.accounts.gate.candle.t0,
            seller: ctx.accounts.seller.key(),
            buyer: None,
            premium,
            strike_bps,
            state: TicketState::Open,
            span_loaded: 0,
            step_bps: 0,
            marker: Pubkey::default(),
            tail_high: 0,
            tail_low: 0,
            marks: 0,
            burned: 0,
            bump: ctx.bumps.ticket,
            vault_bump: ctx.bumps.vault,
            span_bump: 0,
        });
        let before = ctx.accounts.vault.amount;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::TransferChecked {
                    from: ctx.accounts.seller_source.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.seller.to_account_info(),
                },
            ),
            deposit,
            6,
        )?;
        ctx.accounts.vault.reload()?;
        require!(
            ctx.accounts.vault.amount.checked_sub(before) == Some(deposit),
            SpanError::DepositMismatch
        );
        ctx.accounts.gate.config.next_ticket_id = id.checked_add(1).ok_or(SpanError::Overflow)?;
        emit_cpi!(TicketOpened {
            ticket: t.key(),
            id,
            t0: t.t0,
            seller: t.seller,
            premium,
            strike_bps,
            deposit
        });
        Ok(())
    }

    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        let t = &ctx.accounts.ticket;
        require!(ctx.accounts.seller.key() == t.seller, SpanError::NotSeller);
        require!(t.state == TicketState::Open, SpanError::NotOpen);
        let id_bytes = t.id.to_le_bytes();
        let bump = [t.bump];
        let seeds: &[&[u8]] = &[b"ticket", &id_bytes, &bump];
        let amount = ctx.accounts.vault.amount;
        transfer_usdc(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.usdc_mint.to_account_info(),
            &ctx.accounts.seller_destination.to_account_info(),
            &t.to_account_info(),
            amount,
            &[seeds],
        )?;
        close_usdc(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &t.to_account_info(),
            &[seeds],
        )?;
        emit_cpi!(Withdrawn {
            ticket: t.key(),
            id: t.id,
            t0: t.t0,
            seller: t.seller,
            returned: amount
        });
        Ok(())
    }

    pub fn buy(ctx: Context<Buy>) -> Result<()> {
        require!(
            ctx.accounts.ticket.state == TicketState::Open,
            SpanError::NotOpen
        );
        sale_open(&ctx.accounts.candle)?;
        let before = ctx.accounts.vault.amount;
        let premium = ctx.accounts.ticket.premium;
        token::transfer_checked(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                token::TransferChecked {
                    from: ctx.accounts.buyer_source.to_account_info(),
                    mint: ctx.accounts.usdc_mint.to_account_info(),
                    to: ctx.accounts.vault.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            premium,
            6,
        )?;
        ctx.accounts.vault.reload()?;
        require!(
            ctx.accounts.vault.amount.checked_sub(before) == Some(premium),
            SpanError::DepositMismatch
        );
        require!(
            ctx.accounts.vault.amount >= VAULT_CAP,
            SpanError::DepositMismatch
        );
        let t = &mut ctx.accounts.ticket;
        t.buyer = Some(ctx.accounts.buyer.key());
        t.state = TicketState::Sold;
        emit_cpi!(Bought {
            ticket: t.key(),
            id: t.id,
            t0: t.t0,
            buyer: ctx.accounts.buyer.key(),
            premium
        });
        Ok(())
    }

    pub fn set_marker(ctx: Context<SetMarker>, marker: Pubkey) -> Result<()> {
        let t = &mut ctx.accounts.ticket;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.buyer == Some(ctx.accounts.buyer.key()), SpanError::NotBuyer);
        require!(t.span_loaded > 0, SpanError::NotLoaded);
        require!(
            Clock::get()?.unix_timestamp <= mark_deadline(&ctx.accounts.candle)?,
            SpanError::MarkClosed
        );
        let old_marker = t.marker;
        t.marker = marker;
        emit_cpi!(MarkerSet {
            ticket: t.key(),
            id: t.id,
            buyer: ctx.accounts.buyer.key(),
            old_marker,
            new_marker: marker,
        });
        Ok(())
    }

    pub fn load_span(
        ctx: Context<LoadSpan>,
        amount: u64,
        step_bps: u16,
        marker: Pubkey,
    ) -> Result<()> {
        let gate = &ctx.accounts.gate;
        require!(
            [2, 5, 10, 25].contains(&step_bps),
            SpanError::StepNotAllowed
        );
        require!(amount >= gate.config.burn_per_mark, SpanError::InvalidValue);
        let before = ctx.accounts.span_hold.amount;
        token_interface::transfer_checked(
            CpiContext::new(
                ctx.accounts.span_token_program.key(),
                token_interface::TransferChecked {
                    from: ctx.accounts.span_source.to_account_info(),
                    mint: ctx.accounts.span_mint.to_account_info(),
                    to: ctx.accounts.span_hold.to_account_info(),
                    authority: ctx.accounts.gate.buyer.to_account_info(),
                },
            ),
            amount,
            ctx.accounts.span_mint.decimals,
        )?;
        ctx.accounts.span_hold.reload()?;
        require!(
            ctx.accounts.span_hold.amount.checked_sub(before) == Some(amount),
            SpanError::DepositMismatch
        );
        let t = &mut ctx.accounts.gate.ticket;
        t.span_loaded = amount;
        t.step_bps = step_bps;
        t.marker = marker;
        t.span_bump = ctx.bumps.span_hold;
        emit_cpi!(SpanLoaded {
            ticket: t.key(),
            id: t.id,
            buyer: ctx.accounts.gate.buyer.key(),
            amount,
            step_bps,
            marker
        });
        Ok(())
    }

    pub fn read(ctx: Context<ReadPrice>, j: u8) -> Result<()> {
        require!(j <= math::window(ctx.accounts.candle.t0)?.2, SpanError::InvalidValue);
        let candle = &mut ctx.accounts.candle;
        let slot = usize::from(j);
        require!(candle.reads[slot].price == 0, SpanError::ReadFilled);
        if j > 0 {
            require!(candle.reads[0].price > 0, SpanError::NoOpen);
        }
        let clock = Clock::get()?;
        let boundary = math::add_time(candle.t0, i64::from(j) * 300)?;
        require!(clock.unix_timestamp >= boundary, SpanError::BeforeBoundary);
        require_keys_eq!(
            ctx.accounts.feed.key(),
            oracle::feed_of(ctx.accounts.config.feed, math::window(candle.t0)?.0)?,
            SpanError::FeedNotConfig
        );
        let price = oracle::read(
            &ctx.accounts.feed.to_account_info(),
            clock.unix_timestamp,
            candle.age_limit,
            math::window(candle.t0)?.0,
        )?;
        require!(
            price.publish_ts >= boundary
                && price.publish_ts <= math::add_time(boundary, i64::from(candle.read_window))?,
            SpanError::OutsideWindow
        );
        candle.reads[slot] = PriceRead {
            price: price.price,
            publish_ts: price.publish_ts,
        };
        if j == 0 {
            candle.read_high = price.price;
            candle.read_low = price.price;
        } else {
            candle.read_high = candle.read_high.max(price.price);
            candle.read_low = candle.read_low.min(price.price);
        }
        emit_cpi!(Read {
            candle: candle.key(),
            t0: candle.t0,
            j,
            price: price.price,
            publish_ts: price.publish_ts,
            slot: clock.slot,
            read_high: candle.read_high,
            read_low: candle.read_low
        });
        Ok(())
    }

    pub fn mark(ctx: Context<Mark>) -> Result<()> {
        let t = &ctx.accounts.gate.ticket;
        require!(t.state == TicketState::Sold, SpanError::NotSold);
        require!(t.span_loaded > 0, SpanError::NotLoaded);
        require_keys_eq!(
            ctx.accounts.gate.marker.key(),
            t.marker,
            SpanError::NotMarker
        );
        let candle = &ctx.accounts.gate.candle;
        let p0 = candle.reads[0].price;
        require!(p0 > 0, SpanError::NoOpen);
        require_keys_eq!(
            ctx.accounts.feed.key(),
            oracle::feed_of(ctx.accounts.gate.config.feed, math::window(candle.t0)?.0)?,
            SpanError::FeedNotConfig
        );
        let clock = Clock::get()?;
        let price = oracle::read(
            &ctx.accounts.feed.to_account_info(),
            clock.unix_timestamp,
            candle.age_limit,
            math::window(candle.t0)?.0,
        )?;
        require!(
            price.publish_ts > candle.t0 && price.publish_ts <= math::add_time(candle.t0, math::window(candle.t0)?.1)?,
            SpanError::OutsideCandle
        );
        let (high, low) = t.high_low(candle);
        let side = math::extends(price.price, high, low, p0, t.step_bps)?
            .ok_or(SpanError::NotExtension)?;
        require!(
            math::payout(p0, high, low, t.strike_bps)? < VAULT_CAP,
            SpanError::CapReached
        );
        let burn_per_mark = ctx.accounts.gate.config.burn_per_mark;
        require!(ctx.accounts.span_hold.amount >= burn_per_mark, SpanError::SpanShort);
        let before = math::payout(p0, high, low, t.strike_bps)?;
        let after = math::payout(p0, if side { price.price } else { high }, if side { low } else { price.price }, t.strike_bps)?;
        let burn = if after > before { burn_per_mark } else { 0 };
        let id_bytes = t.id.to_le_bytes();
        let bump = [t.bump];
        let seeds: &[&[u8]] = &[b"ticket", &id_bytes, &bump];
        if burn > 0 { token_interface::burn(
            CpiContext::new_with_signer(
                ctx.accounts.span_token_program.key(),
                token_interface::Burn {
                    mint: ctx.accounts.span_mint.to_account_info(),
                    from: ctx.accounts.span_hold.to_account_info(),
                    authority: t.to_account_info(),
                },
                &[seeds],
            ),
            burn,
        )?; }
        let t = &mut ctx.accounts.gate.ticket;
        if side {
            t.tail_high = price.price;
        } else {
            t.tail_low = price.price;
        }
        t.marks = t.marks.checked_add(1).ok_or(SpanError::Overflow)?;
        t.burned = t.burned.checked_add(burn).ok_or(SpanError::Overflow)?;
        emit_cpi!(Marked {
            ticket: t.key(),
            id: t.id,
            t0: t.t0,
            side: if side { Side::High } else { Side::Low },
            price: price.price,
            publish_ts: price.publish_ts,
            slot: clock.slot,
            tail_high: t.tail_high,
            tail_low: t.tail_low,
            marks: t.marks,
            burned: t.burned,
            burn,
            span_left: ctx
                .accounts
                .span_hold
                .amount
                .checked_sub(burn)
                .ok_or(SpanError::Overflow)?
        });
        Ok(())
    }

    pub fn settle(ctx: Context<Settle>) -> Result<()> {
        let candle = &ctx.accounts.candle;
        let end = math::add_time(
            math::add_time(candle.t0, math::window(candle.t0)?.1)?,
            i64::from(candle.read_window) + i64::from(candle.age_limit) + 1,
        )?;
        require!(Clock::get()?.unix_timestamp >= end, SpanError::NotClosed);
        let t = &ctx.accounts.ticket;
        require_keys_eq!(
            ctx.accounts.seller.key(),
            t.seller,
            SpanError::ReceiverMismatch
        );
        let buyer_key = t.buyer;
        if t.state == TicketState::Sold {
            require!(
                ctx.accounts.buyer.as_ref().map(|a| a.key()) == buyer_key,
                SpanError::ReceiverMismatch
            );
        } else if let Some(b) = &ctx.accounts.buyer {
            require!(Some(b.key()) == buyer_key, SpanError::ReceiverMismatch);
        }
        let (outcome, payout, high, low) = if t.state == TicketState::Open {
            (Outcome::Unsold, 0, 0, 0)
        } else if candle.reads[0].price == 0 {
            (Outcome::Void, 0, 0, 0)
        } else {
            let (h, l) = t.high_low(candle);
            (
                Outcome::Paid,
                math::payout(candle.reads[0].price, h, l, t.strike_bps)?,
                h,
                l,
            )
        };
        let to_buyer = match outcome {
            Outcome::Paid => payout,
            Outcome::Void => t.premium,
            Outcome::Unsold => 0,
        };
        let floor = if t.state == TicketState::Sold {
            VAULT_CAP
        } else {
            VAULT_CAP
                .checked_sub(t.premium)
                .ok_or(SpanError::Overflow)?
        };
        require!(
            ctx.accounts.vault.amount >= floor,
            SpanError::DepositMismatch
        );
        let to_seller = ctx
            .accounts
            .vault
            .amount
            .checked_sub(to_buyer)
            .ok_or(SpanError::Overflow)?;
        check_usdc_destination(
            &ctx.accounts.seller_usdc,
            t.seller,
            ctx.accounts.config.usdc_mint,
            to_seller,
        )?;
        if let Some(buyer) = buyer_key {
            check_usdc_destination(
                &ctx.accounts.buyer_usdc,
                buyer,
                ctx.accounts.config.usdc_mint,
                to_buyer,
            )?;
        }
        let id_bytes = t.id.to_le_bytes();
        let bump = [t.bump];
        let seeds: &[&[u8]] = &[b"ticket", &id_bytes, &bump];
        if to_buyer > 0 {
            transfer_usdc(
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.usdc_mint.to_account_info(),
                &ctx.accounts
                    .buyer_usdc
                    .as_ref()
                    .ok_or(SpanError::MissingAccount)?
                    .to_account_info(),
                &t.to_account_info(),
                to_buyer,
                &[seeds],
            )?;
        }
        if to_seller > 0 {
            transfer_usdc(
                &ctx.accounts.token_program.to_account_info(),
                &ctx.accounts.vault.to_account_info(),
                &ctx.accounts.usdc_mint.to_account_info(),
                &ctx.accounts
                    .seller_usdc
                    .as_ref()
                    .ok_or(SpanError::MissingAccount)?
                    .to_account_info(),
                &t.to_account_info(),
                to_seller,
                &[seeds],
            )?;
        }
        close_usdc(
            &ctx.accounts.token_program.to_account_info(),
            &ctx.accounts.vault.to_account_info(),
            &ctx.accounts.seller.to_account_info(),
            &t.to_account_info(),
            &[seeds],
        )?;
        let mut span_returned = 0;
        if t.span_loaded > 0 {
            let mint = ctx
                .accounts
                .span_mint
                .as_ref()
                .ok_or(SpanError::MissingAccount)?;
            let hold = ctx
                .accounts
                .span_hold
                .as_ref()
                .ok_or(SpanError::MissingAccount)?;
            let program = ctx
                .accounts
                .span_token_program
                .as_ref()
                .ok_or(SpanError::MissingAccount)?;
            let buyer = ctx
                .accounts
                .buyer
                .as_ref()
                .ok_or(SpanError::MissingAccount)?;
            let (expected, _) =
                Pubkey::find_program_address(&[b"span", t.key().as_ref()], &crate::ID);
            require_keys_eq!(hold.key(), expected, SpanError::WrongOwner);
            require_keys_eq!(hold.mint, mint.key(), SpanError::WrongMint);
            require_keys_eq!(hold.owner, t.key(), SpanError::WrongOwner);
            require_keys_eq!(
                *hold.to_account_info().owner,
                program.key(),
                SpanError::UnsupportedTokenProgram
            );
            require_keys_eq!(
                *mint.to_account_info().owner,
                program.key(),
                SpanError::UnsupportedTokenProgram
            );
            span_returned = hold.amount;
            if span_returned > 0 {
                let destination = ctx
                    .accounts
                    .buyer_span
                    .as_ref()
                    .ok_or(SpanError::MissingAccount)?;
                require_keys_eq!(destination.mint, mint.key(), SpanError::WrongMint);
                require_keys_eq!(destination.owner, buyer.key(), SpanError::WrongOwner);
                require_keys_eq!(
                    *destination.to_account_info().owner,
                    program.key(),
                    SpanError::UnsupportedTokenProgram
                );
                token_interface::transfer_checked(
                    CpiContext::new_with_signer(
                        program.key(),
                        token_interface::TransferChecked {
                            from: hold.to_account_info(),
                            mint: mint.to_account_info(),
                            to: destination.to_account_info(),
                            authority: t.to_account_info(),
                        },
                        &[seeds],
                    ),
                    span_returned,
                    mint.decimals,
                )?;
            }
            token_interface::close_account(CpiContext::new_with_signer(
                program.key(),
                token_interface::CloseAccount {
                    account: hold.to_account_info(),
                    destination: buyer.to_account_info(),
                    authority: t.to_account_info(),
                },
                &[seeds],
            ))?;
        }
        let reads = candle.reads.iter().enumerate().fold(0u16, |bits, (j, r)| {
            if r.price > 0 {
                bits | (1u16 << j)
            } else {
                bits
            }
        });
        emit_cpi!(Settled {
            ticket: t.key(),
            id: t.id,
            t0: t.t0,
            outcome,
            seller: t.seller,
            buyer: t.buyer,
            premium: t.premium,
            strike_bps: t.strike_bps,
            p0: candle.reads[0].price,
            read_high: candle.read_high,
            read_low: candle.read_low,
            tail_high: t.tail_high,
            tail_low: t.tail_low,
            high,
            low,
            payout,
            to_buyer,
            to_seller,
            span_returned,
            burned: t.burned,
            marks: t.marks,
            reads
        });
        Ok(())
    }

    #[cfg(feature = "devnet")]
    pub fn dev_feed_init(ctx: Context<DevFeedInit>, asset: u8) -> Result<()> {
        require!(asset < oracle::ASSETS, SpanError::InvalidValue);
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
        d[..8].copy_from_slice(&oracle::DISC);
        d[8..40].copy_from_slice(oracle::mint_of(asset)?.as_ref());
        d[168..176].copy_from_slice(&1u64.to_le_bytes());
        d[176] = 248;
        d[177..185].copy_from_slice(&now.to_le_bytes());
        drop(d);
        emit_cpi!(DevFeedUpdated {
            price: 1,
            publish_ts: now
        });
        Ok(())
    }

    #[cfg(feature = "devnet")]
    pub fn dev_feed_write(ctx: Context<DevFeedWrite>, asset: u8, price: u64, publish_ts: i64) -> Result<()> {
        require!(asset < oracle::ASSETS, SpanError::InvalidValue);
        require!(price > 0, SpanError::InvalidValue);
        let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
        d[168..176].copy_from_slice(&price.to_le_bytes());
        d[177..185].copy_from_slice(&publish_ts.to_le_bytes());
        drop(d);
        emit_cpi!(DevFeedUpdated { price, publish_ts });
        Ok(())
    }
}

fn check_usdc_destination(
    a: &Option<Box<Account<token::TokenAccount>>>,
    owner: Pubkey,
    mint: Pubkey,
    amount: u64,
) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let a = a.as_ref().ok_or(SpanError::MissingAccount)?;
    require_keys_eq!(a.mint, mint, SpanError::WrongMint);
    require_keys_eq!(a.owner, owner, SpanError::WrongOwner);
    Ok(())
}

fn transfer_usdc<'info>(
    program: &AccountInfo<'info>,
    from: &AccountInfo<'info>,
    mint: &AccountInfo<'info>,
    to: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    amount: u64,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token::transfer_checked(
        CpiContext::new_with_signer(
            program.key(),
            token::TransferChecked {
                from: from.clone(),
                mint: mint.clone(),
                to: to.clone(),
                authority: authority.clone(),
            },
            seeds,
        ),
        amount,
        6,
    )
}

fn close_usdc<'info>(
    program: &AccountInfo<'info>,
    account: &AccountInfo<'info>,
    destination: &AccountInfo<'info>,
    authority: &AccountInfo<'info>,
    seeds: &[&[&[u8]]],
) -> Result<()> {
    token::close_account(CpiContext::new_with_signer(
        program.key(),
        token::CloseAccount {
            account: account.clone(),
            destination: destination.clone(),
            authority: authority.clone(),
        },
        seeds,
    ))
}

fn bid_token_balance(account: &AccountInfo, mint: Pubkey, authority: Pubkey, program: Pubkey) -> Result<u64> {
    require_keys_eq!(*account.owner, program, SpanError::UnsupportedTokenProgram);
    let bytes = account.try_borrow_data()?;
    let token = token_interface::TokenAccount::try_deserialize(&mut &bytes[..])?;
    require_keys_eq!(token.mint, mint, SpanError::WrongMint);
    require_keys_eq!(token.owner, authority, SpanError::WrongOwner);
    Ok(token.amount)
}
