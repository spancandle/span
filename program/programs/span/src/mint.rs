use crate::error::SpanError;
use anchor_lang::prelude::*;
use anchor_spl::token_2022::spl_token_2022::{
    extension::{
        default_account_state::DefaultAccountState, pausable::PausableConfig,
        permanent_delegate::PermanentDelegate, transfer_hook::TransferHook,
        BaseStateWithExtensions, ExtensionType, StateWithExtensions,
    },
    state::{AccountState, Mint},
};

pub fn validate(account: &AccountInfo<'_>) -> Result<()> {
    require!(
        *account.owner == anchor_spl::token::ID || *account.owner == anchor_spl::token_2022::ID,
        SpanError::UnsupportedTokenProgram
    );
    let d = account.try_borrow_data()?;
    let mint = StateWithExtensions::<Mint>::unpack(&d).map_err(|_| SpanError::InvalidValue)?;
    require!(
        mint.base.freeze_authority.is_none(),
        SpanError::FreezeAuthorityMint
    );
    if *account.owner == anchor_spl::token::ID {
        return Ok(());
    }
    let extensions = mint.get_extension_types()?;
    require!(
        !extensions.contains(&ExtensionType::TransferFeeConfig),
        SpanError::TransferFeeMint
    );
    if extensions.contains(&ExtensionType::PermanentDelegate) {
        let delegate = mint.get_extension::<PermanentDelegate>()?;
        require!(
            Option::<Pubkey>::from(delegate.delegate).is_none(),
            SpanError::PermanentDelegateMint
        );
    }
    if extensions.contains(&ExtensionType::Pausable) {
        let pause = mint.get_extension::<PausableConfig>()?;
        require!(
            Option::<Pubkey>::from(pause.authority).is_none() && !bool::from(pause.paused),
            SpanError::PausableMint
        );
    }
    if extensions.contains(&ExtensionType::TransferHook) {
        let hook = mint.get_extension::<TransferHook>()?;
        require!(
            Option::<Pubkey>::from(hook.program_id).is_none()
                && Option::<Pubkey>::from(hook.authority).is_none(),
            SpanError::TransferHookActive
        );
    }
    if extensions.contains(&ExtensionType::DefaultAccountState) {
        require!(
            mint.get_extension::<DefaultAccountState>()?.state == AccountState::Initialized as u8,
            SpanError::DefaultStateFrozen
        );
    }
    Ok(())
}
