use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount};
use serum_dex::state::MarketState;
use solana_program::entrypoint::ProgramResult;
use std::num::NonZeroU64;
mod dex;

declare_id!("FUXgqvNpxNN87NKXyyz5u6UHe8ywEzWNsn63KUHCP96B");

pub const USDC_MINT: Pubkey = pubkey!("8yvpPAk8avJitZbczXMya9tjZZa4s4txK7FCHEFNaoP");
#[program]
pub mod dexaggregator {

    use token::Transfer;

    use super::*;

    // initialize with owner publickey
    pub fn initialize(ctx: Context<Initialize>, owner: Pubkey) -> Result<()> {
        let state = &mut ctx.accounts.state;
        state.owner = owner;
        Ok(())
    }

    //  Function: `swap`

    //  A convenience API to call the SendTake function on the Serum DEX.

    //  SendTake does not require an open orders account or settlement of funds for the user -
    //  rather it immediately settles the deposites funds into the user's account if there is a counterparty in the orderbook.

    //  Thus, this function is useful for instant swaps on a single A/B market,
    //  where A is the base currency and B is the quote currency.

    //  When side is "bid", then swaps B for A. When side is "ask", then swaps A for B.

    //  When side is 'bid', amount -> B, amount_out_min -> A, the implied price (of A) is amount/amount_out_min,
    //  e.g. if amount = 1000, amount_out_min = 100, then the implied price is 1000/100 = 10.

    //  Similarly, when side is 'ask', amount -> A, amount_out_min -> B, the implied price (of A) is amount_out_min/amount.

    // / * `side`           - The direction to swap.
    // / * `amount_in_max`  - The max input  amount to swap "from".
    // / * `amount_out_min` - The minimum output amount of the "to" token, the instruction fails if execution would result in less.

