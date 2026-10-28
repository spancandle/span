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
        require!(t0 % 60 == 0, SpanError::InvalidValue);
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
        require!(j <= 12, SpanError::InvalidValue);
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
            ctx.accounts.config.feed,
            SpanError::FeedNotConfig
        );
        let price = oracle::read(
            &ctx.accounts.feed.to_account_info(),
            clock.unix_timestamp,
            candle.age_limit,
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
            ctx.accounts.gate.config.feed,
            SpanError::FeedNotConfig
        );
        let clock = Clock::get()?;
        let price = oracle::read(
            &ctx.accounts.feed.to_account_info(),
            clock.unix_timestamp,
            candle.age_limit,
        )?;
        require!(
            price.publish_ts > candle.t0 && price.publish_ts <= math::add_time(candle.t0, 3600)?,
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
            math::add_time(candle.t0, 3600)?,
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
    pub fn dev_feed_init(ctx: Context<DevFeedInit>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let mut d = ctx.accounts.feed.try_borrow_mut_data()?;
        d[..8].copy_from_slice(&oracle::DISC);
        d[8..40].copy_from_slice(oracle::SOL.as_ref());
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
    pub fn dev_feed_write(ctx: Context<DevFeedWrite>, price: u64, publish_ts: i64) -> Result<()> {
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
