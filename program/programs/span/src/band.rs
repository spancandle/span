use anchor_lang::prelude::*;
use anchor_lang::system_program;
use crate::{error::SpanError, state::{Band, BANDS, BAND_DEFAULT}};

pub fn band_of(program_id: &Pubkey, ticket: &Pubkey, acc: &AccountInfo) -> Result<u16> {
    let (key, _) = Pubkey::find_program_address(&[b"band", ticket.as_ref()], program_id);
    require_keys_eq!(*acc.key, key, SpanError::InvalidBand);
    if acc.data_is_empty() { return Ok(BAND_DEFAULT); }
    require_keys_eq!(*acc.owner, *program_id, SpanError::InvalidBand);
    let data = acc.try_borrow_data()?;
    let band = Band::try_deserialize(&mut &data[..]).map_err(|_| error!(SpanError::InvalidBand))?;
    require!(band.ticket == *ticket && BANDS.contains(&band.width_bps), SpanError::InvalidBand);
    Ok(band.width_bps)
}

pub fn required_band(program_id: &Pubkey, ticket: &Pubkey, remaining: &[AccountInfo]) -> Result<u16> {
    band_of(program_id, ticket, remaining.first().ok_or(SpanError::BandMissing)?)
}

pub fn create_band<'info>(acc: AccountInfo<'info>, seller: AccountInfo<'info>, system: Pubkey,
    ticket: Pubkey, width_bps: u16, bump: u8) -> Result<()> {
    require!(BANDS.contains(&width_bps), SpanError::InvalidBand);
    require!(acc.data_is_empty() && *acc.owner == system_program::ID, SpanError::InvalidBand);
    if width_bps == BAND_DEFAULT { return Ok(()); }
    let size = 8 + Band::INIT_SPACE;
    let minimum = Rent::get()?.minimum_balance(size);
    let bump_bytes = [bump];
    let seeds: &[&[u8]] = &[b"band", ticket.as_ref(), &bump_bytes];
    if acc.lamports() == 0 {
        system_program::create_account(CpiContext::new_with_signer(system, system_program::CreateAccount {
            from: seller.clone(), to: acc.clone(),
        }, &[seeds]), minimum, size as u64, &crate::ID)?;
    } else {
        let top_up = minimum.saturating_sub(acc.lamports());
        if top_up > 0 {
            system_program::transfer(CpiContext::new(system, system_program::Transfer {
                from: seller.clone(), to: acc.clone(),
            }), top_up)?;
        }
        system_program::allocate(CpiContext::new_with_signer(system, system_program::Allocate {
            account_to_allocate: acc.clone(),
        }, &[seeds]), size as u64)?;
        system_program::assign(CpiContext::new_with_signer(system, system_program::Assign {
            account_to_assign: acc.clone(),
        }, &[seeds]), &crate::ID)?;
    }
    Band {ticket, seller: *seller.key, width_bps, bump}.try_serialize(&mut &mut acc.try_borrow_mut_data()?[..])?;
    Ok(())
}