    #[access_control(is_valid_swap(&ctx))]
    pub fn swap<'info>(
        ctx: Context<'_, '_, '_, 'info, Swap<'info>>,
        side: Side,
        amount_in_max: u64,
        amount_out_min: u64,
    ) -> Result<()> {
        msg!("Serum Swap Instruction: Swap");
        msg!(
            "Inputs: side: {:?}, amount_in_max: {}, amount_out_min: {}",
            side,
            amount_in_max,
            amount_out_min
        );

        let orderbook: OrderbookClient<'info> = (&*ctx.accounts).into();

        // Side determines swap direction.
        let (from_token, to_token) = match side {
            Side::Bid => (&ctx.accounts.pc_wallet, &ctx.accounts.market.coin_wallet),
            Side::Ask => (&ctx.accounts.market.coin_wallet, &ctx.accounts.pc_wallet),
        };

        // Sent some percent token to treasury
        if side == Side::Bid {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pc_wallet.to_account_info(),
                        to: ctx.accounts.treasury_usdc.to_account_info(),
                        authority: ctx.accounts.pc_wallet.to_account_info(),
                    },
                ),
                amount_in_max * 10 / 1000,
            )?;
        }

        // Token balances before the trade.
        let from_amount_before = token::accessor::amount(from_token)?;
        let to_amount_before = token::accessor::amount(to_token)?;

        // Execute the swap.
        match side {
            Side::Bid => orderbook.bid(amount_in_max * 990 / 1000, amount_out_min)?,
            Side::Ask => orderbook.ask(amount_in_max, amount_out_min)?,
        };

        // Token balances after the trade.
        let from_amount_after = token::accessor::amount(from_token)?;
        let to_amount_after = token::accessor::amount(to_token)?;

        //  Calculate the delta, i.e. the amount swapped.
        let from_amount = from_amount_before.checked_sub(from_amount_after).unwrap();
        let to_amount = to_amount_after.checked_sub(to_amount_before).unwrap();

        // Sent some percent token to treasury
        if side == Side::Ask {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.pc_wallet.to_account_info(),
                        to: ctx.accounts.treasury_usdc.to_account_info(),
                        authority: ctx.accounts.pc_wallet.to_account_info(),
                    },
                ),
                to_amount * 10 / 1000,
            )?;
        }

        // Safety checks.
        apply_safety_checks(
            amount_in_max * 990 / 1000,
            amount_out_min,
            from_amount,
            to_amount,
        )?;

        Ok(())
    }

    /// Function: `swap_transitive`

    /// Swap two base currencies across two different markets.
    ///
    /// That is, suppose there are two markets, A/USD(x) and B/USD(x).
    /// Then swaps token A for token B via
    ///
    /// 1. Selling A to USD(x) on A/USD(x) market using SendTake.
    /// 2. Buying B using the proceed USD(x) on B/USD(x) market using SendTake.

    /// * `amount_in_max`  - The max input  amount to swap "from".
    /// * `amount_out_min` - The minimum output amount of the "to" token, the instruction fails if execution would result in less.

    #[access_control(is_valid_swap_transitive(&ctx))]
    pub fn swap_transitive<'info>(
        ctx: Context<'_, '_, '_, 'info, SwapTransitive<'info>>,
        amount_in_max: u64,
        amount_out_min: u64,
    ) -> Result<()> {
        msg!("Serum Swap Instruction: Swap Transitive");
        msg!(
            "Inputs: amount_in_max: {}, amount_out_min: {}",
            amount_in_max,
            amount_out_min
        );
        // Leg 1 : A -> USD(x)
        let (from_amount, sell_proceeds) = {
            let coin_before = token::accessor::amount(&ctx.accounts.from.coin_wallet)?;
            let pc_before = token::accessor::amount(&ctx.accounts.pc_wallet)?;

            let orderbook: OrderbookClient<'info> = ctx.accounts.orderbook_from();
            orderbook.ask(amount_in_max, 0)?;

            let coin_after = token::accessor::amount(&ctx.accounts.from.coin_wallet)?;
            let pc_after = token::accessor::amount(&ctx.accounts.pc_wallet)?;
            (
                coin_before.checked_sub(coin_after).unwrap(),
                pc_after.checked_sub(pc_before).unwrap(),
            )
        };

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.pc_wallet.to_account_info(),
                    to: ctx.accounts.treasury_usdc.to_account_info(),
                    authority: ctx.accounts.pc_wallet.to_account_info(),
                },
            ),
            sell_proceeds * 10 / 1000,
        )?;

        // Leg 2 : USD(x) -> B
        let (to_amount, buy_proceeds) = {
            let coin_before = token::accessor::amount(&ctx.accounts.to.coin_wallet)?;
            let pc_before = token::accessor::amount(&ctx.accounts.pc_wallet)?;

            let orderbook: OrderbookClient<'info> = ctx.accounts.orderbook_to();
            orderbook.bid(sell_proceeds * 990 / 1000, amount_out_min)?;

            let coin_after = token::accessor::amount(&ctx.accounts.to.coin_wallet)?;
            let pc_after = token::accessor::amount(&ctx.accounts.pc_wallet)?;
            (
                coin_after.checked_sub(coin_before).unwrap(),
                pc_before.checked_sub(pc_after).unwrap(),
            )
        };

        // USD(x) spills due to rounding errors of the lot size.
        let spill_amount = sell_proceeds.checked_sub(buy_proceeds).unwrap();
        msg!("Intermediate token spill amount: {:?}", spill_amount);

        // Safety checks.
        apply_safety_checks(amount_in_max, amount_out_min, from_amount, to_amount)?;

        Ok(())
    }

    // withdraw from treasury
    pub fn withdraw(ctx: Context<Withdraw>) -> Result<()> {
        // Check if the signer is the program owner
        require!(
            ctx.accounts.owner.key() == ctx.accounts.state.owner,
            ErrorCode::Unauthorized
        );

        let authority_bump = ctx.bumps.treasury;
        let authority_seeds: &[&[u8]] = &[b"treasury", &[authority_bump]];
        let signer_seeds = &[&authority_seeds[..]];

        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.treasury.to_account_info(),
                    to: ctx.accounts.owner.to_account_info(),
                    authority: ctx.accounts.treasury.to_account_info(),
                },
                signer_seeds,
            ),
            ctx.accounts.treasury_usdc.amount,
        )?;
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = user, space = 8 + 32)]
    pub state: Account<'info, State>,
    #[account(mut)]
    pub user: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[account]
