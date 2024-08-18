import * as anchor from "@project-serum/anchor";
import { DexMarket } from "@project-serum/serum-dev-tools";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Account, Connection, Keypair, PublicKey } from "@solana/web3.js";

// Side rust enum used for the program's RPC API.
export const Side = {
  Bid: { bid: {} },
  Ask: { ask: {} },
};

export const getVaultOwnerAndNonce = async (
  marketPublicKey: PublicKey,
  dexProgramId: PublicKey
) => {
  const nonce = new anchor.BN(0);
  while (nonce.toNumber() < 255) {
    try {
      const vaultOwner = await PublicKey.createProgramAddress(
        [marketPublicKey.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
        dexProgramId
      );
      return [vaultOwner, nonce];
    } catch (e) {
      nonce.iaddn(1);
    }
  }
  throw new Error("Unable to find nonce");
};

// TODO: change to placing ladder orders instead of just one order.
interface SetupOrderbookParams {
  market: DexMarket;
  marketMaker: Keypair;
  midPrice: number;
  size: number;
}

export const setupOrderbook = async (
  connection: Connection, {
    market,
    marketMaker,
    midPrice,
    size,
  }: SetupOrderbookParams
) => {
  const baseAccount = await getAssociatedTokenAddress(market.serumMarket.baseMintAddress, marketMaker.publicKey);
  const quoteAccount = await getAssociatedTokenAddress(market.serumMarket.quoteMintAddress, marketMaker.publicKey);

  const mmAccount = new Account(marketMaker.secretKey);

  await market.serumMarket.placeOrder(connection, {
    owner: mmAccount,
    payer: baseAccount,
    side: 'sell',
    price: midPrice + 1,
    size: size,
    orderType: 'postOnly',
    clientId: undefined,
    openOrdersAddressKey: undefined,
    openOrdersAccount: undefined,
    feeDiscountPubkey: null,
    selfTradeBehavior: 'abortTransaction',
  });

  await market.serumMarket.placeOrder(connection, {
    owner: mmAccount,
    payer: quoteAccount,
    side: 'buy',
    price: midPrice - 1,
    size: size,
    orderType: 'postOnly',
    clientId: undefined,
    openOrdersAddressKey: undefined,
    openOrdersAccount: undefined,
    feeDiscountPubkey: null,
    selfTradeBehavior: 'abortTransaction',
  });
}