pub struct State {
    pub owner: Pubkey,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    // The single A/B market to swap on
    /// CHECK: Safe
    pub market: MarketAccounts<'info>,
    // The swap user
    /// CHECK: Safe
    #[account(signer, mut)]
    pub wallet_owner: AccountInfo<'info>,

    pub mint_a: Box<Account<'info, Mint>>,
    // The treasury wallet account
    /// CHECK: safe
    #[account(
        mut,
        seeds = [
            b"treasury"
        ],
        bump,
    )]
    pub treasury: AccountInfo<'info>,

    #[account(
        init_if_needed,
        payer = wallet_owner,
        associated_token::mint = mint_a,
        associated_token::authority = treasury,
    )]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    // The user's token account for the 'price' currency
    /// CHECK: Safe
    #[account(mut)]
    pub pc_wallet: AccountInfo<'info>,

    /// Solana ecosystem accounts
    pub system_program: Program<'info, System>,
    pub associated_token_program: Program<'info, AssociatedToken>,

    // The Serum DEX program
    /// CHECK: Safe
    pub dex_program: AccountInfo<'info>,
    // The token program
    /// CHECK: Safe
    pub token_program: AccountInfo<'info>,
}

impl<'info> From<&Swap<'info>> for OrderbookClient<'info> {
    fn from(accounts: &Swap<'info>) -> OrderbookClient<'info> {
        OrderbookClient {
            market: accounts.market.clone(),
            wallet_owner: accounts.wallet_owner.clone(),
            pc_wallet: accounts.pc_wallet.clone(),
            dex_program: accounts.dex_program.clone(),
            token_program: accounts.token_program.clone(),
        }
    }
}

#[derive(Accounts)]
pub struct SwapTransitive<'info> {
    // The first A/B market to swap on, A -> B, ask
    pub from: MarketAccounts<'info>,
    // The second C/B market to swap on, B -> C, bid
    pub to: MarketAccounts<'info>,
    // The swap user
    /// CHECK: Safe
    #[account(signer)]
    pub wallet_owner: AccountInfo<'info>,
    // The user's token account for the 'price' currency
    /// CHECK: Safe
    #[account(mut)]
    pub pc_wallet: AccountInfo<'info>,
    // The treasury wallet account
    /// CHECK: safe
    #[account(
        mut,
        seeds = [
            b"treasury"
        ],
        bump,
    )]
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = USDC_MINT,
        associated_token::authority = treasury,
    )]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,
    // The Serum DEX program
    /// CHECK: Safe
    pub dex_program: AccountInfo<'info>,
    // The token program
    /// CHECK: Safe
    pub token_program: AccountInfo<'info>,
}

impl<'info> SwapTransitive<'info> {
    fn orderbook_from(&self) -> OrderbookClient<'info> {
        OrderbookClient {
            market: self.from.clone(),
            wallet_owner: self.wallet_owner.clone(),
            pc_wallet: self.pc_wallet.clone(),
            dex_program: self.dex_program.clone(),
            token_program: self.token_program.clone(),
        }
    }
    fn orderbook_to(&self) -> OrderbookClient<'info> {
        OrderbookClient {
            market: self.to.clone(),
            wallet_owner: self.wallet_owner.clone(),
            pc_wallet: self.pc_wallet.clone(),
            dex_program: self.dex_program.clone(),
            token_program: self.token_program.clone(),
        }
    }
}

// Market accounts are the accounts used to place orders against the dex minus
// common accounts, i.e., program ids, sysvars
#[derive(Accounts, Clone)]
pub struct MarketAccounts<'info> {
    // The DEX markets
    /// CHECK: Safe
    #[account(mut)]
    pub market: AccountInfo<'info>,
    // The DEX request queue
    /// CHECK: Safe
    #[account(mut)]
    pub request_queue: AccountInfo<'info>,
    // The DEX event queue
    /// CHECK: Safe
    #[account(mut)]
    pub event_queue: AccountInfo<'info>,
    // The DEX market bids
    /// CHECK: Safe
    #[account(mut)]
    pub market_bids: AccountInfo<'info>,
    // The DEX market asks
    /// CHECK: Safe
    #[account(mut)]
    pub market_asks: AccountInfo<'info>,
    // Also known as the "base" currency. For a given A/B market,
    // this is the vault for the A mint.
    /// CHECK: Safe
    #[account(mut)]
    pub coin_vault: AccountInfo<'info>,
    // Also known as the "quote" currency. For a given A/B market,
    // this is the vault for the B mint.
    /// CHECK: Safe
    #[account(mut)]
    pub pc_vault: AccountInfo<'info>,
    // PDA owner of the DEX's token accounts for base + quote currencies.
    /// CHECK: Safe
    #[account(mut)]
    pub vault_signer: AccountInfo<'info>,
    // The user's token account for the 'coin' currency
    /// CHECK: Safe
    #[account(mut)]
    pub coin_wallet: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct Withdraw<'info> {
    #[account(mut, has_one = owner)]
    pub state: Account<'info, State>,
    // treasury wallet
    /// CHECK: safe
    #[account(
        mut,
        seeds = [
            b"treasury"
        ],
        bump,
    )]
    pub treasury: AccountInfo<'info>,

    #[account(
        mut,
        associated_token::mint = USDC_MINT,
        associated_token::authority = treasury,
    )]
    pub treasury_usdc: Box<Account<'info, TokenAccount>>,

    // owner wallet
    /// CHECK: safe
    #[account(mut, signer)]
    pub owner: AccountInfo<'info>,

    pub token_program: Program<'info, Token>,
}
// Client for sending orders to the Serum DEX.
#[derive(Clone)]
struct OrderbookClient<'info> {
    // The DEX market
    /// CHECK: Safe
    market: MarketAccounts<'info>,
    // The swap user
    /// CHECK: Safe
    wallet_owner: AccountInfo<'info>,
    // The user's token account for the 'price' currency
    /// CHECK: Safe
    pc_wallet: AccountInfo<'info>,
    // The Serum DEX program
    /// CHECK: Safe
    dex_program: AccountInfo<'info>,
    // The token program
    /// CHECK: Safe
    token_program: AccountInfo<'info>,
}

impl<'info> OrderbookClient<'info> {
    /// 'Swap' from pc to coin - Bid
    fn bid(&self, max_pc_amount_input: u64, min_coin_amount_output: u64) -> ProgramResult {
        let limit_price = u64::MAX;
        let max_coin_qty = u64::MAX;
        let max_native_pc_qty_including_fees = max_pc_amount_input;
        let min_coin_qty = {
            let market = MarketState::load(&self.market.market, &dex::ID, false)?;
            coin_lots(&market, min_coin_amount_output)
        };
        let min_native_pc_qty = 0;
        self.send_take_cpi(
            Side::Bid,
            limit_price,
            max_coin_qty,
            max_native_pc_qty_including_fees,
            min_coin_qty,
            min_native_pc_qty,
        )
    }

    /// 'Swap' from coin to pc - Ask
    fn ask(&self, max_coin_amount_input: u64, min_pc_amount_output: u64) -> ProgramResult {
        let limit_price = 1;
        let max_coin_qty = {
            let market = MarketState::load(&self.market.market, &dex::ID, false)?;
            coin_lots(&market, max_coin_amount_input)
        };
        let max_native_pc_qty_including_fees = u64::MAX;
        let min_coin_qty = max_coin_qty;
        let min_native_pc_qty = min_pc_amount_output;
        self.send_take_cpi(
            Side::Ask,
            limit_price,
            max_coin_qty,
            max_native_pc_qty_including_fees,
            min_coin_qty,
            min_native_pc_qty,
        )
    }

    /// Execute SendTake on the Serum DEX via CPI
    fn send_take_cpi(
        &self,
        side: Side,
        limit_price: u64,
        max_coin_qty: u64,
        max_native_pc_qty_including_fees: u64,
        min_coin_qty: u64,
        min_native_pc_qty: u64,
    ) -> ProgramResult {
        let cpi_accounts = dex::SendTake {
            market: self.market.market.clone(),
            request_queue: self.market.request_queue.clone(),
            event_queue: self.market.event_queue.clone(),
            market_bids: self.market.market_bids.clone(),
            market_asks: self.market.market_asks.clone(),
            coin_wallet: self.market.coin_wallet.clone(),
            pc_wallet: self.pc_wallet.clone(),
            wallet_owner: self.wallet_owner.clone(),
            coin_vault: self.market.coin_vault.clone(),
            pc_vault: self.market.pc_vault.clone(),
            token_program: self.token_program.clone(),
            vault_signer: self.market.vault_signer.clone(),
        };
        // Limit is the dex's custom compute budge parameter, setting an upper
        // bound on the number of matching cycles the program can perform
        // before giving up and posting the remaining unmatched order.
        let limit = 65535;
        let ctx = CpiContext::new(self.dex_program.clone(), cpi_accounts);

        msg!("SendTake CPI: side: {:?}, limit_price: {}, max_coin_qty: {}, max_native_pc_qty_including_fees: {}, min_coin_qty: {}, min_native_pc_qty: {}, limit: {}", side, limit_price, max_coin_qty, max_native_pc_qty_including_fees, min_coin_qty, min_native_pc_qty, limit);
        dex::send_take(
            ctx,
            side.into(),
            NonZeroU64::new(limit_price).unwrap(),
            NonZeroU64::new(max_coin_qty).unwrap(),
            NonZeroU64::new(max_native_pc_qty_including_fees).unwrap(),
            min_coin_qty,
            min_native_pc_qty,
            limit,
        )
    }
}

#[derive(AnchorSerialize, AnchorDeserialize, Debug, PartialEq)]
pub enum Side {
    Bid,
    Ask,
}

// Returns the amount of lots for the base currency of a trade with `size`.
fn coin_lots(market: &MarketState, size: u64) -> u64 {
    size.checked_div(market.coin_lot_size).unwrap()
}

impl From<Side> for serum_dex::matching::Side {
    fn from(side: Side) -> Self {
        match side {
            Side::Bid => serum_dex::matching::Side::Bid,
            Side::Ask => serum_dex::matching::Side::Ask,
        }
    }
}

// Access control modifiers.
fn is_valid_swap(ctx: &Context<Swap>) -> Result<()> {
    _is_valid_swap(&ctx.accounts.market.coin_wallet, &ctx.accounts.pc_wallet)
}

fn is_valid_swap_transitive(ctx: &Context<SwapTransitive>) -> Result<()> {
    _is_valid_swap(&ctx.accounts.from.coin_wallet, &ctx.accounts.to.coin_wallet)
}

// Validates the tokens being swapped are of different mints.
fn _is_valid_swap<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>) -> Result<()> {
    let from_token_mint = token::accessor::mint(from)?;
    let to_token_mint = token::accessor::mint(to)?;
    if from_token_mint == to_token_mint {
        return Err(ErrorCode::SwapTokensCannotMatch.into());
    }
    Ok(())
}

// Safety checks.
fn apply_safety_checks(
    amount_in_max: u64,
    amount_out_min: u64,
    from_amount: u64,
    to_amount: u64,
) -> Result<()> {
    if amount_in_max < from_amount {
        return Err(ErrorCode::SwapTokenAmountExceedsMax.into());
    }
    if amount_out_min > to_amount {
        return Err(ErrorCode::SwapTokenAmountLessThanMin.into());
    }
    if to_amount == 0 {
        return Err(ErrorCode::ZeroSwap.into());
    }
    Ok(())
}

#[error_code]
pub enum ErrorCode {
    #[msg("The tokens being swapped must have different mints")]
    SwapTokensCannotMatch,
    #[msg("The token input is greater than the max amount input")]
    SwapTokenAmountExceedsMax,
    #[msg("The token output is less than the min amount output")]
    SwapTokenAmountLessThanMin,
    #[msg["No token is received from the swap"]]
    ZeroSwap,
    #[msg["You are not owner of this program"]]
    Unauthorized,
}
